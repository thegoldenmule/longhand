/**
 * Restart recovery and rebuild: the streams are the source of truth. A crashed
 * service comes back with an identical folded state, and `rebuild` reproduces the
 * Postgres read model exactly.
 */
import { describe, expect, it } from 'vitest';
import { verifyChain, verifyWitnesses } from '@longhand/ledger';
import { loadFixture } from '@longhand/ledger/fixtures';
import type { Commit } from '@longhand/schema';
import { READ_MODEL_TABLES } from '../src/storage/readmodel';
import { startTestServer, type TestServer } from '../src/testing';
import { DB, api, fixtureHooks, replayFixture, replaySigner } from './helpers';

const ORDER: Record<string, string> = {
  projects: 'project_id',
  commits: 'project_id, seq',
  witnesses: 'project_id, seq',
  snapshots: 'project_id',
  documents: 'project_id, document_id',
  annotations: 'project_id, collection, annotation_id',
  agent_sessions: 'project_id, session_id',
};

async function dump(t: TestServer): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of READ_MODEL_TABLES) {
    if (table === 'session_tokens') continue; // ephemeral by design
    const r = await t.db.pool.query(`SELECT * FROM ${table} ORDER BY ${ORDER[table]}`);
    out[table] = r.rows;
  }
  return out;
}

describe.skipIf(!DB())('restart and rebuild', () => {
  it('rebuilds identical state after a crash, keeps appending, and `rebuild` reproduces Postgres', async () => {
    const f = loadFixture('proposals');
    const t = await startTestServer({
      signer: replaySigner(f),
      hooks: fixtureHooks(f),
      autoStartSessions: false,
    });
    try {
      await replayFixture(t, f);
      const P = (f.commits[0] as Commit).projectId;
      const before = await api(t, 'GET', `/v1/projects/${P}/state`);
      const bundleBefore = await api<{ commits: Commit[] }>(t, 'GET', `/v1/projects/${P}/bundle`);
      await t.handle.service.flush({ snapshots: true });
      const pgBefore = await dump(t);
      expect(pgBefore.commits).toHaveLength(f.commits.length);
      expect(pgBefore.snapshots).toHaveLength(1);

      // Crash: no graceful close, no final snapshot.
      await t.restart({ crash: true });
      const after = await api(t, 'GET', `/v1/projects/${P}/state`);
      expect(after.body).toEqual(before.body);
      const bundleAfter = await api<{ commits: Commit[] }>(t, 'GET', `/v1/projects/${P}/bundle`);
      expect(bundleAfter.body).toEqual(bundleBefore.body);

      // The new instance keeps writing at the right writer seq.
      const docs = (after.body as { state: { documents: Record<string, { version: number }> } })
        .state.documents;
      const documentId = Object.keys(docs)[0] as string;
      const draft = {
        commitId: 'after-restart',
        projectId: P,
        clientTime: new Date().toISOString(),
        actor: { kind: 'human', id: 'writer-1' },
        deviceId: 'device-1',
        sessionId: 'editor-9',
        schemaVersion: 1,
        type: 'DocumentRenamed',
        payload: { documentId, title: 'Renamed after restart' },
      };
      const r = await api<{ status: string; seq: number }>(
        t,
        'POST',
        `/v1/projects/${P}/commits`,
        draft,
      );
      expect(r.status).toBe(200);
      expect(r.body.seq).toBe(f.commits.length + 1);

      // A graceful restart after the write: identical again.
      const s2 = await api(t, 'GET', `/v1/projects/${P}/state`);
      await t.restart();
      expect((await api(t, 'GET', `/v1/projects/${P}/state`)).body).toEqual(s2.body);
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

      // rebuild: empty Postgres, refill from the streams, compare every table.
      await t.handle.service.flush({ snapshots: true });
      const pg1 = await dump(t);
      const result = await t.handle.service.rebuild();
      expect(result).toEqual({ projects: 1, commits: f.commits.length + 1 });
      await t.handle.service.flush({ snapshots: true });
      const pg2 = await dump(t);
      expect(pg2).toEqual(pg1);
      expect((pg2.projects![0] as { title: string; head_seq: number }).head_seq).toBe(
        f.commits.length + 1,
      );
    } finally {
      await t.close();
    }
  });

  it('embeds ChainHeadWitnessed every N commits, and the chain verifies', async () => {
    const t = await startTestServer({ cadence: { everyCommits: 3 } });
    try {
      const created = await api<{ projectId: string }>(t, 'POST', '/v1/projects', {
        title: 'Cadence',
      });
      const P = created.body.projectId;
      for (let i = 0; i < 7; i++) {
        const r = await api(t, 'POST', `/v1/projects/${P}/commits`, {
          commitId: `c-${i}`,
          projectId: P,
          clientTime: new Date().toISOString(),
          actor: { kind: 'human', id: 'writer-1' },
          deviceId: 'd',
          sessionId: 's',
          schemaVersion: 1,
          type: 'DocumentCreated',
          payload: {
            documentId: `doc-${i}`,
            kind: 'manuscript',
            title: `D${i}`,
            parentId: null,
            index: i,
          },
        });
        expect(r.status, JSON.stringify(r.body)).toBe(200);
      }
      const b = await api<{ commits: Commit[]; witnesses: never[]; publicKeyPem: string }>(
        t,
        'GET',
        `/v1/projects/${P}/bundle`,
      );
      const embedded = b.body.commits.filter((c) => c.type === 'ChainHeadWitnessed');
      expect(embedded.length).toBeGreaterThanOrEqual(2);
      for (const c of embedded)
        expect((c.payload as { witnessedSeq: number }).witnessedSeq).toBe(c.seq - 1);
      const w = await verifyWitnesses(b.body.commits, b.body.witnesses, b.body.publicKeyPem);
      expect(w.problems).toEqual([]);
      // The interval tick embeds the head when commits arrived since the last one.
      const head = b.body.commits.at(-1) as Commit;
      await t.handle.service.witnessTick();
      const b2 = await api<{ commits: Commit[] }>(t, 'GET', `/v1/projects/${P}/bundle`);
      if (head.type !== 'ChainHeadWitnessed')
        expect(b2.body.commits.at(-1)?.type).toBe('ChainHeadWitnessed');
      await t.handle.service.witnessTick();
      const b3 = await api<{ commits: Commit[] }>(t, 'GET', `/v1/projects/${P}/bundle`);
      expect(b3.body.commits.length).toBe(b2.body.commits.length);
    } finally {
      await t.close();
    }
  });
});
