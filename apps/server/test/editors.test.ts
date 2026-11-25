/**
 * Named editors: the account roster over HTTP (seeding, CRUD, validation,
 * account scoping, reset, rebuild leaves it alone), and the editor a
 * FeedbackRequested names reaching the agent's prompt through the session runner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter, type ModelAdapter, type ModelRunInput } from '@longhand/agent';
import { LedgerBuilder } from '@longhand/ledger';
import {
  STARTER_EDITORS,
  feedbackEditorOf,
  type Commit,
  type EditorProfile,
  type ProjectState,
} from '@longhand/schema';
import type { Authenticator } from '../src/auth';
import { adapterFactory } from '../src/agent/sessions';
import { MAX_EDITORS } from '../src/storage/editors';
import { startTestServer, type TestServer } from '../src/testing';
import { HttpError } from '../src/util';
import { DB, api, draftOf, readSse } from './helpers';

/** Bearer token `acct-x` signs in account `acct-x` (writer `writer-x`). */
const tokenAuth: Authenticator = {
  mode: 'dev',
  async authenticate(token) {
    if (!token) throw new HttpError(401, 'unauthorized', 'no token');
    return { accountId: token, actorId: token.replace('acct', 'writer') };
  },
};
const as = (acct: string) => ({ authorization: `Bearer ${acct}` });

const theo = {
  name: '  Theo  ',
  brief: 'A blunt line editor who hates adverbs.',
  lenses: ['clarity', 'word-choice'],
  intensity: 'standard',
  questions: ['Which words would you cut?', '  '],
};

