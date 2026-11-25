// Live smoke test: one real light-touch review through the local `claude` CLI.
// Skipped unless LONGHAND_LIVE_CLAUDE=1 (`pnpm --filter @longhand/agent test:live`).
import { describe, expect, it } from 'vitest';
import {
  CommitDraftSchema,
  capsFor,
  docFromJSON,
  isManuscriptEventType,
  resolveAnchor,
  segmentDoc,
} from '@longhand/schema';
import {
  AGENT_EVENT_TYPES,
  ClaudeCliAdapter,
  InMemoryAnnotationSink,
  runFeedbackSession,
  type SessionProgressEvent,
} from './index';
import { LIVE_PARAGRAPH, LIVE_PARAGRAPH_REQUEST, liveParagraphState } from './live-fixture';

const live = process.env.LONGHAND_LIVE_CLAUDE === '1';

describe.skipIf(!live)('live claude CLI smoke test', () => {
  it(
    'a light-touch sonnet review sends only valid annotation events to the sink',
    async () => {
      const state = liveParagraphState();
      const before = structuredClone(state);
      const sink = new InMemoryAnnotationSink();
      const progress: SessionProgressEvent[] = [];
      const outcome = await runFeedbackSession({
        state,
        request: LIVE_PARAGRAPH_REQUEST,
        sink,
        adapter: new ClaudeCliAdapter(),
        model: 'sonnet',
        feedbackSessionId: 'live-session',
        timeoutMs: 4 * 60_000,
        onProgress: (e) => progress.push(e),
      });
      console.log(
        JSON.stringify(
          {
            status: outcome.status,
            reason: outcome.reason,
            rejectedCalls: outcome.rejectedCalls,
            rejected: outcome.run?.toolCalls
              .filter((c) => c.result?.isError)
              .map((c) => `${c.name}: ${c.result?.text}`),
            drafts: sink.drafts.map((d) => d.draft.type),
            costUsd: outcome.run?.costUsd,
            durationMs: outcome.run?.durationMs,
          },
          null,
          2,
        ),
      );

      expect(outcome.status).toBe('finished');
      expect(outcome.model).toBe('sonnet');
      const drafts = sink.drafts.map((d) => d.draft);
      expect(drafts[0]?.type).toBe('FeedbackSessionStarted');
      expect(drafts[drafts.length - 1]?.type).toBe('ReviewFinished');
      expect(drafts.filter((d) => d.type === 'ReviewFinished')).toHaveLength(1);

      // Only valid agent annotation events, from this session, reached the sink.
      const seg = segmentDoc(docFromJSON(state.documents.doc1!.content));
      for (const d of drafts) {
        expect(CommitDraftSchema.safeParse(d).success).toBe(true);
        expect((AGENT_EVENT_TYPES as readonly string[]).includes(d.type)).toBe(true);
        expect(isManuscriptEventType(d.type)).toBe(false);
        expect(d.actor).toEqual({ kind: 'agent', id: 'sonnet' });
        expect(d.sessionId).toBe('live-session');
        // Every anchor still resolves exactly against the text the model read.
        const target =
          (d.payload as { target?: unknown; suggestion?: { target?: unknown } }).target ??
          (d.payload as { suggestion?: { target?: unknown } }).suggestion?.target;
        const anchor = (target as { anchor?: Parameters<typeof resolveAnchor>[1] } | null)?.anchor;
        if (anchor) expect(resolveAnchor(seg, anchor).ok).toBe(true);
      }
      const items = drafts.filter(
        (d) => d.type !== 'FeedbackSessionStarted' && d.type !== 'ReviewFinished',
      );
      expect(items.length).toBeLessThanOrEqual(capsFor('light').maxItems);

      // Nothing touched the manuscript.
      expect(state).toEqual(before);
      expect(state.documents.doc1!.content).toEqual(before.documents.doc1!.content);
      expect(seg.blocks[0]!.text).toBe(LIVE_PARAGRAPH);

      // Items streamed as they arrived.
      expect(progress.filter((e) => e.kind === 'annotation')).toHaveLength(drafts.length - 1);
    },
    5 * 60_000,
  );
});
