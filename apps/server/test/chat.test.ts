/**
 * The feedback chat with `MODEL_ADAPTER=mock`: a message in, the agent session
 * started for it, a reply (and, for "review", notes first) over SSE, the
 * conversation folded in order, a message about a note, cancel, and messages sent
 * through `POST /commits` (the editor's queue) starting sessions too.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockModelAdapter } from '@longhand/agent';
import { LedgerBuilder } from '@longhand/ledger';
import type { Commit, CommitDraft, ProjectState } from '@longhand/schema';
import { MOCK_CHAT_REPLIES } from '../src/agent/mock-script';
import { adapterFactory } from '../src/agent/sessions';
import { startTestServer, type TestServer } from '../src/testing';
import { DB, api, draftOf, readSse } from './helpers';

const TEXT =
  'The rain fell sideways on the harbour. Nobody came to the door. The lamps stayed dark.';
const editor = { id: 'ed-1', name: 'Iris', role: 'Line editor', brief: 'Moves, then words.' };

async function setup(t: TestServer, projectId: string): Promise<LedgerBuilder> {
  const b = new LedgerBuilder({ projectId, title: 'Chat' });
  b.createDocument('doc-1', 'Chapter 1');
  b.type('doc-1', TEXT);
  for (const c of b.commits) {
    const r =
      c.type === 'ProjectCreated'
        ? await api(t, 'POST', '/v1/projects', { draft: draftOf(c) })
        : await api(t, 'POST', `/v1/projects/${projectId}/commits`, draftOf(c));
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  }
  return b;
}

const last = (b: LedgerBuilder): CommitDraft => draftOf(b.commits.at(-1) as Commit);

async function state(t: TestServer, pid: string): Promise<ProjectState> {
  return (await api<{ state: ProjectState }>(t, 'GET', `/v1/projects/${pid}/state`)).body.state;
}

async function commits(t: TestServer, pid: string): Promise<Commit[]> {
  return (await api<{ commits: Commit[] }>(t, 'GET', `/v1/projects/${pid}/commits`)).body.commits;
}

async function ended(t: TestServer, pid: string, sessionId: string) {
  const events = await readSse(`${t.url}/v1/projects/${pid}/sessions/${sessionId}/events`, (es) =>
    es.some((e) => e.event === 'ended'),
  );
  return events;
}

describe.skipIf(!DB())('feedback chat (mock model)', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await startTestServer({ adapters: adapterFactory('mock') });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('a plain question gets a reply only; "review" leaves notes then replies', async () => {
    const pid = 'proj-chat';
    const b = await setup(t, pid);
    b.sendChat('chat-1', 'm-1', 'Is the title working?', {
      editor,
      lenses: ['structure', 'word-choice'],
      intensity: 'standard',
      scope: { kind: 'document', documentId: 'doc-1' },
    });
    const r1 = await api<{ sessionId: string }>(t, 'POST', `/v1/projects/${pid}/chat`, {
      draft: last(b),
    });
    expect(r1.status).toBe(201);
    const p1 = await ended(t, pid, r1.body.sessionId);
    expect(p1.at(-1)?.data).toMatchObject({ status: 'finished' });

    b.sendChat('chat-1', 'm-2', 'Please review the opening.', {
      editor,
      lenses: ['structure', 'word-choice'],
      intensity: 'standard',
      scope: { kind: 'document', documentId: 'doc-1' },
    });
    const r2 = await api<{ sessionId: string }>(t, 'POST', `/v1/projects/${pid}/chat`, {
      draft: last(b),
    });
    expect(r2.status).toBe(201);
    const p2 = await ended(t, pid, r2.body.sessionId);
    // Notes stream as annotations before the reply.
    expect(p2.filter((e) => e.event === 'annotation').length).toBeGreaterThan(1);

    const all = await commits(t, pid);
    const agent = all.filter((c) => c.actor.kind === 'agent').map((c) => c.type);
    expect(agent).toEqual([
      'FeedbackSessionStarted',
      'ChatReplied',
      'FeedbackSessionStarted',
      'CommentAdded',
      'QuestionAsked',
      'SuggestionProposed',
      'MoveProposed',
      'ChatReplied',
    ]);
    const s = await state(t, pid);
    const chat = s.annotations.chats['chat-1']!;
    expect(
      chat.messages.map((m) => `${m.role}:${m.role === 'writer' ? m.status : m.body}`),
    ).toEqual([
      'writer:answered',
      `editor:${MOCK_CHAT_REPLIES.plain}`,
      'writer:answered',
      `editor:${MOCK_CHAT_REPLIES.review}`,
    ]);
    expect(chat.messages[1]).toMatchObject({ editor: { name: 'Iris' } });
    const review = s.annotations.agentSessions[r2.body.sessionId]!;
    expect(review).toMatchObject({ kind: 'chat', chatId: 'chat-1', messageId: 'm-2' });
    expect(review.annotationIds).toHaveLength(4);
    expect(s.annotations.agentSessions[r1.body.sessionId]!.annotationIds).toEqual([]);
    // The manuscript is exactly what the writer typed.
    expect(Object.values(s.documents)[0]!.content).toEqual(b.project.documents['doc-1']!.content);
  });

  it('a message about a note answers about it; ChatMessageSent through /commits starts a session too', async () => {
    const pid = 'proj-chat-about';
    const b = await setup(t, pid);
    b.sendChat('chat-a', 'm-1', 'Review this.', {
      editor,
      lenses: ['clarity'],
      intensity: 'light',
      scope: { kind: 'document', documentId: 'doc-1' },
    });
    const r1 = await api<{ sessionId: string }>(t, 'POST', `/v1/projects/${pid}/chat`, {
      draft: last(b),
    });
    await ended(t, pid, r1.body.sessionId);
    const comment = Object.keys((await state(t, pid)).annotations.comments)[0]!;

    // The editor's queue posts human events to /commits; the service starts the session.
    const head = (await commits(t, pid)).length;
    // (The local builder cannot see the server's notes, so set aboutId on its draft.)
    b.sendChat('chat-a', 'm-2', 'Why does this note matter?', {
      editor,
      lenses: ['clarity'],
      intensity: 'light',
      scope: { kind: 'document', documentId: 'doc-1' },
    });
    const draft = last(b) as CommitDraft & { payload: { context: { aboutId: string | null } } };
    draft.payload.context.aboutId = comment;
    const r = await api(t, 'POST', `/v1/projects/${pid}/commits`, draft);
    expect(r.status).toBe(200);
    await readSse(`${t.url}/v1/projects/${pid}/events?after=${head}`, (es) =>
      es.some((e) => (e.data as Commit).type === 'ChatReplied'),
    );
    const chat = (await state(t, pid)).annotations.chats['chat-a']!;
    const replyTo = chat.messages.at(-1)!;
    expect(replyTo).toMatchObject({
      role: 'editor',
      body: MOCK_CHAT_REPLIES.about,
      replyTo: 'm-2',
    });
    expect(chat.messages[2]).toMatchObject({ role: 'writer', aboutId: comment });
  });

  it('a chat session obeys its message intensity caps on the internal route', async () => {
    const t = await startTestServer({ autoStartSessions: false });
    try {
      const pid = 'proj-chat-caps';
      const b = await setup(t, pid);
      b.sendChat('chat-c', 'm-1', 'Notes please.', {
        editor,
        intensity: 'light',
        scope: { kind: 'document', documentId: 'doc-1' },
      });
      await api(t, 'POST', `/v1/projects/${pid}/commits`, last(b));
      // Replay a session by hand: light touch allows 2 questions.
      const svc = t.handle.service;
      const { token } = await svc.sessions.open({
        projectId: pid,
        accountId: 'acct-1',
        kind: 'chat',
        chat: { chatId: 'chat-c', messageId: 'm-1' },
        sessionId: 'fs-manual',
      });
      b.startChat('fs-manual', 'chat-c', 'm-1');
      const post = (d: CommitDraft) =>
        api(t, 'POST', `/internal/sessions/fs-manual/events`, d, {
          authorization: `Bearer ${token}`,
        });
      expect((await post(last(b))).status).toBe(200);
      for (const q of ['q1', 'q2']) {
        b.question('fs-manual', q, `Question ${q}?`);
        expect((await post(last(b))).status).toBe(200);
      }
      const third = { ...last(b), commitId: 'c-third' } as CommitDraft;
      (third.payload as { questionId: string }).questionId = 'q3';
      const r = await post(third);
      expect(r.status).toBe(422);
      expect((r.body as { error: { code: string } }).error.code).toBe('cap-reached');
      // finish_review is not a chat event.
      b.replyInChat('fs-manual', 'chat-c', 'm-1', 'Two questions for you.');
      const reply = last(b);
      const review = {
        ...reply,
        commitId: 'c-review',
        type: 'ReviewFinished',
        payload: { feedbackSessionId: 'fs-manual', summary: 'x', strengths: [], topPriorities: [] },
      } as CommitDraft;
      expect((await post(review)).status).toBe(403);
      expect((await post(reply)).status).toBe(200);
    } finally {
      await t.close();
    }
  });
});

describe.skipIf(!DB())('feedback chat: cancel', () => {
  it('Stop cancels the session; the message fails and nothing else lands', async () => {
    const t = await startTestServer({ adapters: () => new MockModelAdapter([{ hang: true }]) });
    try {
      const pid = 'proj-chat-cancel';
      const b = await setup(t, pid);
      b.sendChat('chat-x', 'm-1', 'Review this.', {
        editor,
        scope: { kind: 'document', documentId: 'doc-1' },
      });
      const r = await api<{ sessionId: string }>(t, 'POST', `/v1/projects/${pid}/chat`, {
        draft: last(b),
      });
      await readSse(`${t.url}/v1/projects/${pid}/sessions/${r.body.sessionId}/events`, (es) =>
        es.some((e) => e.event === 'started'),
      );
      const c = await api(t, 'POST', `/v1/projects/${pid}/sessions/${r.body.sessionId}/cancel`);
      expect(c.status).toBe(200);
      const s = await state(t, pid);
      expect(s.annotations.agentSessions[r.body.sessionId]!.status).toBe('failed');
      expect(s.annotations.chats['chat-x']!.messages[0]).toMatchObject({ status: 'failed' });
    } finally {
      await t.close();
    }
  });
});
