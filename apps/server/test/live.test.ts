/**
 * One real review through the whole service with the local `claude` CLI
 * (`ClaudeCliAdapter`, sonnet, a light-touch selection pass). Skipped unless
 * `LONGHAND_LIVE_CLAUDE=1`: `pnpm --filter @longhand/server test:live`.
 */
import { describe, expect, it } from 'vitest';
import { verifyChain, verifyWitnesses } from '@longhand/ledger';
import { LedgerBuilder } from '@longhand/ledger';
import type { Commit, ProjectState } from '@longhand/schema';
import { adapterFactory } from '../src/agent/sessions';
import { startTestServer } from '../src/testing';
import { DB, api, draftOf, readSse } from './helpers';

const LIVE = process.env.LONGHAND_LIVE_CLAUDE === '1';
const P = 'proj-live';
const TEXT =
  'The rain fell sideways across the harbour, and the boats knocked together like loose teeth. Nobody came to the door that night. Mara counted the letters again and again, as if the number might change.';

describe.skipIf(!LIVE || !DB())('live review with the claude CLI', () => {
  it(
    'runs a light selection review end to end',
    async () => {
      const t = await startTestServer({
        adapters: adapterFactory('claude'),
        sessionTimeoutMs: 4 * 60_000,
        finishGraceMs: 20_000,
      });
      try {
        const b = new LedgerBuilder({ projectId: P, title: 'Live' });
        b.createDocument('doc-1', 'Chapter 1');
        b.type('doc-1', TEXT);
        const v = b.version('doc-1');
        b.requestFeedback('req-live', {
          scope: {
            kind: 'selection',
            documentId: 'doc-1',
            from: 1,
            to: 1 + TEXT.length,
            version: v,
          },
          intensity: 'light',
          lenses: ['clarity', 'word-choice'],
          ask: 'Is the opening image clear?',
        });
        for (const c of b.commits.slice(0, -1)) {
          const r =
            c.type === 'ProjectCreated'
              ? await api(t, 'POST', '/v1/projects', { draft: draftOf(c) })
              : await api(t, 'POST', `/v1/projects/${P}/commits`, draftOf(c));
          expect(r.status).toBeLessThan(300);
        }
        const r = await api<{ sessionId: string }>(t, 'POST', `/v1/projects/${P}/feedback`, {
          draft: draftOf(b.commits.at(-1) as Commit),
        });
        expect(r.status).toBe(201);
        const progress = await readSse(
          `${t.url}/v1/projects/${P}/sessions/${r.body.sessionId}/events`,
          (es) => es.some((e) => e.event === 'ended'),
          { timeoutMs: 5 * 60_000 },
        );
        const ended = progress.at(-1)?.data as { status: string; reason: string | null };
        console.log(
          `[live] session ${r.body.sessionId}: ${ended.status}${ended.reason ? ` (${ended.reason})` : ''}; ` +
            `${progress.filter((e) => e.event === 'annotation').length} annotation(s)`,
        );
        expect(ended.status).toBe('finished');

        const s = (await api<{ state: ProjectState }>(t, 'GET', `/v1/projects/${P}/state`)).body
          .state;
        expect(s.annotations.agentSessions[r.body.sessionId]!.status).toBe('finished');
        expect(JSON.stringify(s.documents['doc-1']!.content)).toContain(TEXT);
        expect(s.documents['doc-1']!.version).toBe(v);
        const bundle = await api<{ commits: Commit[]; witnesses: never[]; publicKeyPem: string }>(
          t,
          'GET',
          `/v1/projects/${P}/bundle`,
        );
        expect(verifyChain(bundle.body.commits).ok).toBe(true);
        expect(
          (
            await verifyWitnesses(
              bundle.body.commits,
              bundle.body.witnesses,
              bundle.body.publicKeyPem,
            )
          ).ok,
        ).toBe(true);
        const agentCommits = bundle.body.commits.filter((c) => c.actor.kind === 'agent');
        expect(agentCommits.length).toBeGreaterThanOrEqual(2);
        for (const c of agentCommits) expect(c.sessionId).toBe(r.body.sessionId);
        const items = agentCommits.filter(
          (c) => !['FeedbackSessionStarted', 'ReviewFinished'].includes(c.type),
        );
        expect(items.length).toBeLessThanOrEqual(5); // light touch
      } finally {
        await t.close();
      }
    },
    6 * 60_000,
  );
});
