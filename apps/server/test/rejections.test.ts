/**
 * What the ledger service refuses, on both the public submit route and the
 * internal session events endpoint, plus a property test: random agent drafts
 * never change manuscript text.
 */
import { randomUUID } from 'node:crypto';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LedgerBuilder } from '@longhand/ledger';
import {
  docFromJSON,
  resolveAnchor,
  type Commit,
  type CommitDraft,
  type PMNodeJSON,
  type ProjectState,
} from '@longhand/schema';
import { startTestServer, type TestServer } from '../src/testing';
import { DB, api, draftOf } from './helpers';

const P = 'proj-1';

function agent(type: string, payload: unknown, sessionId = 'fs-1', model = 'opus'): CommitDraft {
  return {
    commitId: randomUUID(),
    projectId: P,
    clientTime: new Date().toISOString(),
    actor: { kind: 'agent', id: model },
    deviceId: 'server',
    sessionId,
    schemaVersion: 1,
    type,
    payload,
  } as unknown as CommitDraft;
}

async function state(t: TestServer): Promise<ProjectState> {
  return (await api<{ state: ProjectState }>(t, 'GET', `/v1/projects/${P}/state`)).body.state;
}

async function anchorAt(t: TestServer, sentenceId: string, quote: string) {
  const s = await state(t);
  const d = s.documents['doc-1']!;
  const r = resolveAnchor(docFromJSON(d.content as PMNodeJSON), {
    documentId: 'doc-1',
    sentenceId,
    quote,
  });
  if (!r.ok) throw new Error(r.error.message);
  return { anchor: r.anchor, from: r.from, to: r.to, readVersion: d.version, version: d.version };
}

function comment(target: unknown, sessionId = 'fs-1', id = randomUUID().slice(0, 8)): CommitDraft {
  return agent(
    'CommentAdded',
    {
      commentId: `c-${id}`,
      feedbackSessionId: sessionId,
      target: { kind: 'anchor', ...(target as object) },
      category: 'clarity',
      severity: 'minor',
      body: 'A note.',
    },
    sessionId,
  );
}

