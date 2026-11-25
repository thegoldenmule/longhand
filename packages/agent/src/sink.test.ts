import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpAnnotationSink,
  InMemoryAnnotationSink,
  SessionRelay,
  agentDraft,
  interpretResponse,
  sessionFailedDraft,
  sessionEventsPath,
  type SinkDraft,
} from './index';
import { deterministic } from './fixtures.test-helpers';

const ctx = { projectId: 'proj1', feedbackSessionId: 'fs1', model: 'sonnet', ...deterministic() };
const comment = (body = 'A note.') =>
  agentDraft(ctx, 'CommentAdded', {
    commentId: 'c1',
    feedbackSessionId: 'fs1',
    target: {
      kind: 'anchor',
      anchor: { documentId: 'ch1', sentenceId: 'p1.s1', quote: 'rain', occurrence: 0 },
      from: 5,
      to: 9,
      readVersion: 3,
      version: 3,
    },
    category: 'clarity',
    severity: 'minor',
    body,
  });
const finish = () =>
  agentDraft(ctx, 'ReviewFinished', {
    feedbackSessionId: 'fs1',
    summary: 'Done.',
    strengths: [],
    topPriorities: [],
  });

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function fakeLedger(
  handler: (req: IncomingMessage, body: string, n: number) => { status: number; body: unknown },
) {
  const seen: Array<{ url: string; auth: string | undefined; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body });
      const r = handler(req, body, seen.length);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, seen };
}

describe('HttpAnnotationSink', () => {
  it('POSTs the draft to /internal/sessions/:id/events with the bearer token', async () => {
    const ledger = await fakeLedger(() => ({
      status: 200,
      body: { ok: true, seq: 42, commitId: 'x', duplicate: false },
    }));
    const sink = new HttpAnnotationSink({
      baseUrl: ledger.baseUrl,
      feedbackSessionId: 'fs1',
      token: 'tok',
    });
    const d = comment();
    const r = await sink.append(d);
    expect(r).toEqual({ ok: true, seq: 42, commitId: 'x', duplicate: false });
    expect(ledger.seen[0]).toMatchObject({
      url: '/internal/sessions/fs1/events',
      auth: 'Bearer tok',
    });
    expect(JSON.parse(ledger.seen[0]!.body)).toEqual(d);
  });

  it('returns 4xx errors without retrying', async () => {
    const ledger = await fakeLedger(() => ({
      status: 422,
      body: { ok: false, error: { code: 'quote-not-found', message: 'The quote moved.' } },
    }));
    const sink = new HttpAnnotationSink({
      baseUrl: ledger.baseUrl,
      feedbackSessionId: 'fs1',
      token: 't',
    });
    const r = await sink.append(comment());
    expect(r).toEqual({
      ok: false,
      error: { code: 'quote-not-found', message: 'The quote moved.', retryable: false },
    });
    expect(ledger.seen).toHaveLength(1);
  });

  it('retries 5xx with the same commitId', async () => {
    const ledger = await fakeLedger((_req, _body, n) =>
      n < 3
        ? { status: 503, body: { ok: false, error: { code: 'busy', message: 'later' } } }
        : { status: 200, body: { ok: true, seq: 7, commitId: 'x', duplicate: true } },
    );
    const sink = new HttpAnnotationSink({
      baseUrl: ledger.baseUrl,
      feedbackSessionId: 'fs1',
      token: 't',
      backoffMs: 1,
    });
    const r = await sink.append(comment());
    expect(r.ok && r.duplicate).toBe(true);
    const ids = ledger.seen.map((s) => (JSON.parse(s.body) as { commitId: string }).commitId);
    expect(new Set(ids).size).toBe(1);
    expect(ids).toHaveLength(3);
  });

  it('reports an unreachable ledger as retryable', async () => {
    const sink = new HttpAnnotationSink({
      baseUrl: 'http://127.0.0.1:1',
      feedbackSessionId: 'fs1',
      token: 't',
      maxAttempts: 1,
    });
    const r = await sink.append(comment());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: 'unavailable', retryable: true });
  });

  it('interpretResponse maps statuses', () => {
    expect(
      interpretResponse(409, { ok: false, error: { code: 'session-closed', message: 'm' } }, 'c'),
    ).toEqual({ ok: false, error: { code: 'session-closed', message: 'm', retryable: false } });
    expect(interpretResponse(500, null, 'c')).toMatchObject({
      ok: false,
      error: { retryable: true },
    });
    expect(interpretResponse(200, { ok: true, seq: 3 }, 'c')).toEqual({
      ok: true,
      seq: 3,
      commitId: 'c',
      duplicate: false,
    });
    expect(sessionEventsPath('a b')).toBe('/internal/sessions/a%20b/events');
  });
});