describe.skipIf(!DB())('editors API', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer({ auth: tokenAuth });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('seeds the starter editors on first read, once', async () => {
    const a = await api<{ editors: EditorProfile[] }>(
      t,
      'GET',
      '/v1/editors',
      undefined,
      as('acct-a'),
    );
    expect(a.status).toBe(200);
    expect(a.body.editors.map((e) => e.name)).toEqual(STARTER_EDITORS.map((s) => s.name));
    expect(a.body.editors[0]).toMatchObject({
      lenses: STARTER_EDITORS[0]!.lenses,
      intensity: STARTER_EDITORS[0]!.intensity,
      questions: STARTER_EDITORS[0]!.questions,
    });
    const again = await api<{ editors: EditorProfile[] }>(
      t,
      'GET',
      '/v1/editors',
      undefined,
      as('acct-a'),
    );
    expect(again.body.editors.map((e) => e.id)).toEqual(a.body.editors.map((e) => e.id));
  });

  it('seeds concurrently without duplicates', async () => {
    const rs = await Promise.all(
      Array.from({ length: 5 }, () =>
        api<{ editors: EditorProfile[] }>(t, 'GET', '/v1/editors', undefined, as('acct-race')),
      ),
    );
    for (const r of rs) expect(r.status).toBe(200);
    const final = await api<{ editors: EditorProfile[] }>(
      t,
      'GET',
      '/v1/editors',
      undefined,
      as('acct-race'),
    );
    expect(final.body.editors).toHaveLength(STARTER_EDITORS.length);
  });

  it('creates, reads, updates and deletes, normalizing the input', async () => {
    const c = await api<{ editor: EditorProfile }>(t, 'POST', '/v1/editors', theo, as('acct-b'));
    expect(c.status).toBe(201);
    const ed = c.body.editor;
    expect(ed).toMatchObject({
      name: 'Theo',
      lenses: ['clarity', 'word-choice'],
      questions: ['Which words would you cut?'],
    });
    const list = await api<{ editors: EditorProfile[] }>(
      t,
      'GET',
      '/v1/editors',
      undefined,
      as('acct-b'),
    );
    // The starters were seeded first; the new editor comes last.
    expect(list.body.editors.map((e) => e.name)).toEqual([
      ...STARTER_EDITORS.map((s) => s.name),
      'Theo',
    ]);
    const u = await api<{ editor: EditorProfile }>(
      t,
      'PUT',
      `/v1/editors/${ed.id}`,
      { ...theo, name: 'Theodora', lenses: ['word-choice', 'structure'], intensity: 'thorough' },
      as('acct-b'),
    );
    expect(u.status).toBe(200);
    // Lenses come back in display order.
    expect(u.body.editor).toMatchObject({
      id: ed.id,
      name: 'Theodora',
      lenses: ['structure', 'word-choice'],
      intensity: 'thorough',
    });
    const g = await api<{ editor: EditorProfile }>(
      t,
      'GET',
      `/v1/editors/${ed.id}`,
      undefined,
      as('acct-b'),
    );
    expect(g.body.editor.name).toBe('Theodora');
    const d = await api(t, 'DELETE', `/v1/editors/${ed.id}`, undefined, as('acct-b'));
    expect(d.status).toBe(200);
    expect((await api(t, 'GET', `/v1/editors/${ed.id}`, undefined, as('acct-b'))).status).toBe(404);
    expect((await api(t, 'DELETE', `/v1/editors/${ed.id}`, undefined, as('acct-b'))).status).toBe(
      404,
    );
  });

  it('rejects invalid editors with 422 invalid-editor', async () => {
    for (const bad of [
      { ...theo, name: ' ' },
      { ...theo, lenses: [] },
      { ...theo, lenses: ['nope'] },
      { ...theo, intensity: 'heavy' },
      { ...theo, brief: 'x'.repeat(601) },
      { ...theo, questions: ['a?', 'b?', 'c?', 'd?', 'e?', 'f?'] },
      'not json',
    ]) {
      const r = await api<{ error: { code: string } }>(t, 'POST', '/v1/editors', bad, as('acct-c'));
      expect(r.status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
      if (typeof bad !== 'string') expect(r.body.error.code).toBe('invalid-editor');
    }
    const r = await api(t, 'PUT', '/v1/editors/whatever', { ...theo, lenses: [] }, as('acct-c'));
    expect(r.status).toBe(422);
  });

  it('scopes editors to the account', async () => {
    const mine = await api<{ editor: EditorProfile }>(t, 'POST', '/v1/editors', theo, as('acct-d'));
    const id = mine.body.editor.id;
    const other = await api<{ editors: EditorProfile[] }>(
      t,
      'GET',
      '/v1/editors',
      undefined,
      as('acct-e'),
    );
    expect(other.body.editors.some((e) => e.id === id)).toBe(false);
    expect((await api(t, 'GET', `/v1/editors/${id}`, undefined, as('acct-e'))).status).toBe(404);
    expect((await api(t, 'PUT', `/v1/editors/${id}`, theo, as('acct-e'))).status).toBe(404);
    expect((await api(t, 'DELETE', `/v1/editors/${id}`, undefined, as('acct-e'))).status).toBe(404);
    expect((await api(t, 'GET', `/v1/editors/${id}`, undefined, as('acct-d'))).status).toBe(200);
    expect((await api(t, 'GET', '/v1/editors')).status).toBe(401);
  });

  it('keeps an emptied roster empty, and resets to the starters', async () => {
    const list = await api<{ editors: EditorProfile[] }>(
      t,
      'GET',
      '/v1/editors',
      undefined,
      as('acct-f'),
    );
    for (const e of list.body.editors)
      expect((await api(t, 'DELETE', `/v1/editors/${e.id}`, undefined, as('acct-f'))).status).toBe(
        200,
      );
    const empty = await api<{ editors: EditorProfile[] }>(
      t,
      'GET',
      '/v1/editors',
      undefined,
      as('acct-f'),
    );
    expect(empty.body.editors).toEqual([]);
    await api(t, 'POST', '/v1/editors', theo, as('acct-f'));
    const reset = await api<{ editors: EditorProfile[] }>(
      t,
      'POST',
      '/v1/editors/reset',
      undefined,
      as('acct-f'),
    );
    expect(reset.status).toBe(200);
    expect(reset.body.editors.map((e) => e.name)).toEqual(STARTER_EDITORS.map((s) => s.name));
    expect(reset.body.editors.every((e) => !list.body.editors.some((o) => o.id === e.id))).toBe(
      true,
    );
  });

  it(`caps a roster at ${MAX_EDITORS}`, async () => {
    for (let i = STARTER_EDITORS.length; i < MAX_EDITORS; i++)
      expect((await api(t, 'POST', '/v1/editors', theo, as('acct-g'))).status).toBe(201);
    const r = await api<{ error: { code: string } }>(t, 'POST', '/v1/editors', theo, as('acct-g'));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('too-many-editors');
  });

  it('allows PUT and DELETE from the web origin (CORS)', async () => {
    const res = await fetch(`${t.url}/v1/editors/x`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:3100',
        'access-control-request-method': 'DELETE',
      },
    });
    expect(res.headers.get('access-control-allow-methods')).toMatch(/DELETE/);
    expect(res.headers.get('access-control-allow-methods')).toMatch(/PUT/);
  });

  it('survives a read-model rebuild', async () => {
    const before = await api<{ editors: EditorProfile[] }>(
      t,
      'GET',
      '/v1/editors',
      undefined,
      as('acct-a'),
    );
    await t.handle.service.rebuild();
    const after = await api<{ editors: EditorProfile[] }>(
      t,
      'GET',
      '/v1/editors',
      undefined,
      as('acct-a'),
    );
    expect(after.body.editors).toEqual(before.body.editors);
  });
});

