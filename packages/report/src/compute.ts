/**
 * `computeReport`: the authorship report (F7), derived from the ledger alone.
 *
 * Pure and deterministic: the same commits (and witnesses) give byte-identical
 * canonical JSON in Node and in browsers, so a verifier can recompute the report
 * and compare. No `Date.now`, no `Intl`, no locale or time-zone APIs.
 *
 * What each part counts:
 *
 * - **Words and characters** count the text as it stands now, with the shared
 *   least-trusted-class rule (`projectWordsByClass` / `wordsByClass` in
 *   `@longhand/ledger`). A project report counts the non-archived manuscript
 *   documents; a document report counts that one document.
 * - **Process figures** (active time, sessions, AI activity, pastes, imports)
 *   count the history. A project report counts the whole project, notes and
 *   archived documents included, so it never leaves anything out. A document
 *   report counts what happened to that document: its edits, pastes and imports,
 *   its annotations, feedback requests whose scope is that document or the whole
 *   project, and Discuss threads about its annotations.
 */
import {
  applyCommit,
  attributeWords,
  charactersByClass,
  documentProvenance,
  emptyState,
  projectCharactersByClass,
  projectState,
  projectWordsByClass,
  wordsByClass,
  type ClassCounts,
} from '@longhand/ledger';
import {
  PROVES_TABLE,
  REPORT_VERSION,
  SESSION_GAP_MS,
  targetDocumentId,
  type Commit,
  type DocumentState,
  type MatchedKind,
  type ProjectState,
  type ReportScope,
  type Target,
  type Witness,
  type WritingSession,
} from '@longhand/schema';
import { disclosureStatement } from './disclosure';
import { utcDay } from './format';
import {
  ASSISTED_KINDS,
  type AssistedKind,
  type Report,
  type ReportAiSession,
  type ReportExtensions,
  type SuggestionOutcomeCounts,
} from './types';
import { UNWITNESSED_LAG_MS, unwitnessedIntervals } from './unwitnessed';

/** Options for {@link computeReport}. */
export interface ComputeReportOptions {
  /** What the report covers: the project, or one document (`{ documentId }` is shorthand). */
  scope: ReportScope | 'project' | { documentId: string };
  /** The bundle's witnesses; commits without one are reported as unwitnessed. */
  witnesses?: readonly Witness[];
}

/** Normalizes the scope shorthands. */
export function normalizeScope(scope: ComputeReportOptions['scope']): ReportScope {
  if (scope === 'project') return { kind: 'project' };
  if (!('kind' in scope)) return { kind: 'document', documentId: scope.documentId };
  return scope.kind === 'project'
    ? { kind: 'project' }
    : { kind: 'document', documentId: scope.documentId };
}

/** A manuscript commit, for writing sessions (same rules as the fold's). */
export interface SessionEntry {
  seq: number;
  timeMs: number;
  clientTime: string;
  durationMs: number;
  characters: number;
  documentId: string;
}

/** Text characters inserted by a TextEdited's steps (the fold's `charactersInserted`). */
function insertedTextCharacters(steps: readonly unknown[]): number {
  let n = 0;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const o = node as { type?: unknown; text?: unknown; content?: unknown };
    if (o.type === 'text' && typeof o.text === 'string') n += o.text.length;
    if (Array.isArray(o.content)) o.content.forEach(walk);
  };
  for (const s of steps) {
    const step = s as { stepType?: unknown; slice?: { content?: unknown } };
    if ((step.stepType === 'replace' || step.stepType === 'replaceAround') && step.slice) {
      if (Array.isArray(step.slice.content)) step.slice.content.forEach(walk);
    }
  }
  return n;
}

