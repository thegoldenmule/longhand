/**
 * A scripted stand-in for the agent runner, for the demo page: when the writer
 * sends a chat message, asks for feedback or discusses a card it replays a short session into a
 * {@link FoldingTransport} — agent annotation events with anchors resolved against
 * the current document, a `finish_review` summary or a discuss answer — with
 * delays, and reports `SessionProgressEvent`-shaped progress like the real runner.
 * It never emits a manuscript event.
 */
import { documentNode } from '@longhand/ledger';
import {
  SCHEMA_VERSION,
  resolveAnchor,
  segmentDoc,
  type Commit,
  type CommitDraft,
  type EventPayloads,
  type EventType,
  type PMNode,
} from '@longhand/schema';
import type { ReviewProgressEvent } from '../src/progress';
import type { FoldingTransport } from './foldingTransport';

/** Options for {@link MockReviewer}. */
export interface MockReviewerOptions {
  /** Delay between steps, ms. Default 450. */
  stepMs?: number;
  model?: string;
  /** Fail reviews (with a calm reason) instead of finishing them. */
  fail?: () => boolean;
  /** Agent-shaped progress: every event names its session, like the runner's. */
  onProgress?: (event: ReviewProgressEvent) => void;
  newId?: () => string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Replays scripted sessions for feedback requests and discuss messages. */
export class MockReviewer {
  private readonly unsub: () => void;
  private counter = 0;

  constructor(
    private readonly transport: FoldingTransport,
    private readonly opts: MockReviewerOptions = {},
  ) {
    this.unsub = transport.onCommit((c) => {
      if (c.type === 'FeedbackRequested') void this.review(c);
      if (c.type === 'DiscussRequested') void this.answer(c);
      if (c.type === 'ChatMessageSent') void this.chat(c);
    });
  }

  private readonly cancelled = new Set<string>();

  /** Stops a running session (the chat's Stop): it fails as cancelled. */
  cancel(feedbackSessionId: string): void {
    this.cancelled.add(feedbackSessionId);
  }

  /** True once cancelled; records the failure the first time it is seen. */
  private stopped(sessionId: string): boolean {
    if (!this.cancelled.has(sessionId)) return false;
    if (this.cancelled.delete(sessionId)) {
      const reason = 'the session was cancelled';
      this.transport.append(
        this.draft(
          'FeedbackSessionFailed',
          { feedbackSessionId: sessionId, requestId: null, threadId: null, reason },
          sessionId,
          'system',
        ),
      );
      this.progress({ kind: 'failed', feedbackSessionId: sessionId, reason });
    }
    return true;
  }

  destroy(): void {
    this.unsub();
  }

  private id(prefix: string): string {
    this.counter += 1;
    return this.opts.newId?.() ?? `${prefix}-${Date.now().toString(36)}-${this.counter}`;
  }

  private draft<K extends EventType>(
    type: K,
    payload: EventPayloads[K],
    sessionId: string,
    actor: 'agent' | 'system' = 'agent',
  ): CommitDraft {
    return {
      commitId: this.id('c'),
      projectId: this.transport.projectState().projectId,
      clientTime: new Date().toISOString(),
      actor:
        actor === 'agent'
          ? { kind: 'agent', id: this.opts.model ?? 'opus' }
          : { kind: 'system', id: 'agent-runner' },
      deviceId: 'server',
      sessionId: actor === 'agent' ? sessionId : 'system',
      type,
      schemaVersion: SCHEMA_VERSION,
      payload,
    } as unknown as CommitDraft;
  }

  private progress(event: ReviewProgressEvent): void {
    this.opts.onProgress?.(event);
  }

  private emit<K extends EventType>(
    type: K,
    payload: EventPayloads[K],
    sessionId: string,
  ): boolean {
    const r = this.transport.append(this.draft(type, payload, sessionId));
    if (r.status !== 'ack') {
      console.warn('[mock reviewer] rejected', type, r);
      return false;
    }
    this.progress({
      kind: 'annotation',
      feedbackSessionId: sessionId,
      seq: r.seq,
      draft: { type, sessionId, payload },
    });
    return true;
  }

  private tool(name: string, sessionId: string): void {
    this.progress({
      kind: 'model',
      feedbackSessionId: sessionId,
      event: { type: 'tool-call', id: this.id('t'), name: `mcp__longhand__${name}`, input: {} },
    });
  }

  private target(
    doc: PMNode,
    documentId: string,
    version: number,
    sentenceId: string,
    quote: string,
  ) {
    const r = resolveAnchor(doc, { documentId, sentenceId, quote });
    if (!r.ok) return null;
    return { anchor: r.anchor, from: r.from, to: r.to, readVersion: version, version };
  }

