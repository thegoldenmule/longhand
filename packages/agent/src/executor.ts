/**
 * The tool executor: validates one tool call against the schema, the session's
 * document snapshot, the review scope and the caps, then turns an accepted call
 * into exactly one agent-actor draft and hands it to the sink.
 *
 * Order of checks for every call:
 * 1. the session is not finished;
 * 2. the tool exists and is offered for this session kind (`toolsForSession`);
 * 3. the zod input schema (`TOOLS[name].input`): lengths, word counts, one sentence;
 *    then no writer-facing text mentions an id (`writerFacingIdViolation`);
 * 4. caps (`capViolation`);
 * 5. documents, anchors and spans resolve against the snapshot (`resolveAnchor`,
 *    `resolveSpan`, `resolveMove`, `resolveInsertionPoint`, `resolveSplit`,
 *    `resolveMerge`), and the target lies inside the scope under review;
 * 6. tool-specific checks (rephrase guidance, known source, known thread);
 * 7. the draft passes `CommitDraftSchema`, and the sink accepts it.
 *
 * Any failure returns a message written for the model so it can fix the call and
 * retry. Nothing here can produce a manuscript event.
 */
import { randomUUID } from 'node:crypto';
import {
  BOUNDS,
  TOOLS,
  capViolation,
  capsFor,
  countCall,
  rephraseGuidanceViolation,
  resolveAnchor,
  resolveInsertionPoint,
  resolveMerge,
  resolveMove,
  resolveSpan,
  resolveSplit,
  toolsForSession,
  type AnchorInput,
  type EventPayloads,
  type ResolvedAnchor,
  type SessionCounts,
  type SourceSearch,
  type SpanRef,
  type Target,
  type ToolErrorCode,
  type ToolInputs,
  type ToolName,
} from '@longhand/schema';
import { agentDraft, draftError, type DraftContext, type ToolEventDraft } from './drafts';
import { docWordCount, renderOutline, renderPlain, renderSegmented } from './format';
import type { AnnotationSink } from './sink';
import { toCandidates } from './search';
import { DocumentCache, type LoadedDocument, type SessionSnapshot } from './snapshot';
import { idTokens, writerFacingIdViolation, writerFacingTexts } from './writer-text';

/** Result of one tool call. */
export type ToolCallResult =
  | { ok: true; id?: string; content: string }
  | { ok: false; error: { code: ToolErrorCode; message: string } };

/** What a call produced, for the MCP layer and progress reporting. */
export interface ToolCallOutcome {
  tool: string;
  result: ToolCallResult;
  /** The accepted draft, for annotation-producing calls. */
  draft?: ToolEventDraft;
  /** Seq the sink assigned. */
  seq?: number;
  /** True when this call ended the session. */
  finished: boolean;
}

/** Options for {@link ToolExecutor}. */
export interface ToolExecutorOptions {
  snapshot: SessionSnapshot;
  sink: AnnotationSink;
  search?: SourceSearch | null;
  now?: () => string;
  newId?: () => string;
}

type Fail = { ok: false; error: { code: ToolErrorCode; message: string } };
type Ok<T> = { ok: true } & T;

function fail(code: ToolErrorCode, message: string): Fail {
  return { ok: false, error: { code, message } };
}

const RETRY_HINT = 'Fix the arguments and call the tool again.';

/** Validates and executes tool calls for one session. Calls are serialized. */
export class ToolExecutor {
  /** Tools offered in this session. */
  readonly tools: readonly ToolName[];
  private countsValue: SessionCounts;
  private finishedValue = false;
  private readonly docs: DocumentCache;
  private readonly ctx: DraftContext;
  private queue: Promise<unknown> = Promise.resolve();
  private manuscriptTokens: Set<string> | null = null;

  constructor(private readonly opts: ToolExecutorOptions) {
    const s = opts.snapshot;
    this.tools = toolsForSession(s.sessionKind);
    this.countsValue = { ...s.counts };
    this.docs = new DocumentCache(s.documents);
    this.ctx = {
      projectId: s.projectId,
      feedbackSessionId: s.feedbackSessionId,
      model: s.model,
      now: opts.now ?? (() => new Date().toISOString()),
      newId: opts.newId ?? randomUUID,
    };
  }