/** Writing sessions from manuscript commits: a gap of 30 minutes or more starts a new one. */
export function sessionsFrom(entries: readonly SessionEntry[]): WritingSession[] {
  const sorted = [...entries].sort((a, b) => a.timeMs - b.timeMs || a.seq - b.seq);
  const out: WritingSession[] = [];
  let prev: SessionEntry | null = null;
  let endMs = 0;
  for (const e of sorted) {
    const last = out[out.length - 1];
    if (last && prev && e.timeMs - prev.timeMs < SESSION_GAP_MS) {
      endMs = Math.max(endMs, e.timeMs + e.durationMs);
      last.endSeq = e.seq;
      last.endTime = new Date(endMs).toISOString();
      last.activeMs += e.durationMs;
      last.commits += 1;
      last.charactersInserted += e.characters;
      if (!last.documentIds.includes(e.documentId)) last.documentIds.push(e.documentId);
    } else {
      endMs = e.timeMs + e.durationMs;
      out.push({
        index: out.length,
        startSeq: e.seq,
        endSeq: e.seq,
        startTime: e.clientTime,
        endTime: new Date(endMs).toISOString(),
        activeMs: e.durationMs,
        commits: 1,
        charactersInserted: e.characters,
        documentIds: [e.documentId],
      });
    }
    prev = e;
  }
  return out;
}

/** Distinct UTC calendar days touched by any session (start day through end day). */
function sessionDays(sessions: readonly WritingSession[]): number {
  const days = new Set<string>();
  for (const s of sessions) {
    let t = Date.parse(`${utcDay(s.startTime)}T00:00:00.000Z`);
    const end = Date.parse(s.endTime);
    while (t <= end) {
      days.add(utcDay(new Date(t).toISOString()));
      t += 86_400_000;
    }
  }
  return days.size;
}

function emptyOutcomes(): SuggestionOutcomeCounts {
  return { open: 0, adopted: 0, adapted: 0, stale: 0, dismissed: 0 };
}

function emptyProposalOutcomes() {
  return { proposed: 0, accepted: 0, rejected: 0, stale: 0, open: 0 };
}

function commitDocumentId(c: Commit): string | null {
  const id = (c.payload as { documentId?: unknown }).documentId;
  return typeof id === 'string' ? id : null;
}

function sortedValues<T extends { seq: number; id: string }>(rec: Record<string, T>): T[] {
  return Object.values(rec).sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1));
}

/** Which document an annotation belongs to, for document reports (null: project-level). */
function annotationDocuments(ps: ProjectState) {
  const ann = ps.annotations;
  const requestDoc = (sessionId: string): string | null => {
    const session = ann.agentSessions[sessionId];
    const req = session?.requestId ? ann.feedbackRequests[session.requestId] : undefined;
    return req && req.scope.kind !== 'project' ? req.scope.documentId : null;
  };
  const ofTarget = (t: Target | null, sessionId: string): string | null =>
    t ? targetDocumentId(t) : requestDoc(sessionId);
  const byId = new Map<string, string | null>();
  for (const a of Object.values(ann.comments))
    byId.set(a.id, ofTarget(a.target, a.feedbackSessionId));
  for (const a of Object.values(ann.questions))
    byId.set(a.id, ofTarget(a.target, a.feedbackSessionId));
  for (const a of Object.values(ann.suggestions))
    byId.set(a.id, a.kind === 'insertion' ? a.documentId : a.anchor.documentId);
  for (const a of Object.values(ann.proposals)) byId.set(a.id, a.documentId);
  for (const a of Object.values(ann.citationFlags))
    byId.set(a.id, ofTarget(a.target, a.feedbackSessionId));
  for (const a of Object.values(ann.surfacedSources))
    byId.set(a.id, ofTarget(a.target, a.feedbackSessionId));
  for (const a of Object.values(ann.sourceSuggestions))
    byId.set(a.id, ofTarget(a.target, a.feedbackSessionId));
  const threadDoc = (threadId: string): string | null => {
    const t = ann.discussions[threadId];
    return t ? (byId.get(t.targetId) ?? null) : null;
  };
  return { of: (id: string) => byId.get(id) ?? null, threadDoc };
}

/**
 * Folds the ledger once, collecting what the public state does not keep per
 * commit: writing-session entries (so a document report can rebuild its own
 * sessions with the fold's rules) and the clippings each TextEdited placed.
 */