  /** Leaves a comment on the first sentence and a question on the last. */
  private async notes(sessionId: string, documentId: string | null, lens: string): Promise<void> {
    const step = this.opts.stepMs ?? 450;
    const state = this.transport.projectState();
    const doc = documentId ? documentNode(this.transport.state, documentId) : undefined;
    const version = documentId ? (state.documents[documentId]?.version ?? 0) : 0;
    const sentences = doc ? segmentDoc(doc).sentences : [];
    const first = sentences[0];
    const last = sentences[sentences.length - 1];
    if (doc && documentId && first) {
      this.tool('comment', sessionId);
      await sleep(step);
      if (this.stopped(sessionId)) return;
      const words = first.text.split(/\s+/).filter(Boolean);
      const quote = words
        .slice(0, Math.min(4, words.length))
        .join(' ')
        .replace(/[.,;:!?]+$/, '');
      const t = quote ? this.target(doc, documentId, version, first.id, quote) : null;
      if (t)
        this.emit(
          'CommentAdded',
          {
            commentId: this.id('com'),
            feedbackSessionId: sessionId,
            target: { kind: 'anchor', ...t },
            category: lens as 'clarity',
            severity: 'minor',
            body: 'The opening is doing quiet work here; let the reader feel the weather before the plot.',
          },
          sessionId,
        );
    }
    if (doc && documentId && last && last !== first) {
      this.tool('ask_question', sessionId);
      await sleep(step);
      if (this.stopped(sessionId)) return;
      const words = last.text.split(/\s+/).filter(Boolean);
      const quote = words
        .slice(0, Math.min(3, words.length))
        .join(' ')
        .replace(/[.,;:!?]+$/, '');
      const t = quote ? this.target(doc, documentId, version, last.id, quote) : null;
      if (t)
        this.emit(
          'QuestionAsked',
          {
            questionId: this.id('q'),
            feedbackSessionId: sessionId,
            target: { kind: 'anchor', ...t },
            question: 'What should the reader carry out of this ending: relief or unease?',
          },
          sessionId,
        );
    }
  }

  /**
   * A chat reply: notes first when the message contains "review", then the
   * reply. "fail" in the message (or `fail`) fails the session; Stop cancels it.
   */
  private async chat(c: Extract<Commit, { type: 'ChatMessageSent' }>): Promise<void> {
    const step = this.opts.stepMs ?? 450;
    const m = c.payload;
    const sessionId = this.id('fs');
    await sleep(step / 2);
    const model = 'sonnet';
    const started = this.transport.append(
      this.draft(
        'FeedbackSessionStarted',
        {
          feedbackSessionId: sessionId,
          trigger: { kind: 'chat', chatId: m.chatId, messageId: m.messageId },
          model,
        },
        sessionId,
      ),
    );
    if (started.status !== 'ack') return;
    this.progress({ kind: 'started', feedbackSessionId: sessionId, model, seq: started.seq });
    this.tool('read_document', sessionId);
    await sleep(step);
    if (this.stopped(sessionId)) return;
    if (this.opts.fail?.() || m.text.toLowerCase().includes('fail')) {
      const reason = 'the model timed out';
      this.transport.append(
        this.draft(
          'FeedbackSessionFailed',
          { feedbackSessionId: sessionId, requestId: null, threadId: null, reason },
          sessionId,
          'system',
        ),
      );
      this.progress({ kind: 'failed', feedbackSessionId: sessionId, reason });
      return;
    }
    const review = /\breview\b/i.test(m.text);
    if (review) {
      const state = this.transport.projectState();
      const scope = m.context.scope;
      const documentId =
        scope.kind === 'project'
          ? (state.binder.manuscript.find((r) => r.kind === 'document')?.id ?? null)
          : scope.documentId;
      await this.notes(sessionId, documentId, m.lenses[0] ?? 'clarity');
      if (this.cancelled.has(sessionId) || this.stopped(sessionId)) return;
    }
    this.tool('reply', sessionId);
    await sleep(step);
    if (this.stopped(sessionId)) return;
    this.emit(
      'ChatReplied',
      {
        feedbackSessionId: sessionId,
        chatId: m.chatId,
        replyTo: m.messageId,
        body: m.context.aboutId
          ? 'Fair challenge. Keep yours if it is the truer feeling. The note only asks whether the sentence carries the weight you mean.'
          : review
            ? 'I left two notes. The opening does quiet work.\n\nThe open question is what the reader should carry out of the ending.'
            : 'Yes, mostly. The images are concrete and the rhythm is patient. Ask me to review it if you want notes in the margin.',
      },
      sessionId,
    );
    this.progress({ kind: 'finished', feedbackSessionId: sessionId });
  }

