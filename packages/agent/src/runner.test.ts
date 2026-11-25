import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CommitDraftSchema, docFromJSON, segmentDoc, toolsForSession } from '@longhand/schema';
import {
  InMemoryAnnotationSink,
  MockModelAdapter,
  SYSTEM_PROMPT_VERSION,
  StaticSourceSearch,
  runDiscussSession,
  runFeedbackSession,
  type MockStep,
  type SessionProgressEvent,
} from './index';
import { docRequest, makeState } from './fixtures.test-helpers';

const state = makeState();
const A = (sentenceId: string, quote: string) => ({ documentId: 'ch1', sentenceId, quote });
const comment = (sentenceId: string, quote: string, body = 'Worth a look.'): MockStep => ({
  tool: 'comment',
  input: { anchor: A(sentenceId, quote), category: 'structure', severity: 'moderate', body },
});
const finish: MockStep = {
  tool: 'finish_review',
  input: {
    summary: 'The opening is steady; the letter needs to matter sooner.',
    strengths: ['Controlled rhythm'],
    topPriorities: ['Show what the letter means to Mara'],
  },
};

describe('runFeedbackSession with MockModelAdapter', () => {
  it('runs a full review: invalid calls are rejected and retried, valid ones reach the sink in order', async () => {
    const adapter = new MockModelAdapter([
      { text: 'Reading the chapter.' },
      comment('p2.s1', 'rain fell slantwise'), // wrong quote
      comment('p2.s1', 'rain fell sideways'), // retry
      {
        tool: 'suggest_insertion',
        input: {
          documentId: 'ch1',
          position: 'after',
          sentenceId: 'p3.s2',
          sentence: 'It was from her brother. He was dead.', // two sentences
          purpose: 'Stakes.',
        },
      },
      {
        tool: 'suggest_insertion',
        input: {
          documentId: 'ch1',
          position: 'after',
          sentenceId: 'p3.s2',
          sentence: 'It was from her brother.',
          purpose: 'Stakes.',
        },
      },
      {
        tool: 'propose_move',
        input: {
          documentId: 'ch1',
          unit: 'paragraph',
          ids: ['p2', 'p5'], // not contiguous
          destination: { position: 'after', id: 'p3' },
          rationale: 'Order.',
        },
      },
      {
        tool: 'propose_move',
        input: {
          documentId: 'ch1',
          unit: 'paragraph',
          ids: ['p2'],
          destination: { position: 'after', id: 'p3' },
          rationale: 'Open on Mara.',
        },
      },
      finish,
      { text: 'Done.' },
    ]);
    const sink = new InMemoryAnnotationSink();
    const events: SessionProgressEvent[] = [];
    const outcome = await runFeedbackSession({
      state,
      request: docRequest(),
      sink,
      adapter,
      feedbackSessionId: 'fs-run',
      onProgress: (e) => events.push(e),
    });

    expect(outcome.status).toBe('finished');
    expect(outcome.reason).toBeNull();
    expect(outcome.model).toBe('opus');
    expect(outcome.rejectedCalls).toBe(3);
    expect(sink.drafts.map((d) => d.draft.type)).toEqual([
      'FeedbackSessionStarted',
      'CommentAdded',
      'SuggestionProposed',
      'MoveProposed',
      'ReviewFinished',
    ]);
    for (const { draft } of sink.drafts) {
      expect(CommitDraftSchema.safeParse(draft).success).toBe(true);
      expect(draft.actor).toEqual({ kind: 'agent', id: 'opus' });
      expect(draft.sessionId).toBe('fs-run');
      expect(draft.projectId).toBe('proj1');
    }
    expect(sink.drafts[0]!.draft.payload).toEqual({
      feedbackSessionId: 'fs-run',
      trigger: { kind: 'feedback', requestId: 'req1' },
      model: 'opus',
      systemPromptVersion: SYSTEM_PROMPT_VERSION,
    });
    expect(outcome.startedSeq).toBe(1);
    expect(outcome.annotations.map((a) => a.seq)).toEqual([2, 3, 4, 5]);

    // The adapter was driven with the exact session inputs.
    const run = adapter.runs[0]!;
    expect(run.model).toBe('opus');
    expect(run.allowedTools).toEqual(toolsForSession('review').map((t) => `mcp__longhand__${t}`));
    expect(run.systemPrompt).toContain('You cannot write the manuscript');
    expect(run.prompt).toContain('[p2.s1] The rain fell sideways.');
    expect(adapter.listedTools[0]).toEqual(toolsForSession('review'));
    expect(existsSync(run.cwd)).toBe(false); // temp dir cleaned up

    // Progress streams items as they arrive.
    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe('started');
    expect(kinds[kinds.length - 1]).toBe('finished');
    expect(events.filter((e) => e.kind === 'annotation')).toHaveLength(4);
    const toolCalls = events.filter((e) => e.kind === 'model' && e.event.type === 'tool-call');
    expect(toolCalls).toHaveLength(7);
    // Every event names the session, from the first one on.
    expect(events.every((e) => e.feedbackSessionId === 'fs-run')).toBe(true);
  }, 30_000);

  it('enforces caps across the session (light touch: 5 items)', async () => {
    const adapter = new MockModelAdapter([
      ...Array.from({ length: 7 }, () => comment('p2.s1', 'sideways')),
      finish,
    ]);
    const sink = new InMemoryAnnotationSink();
    const outcome = await runFeedbackSession({
      state,
      request: docRequest({ intensity: 'light' }),
      sink,
      adapter,
    });
    expect(outcome.status).toBe('finished');
    expect(sink.ofType('CommentAdded')).toHaveLength(5);
    expect(outcome.rejectedCalls).toBe(2);
  }, 30_000);

  it('uses sonnet for a selection pass and passes the selection scope to the tools', async () => {
    const seg = segmentDoc(docFromJSON(state.documents.ch1!.content));
    const p3 = seg.blockById.get('p3')!;
    const adapter = new MockModelAdapter([
      comment('p2.s1', 'sideways'),
      comment('p3.s2', 'letter'),
      finish,
    ]);
    const sink = new InMemoryAnnotationSink();
    const outcome = await runFeedbackSession({
      state,
      request: docRequest({
        scope: {
          kind: 'selection',
          documentId: 'ch1',
          from: p3.contentFrom,
          to: p3.contentTo,
          version: 7,
        },
      }),
      sink,
      adapter,
    });
    expect(outcome.model).toBe('sonnet');
    expect(outcome.status).toBe('finished');
    expect(outcome.rejectedCalls).toBe(1); // p2.s1 is outside the selection
    expect(sink.ofType('CommentAdded')).toHaveLength(1);
  }, 30_000);

  it('fails the session when the model ends without finish_review', async () => {
    const adapter = new MockModelAdapter([comment('p2.s1', 'sideways')]);
    const sink = new InMemoryAnnotationSink();
    const events: SessionProgressEvent[] = [];
    const outcome = await runFeedbackSession({
      state,
      request: docRequest(),
      sink,
      adapter,
      feedbackSessionId: 'fs-nofin',
      onProgress: (e) => events.push(e),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/without calling finish_review/);
    const failed = sink.ofType('FeedbackSessionFailed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.actor.kind).toBe('system');
    expect(failed[0]!.sessionId).toBe('system');
    expect(failed[0]!.payload).toMatchObject({
      feedbackSessionId: 'fs-nofin',
      requestId: 'req1',
      threadId: null,
    });
    expect(events[events.length - 1]).toMatchObject({
      kind: 'failed',
      feedbackSessionId: 'fs-nofin',
    });
  }, 30_000);

  it('kills a hung model at the wall-clock timeout', async () => {
    const adapter = new MockModelAdapter([comment('p2.s1', 'sideways'), { hang: true }]);
    const sink = new InMemoryAnnotationSink();
    const outcome = await runFeedbackSession({
      state,
      request: docRequest(),
      sink,
      adapter,
      timeoutMs: 1500,
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.run?.status).toBe('timeout');
    expect(outcome.reason).toMatch(/timed out after 2 s without finish_review/);
    expect(sink.ofType('CommentAdded')).toHaveLength(1);
  }, 30_000);

  it('a timeout after finish_review still counts as finished', async () => {
    const adapter = new MockModelAdapter([finish, { hang: true }]);
    const outcome = await runFeedbackSession({
      state,
      request: docRequest(),
      sink: new InMemoryAnnotationSink(),
      adapter,
      timeoutMs: 1500,
    });
    expect(outcome.status).toBe('finished');
  }, 30_000);

  it('stops a model that lingers after finish_review once the grace period ends', async () => {
    const adapter = new MockModelAdapter([finish, { hang: true }]);
    const started = Date.now();
    const outcome = await runFeedbackSession({
      state,
      request: docRequest(),
      sink: new InMemoryAnnotationSink(),
      adapter,
      timeoutMs: 60_000,
      finishGraceMs: 200,
    });
    expect(outcome.status).toBe('finished');
    expect(outcome.run?.status).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('a mock run whose signal was aborted before it started stops at once', async () => {
    const adapter = new MockModelAdapter([{ hang: true }]);
    const ac = new AbortController();
    ac.abort();
    const started = Date.now();
    const run = await adapter.run({
      sessionKind: 'review',
      prompt: 'x',
      systemPrompt: 'y',
      model: 'sonnet',
      mcp: { launch: { command: 'false', args: [] }, configPath: '/nonexistent' },
      allowedTools: [],
      cwd: process.cwd(),
      timeoutMs: 60_000,
      signal: ac.signal,
    });
    expect(run.status).toBe('aborted');
    expect(run.toolCalls).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a session cancelled before it starts fails without running the model', async () => {
    const adapter = new MockModelAdapter([{ hang: true }]);
    const ac = new AbortController();
    ac.abort();
    const sink = new InMemoryAnnotationSink();
    const started = Date.now();
    const outcome = await runFeedbackSession({
      state,
      request: docRequest(),
      sink,
      adapter,
      signal: ac.signal,
      timeoutMs: 60_000,
    });
    expect(outcome.status).toBe('failed');
    expect(sink.ofType('FeedbackSessionFailed')).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  it('the caller can cancel a running session', async () => {
    const adapter = new MockModelAdapter([comment('p2.s1', 'sideways'), { hang: true }]);
    const ac = new AbortController();
    const sink = new InMemoryAnnotationSink();
    const pending = runFeedbackSession({
      state,
      request: docRequest(),
      sink,
      adapter,
      signal: ac.signal,
      onProgress: (e) => {
        if (e.kind === 'annotation') ac.abort();
      },
    });
    const outcome = await pending;
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe('the session was cancelled');
    expect(sink.ofType('FeedbackSessionFailed')).toHaveLength(1);
  }, 30_000);

  it('records model errors as FeedbackSessionFailed', async () => {
    const adapter = new MockModelAdapter([{ fail: 'overloaded' }]);
    const sink = new InMemoryAnnotationSink();
    const outcome = await runFeedbackSession({ state, request: docRequest(), sink, adapter });
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/overloaded/);
    expect(sink.ofType('FeedbackSessionFailed')).toHaveLength(1);
  }, 30_000);

  it('an unservable request fails before starting a session', async () => {
    const adapter = new MockModelAdapter([finish]);
    const sink = new InMemoryAnnotationSink();
    const events: SessionProgressEvent[] = [];
    const outcome = await runFeedbackSession({
      state,
      request: docRequest({ scope: { kind: 'document', documentId: 'style' } }),
      sink,
      adapter,
      onProgress: (e) => events.push(e),
    });
    expect(outcome.status).toBe('failed');
    expect(adapter.runs).toHaveLength(0);
    expect(sink.drafts.map((d) => d.draft.type)).toEqual(['FeedbackSessionFailed']);
    expect(sink.ofType('FeedbackSessionFailed')[0]!.payload.feedbackSessionId).toBeNull();
    // No session started, so the one progress event names none (like the ledger event).
    expect(events).toEqual([{ kind: 'failed', feedbackSessionId: null, reason: outcome.reason }]);
  });

  it('does not run the model if the sink refuses FeedbackSessionStarted', async () => {
    const adapter = new MockModelAdapter([finish]);
    const sink = new InMemoryAnnotationSink({
      reject: (d) =>
        d.type === 'FeedbackSessionStarted'
          ? { code: 'forbidden', message: 'no session', retryable: false }
          : null,
    });
    const outcome = await runFeedbackSession({ state, request: docRequest(), sink, adapter });
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/could not start/);
    expect(adapter.runs).toHaveLength(0);
  });

  it('passes the injected SourceSearch through to search_sources', async () => {
    const search = new StaticSourceSearch([
      {
        csl: { id: 'c1', type: 'book', title: 'Rain', ISBN: '1' },
        provider: 'openlibrary',
        url: null,
      },
    ]);
    const adapter = new MockModelAdapter([
      { tool: 'search_sources', input: { query: 'storm psychology' } },
      finish,
    ]);
    const sink = new InMemoryAnnotationSink();
    const outcome = await runFeedbackSession({
      state,
      request: docRequest(),
      sink,
      adapter,
      search,
    });
    expect(outcome.status).toBe('finished');
    expect(search.queries).toEqual(['storm psychology']);
    expect(sink.ofType('SourceSurfaced')).toHaveLength(1);
  }, 30_000);
});

describe('runDiscussSession', () => {
  it('answers the thread with answer_discussion and finishes', async () => {
    const adapter = new MockModelAdapter([
      {
        tool: 'comment',
        input: { anchor: A('p2.s1', 'rain'), category: 'clarity', severity: 'minor', body: 'x' },
      },
      { tool: 'read_document', input: { documentId: 'ch1' } },
      {
        tool: 'answer_discussion',
        input: { threadId: 'th1', body: 'Slantwise keeps the angle without the cliché.' },
      },
    ]);
    const sink = new InMemoryAnnotationSink();
    const outcome = await runDiscussSession({
      state,
      request: { threadId: 'th1', targetId: 'sg0', message: 'Why slantwise?' },
      sink,
      adapter,
      feedbackSessionId: 'fs-d',
    });
    expect(outcome.status).toBe('finished');
    expect(outcome.model).toBe('sonnet');
    expect(outcome.rejectedCalls).toBe(1);
    expect(adapter.listedTools[0]!.sort()).toEqual([
      'answer_discussion',
      'get_outline',
      'read_document',
      'read_notes',
    ]);
    expect(sink.drafts.map((d) => d.draft.type)).toEqual([
      'FeedbackSessionStarted',
      'DiscussAnswered',
    ]);
    expect(sink.drafts[0]!.draft.payload).toMatchObject({
      trigger: { kind: 'discuss', threadId: 'th1' },
    });
  }, 30_000);

  it('fails with threadId when no answer is given', async () => {
    const sink = new InMemoryAnnotationSink();
    const outcome = await runDiscussSession({
      state,
      request: { threadId: 'th1', targetId: 'sg0', message: 'Why?' },
      sink,
      adapter: new MockModelAdapter([{ text: 'Hmm.' }]),
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toMatch(/answer_discussion/);
    expect(sink.ofType('FeedbackSessionFailed')[0]!.payload).toMatchObject({
      requestId: null,
      threadId: 'th1',
    });
  }, 30_000);
});
