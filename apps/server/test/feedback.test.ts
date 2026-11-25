/**
 * End-to-end agent sessions with `MODEL_ADAPTER=mock`: the request goes in, the
 * real MCP tool server and relay run, annotations reach the ledger through the
 * internal events endpoint and stream out over SSE, and `ReviewFinished` arrives.
 * Also: selection scopes mapped by the fold, Discuss, cancel and shutdown.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@longhand/agent';
import { LedgerBuilder } from '@longhand/ledger';
import type { Commit, CommitDraft, ProjectState } from '@longhand/schema';
import { adapterFactory } from '../src/agent/sessions';
import { startTestServer, type TestServer } from '../src/testing';
import { DB, api, draftOf, readSse } from './helpers';

const P = 'proj-fb';
const TEXT =
  'The rain fell sideways on the harbour. Nobody came to the door. The lamps stayed dark.';

async function setup(t: TestServer): Promise<LedgerBuilder> {
  const b = new LedgerBuilder({ projectId: P, title: 'Feedback' });
  b.createDocument('doc-1', 'Chapter 1');
  b.type('doc-1', TEXT);
  for (const c of b.commits) {
    const r =
      c.type === 'ProjectCreated'
        ? await api(t, 'POST', '/v1/projects', { draft: draftOf(c) })
        : await api(t, 'POST', `/v1/projects/${P}/commits`, draftOf(c));
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  }
  return b;
}

async function state(t: TestServer): Promise<ProjectState> {
  return (await api<{ state: ProjectState }>(t, 'GET', `/v1/projects/${P}/state`)).body.state;
}

function lastDraft(b: LedgerBuilder): CommitDraft {
  return draftOf(b.commits.at(-1) as Commit);
}

describe.skipIf(!DB())('agent sessions (mock model)', () => {
  let t: TestServer;
  let b: LedgerBuilder;
  beforeAll(async () => {
    t = await startTestServer({ adapters: adapterFactory('mock') });
    b = await setup(t);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('streams a review: request in, annotations over SSE, ReviewFinished', async () => {
    const head = (await state(t)).headSeq;
    let opened!: () => void;
    const ready = new Promise<void>((r) => (opened = r));
    const events = readSse(
      `${t.url}/v1/projects/${P}/events?after=${head}`,
      (es) => es.some((e) => (e.data as Commit).type === 'ReviewFinished'),
      { onOpen: () => opened() },
    );
    await ready;
    b.requestFeedback('req-1', {
      scope: { kind: 'document', documentId: 'doc-1' },
      intensity: 'light',
      lenses: ['clarity'],
    });
    const r = await api<{ sessionId: string; status: string; seq: number }>(
      t,
      'POST',
      `/v1/projects/${P}/feedback`,
      {
        draft: lastDraft(b),
      },
    );
    expect(r.status).toBe(201);
    expect(r.body.sessionId).toBeTruthy();
    const progress = await readSse(
      `${t.url}/v1/projects/${P}/sessions/${r.body.sessionId}/events`,
      (es) => es.some((e) => e.event === 'ended'),
    );
    expect(progress.map((e) => e.event)).toEqual(
      expect.arrayContaining(['started', 'annotation', 'finished', 'ended']),
    );
    expect(progress.at(-1)?.data).toMatchObject({ kind: 'ended', status: 'finished' });

    const commits = (await events).map((e) => e.data as Commit);
    const types = commits.map((c) => c.type);
    expect(types).toEqual([
      'FeedbackRequested',
      'FeedbackSessionStarted',
      'CommentAdded',
      'QuestionAsked',
      'ReviewFinished',
    ]);
    expect(commits.map((c) => c.seq)).toEqual(commits.map((_, i) => head + 1 + i));
    for (const c of commits.slice(1)) {
      expect(c.actor.kind).toBe('agent');
      expect(c.sessionId).toBe(r.body.sessionId);
    }

    const s = await state(t);
    const session = s.annotations.agentSessions[r.body.sessionId]!;
    expect(session.status).toBe('finished');
    expect(session.systemPromptVersion).toBeTruthy();
    expect(s.annotations.feedbackRequests['req-1']!.status).toBe('finished');
    const comment = Object.values(s.annotations.comments)[0]!;
    expect(comment.range).not.toBeNull();
    expect(JSON.stringify(s.documents['doc-1']!.content)).toContain(TEXT);
    // A duplicate request returns the same session.
    const again = await api<{ sessionId: string; status: string }>(
      t,
      'POST',
      `/v1/projects/${P}/feedback`,
      { draft: lastDraft(b) },
    );
    expect(again.body).toMatchObject({ status: 'duplicate', sessionId: r.body.sessionId });
  });

  it('passes the selection the fold mapped to the current version', async () => {
    // Select "Nobody came to the door." then type before it, so the selection moves.
    const s0 = await state(t);
    const v0 = s0.documents['doc-1']!.version;
    const from = 1 + TEXT.indexOf('Nobody');
    const to = from + 'Nobody came to the door.'.length;
    b.requestFeedback('req-sel', {
      scope: { kind: 'selection', documentId: 'doc-1', from, to, version: v0 },
      intensity: 'light',
      lenses: ['clarity'],
    });
    const request = lastDraft(b);
    b.type('doc-1', 'Dusk. ', { at: 1 });
    const typed = lastDraft(b);
    // The edit reaches the ledger before the request (positions stay at v0), so the
    // fold maps the selection by 6 characters before the session starts.
    expect((await api(t, 'POST', `/v1/projects/${P}/commits`, typed)).status).toBe(200);
    const r = await api<{ sessionId: string }>(t, 'POST', `/v1/projects/${P}/feedback`, {
      draft: request,
    });
    expect(r.status).toBe(201);
    const progress = await readSse(
      `${t.url}/v1/projects/${P}/sessions/${r.body.sessionId}/events`,
      (es) => es.some((e) => e.event === 'ended'),
    );
    expect(progress.at(-1)?.data).toMatchObject({ status: 'finished' });
    const s = await state(t);
    const scope = s.annotations.feedbackRequests['req-sel']!.scope as { from: number; to: number };
    expect(scope).toMatchObject({ from: from + 6, to: to + 6 });
    // The mock comments on the first sentence of the selection it was shown.
    const comments = Object.values(s.annotations.comments).filter(
      (c) => c.feedbackSessionId === r.body.sessionId,
    );
    expect(comments).toHaveLength(1);
    expect((comments[0]!.target as { anchor: { quote: string } }).anchor.quote).toBe(
      'Nobody came to',
    );
  });

  it('answers a Discuss request', async () => {
    const s0 = await state(t);
    const commentId = Object.keys(s0.annotations.comments)[0]!;
    const draft = {
      commitId: 'discuss-1',
      projectId: P,
      clientTime: new Date().toISOString(),
      actor: { kind: 'human', id: 'writer-1' },
      deviceId: 'device-1',
      sessionId: 'editor-1',
      schemaVersion: 1,
      type: 'DiscussRequested',
      payload: { threadId: 'th-1', targetId: commentId, message: 'Why does this matter?' },
    };
    const r = await api<{ sessionId: string }>(t, 'POST', `/v1/projects/${P}/discuss`, { draft });
    expect(r.status).toBe(201);
    const progress = await readSse(
      `${t.url}/v1/projects/${P}/sessions/${r.body.sessionId}/events`,
      (es) => es.some((e) => e.event === 'ended'),
    );
    expect(progress.at(-1)?.data).toMatchObject({ status: 'finished' });
    const s = await state(t);
    const thread = s.annotations.discussions['th-1']!;
    expect(thread.messages.map((m) => m.role)).toEqual(['writer', 'editor']);
  });
});

describe.skipIf(!DB())('session cancel and shutdown', () => {
  it('cancels a running session and records FeedbackSessionFailed', async () => {
    const t = await startTestServer({ adapters: () => new MockModelAdapter([{ hang: true }]) });
    try {
      const b = await setup(t);
      b.requestFeedback('req-c', {
        scope: { kind: 'document', documentId: 'doc-1' },
        intensity: 'light',
      });
      const r = await api<{ sessionId: string }>(t, 'POST', `/v1/projects/${P}/feedback`, {
        draft: lastDraft(b),
      });
      // Wait until the session started.
      await readSse(`${t.url}/v1/projects/${P}/sessions/${r.body.sessionId}/events`, (es) =>
        es.some((e) => e.event === 'started'),
      );
      const c = await api(t, 'POST', `/v1/projects/${P}/sessions/${r.body.sessionId}/cancel`);
      expect(c.status).toBe(200);
      const s = await state(t);
      const session = s.annotations.agentSessions[r.body.sessionId]!;
      expect(session.status).toBe('failed');
      expect(session.failureReason).toMatch(/cancel/);
      expect(s.annotations.feedbackRequests['req-c']!.status).toBe('failed');
    } finally {
      await t.close();
    }
  });

  it('fails sessions still running at shutdown', async () => {
    const t = await startTestServer({ adapters: () => new MockModelAdapter([{ hang: true }]) });
    try {
      const b = await setup(t);
      b.requestFeedback('req-s', {
        scope: { kind: 'document', documentId: 'doc-1' },
        intensity: 'light',
      });
      const r = await api<{ sessionId: string }>(t, 'POST', `/v1/projects/${P}/feedback`, {
        draft: lastDraft(b),
      });
      await readSse(`${t.url}/v1/projects/${P}/sessions/${r.body.sessionId}/events`, (es) =>
        es.some((e) => e.event === 'started'),
      );
      await t.restart(); // graceful: cancels the session first
      const s = await state(t);
      expect(s.annotations.agentSessions[r.body.sessionId]!.status).toBe('failed');
    } finally {
      await t.close();
    }
  });

  it('fails sessions orphaned by a crash when the project loads again', async () => {
    const t = await startTestServer({ adapters: () => new MockModelAdapter([{ hang: true }]) });
    try {
      const b = await setup(t);
      b.requestFeedback('req-o', {
        scope: { kind: 'document', documentId: 'doc-1' },
        intensity: 'light',
      });
      const r = await api<{ sessionId: string }>(t, 'POST', `/v1/projects/${P}/feedback`, {
        draft: lastDraft(b),
      });
      await readSse(`${t.url}/v1/projects/${P}/sessions/${r.body.sessionId}/events`, (es) =>
        es.some((e) => e.event === 'started'),
      );
      const orphan = t.handle.service.sessions.get(r.body.sessionId)!;
      await t.restart({ crash: true });
      const s = await state(t);
      const session = s.annotations.agentSessions[r.body.sessionId]!;
      expect(session.status).toBe('failed');
      expect(session.failureReason).toMatch(/restarted/);
      orphan.abort.abort(); // stop the old instance's mock run
    } finally {
      await t.close();
    }
  });
});