describe('InMemoryAnnotationSink', () => {
  it('validates, dedupes by commitId and assigns seqs', async () => {
    const sink = new InMemoryAnnotationSink({ startSeq: 10 });
    const d = comment();
    expect(await sink.append(d)).toMatchObject({ ok: true, seq: 10, duplicate: false });
    expect(await sink.append(d)).toMatchObject({ ok: true, seq: 10, duplicate: true });
    const bad = { ...comment(), type: 'TextEdited' } as unknown as SinkDraft;
    expect(await sink.append(bad)).toMatchObject({ ok: false, error: { code: 'invalid-draft' } });
    expect(sink.drafts).toHaveLength(1);
  });

  it('accepts the system FeedbackSessionFailed draft', async () => {
    const sink = new InMemoryAnnotationSink();
    const d = sessionFailedDraft(ctx, {
      feedbackSessionId: 'fs1',
      requestId: 'r1',
      threadId: null,
      reason: 'x'.repeat(900),
    });
    expect(d.actor).toEqual({ kind: 'system', id: 'agent-runner' });
    expect(d.payload.reason.length).toBe(500);
    expect((await sink.append(d)).ok).toBe(true);
  });
});

describe('SessionRelay (second line of defense)', () => {
  async function relayWith(sessionKind: 'review' | 'discuss' = 'review') {
    const sink = new InMemoryAnnotationSink();
    const relay = new SessionRelay({
      projectId: 'proj1',
      feedbackSessionId: 'fs1',
      sessionKind,
      intensity: 'light',
      sink,
    });
    const addr = await relay.start();
    servers.push({ close: () => void relay.close() });
    const post = async (body: unknown, token = addr.token, path = sessionEventsPath('fs1')) => {
      const res = await fetch(new URL(path, addr.baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return {
        status: res.status,
        body: (await res.json()) as { ok: boolean; error?: { code: string } },
      };
    };
    return { sink, relay, post };
  }

  it('requires the session token', async () => {
    const { post, sink } = await relayWith();
    expect((await post(comment(), 'wrong')).status).toBe(401);
    expect(sink.drafts).toHaveLength(0);
  });

  it('refuses anything but this session’s annotation drafts', async () => {
    const { post, sink } = await relayWith();
    const textEdited = {
      ...comment(),
      actor: { kind: 'human', id: 'u1' },
      type: 'TextEdited',
      payload: {
        documentId: 'ch1',
        baseVersion: 3,
        steps: [
          {
            stepType: 'replace',
            from: 1,
            to: 1,
            slice: { content: [{ type: 'text', text: 'AI words' }] },
          },
        ],
        runs: [{ steps: 1, method: 'typed' }],
        timeline: [],
        characters: 8,
        durationMs: 0,
      },
    };
    const r1 = await post(textEdited);
    expect(r1.status).toBe(403);
    expect(
      (await post({ ...comment(), actor: { kind: 'agent', id: 'x' }, type: 'TextEdited' })).status,
    ).toBe(400);
    expect((await post({ ...comment(), sessionId: 'other' })).status).toBe(403);
    expect((await post({ ...comment(), projectId: 'other' })).status).toBe(403);
    const started = agentDraft(ctx, 'FeedbackSessionStarted', {
      feedbackSessionId: 'fs1',
      trigger: { kind: 'feedback', requestId: 'r1' },
      model: 'sonnet',
    });
    expect((await post(started)).status).toBe(403);
    expect((await post({ not: 'a draft' })).status).toBe(400);
    expect(sink.drafts).toHaveLength(0);
  });

  it('enforces caps, dedupes resends and closes after ReviewFinished', async () => {
    const { post, sink, relay } = await relayWith();
    const first = comment();
    expect((await post(first)).status).toBe(200);
    expect((await post(first)).status).toBe(200); // resend: deduped
    for (let i = 0; i < 4; i++) expect((await post(comment())).status).toBe(200);
    const capped = await post(comment());
    expect(capped.status).toBe(422);
    expect(capped.body.error?.code).toBe('cap-reached');
    expect((await post(finish())).status).toBe(200);
    expect(relay.finished).toBe(true);
    const late = await post(comment());
    expect(late.status).toBe(409);
    expect(late.body.error?.code).toBe('session-closed');
    expect(sink.drafts.map((d) => d.draft.type)).toEqual([
      ...Array(5).fill('CommentAdded'),
      'ReviewFinished',
    ]);
  });

  it('discuss sessions accept only DiscussAnswered', async () => {
    const { post } = await relayWith('discuss');
    expect((await post(comment())).status).toBe(403);
    const answer = agentDraft(ctx, 'DiscussAnswered', {
      feedbackSessionId: 'fs1',
      threadId: 't1',
      targetId: 'x',
      body: 'Because.',
    });
    expect((await post(answer)).status).toBe(200);
  });
});