  /** Counts of accepted annotation-producing calls so far. */
  get counts(): SessionCounts {
    return { ...this.countsValue };
  }

  /** True once the session's finishing tool (`finish_review`, `answer_discussion`, `reply`) was accepted. */
  get finished(): boolean {
    return this.finishedValue;
  }

  /** Validates and executes one call. Never throws. */
  call(name: string, args: unknown): Promise<ToolCallOutcome> {
    const run = this.queue.then(() => this.callNow(name, args));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async callNow(name: string, args: unknown): Promise<ToolCallOutcome> {
    const done = (result: ToolCallResult, extra: Partial<ToolCallOutcome> = {}) => ({
      tool: name,
      result,
      finished: false,
      ...extra,
    });
    try {
      if (this.finishedValue) {
        return done(
          fail(
            'session-finished',
            'This session is already finished. Do not call any more tools; end your turn.',
          ),
        );
      }
      if (!(name in TOOLS)) {
        return done(
          fail('unknown-tool', `There is no tool ${name}. Available: ${this.tools.join(', ')}.`),
        );
      }
      const tool = name as ToolName;
      if (!this.tools.includes(tool)) {
        return done(
          fail(
            'tool-not-allowed',
            `${tool} is not available in a ${this.opts.snapshot.sessionKind} session. Available: ${this.tools.join(', ')}.`,
          ),
        );
      }
      const parsed = TOOLS[tool].input.safeParse(args ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .slice(0, 8)
          .map((i) => `${i.path.length ? i.path.join('.') : '(arguments)'}: ${i.message}`)
          .join('; ');
        return done(fail('invalid-arguments', `Invalid arguments: ${issues}. ${RETRY_HINT}`));
      }
      const leak = writerFacingIdViolation(
        writerFacingTexts(tool, parsed.data as ToolInputs[ToolName]),
        this.idLikeWordsInText(),
      );
      if (leak) return done(fail('invalid-arguments', `${leak} ${RETRY_HINT}`));
      const cap = capViolation(tool, this.countsValue, this.opts.snapshot.intensity);
      if (cap) return done(fail('cap-reached', cap));

      const handled = await this.handle(tool, parsed.data as ToolInputs[ToolName]);
      if (!handled.ok) return done(handled);
      if (handled.kind === 'read') return done({ ok: true, content: handled.content });
      if (handled.kind === 'empty-search') {
        this.countsValue = { ...this.countsValue, searches: this.countsValue.searches + 1 };
        return done({ ok: true, content: handled.content });
      }

      const draft = handled.draft;
      const invalid = draftError(draft);
      if (invalid) {
        return done(
          fail('invalid-arguments', `The annotation is invalid: ${invalid}. ${RETRY_HINT}`),
        );
      }
      const appended = await this.opts.sink.append(draft);
      if (!appended.ok) {
        const closed = appended.error.code === 'session-closed';
        if (closed) this.finishedValue = true;
        return done(
          fail(
            closed ? 'session-finished' : 'sink-rejected',
            `The ledger did not record it (${appended.error.code}): ${appended.error.message}`,
          ),
        );
      }
      this.countsValue = countCall(tool, this.countsValue);
      const finished = TOOLS[tool].kind === 'control';
      if (finished) this.finishedValue = true;
      return done(
        { ok: true, id: handled.id, content: this.successText(tool, handled.id, finished) },
        { draft, seq: appended.seq, finished },
      );
    } catch (e) {
      return done(
        fail('internal-error', `Internal error: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  private successText(tool: ToolName, id: string, finished: boolean): string {
    if (finished) {
      return tool === 'finish_review'
        ? 'Review recorded. The session is finished: do not call any more tools.'
        : tool === 'reply'
          ? 'Reply recorded. The session is finished: do not call any more tools.'
          : 'Answer recorded. The session is finished: do not call any more tools.';
    }
    const caps = capsFor(this.opts.snapshot.intensity);
    const c = this.countsValue;
    const left = [
      `${caps.maxItems - c.items} items`,
      `${caps.maxSuggestions - c.suggestions} suggestions`,
      `${caps.maxInsertions - c.insertions} insertions`,
      `${caps.maxProposals - c.proposals} proposals`,
      `${caps.maxQuestions - c.questions} questions`,
    ].join(', ');
    return `Recorded ${TOOLS[tool].emits} ${id}. Left this session: ${left}.`;
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  private async handle(
    tool: ToolName,
    input: ToolInputs[ToolName],
  ): Promise<
    | Fail
    | Ok<{ kind: 'read'; content: string }>
    | Ok<{ kind: 'empty-search'; content: string }>
    | Ok<{ kind: 'draft'; id: string; draft: ToolEventDraft }>
  > {
    const sid = this.ctx.feedbackSessionId;
    const draft = <K extends ToolEventDraft['type']>(
      type: K,
      id: string,
      payload: EventPayloads[K],
    ) => ({
      ok: true as const,
      kind: 'draft' as const,
      id,
      draft: agentDraft(this.ctx, type, payload) as ToolEventDraft,
    });

    switch (tool) {
      case 'read_document': {
        const i = input as ToolInputs['read_document'];
        const doc = this.docs.get(i.documentId);
        if (!doc) return this.unknownDocument(i.documentId);
        return {
          ok: true,
          kind: 'read',
          content: doc.area === 'notes' ? renderPlain(doc) : renderSegmented(doc),
        };
      }
      case 'read_notes': {
        const i = input as ToolInputs['read_notes'];
        const ids =
          i.noteIds ??
          this.opts.snapshot.outline
            .filter((e) => e.kind === 'document' && e.area === 'notes')
            .map((e) => e.id);
        const parts: string[] = [];
        for (const id of ids) {
          const doc = this.docs.get(id);
          if (!doc || doc.area !== 'notes') {
            return fail('unknown-document', `No note ${id}. ${this.noteList()}`);
          }
          parts.push(renderPlain(doc));
        }
        return {
          ok: true,
          kind: 'read',
          content: parts.length ? parts.join('\n\n') : 'The project has no notes.',
        };
      }
      case 'get_outline':
        return {
          ok: true,
          kind: 'read',
          content: renderOutline(this.opts.snapshot.outline, (id) => {
            const d = this.docs.get(id);
            return d ? docWordCount(d.seg) : null;
          }),
        };
      case 'comment': {
        const i = input as ToolInputs['comment'];
        const t = this.resolveTarget(i.anchor, i.span);
        if (!t.ok) return t;
        const id = this.ctx.newId();
        return draft('CommentAdded', id, {
          commentId: id,
          feedbackSessionId: sid,
          target: t.target,
          category: i.category,
          severity: i.severity,
          body: i.body.trim(),
        });
      }
      case 'ask_question': {
        const i = input as ToolInputs['ask_question'];
        let target: Target | null = null;
        if (i.anchor) {
          const a = this.resolveAnchorIn(i.anchor);
          if (!a.ok) return a;
          target = { kind: 'anchor', ...a.resolved };
        }
        const id = this.ctx.newId();
        return draft('QuestionAsked', id, {
          questionId: id,
          feedbackSessionId: sid,
          target,
          question: i.question.trim(),
        });
      }
      case 'suggest_word_choice': {
        const i = input as ToolInputs['suggest_word_choice'];
        const a = this.resolveAnchorIn(i.anchor);
        if (!a.ok) return a;
        const id = this.ctx.newId();
        return draft('SuggestionProposed', id, {
          suggestionId: id,
          feedbackSessionId: sid,
          suggestion: {
            kind: 'word-choice',
            target: a.resolved,
            alternatives: i.alternatives.map((s) => s.trim()),
            rationale: i.rationale.trim(),
          },
        });
      }
      case 'suggest_insertion': {
        const i = input as ToolInputs['suggest_insertion'];
        const doc = this.annotatableDoc(i.documentId);
        if (!doc.ok) return doc;
        const p = resolveInsertionPoint(doc.doc.seg, i.position, i.sentenceId);
        if (!p.ok) return fail(p.error.code, `${p.error.message} ${RETRY_HINT}`);
        const scope = this.scopeCheck(doc.doc, p.pos, p.pos);
        if (scope) return scope;
        const id = this.ctx.newId();
        return draft('SuggestionProposed', id, {
          suggestionId: id,
          feedbackSessionId: sid,
          suggestion: {
            kind: 'insertion',
            target: {
              documentId: doc.doc.id,
              position: i.position,
              sentenceId: i.sentenceId,
              pos: p.pos,
              readVersion: doc.doc.version,
              version: doc.doc.version,
            },
            sentence: i.sentence.trim(),
            purpose: i.purpose.trim(),
          },
        });
      }
      case 'suggest_rephrase': {
        const i = input as ToolInputs['suggest_rephrase'];
        const a = this.resolveAnchorIn(i.anchor);
        if (!a.ok) return a;
        const bad = rephraseGuidanceViolation(i.guidance, a.sentenceText);
        if (bad) return fail('replacement-text', bad);
        const id = this.ctx.newId();
        return draft('SuggestionProposed', id, {
          suggestionId: id,
          feedbackSessionId: sid,
          suggestion: { kind: 'rephrase', target: a.resolved, guidance: i.guidance.trim() },
        });
      }
      case 'propose_move': {
        const i = input as ToolInputs['propose_move'];
        const doc = this.annotatableDoc(i.documentId);
        if (!doc.ok) return doc;
        const m = resolveMove(doc.doc.seg, { unit: i.unit, ids: i.ids }, i.destination);
        if (!m.ok) return fail(m.error.code, `${m.error.message} ${RETRY_HINT}`);
        const scope = this.scopeCheck(doc.doc, m.from, m.to);
        if (scope) return scope;
        const id = this.ctx.newId();
        return draft('MoveProposed', id, {
          proposalId: id,
          feedbackSessionId: sid,
          source: {
            span: { documentId: doc.doc.id, unit: i.unit, ids: i.ids },
            from: m.from,
            to: m.to,
            readVersion: doc.doc.version,
            version: doc.doc.version,
          },
          destination: { position: i.destination.position, id: i.destination.id, pos: m.insertAt },
          rationale: i.rationale.trim(),
        });
      }
      case 'propose_cut': {
        const i = input as ToolInputs['propose_cut'];
        const t = this.resolveTarget(i.anchor, i.span);
        if (!t.ok) return t;
        const id = this.ctx.newId();
        return draft('CutProposed', id, {
          proposalId: id,
          feedbackSessionId: sid,
          target: t.target,
          rationale: i.rationale.trim(),
        });
      }
      case 'propose_split': {
        const i = input as ToolInputs['propose_split'];
        const doc = this.annotatableDoc(i.documentId);
        if (!doc.ok) return doc;
        const r = resolveSplit(doc.doc.seg, i.paragraphId, i.sentenceId);
        if (!r.ok) return fail(r.error.code, `${r.error.message} ${RETRY_HINT}`);
        const scope = this.scopeCheck(doc.doc, r.pos, r.pos);
        if (scope) return scope;
        const id = this.ctx.newId();
        return draft('SplitProposed', id, {
          proposalId: id,
          feedbackSessionId: sid,
          documentId: doc.doc.id,
          paragraphId: i.paragraphId,
          sentenceId: i.sentenceId,
          pos: r.pos,
          readVersion: doc.doc.version,
          version: doc.doc.version,
          rationale: i.rationale.trim(),
        });
      }
      case 'propose_merge': {
        const i = input as ToolInputs['propose_merge'];
        const doc = this.annotatableDoc(i.documentId);
        if (!doc.ok) return doc;
        const r = resolveMerge(doc.doc.seg, i.firstParagraphId, i.secondParagraphId);
        if (!r.ok) return fail(r.error.code, `${r.error.message} ${RETRY_HINT}`);
        const scope = this.scopeCheck(doc.doc, r.first.pos, r.second.end);
        if (scope) return scope;
        const id = this.ctx.newId();
        return draft('MergeProposed', id, {
          proposalId: id,
          feedbackSessionId: sid,
          documentId: doc.doc.id,
          firstParagraphId: i.firstParagraphId,
          secondParagraphId: i.secondParagraphId,
          joinPos: r.joinPos,
          from: r.first.pos,
          to: r.second.end,
          readVersion: doc.doc.version,
          version: doc.doc.version,
          rationale: i.rationale.trim(),
        });
      }
      case 'flag_citation_needed': {
        const i = input as ToolInputs['flag_citation_needed'];
        const a = this.resolveAnchorIn(i.anchor);
        if (!a.ok) return a;
        const id = this.ctx.newId();
        return draft('CitationNeededFlagged', id, {
          flagId: id,
          feedbackSessionId: sid,
          target: a.resolved,
          claim: i.claim.trim(),
        });
      }
      case 'search_sources': {
        const i = input as ToolInputs['search_sources'];
        let target: ResolvedAnchor | null = null;
        if (i.anchor) {
          const a = this.resolveAnchorIn(i.anchor);
          if (!a.ok) return a;
          target = a.resolved;
        }
        if (!this.opts.search) {
          return fail(
            'search-unavailable',
            'Source search is not available in this session. Use flag_citation_needed instead.',
          );
        }
        let items: unknown[];
        try {
          items = await this.opts.search.search(i.query.trim(), BOUNDS.searchMaxCandidates);
        } catch (e) {
          return fail(
            'search-unavailable',
            `Source search failed (${e instanceof Error ? e.message : String(e)}). Try a different query later, or use flag_citation_needed.`,
          );
        }
        const candidates = toCandidates(items);
        if (candidates.length === 0) {
          return {
            ok: true,
            kind: 'empty-search',
            content: 'No candidate sources found. Try a more specific query, or flag the claim.',
          };
        }
        const id = this.ctx.newId();
        const d = draft('SourceSurfaced', id, {
          surfacedId: id,
          feedbackSessionId: sid,
          query: i.query.trim(),
          target,
          candidates,
        });
        return d;
      }
      case 'suggest_source': {
        const i = input as ToolInputs['suggest_source'];
        const a = this.resolveAnchorIn(i.anchor);
        if (!a.ok) return a;
        if (!this.opts.snapshot.sources[i.sourceId]) {
          const known = Object.values(this.opts.snapshot.sources)
            .slice(0, 30)
            .map((s) => `${s.id} (${s.csl.title ?? 'untitled'})`);
          return fail(
            'unknown-source',
            `No library source ${i.sourceId}. ${known.length ? `Library: ${known.join('; ')}.` : 'The library is empty.'}`,
          );
        }
        const id = this.ctx.newId();
        return draft('SourceSuggested', id, {
          sourceSuggestionId: id,
          feedbackSessionId: sid,
          target: a.resolved,
          sourceId: i.sourceId,
          rationale: i.rationale.trim(),
        });
      }
      case 'answer_discussion': {
        const i = input as ToolInputs['answer_discussion'];
        const thread = this.opts.snapshot.discussion;
        if (!thread || thread.threadId !== i.threadId) {
          return fail(
            'unknown-thread',
            thread
              ? `Answer thread ${thread.threadId}; ${i.threadId} is not part of this session.`
              : 'This session has no discussion thread to answer.',
          );
        }
        return draft('DiscussAnswered', thread.threadId, {
          feedbackSessionId: sid,
          threadId: thread.threadId,
          targetId: thread.targetId,
          body: i.body.trim(),
        });
      }
      case 'reply': {
        const i = input as ToolInputs['reply'];
        const chat = this.opts.snapshot.chat;
        if (!chat) return fail('unknown-thread', 'This session has no chat to reply in.');
        return draft('ChatReplied', sid, {
          feedbackSessionId: sid,
          chatId: chat.chatId,
          replyTo: chat.messageId,
          body: i.body.trim(),
        });
      }
      case 'finish_review': {
        const i = input as ToolInputs['finish_review'];
        return draft('ReviewFinished', sid, {
          feedbackSessionId: sid,
          summary: i.summary.trim(),
          strengths: i.strengths.map((s) => s.trim()),
          topPriorities: i.topPriorities.map((s) => s.trim()),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Resolution and scope
  // -------------------------------------------------------------------------

  /** Id-like words the writer actually wrote (a gene called p53), which prose may mention. */
  private idLikeWordsInText(): Set<string> {
    if (this.manuscriptTokens) return this.manuscriptTokens;
    const tokens = new Set<string>();
    for (const id of Object.keys(this.opts.snapshot.documents)) {
      const doc = this.docs.get(id);
      for (const b of doc?.seg.blocks ?? []) for (const t of idTokens(b.text)) tokens.add(t);
    }
    this.manuscriptTokens = tokens;
    return tokens;
  }

  private documentList(): string {
    const docs = this.opts.snapshot.outline.filter(
      (e) => e.kind === 'document' && e.area === 'manuscript',
    );
    return docs.length
      ? `Manuscript documents: ${docs.map((d) => `${d.id} (${d.title})`).join('; ')}.`
      : 'The project has no manuscript documents.';
  }

  private noteList(): string {
    const notes = this.opts.snapshot.outline.filter(
      (e) => e.kind === 'document' && e.area === 'notes',
    );
    return notes.length
      ? `Notes: ${notes.map((d) => `${d.id} (${d.title})`).join('; ')}.`
      : 'The project has no notes.';
  }

  private unknownDocument(id: string): Fail {
    return fail('unknown-document', `No document ${id}. ${this.documentList()}`);
  }

  /** A manuscript document the session may annotate. */
  private annotatableDoc(id: string): Fail | Ok<{ doc: LoadedDocument }> {
    const doc = this.docs.get(id);
    if (!doc) return this.unknownDocument(id);
    if (doc.area !== 'manuscript') {
      return fail(
        'out-of-scope',
        `${id} is a note. Notes are context only; annotate manuscript text. ${this.documentList()}`,
      );
    }
    const scope = this.opts.snapshot.scope;
    if (scope.kind === 'none') {
      return fail('tool-not-allowed', 'This session cannot annotate text.');
    }
    if (scope.kind !== 'project' && scope.documentId !== id) {
      const target = this.docs.get(scope.documentId);
      return fail(
        'out-of-scope',
        `This review covers only document ${scope.documentId}${target ? ` (${target.title})` : ''}. Anchor to text in it.`,
      );
    }
    return { ok: true, doc };
  }

  /** Checks a resolved range against a selection scope. */
  private scopeCheck(doc: LoadedDocument, from: number, to: number): Fail | null {
    const scope = this.opts.snapshot.scope;
    if (scope.kind !== 'selection') return null;
    if (from <= scope.to && to >= scope.from) return null;
    const inSel = doc.seg.sentences.filter((s) => s.from <= scope.to && s.to >= scope.from);
    const range = inSel.length
      ? `sentences ${inSel[0]?.id}${inSel.length > 1 ? `–${inSel[inSel.length - 1]?.id}` : ''}`
      : 'no complete sentence';
    return fail(
      'out-of-scope',
      `That target is outside the selection under review (${range}). Anchor to text inside the selection.`,
    );
  }

  private resolveAnchorIn(
    anchor: AnchorInput,
  ): Fail | Ok<{ resolved: ResolvedAnchor; sentenceText: string }> {
    const doc = this.annotatableDoc(anchor.documentId);
    if (!doc.ok) return doc;
    const r = resolveAnchor(doc.doc.seg, anchor);
    if (!r.ok) return fail(r.error.code, `${r.error.message} ${RETRY_HINT}`);
    const scope = this.scopeCheck(doc.doc, r.from, r.to);
    if (scope) return scope;
    return {
      ok: true,
      resolved: {
        anchor: r.anchor,
        from: r.from,
        to: r.to,
        readVersion: doc.doc.version,
        version: doc.doc.version,
      },
      sentenceText: r.sentence.text,
    };
  }

  private resolveTarget(
    anchor: AnchorInput | undefined,
    span: SpanRef | undefined,
  ): Fail | Ok<{ target: Target }> {
    if (anchor) {
      const a = this.resolveAnchorIn(anchor);
      if (!a.ok) return a;
      return { ok: true, target: { kind: 'anchor', ...a.resolved } };
    }
    if (!span) return fail('invalid-arguments', 'Pass exactly one of anchor or span.');
    const doc = this.annotatableDoc(span.documentId);
    if (!doc.ok) return doc;
    const r = resolveSpan(doc.doc.seg, span);
    if (!r.ok) return fail(r.error.code, `${r.error.message} ${RETRY_HINT}`);
    const scope = this.scopeCheck(doc.doc, r.from, r.to);
    if (scope) return scope;
    return {
      ok: true,
      target: {
        kind: 'span',
        span: { documentId: span.documentId, unit: span.unit, ids: span.ids },
        from: r.from,
        to: r.to,
        readVersion: doc.doc.version,
        version: doc.doc.version,
      },
    };
  }
}