describe.skipIf(!DB())('rejections', () => {
  let t: TestServer;
  let b: LedgerBuilder;
  let token: string;
  const post = (draft: unknown, tok = token, sessionId = 'fs-1') =>
    api<{
      ok: boolean;
      seq?: number;
      duplicate?: boolean;
      error?: { code: string; message: string };
    }>(t, 'POST', `/internal/sessions/${sessionId}/events`, draft, {
      authorization: `Bearer ${tok}`,
    });

  beforeAll(async () => {
    t = await startTestServer({ autoStartSessions: false });
    b = new LedgerBuilder({ title: 'Rejections' });
    b.createDocument('doc-1', 'Chapter 1');
    b.type('doc-1', 'The rain fell sideways. Nobody came to the door. The house was quiet.');
    b.requestFeedback('req-1', {
      scope: { kind: 'document', documentId: 'doc-1' },
      intensity: 'light',
      lenses: ['clarity'],
    });
    for (const c of b.commits) {
      const r =
        c.type === 'ProjectCreated'
          ? await api(t, 'POST', '/v1/projects', { draft: draftOf(c) })
          : await api(t, 'POST', `/v1/projects/${P}/commits`, draftOf(c));
      expect(r.status).toBeLessThan(300);
    }
    ({ token } = await t.handle.service.sessions.open({
      projectId: P,
      accountId: 'acct-1',
      kind: 'review',
      requestId: 'req-1',
      intensity: 'light',
      sessionId: 'fs-1',
    }));
  });
  afterAll(async () => {
    await t?.close();
  });

  const lastText = (): Commit => b.commits.filter((c) => c.type === 'TextEdited').at(-1) as Commit;

  it('refuses an agent actor submitting TextEdited, on both routes', async () => {
    const forged = {
      ...draftOf(lastText()),
      commitId: randomUUID(),
      actor: { kind: 'agent', id: 'opus' },
    };
    const pub = await api<{ status: string; code: string }>(
      t,
      'POST',
      `/v1/projects/${P}/commits`,
      forged,
    );
    expect(pub.status).toBe(403);
    expect(pub.body.status).toBe('rejected');
    expect(pub.body.code).toBe('actor-not-permitted');
    // The schema refuses it before anything else (agent README: 400 invalid-draft).
    const internal = await post({ ...forged, sessionId: 'fs-1' });
    expect(internal.status).toBe(400);
    expect(internal.body.error?.code).toBe('invalid-draft');
  });

  it('refuses a forged human actor', async () => {
    const s = await state(t);
    const d = s.documents['doc-1']!;
    const forged = {
      ...draftOf(lastText()),
      commitId: randomUUID(),
      actor: { kind: 'human', id: 'someone-else' },
      payload: { ...(lastText().payload as object), baseVersion: d.version },
    };
    const r = await api<{ status: string; code: string }>(
      t,
      'POST',
      `/v1/projects/${P}/commits`,
      forged,
    );
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('actor-mismatch');
    // An agent draft on the public route is refused too.
    const a = await api<{ code: string }>(
      t,
      'POST',
      `/v1/projects/${P}/commits`,
      comment(await anchorAt(t, 'p1.s1', 'rain')),
    );
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('actor-mismatch');
  });

  it('answers a stale or future baseVersion with a conflict and the current version', async () => {
    const s = await state(t);
    const v = s.documents['doc-1']!.version;
    const base = draftOf(lastText()) as CommitDraft & { payload: { baseVersion: number } };
    for (const baseVersion of [v - 1, v + 3]) {
      const r = await api<{ status: string; currentVersion: number; code: string }>(
        t,
        'POST',
        `/v1/projects/${P}/commits`,
        {
          ...base,
          commitId: randomUUID(),
          payload: { ...base.payload, baseVersion },
        },
      );
      expect(r.status).toBe(409);
      expect(r.body.status).toBe('conflict');
      expect(r.body.currentVersion).toBe(v);
      expect(r.body.code).toBe(baseVersion < v ? 'stale-base-version' : 'future-base-version');
    }
  });

  it('authenticates session drafts: unknown session, missing or wrong token, another project', async () => {
    const d = agent('FeedbackSessionStarted', {
      feedbackSessionId: 'fs-1',
      trigger: { kind: 'feedback', requestId: 'req-1' },
      model: 'opus',
    });
    expect((await post(d, token, 'nope')).status).toBe(404);
    expect((await post(d, 'not-the-token')).status).toBe(401);
    const noAuth = await api(t, 'POST', '/internal/sessions/fs-1/events', d);
    expect(noAuth.status).toBe(401);
    const { token: other } = await t.handle.service.sessions.open({
      projectId: P,
      accountId: 'acct-1',
      kind: 'review',
      requestId: 'req-1',
      sessionId: 'fs-other',
    });
    expect((await post(d, other)).status).toBe(401); // fs-other's token on fs-1
    const foreign = await post({ ...d, projectId: 'proj-2' });
    expect(foreign.status).toBe(403);
  });

  it('orders a session: nothing before FeedbackSessionStarted, which comes once', async () => {
    const early = await post(comment(await anchorAt(t, 'p1.s1', 'rain')));
    expect(early.status).toBe(409);
    const wrongTrigger = await post(
      agent('FeedbackSessionStarted', {
        feedbackSessionId: 'fs-1',
        trigger: { kind: 'feedback', requestId: 'other' },
        model: 'opus',
      }),
    );
    expect(wrongTrigger.status).toBe(403);
    const start = agent('FeedbackSessionStarted', {
      feedbackSessionId: 'fs-1',
      trigger: { kind: 'feedback', requestId: 'req-1' },
      model: 'opus',
    });
    const r = await post(start);
    expect(r.status).toBe(200);
    expect(r.body.duplicate).toBe(false);
    const again = await post(start);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ seq: r.body.seq, duplicate: true });
    const second = await post({ ...start, commitId: randomUUID() });
    expect(second.status).toBe(409);
  });

  it('refuses unresolvable anchors with the resolver code', async () => {
    const a = await anchorAt(t, 'p1.s1', 'rain');
    const r1 = await post(comment({ ...a, anchor: { ...a.anchor, quote: 'snow' } }));
    expect(r1.status).toBe(422);
    expect(r1.body.error?.code).toBe('quote-not-found');
    const r2 = await post(comment({ ...a, anchor: { ...a.anchor, sentenceId: 'p9.s9' } }));
    expect(r2.status).toBe(422);
    expect(r2.body.error?.code).toBe('unknown-sentence');
    const r3 = await post(comment({ ...a, from: a.from + 1 }));
    expect(r3.status).toBe(422);
    expect(r3.body.error?.code).toBe('target-mismatch');
    const r4 = await post(
      comment({ ...a, readVersion: a.readVersion + 5, version: a.readVersion + 5 }),
    );
    expect(r4.status).toBe(422);
    expect(r4.body.error?.code).toBe('invalid-version');
  });

  it('maps positions from readVersion to the current version under the lock', async () => {
    const a = await anchorAt(t, 'p1.s2', 'door');
    // The writer types at the start of the document after the agent read it.
    b.type('doc-1', 'Rain. ', { at: 1 });
    const typed = b.commits.at(-1) as Commit;
    expect((await api(t, 'POST', `/v1/projects/${P}/commits`, draftOf(typed))).status).toBe(200);
    const r = await post(comment(a, 'fs-1', 'mapped'));
    expect(r.status).toBe(200);
    const s = await state(t);
    const c = s.annotations.comments['c-mapped']!;
    expect(c.range).toEqual({ documentId: 'doc-1', from: a.from + 6, to: a.to + 6 });
    expect((c.target as { readVersion: number; version: number }).version).toBe(
      s.documents['doc-1']!.version,
    );
  });

  it('enforces caps (light: 5 items)', async () => {
    const s0 = await state(t);
    const used = s0.annotations.agentSessions['fs-1']!.counts.items;
    const a = await anchorAt(t, 'p1.s4', 'house');
    for (let i = used; i < 5; i++) expect((await post(comment(a))).status).toBe(200);
    const over = await post(comment(a));
    expect(over.status).toBe(422);
    expect(over.body.error?.code).toBe('cap-reached');
  });

  it('closes the session after ReviewFinished', async () => {
    const fin = agent('ReviewFinished', {
      feedbackSessionId: 'fs-1',
      summary: 'Done.',
      strengths: [],
      topPriorities: [],
    });
    expect((await post(fin)).status).toBe(200);
    const late = await post(
      agent('QuestionAsked', {
        questionId: 'q-late',
        feedbackSessionId: 'fs-1',
        target: null,
        question: 'Why?',
      }),
    );
    expect(late.status).toBe(409);
    expect(late.body.error?.code).toBe('session-closed');
  });

  it('refuses types a discuss session may not emit', async () => {
    const { token: dt } = await t.handle.service.sessions.open({
      projectId: P,
      accountId: 'acct-1',
      kind: 'discuss',
      threadId: 'th-1',
      sessionId: 'fs-d',
    });
    const r = await post(comment(await anchorAt(t, 'p1.s2', 'rain'), 'fs-d'), dt, 'fs-d');
    expect(r.status).toBe(403);
    expect(r.body.error?.code).toBe('forbidden');
  });

  it('property: random agent drafts never change manuscript text', async () => {
    b.requestFeedback('req-p', {
      scope: { kind: 'document', documentId: 'doc-1' },
      intensity: 'thorough',
    });
    expect(
      (await api(t, 'POST', `/v1/projects/${P}/commits`, draftOf(b.commits.at(-1) as Commit)))
        .status,
    ).toBe(200);
    const { token: pt } = await t.handle.service.sessions.open({
      projectId: P,
      accountId: 'acct-1',
      kind: 'review',
      requestId: 'req-p',
      sessionId: 'fs-p',
    });
    expect(
      (
        await post(
          agent(
            'FeedbackSessionStarted',
            {
              feedbackSessionId: 'fs-p',
              trigger: { kind: 'feedback', requestId: 'req-p' },
              model: 'opus',
            },
            'fs-p',
          ),
          pt,
          'fs-p',
        )
      ).status,
    ).toBe(200);
    const before = await state(t);
    const text = JSON.stringify(
      Object.values(before.documents).map((d) => [d.id, d.content, d.version, d.provenance]),
    );
    const lastHuman = draftOf(lastText()) as CommitDraft & { payload: { baseVersion: number } };
    const docVersion = before.documents['doc-1']!.version;
    const a = await anchorAt(t, 'p1.s1', 'Rain');

    const manuscriptDraft = fc.constantFrom(
      { type: 'TextEdited', payload: { ...lastHuman.payload, baseVersion: docVersion } },
      {
        type: 'ProposalAccepted',
        payload: { proposalId: 'p-x', documentId: 'doc-1', baseVersion: docVersion },
      },
      {
        type: 'DocumentImported',
        payload: {
          documentId: 'doc-x',
          title: 'X',
          parentId: null,
          index: 0,
          content: before.documents['doc-1']!.content,
          sourceFormat: 'text',
          sourceName: null,
          sourceHash: '0'.repeat(64),
        },
      },
    );
    const annotationDraft = fc.record({
      quote: fc.constantFrom('Rain', 'rain fell', 'sideways', 'door', 'zzz', ''),
      sentenceId: fc.constantFrom('p1.s1', 'p1.s2', 'p1.s9', 'x'),
      shift: fc.integer({ min: -3, max: 3 }),
    });
    const draft = fc.oneof(
      manuscriptDraft.map((m) => agent(m.type, m.payload, 'fs-p')),
      annotationDraft.map((x) =>
        comment(
          {
            ...a,
            anchor: {
              documentId: 'doc-1',
              sentenceId: x.sentenceId,
              quote: x.quote,
              occurrence: 0,
            },
            from: a.from + x.shift,
          },
          'fs-p',
        ),
      ),
      fc
        .record({
          kind: fc.constantFrom('human', 'agent', 'system'),
          id: fc.string({ maxLength: 8 }),
        })
        .map((actor) => ({
          ...agent('CommentAdded', { junk: true }, 'fs-p'),
          actor,
        })),
      fc.jsonValue().map((v) => ({ commitId: randomUUID(), projectId: P, garbage: v })),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(draft, { minLength: 1, maxLength: 6 }), async (drafts) => {
        for (const d of drafts) {
          const r = await post(d, pt, 'fs-p');
          expect([200, 400, 403, 409, 422]).toContain(r.status);
        }
        const after = await state(t);
        expect(
          JSON.stringify(
            Object.values(after.documents)
              .filter((d) => d.id in before.documents)
              .map((d) => [d.id, d.content, d.version, d.provenance]),
          ),
        ).toBe(text);
        expect(after.documents['doc-x']).toBeUndefined();
      }),
      { numRuns: Number(process.env.FC_RUNS ?? 25) },
    );
  });
});