export function foldForReport(commits: readonly Commit[]) {
  let state = emptyState();
  const entries: SessionEntry[] = [];
  const clippingSourcesBySeq = new Map<number, string[]>();
  for (const c of commits) {
    state = applyCommit(state, c);
    if (c.type === 'TextEdited') {
      entries.push({
        seq: c.seq,
        timeMs: Date.parse(c.clientTime),
        clientTime: c.clientTime,
        durationMs: c.payload.durationMs,
        characters: insertedTextCharacters(c.payload.steps),
        documentId: c.payload.documentId,
      });
      const clippings = c.payload.runs.flatMap((r) => (r.clippingId ? [r.clippingId] : []));
      if (clippings.length > 0) clippingSourcesBySeq.set(c.seq, clippings);
    } else if (c.type === 'ProposalAccepted') {
      const p = projectState(state).annotations.proposals[c.payload.proposalId];
      if (p?.status === 'accepted' && p.resolvedSeq === c.seq) {
        let chars = 0;
        for (const r of documentProvenance(state, c.payload.documentId) ?? [])
          if (r.originSeq === c.seq) chars += r.to - r.from;
        entries.push({
          seq: c.seq,
          timeMs: Date.parse(c.clientTime),
          clientTime: c.clientTime,
          durationMs: 0,
          characters: chars,
          documentId: c.payload.documentId,
        });
      }
    }
  }
  return { state, entries, clippingSourcesBySeq };
}

/**
 * Computes the authorship report for a ledger. `commits` must be the whole
 * ledger, seq 1…n, as the verifier has checked it; throws (a `FoldError`) when
 * the ledger does not fold, and an `Error` for an unknown document scope.
 */