describe.skipIf(!DB())('a feedback request names its editor', () => {
  const P = 'proj-ed';
  const prompts: ModelRunInput[] = [];
  let t: TestServer;
  beforeAll(async () => {
    const mock = adapterFactory('mock');
    t = await startTestServer({
      adapters: (ctx) => {
        const inner: ModelAdapter = mock(ctx);
        return {
          name: inner.name,
          run: (input) => {
            prompts.push(input);
            return inner.run(input);
          },
        } satisfies ModelAdapter;
      },
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('records the editor in the ledger and passes its brief to the agent', async () => {
    const ed = (await api<{ editors: EditorProfile[] }>(t, 'GET', '/v1/editors')).body.editors.find(
      (e) => e.name === 'Theo',
    )!;
    const b = new LedgerBuilder({ projectId: P, title: 'Editors' });
    b.createDocument('doc-1', 'Chapter 1');
    b.type('doc-1', 'The rain fell sideways on the harbour. Nobody came to the door.');
    b.requestFeedback('req-ed', {
      scope: { kind: 'document', documentId: 'doc-1' },
      lenses: ed.lenses,
      intensity: ed.intensity,
      ask: ed.questions[0]!,
      editor: feedbackEditorOf(ed),
    });
    for (const c of b.commits.slice(0, -1)) {
      const r =
        c.type === 'ProjectCreated'
          ? await api(t, 'POST', '/v1/projects', { draft: draftOf(c) })
          : await api(t, 'POST', `/v1/projects/${P}/commits`, draftOf(c));
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    }
    const r = await api<{ sessionId: string }>(t, 'POST', `/v1/projects/${P}/feedback`, {
      draft: draftOf(b.commits.at(-1) as Commit),
    });
    expect(r.status).toBe(201);
    const progress = await readSse(
      `${t.url}/v1/projects/${P}/sessions/${r.body.sessionId}/events`,
      (es) => es.some((e) => e.event === 'ended'),
    );
    expect(progress.at(-1)?.data).toMatchObject({ status: 'finished' });

    const state = (await api<{ state: ProjectState }>(t, 'GET', `/v1/projects/${P}/state`)).body
      .state;
    expect(state.annotations.feedbackRequests['req-ed']).toMatchObject({
      editor: { id: ed.id, name: 'Theo', brief: ed.brief },
      lenses: ed.lenses,
      intensity: ed.intensity,
    });
    const commits = (await api<{ commits: Commit[] }>(t, 'GET', `/v1/projects/${P}/commits`)).body
      .commits;
    expect(commits.find((c) => c.type === 'FeedbackRequested')?.payload).toMatchObject({
      editor: feedbackEditorOf(ed),
    });
    // The session runner handed the editor to the agent.
    const run = prompts.find((p) => p.sessionKind === 'review')!;
    expect(run.prompt).toContain('The writer asked their editor "Theo".');
    expect(run.prompt).toContain(`"""${ed.brief}"""`);
    expect(run.allowedTools.every((x) => x.startsWith('mcp__longhand__'))).toBe(true);
  });

  it('a request without an editor still works (mock reviewer)', async () => {
    const t2 = await startTestServer({ adapters: () => new MockModelAdapter([]) });
    try {
      const b = new LedgerBuilder({ projectId: 'proj-ne', title: 'No editor' });
      b.createDocument('doc-1', 'Chapter 1');
      b.type('doc-1', 'One line.');
      b.requestFeedback('req-ne', { scope: { kind: 'document', documentId: 'doc-1' } });
      for (const c of b.commits.slice(0, -1)) {
        const r =
          c.type === 'ProjectCreated'
            ? await api(t2, 'POST', '/v1/projects', { draft: draftOf(c) })
            : await api(t2, 'POST', `/v1/projects/proj-ne/commits`, draftOf(c));
        expect(r.status).toBeLessThan(300);
      }
      const r = await api(t2, 'POST', `/v1/projects/proj-ne/feedback`, {
        draft: draftOf(b.commits.at(-1) as Commit),
      });
      expect(r.status).toBe(201);
      const st = (await api<{ state: ProjectState }>(t2, 'GET', `/v1/projects/proj-ne/state`)).body
        .state;
      expect('editor' in st.annotations.feedbackRequests['req-ne']!).toBe(false);
    } finally {
      await t2.close();
    }
  });
});
