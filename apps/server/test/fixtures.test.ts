/**
 * Every golden fixture, replayed through the HTTP ingest: human drafts through
 * the public submit route, agent drafts through the internal events endpoint (in
 * the agent's form, positions at readVersion), system commits produced by the
 * service itself. The folded state must equal the fixture's, and the stored chain
 * must be byte-identical and verify with the stored witnesses.
 */
import { describe, expect, it } from 'vitest';
import { verifyChain, verifyWitnesses } from '@longhand/ledger';
import { FIXTURE_NAMES, loadFixture } from '@longhand/ledger/fixtures';
import { schema, type Commit, type StepJSON } from '@longhand/schema';
import { Step } from 'prosemirror-transform';
import { startTestServer } from '../src/testing';
import { DB, api, fixtureHooks, replayFixture, replaySigner } from './helpers';

describe.skipIf(!DB())('golden fixtures through the HTTP ingest', () => {
  for (const name of FIXTURE_NAMES) {
    it(name, async () => {
      const f = loadFixture(name);
      const t = await startTestServer({
        signer: replaySigner(f),
        hooks: fixtureHooks(f),
        autoStartSessions: false,
      });
      try {
        await replayFixture(t, f);
        const projectId = (f.commits[0] as Commit).projectId;

        const s = await api<{ state: unknown; headSeq: number }>(
          t,
          'GET',
          `/v1/projects/${projectId}/state`,
        );
        expect(s.status).toBe(200);
        expect(s.body.headSeq).toBe(f.expected.headSeq);
        expect(s.body.state).toEqual(f.expected.state);

        const b = await api<{
          commits: Commit[];
          witnesses: typeof f.witnesses;
          publicKeyPem: string;
          keyId: string;
          unwitnessedSeqs: number[];
        }>(t, 'GET', `/v1/projects/${projectId}/bundle`);
        expect(b.status).toBe(200);
        expect(b.body.commits).toEqual(f.commits);
        expect(b.body.unwitnessedSeqs).toEqual([]);
        expect(
          verifyChain(b.body.commits, {
            expectedHead: { seq: f.expected.headSeq, hash: f.expected.headHash },
          }).ok,
        ).toBe(true);
        const w = await verifyWitnesses(b.body.commits, b.body.witnesses, b.body.publicKeyPem);
        expect(w.problems).toEqual([]);
        expect(w.ok).toBe(true);
        expect(b.body.keyId).toBe(f.keyId);

        // The Postgres read model holds the same witnesses.
        await t.handle.service.flush();
        const rows = await t.handle.service.opts.readModel.witnesses(projectId);
        expect(rows).toEqual(b.body.witnesses);

        // fetchSince(0) replays every document to its folded content, with fold-derived proposal steps.
        const state = s.body.state as {
          documents: Record<string, { content: unknown; version: number }>;
        };
        for (const [documentId, d] of Object.entries(state.documents)) {
          const ledger = await t.handle.service.ledger(projectId);
          const h = ledger.history.get(documentId);
          expect(h, documentId).toBeTruthy();
          const r = await api<{
            kind: string;
            updates: Array<{ baseVersion: number; version: number; steps: StepJSON[] }>;
            version: number;
          }>(
            t,
            'GET',
            `/v1/projects/${projectId}/documents/${documentId}/updates?since=${h!.initialVersion}`,
          );
          expect(r.body.kind).toBe('updates');
          expect(r.body.version).toBe(d.version);
          let doc = h!.initialDoc;
          let v = h!.initialVersion;
          for (const u of r.body.updates) {
            expect(u.baseVersion).toBe(v);
            expect(u.version - u.baseVersion).toBe(u.steps.length);
            for (const j of u.steps) {
              const res = Step.fromJSON(schema, j).apply(doc);
              expect(res.failed).toBeNull();
              doc = res.doc!;
            }
            v = u.version;
          }
          expect(doc.toJSON()).toEqual(d.content);
        }
      } finally {
        await t.close();
      }
    });
  }
});