export function computeReport(commits: readonly Commit[], opts: ComputeReportOptions): Report {
  if (commits.length === 0) throw new Error('computeReport: the ledger has no commits');
  const scope = normalizeScope(opts.scope);
  const docScope = scope.kind === 'document' ? scope.documentId : null;
  const inScope = (documentId: string | null): boolean =>
    docScope === null || documentId === docScope;

  const { state, entries, clippingSourcesBySeq } = foldForReport(commits);
  const ps = projectState(state);
  const head = commits[commits.length - 1] as Commit;

  // --- Words and characters ------------------------------------------------
  let countedDocs: DocumentState[];
  let words: ClassCounts;
  let characters: ClassCounts;
  if (docScope === null) {
    countedDocs = Object.keys(ps.documents)
      .sort()
      .map((id) => ps.documents[id] as DocumentState)
      .filter((d) => d.kind === 'manuscript' && !d.archived);
    words = projectWordsByClass(ps);
    characters = projectCharactersByClass(ps);
  } else {
    const doc = ps.documents[docScope];
    if (!doc) throw new Error(`computeReport: no document ${docScope} in this ledger`);
    countedDocs = [doc];
    words = wordsByClass(doc.content, doc.provenance);
    characters = charactersByClass(doc.content, doc.provenance);
  }

  // AI texts behind retyped words, and sources behind quoted words.
  const assistedIds = new Map<string, AssistedKind>();
  const quotedSources = new Set<string>();
  const documents: ReportExtensions['documents'] = [];
  for (const d of countedDocs) {
    const kindOf = new Map<string, MatchedKind>();
    for (const r of d.provenance)
      if (r.suggestionId && r.matchedKind) kindOf.set(r.suggestionId, r.matchedKind);
    const attributed = attributeWords(d.content, d.provenance);
    documents.push({ id: d.id, title: d.title, kind: d.kind, words: attributed.length });
    for (const w of attributed) {
      if (w.class === 'typed-from-suggestion') {
        for (const id of w.suggestionIds ?? []) {
          const mk = kindOf.get(id);
          if (!mk) continue;
          let kind: AssistedKind;
          if (mk === 'suggestion') {
            const s = ps.annotations.suggestions[id];
            kind = s?.kind === 'rephrase' ? 'rephrase' : 'word-choice';
          } else kind = mk;
          assistedIds.set(`${kind}:${id}`, kind);
        }
      } else if (w.class === 'quoted') {
        for (const seq of w.originSeqs) {
          for (const clippingId of clippingSourcesBySeq.get(seq) ?? []) {
            const clip = ps.clippings[clippingId];
            if (clip) quotedSources.add(clip.sourceId);
          }
        }
      }
    }
  }
  const assistedByKind = Object.fromEntries(ASSISTED_KINDS.map((k) => [k, 0])) as Record<
    AssistedKind,
    number
  >;
  for (const kind of assistedIds.values()) assistedByKind[kind] += 1;

  // --- Time and sessions ---------------------------------------------------
  const scopedEntries = entries.filter((e) => inScope(e.documentId));
  const sessions = docScope === null ? ps.writingSessions : sessionsFrom(scopedEntries);
  let activeWritingMs = 0;
  for (const c of commits)
    if (c.type === 'TextEdited' && inScope(c.payload.documentId))
      activeWritingMs += c.payload.durationMs;

  // --- AI activity ---------------------------------------------------------
  const ann = ps.annotations;
  const docs = annotationDocuments(ps);
  const annInScope = (id: string) => docScope === null || docs.of(id) === docScope;
  const requests = Object.values(ann.feedbackRequests)
    .filter(
      (r) => docScope === null || r.scope.kind === 'project' || r.scope.documentId === docScope,
    )
    .sort((a, b) => a.seq - b.seq);
  const requestIds = new Set(requests.map((r) => r.id));
  const threads = Object.values(ann.discussions).filter(
    (t) => docScope === null || docs.threadDoc(t.id) === docScope,
  );
  const threadIds = new Set(threads.map((t) => t.id));
  const aiSessions = Object.values(ann.agentSessions)
    .filter(
      (s) =>
        docScope === null ||
        (s.requestId !== null && requestIds.has(s.requestId)) ||
        (s.threadId !== null && threadIds.has(s.threadId)),
    )
    .sort((a, b) => a.startedSeq - b.startedSeq);
  const sessionList: ReportAiSession[] = aiSessions.map((s) => {
    const req = s.requestId ? ann.feedbackRequests[s.requestId] : undefined;
    return {
      id: s.id,
      kind: s.kind,
      model: s.model,
      systemPromptVersion: s.systemPromptVersion,
      status: s.status,
      startedAt: s.startedAt,
      startedSeq: s.startedSeq,
      requestId: s.requestId,
      threadId: s.threadId,
      lenses: req ? [...req.lenses] : null,
      intensity: req ? req.intensity : null,
      scope: req ? req.scope.kind : null,
      annotations: s.annotationIds.length,
      failureReason: s.failureReason,
    };
  });
  const countIn = (rec: Record<string, { id: string }>) =>
    Object.values(rec).filter((a) => annInScope(a.id)).length;

  // --- Suggestions and proposals -------------------------------------------
  const suggestionsByKind = {
    'word-choice': emptyOutcomes(),
    insertion: emptyOutcomes(),
    rephrase: emptyOutcomes(),
  };
  const byOutcome = emptyOutcomes();
  const byKindTotals = { 'word-choice': 0, insertion: 0, rephrase: 0 };
  let suggestionTotal = 0;
  for (const s of sortedValues(ann.suggestions)) {
    if (!annInScope(s.id)) continue;
    suggestionTotal += 1;
    byKindTotals[s.kind] += 1;
    byOutcome[s.status] += 1;
    suggestionsByKind[s.kind][s.status] += 1;
  }
  const proposalsByKind = {
    move: emptyProposalOutcomes(),
    cut: emptyProposalOutcomes(),
    split: emptyProposalOutcomes(),
    merge: emptyProposalOutcomes(),
  };
  const moves = {
    sentence: { proposed: 0, accepted: 0 },
    paragraph: { proposed: 0, accepted: 0 },
    section: { proposed: 0, accepted: 0 },
  };
  let proposalTotal = 0;
  for (const p of sortedValues(ann.proposals)) {
    if (!annInScope(p.id)) continue;
    proposalTotal += 1;
    const k = proposalsByKind[p.kind];
    k.proposed += 1;
    k[p.status] += 1;
    if (p.kind === 'move') {
      moves[p.span.unit].proposed += 1;
      if (p.status === 'accepted') moves[p.span.unit].accepted += 1;
    }
  }

  // --- Pastes and imports --------------------------------------------------
  const clientTimeOf = (seq: number) => (commits[seq - 1] as Commit).clientTime;
  const pasteEvents = sortedValues(ps.pastes)
    .filter((p) => inScope(p.documentId))
    .map((p) => ({
      seq: p.seq,
      time: clientTimeOf(p.seq),
      documentId: p.documentId,
      origin: p.origin,
      via: p.via,
      characters: p.characters,
      words: p.words,
      id: p.id,
      insertedSeq: p.insertedSeq,
      verifiedInternal: p.verifiedInternal,
    }));
  const pasteTotals = (origin: 'external' | 'internal') => {
    const list = pasteEvents.filter((p) => p.origin === origin);
    return {
      count: list.length,
      characters: list.reduce((n, p) => n + p.characters, 0),
      words: list.reduce((n, p) => n + p.words, 0),
    };
  };
  const imports: ReportExtensions['imports'] = [];
  for (const c of commits) {
    if (c.type !== 'DocumentImported' || !inScope(c.payload.documentId)) continue;
    imports.push({
      seq: c.seq,
      documentId: c.payload.documentId,
      title: c.payload.title,
      sourceFormat: c.payload.sourceFormat,
      sourceName: c.payload.sourceName,
      words: wordsByClass(c.payload.content, []).total,
      clientTime: c.clientTime,
    });
  }

  // --- Unwitnessed intervals ----------------------------------------------
  const unwitnessed = unwitnessedIntervals(commits, {
    ...(opts.witnesses ? { witnesses: opts.witnesses } : {}),
    include: (c) => docScope === null || commitDocumentId(c) === docScope,
  });

  const report: Omit<Report, 'disclosure'> = {
    reportVersion: REPORT_VERSION,
    scope,
    throughSeq: head.seq,
    headHash: head.hash,
    words: { total: words.total, byClass: { ...words.byClass } },
    characters: { total: characters.total, byClass: { ...characters.byClass } },
    activeWritingMs,
    sessions: {
      count: sessions.length,
      days: sessionDays(sessions),
      firstAt: sessions[0]?.startTime ?? null,
      lastAt:
        sessions.length > 0 ? sessions.reduce((m, s) => (s.endTime > m ? s.endTime : m), '') : null,
      list: sessions.map((s) => ({
        startTime: s.startTime,
        endTime: s.endTime,
        activeMs: s.activeMs,
        charactersInserted: s.charactersInserted,
        startSeq: s.startSeq,
        endSeq: s.endSeq,
        commits: s.commits,
        documentIds: [...s.documentIds],
      })),
    },
    ai: {
      feedbackRequests: requests.length,
      sessionsFinished: aiSessions.filter((s) => s.status === 'finished').length,
      sessionsFailed: aiSessions.filter((s) => s.status === 'failed').length,
      comments: countIn(ann.comments),
      questions: countIn(ann.questions),
      citationFlags: countIn(ann.citationFlags),
      surfacedSources: countIn(ann.surfacedSources),
      sourceSuggestions: countIn(ann.sourceSuggestions),
      discussThreads: threads.length,
      sessions: sessionList,
    },
    suggestions: { total: suggestionTotal, byKind: byKindTotals, byOutcome },
    proposals: { total: proposalTotal, byKind: proposalsByKind },
    pastes: {
      external: pasteTotals('external'),
      internal: pasteTotals('internal'),
      events: pasteEvents,
    },
    imports: { documents: imports.length, words: imports.reduce((n, i) => n + i.words, 0) },
    unwitnessed: unwitnessed.map((u) => ({ ...u })),
    provesTable: { proves: [...PROVES_TABLE.proves], doesNotProve: [...PROVES_TABLE.doesNotProve] },
    extensions: {
      unwitnessedThresholdMs: UNWITNESSED_LAG_MS,
      projectTitle: ps.settings.title,
      documents,
      assisted: { annotations: assistedIds.size, byKind: assistedByKind },
      quoted: { sources: quotedSources.size },
      suggestions: { byKind: suggestionsByKind },
      proposals: { moves },
      imports,
    },
  };
  return { ...report, disclosure: disclosureStatement(report) } as Report;
}