  private async review(c: Extract<Commit, { type: 'FeedbackRequested' }>): Promise<void> {
    const step = this.opts.stepMs ?? 450;
    const req = c.payload;
    const sessionId = this.id('fs');
    await sleep(step / 2);
    const state = this.transport.projectState();
    const documentId =
      req.scope.kind === 'project'
        ? (state.binder.manuscript.find((r) => r.kind === 'document')?.id ?? null)
        : req.scope.documentId;
    const model = this.opts.model ?? 'opus';
    const started = this.transport.append(
      this.draft(
        'FeedbackSessionStarted',
        {
          feedbackSessionId: sessionId,
          trigger: { kind: 'feedback', requestId: req.requestId },
          model,
          systemPromptVersion: 'v1',
        },
        sessionId,
      ),
    );
    if (started.status !== 'ack') return;
    this.progress({ kind: 'started', feedbackSessionId: sessionId, model, seq: started.seq });
    await sleep(step);
    this.tool('read_document', sessionId);
    await sleep(step);
    if (this.opts.fail?.() || (req.ask ?? '').toLowerCase().includes('fail')) {
      const reason = 'the model timed out';
      this.transport.append(
        this.draft(
          'FeedbackSessionFailed',
          { feedbackSessionId: sessionId, requestId: req.requestId, threadId: null, reason },
          sessionId,
          'system',
        ),
      );
      this.progress({ kind: 'failed', feedbackSessionId: sessionId, reason });
      return;
    }
    const doc = documentId ? documentNode(this.transport.state, documentId) : undefined;
    const version = documentId ? (state.documents[documentId]?.version ?? 0) : 0;
    const sentences = doc ? segmentDoc(doc).sentences : [];
    const first = sentences[0];
    const last = sentences[sentences.length - 1];
    if (doc && documentId && first) {
      this.tool('comment', sessionId);
      await sleep(step);
      const words = first.text.split(/\s+/).filter(Boolean);
      const quote = words
        .slice(0, Math.min(4, words.length))
        .join(' ')
        .replace(/[.,;:!?]+$/, '');
      const t = quote ? this.target(doc, documentId, version, first.id, quote) : null;
      if (t)
        this.emit(
          'CommentAdded',
          {
            commentId: this.id('com'),
            feedbackSessionId: sessionId,
            target: { kind: 'anchor', ...t },
            category: req.lenses[0] ?? 'clarity',
            severity: 'minor',
            body: 'The opening is doing quiet work here; let the reader feel the weather before the plot.',
          },
          sessionId,
        );
    }
    if (doc && documentId && last && last !== first) {
      this.tool('ask_question', sessionId);
      await sleep(step);
      const words = last.text.split(/\s+/).filter(Boolean);
      const quote = words
        .slice(0, Math.min(3, words.length))
        .join(' ')
        .replace(/[.,;:!?]+$/, '');
      const t = quote ? this.target(doc, documentId, version, last.id, quote) : null;
      if (t)
        this.emit(
          'QuestionAsked',
          {
            questionId: this.id('q'),
            feedbackSessionId: sessionId,
            target: { kind: 'anchor', ...t },
            question: 'What should the reader carry out of this ending: relief or unease?',
          },
          sessionId,
        );
    }
    this.tool('finish_review', sessionId);
    await sleep(step);
    this.emit(
      'ReviewFinished',
      {
        feedbackSessionId: sessionId,
        summary:
          'A steady, atmospheric passage. The images are concrete; the open question is what the scene is for.',
        strengths: ['Concrete, physical detail', 'A patient rhythm'],
        topPriorities: ['Decide what the scene turns on', 'Let one image carry the mood'],
      },
      sessionId,
    );
    this.progress({ kind: 'finished', feedbackSessionId: sessionId });
  }

  private async answer(c: Extract<Commit, { type: 'DiscussRequested' }>): Promise<void> {
    const step = this.opts.stepMs ?? 450;
    const { threadId, targetId, message } = c.payload;
    const sessionId = this.id('fs');
    await sleep(step / 2);
    const model = 'sonnet';
    const started = this.transport.append(
      this.draft(
        'FeedbackSessionStarted',
        { feedbackSessionId: sessionId, trigger: { kind: 'discuss', threadId }, model },
        sessionId,
      ),
    );
    if (started.status !== 'ack') return;
    this.progress({ kind: 'started', feedbackSessionId: sessionId, model, seq: started.seq });
    await sleep(step * 2);
    if (message.toLowerCase().includes('fail')) {
      this.transport.append(
        this.draft(
          'FeedbackSessionFailed',
          { feedbackSessionId: sessionId, requestId: null, threadId, reason: 'model unavailable' },
          sessionId,
          'system',
        ),
      );
      return;
    }
    this.emit(
      'DiscussAnswered',
      {
        feedbackSessionId: sessionId,
        threadId,
        targetId,
        body: 'Fair challenge. Keep yours if it is the truer feeling; the note only asks whether the sentence carries the weight you mean.',
      },
      sessionId,
    );
  }
}
