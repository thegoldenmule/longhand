/**
 * Shared test helpers: HTTP calls, fixture replay through the HTTP ingest.
 */
import { inject } from 'vitest';
import {
  applyCommit,
  documentNode,
  documentVersion,
  emptyState,
  projectState,
} from '@longhand/ledger';
import type { FixtureFile } from '@longhand/ledger/fixtures';
import { loadFixtureWitnessKey } from '@longhand/ledger/fixtures';
import {
  base64Decode,
  resolveAnchor,
  resolveInsertionPoint,
  resolveMerge,
  resolveMove,
  resolveSpan,
  resolveSplit,
  witnessMessage,
  type Commit,
  type CommitDraft,
} from '@longhand/schema';
import type { Node as PMNode } from 'prosemirror-model';
import type { ClockHooks } from '../src/ledger/project';
import { DevFileSigner, type Signer } from '../src/signer';
import type { TestServer } from '../src/testing';

/** True when Postgres is up (see global-setup). */
export const DB = (): boolean => inject('dbAvailable');

/** A JSON HTTP call. */
export async function api<T = Record<string, unknown>>(
  t: { url: string },
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${t.url}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, body: parsed as T };
}

/** The draft a client sent for a stored commit. */
export function draftOf(c: Commit): CommitDraft {
  const { seq: _s, prevHash: _p, hash: _h, serverTime: _t, accountId: _a, ...draft } = c;
  return draft as unknown as CommitDraft;
}

/** Reads SSE events from a URL until `stop` returns true or the timeout passes. */
export async function readSse(
  url: string,
  stop: (events: Array<{ event: string; data: unknown; id?: string }>) => boolean,
  opts: { timeoutMs?: number; headers?: Record<string, string>; onOpen?: () => void } = {},
): Promise<Array<{ event: string; data: unknown; id?: string }>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 20_000);
  const events: Array<{ event: string; data: unknown; id?: string }> = [];
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      headers: { accept: 'text/event-stream', ...opts.headers },
    });
    if (!res.ok || !res.body) throw new Error(`SSE ${url}: HTTP ${res.status}`);
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let event = 'message';
        let data = '';
        let id: string | undefined;
        for (const line of block.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
          else if (line.startsWith('id:')) id = line.slice(3).trim();
        }
        if (!data && event === 'message') continue;
        if (event === 'ready') {
          opts.onOpen?.();
          continue;
        }
        events.push({ event, data: data ? JSON.parse(data) : null, ...(id ? { id } : {}) });
        if (stop(events)) {
          ac.abort();
          return events;
        }
      }
    }
  } catch (e) {
    if (!ac.signal.aborted) throw e;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Fixture replay
// ---------------------------------------------------------------------------

/**
 * The fixture's test key, returning the fixture's own signatures (ECDSA is
 * randomized) so the replayed chain and witnesses are byte-identical.
 */
export function replaySigner(f: FixtureFile): Signer {
  const key = loadFixtureWitnessKey();
  const real = new DevFileSigner(key.privateKeyPkcs8Pem);
  const queue = new Map<string, string[]>();
  const keyOf = (s: { projectId: string; seq: number; hash: string; serverTime: string }) =>
    Buffer.from(witnessMessage(s)).toString('hex');
  const push = (k: string, sig: string) => queue.set(k, [...(queue.get(k) ?? []), sig]);
  for (const w of f.witnesses) push(keyOf(w), w.signature);
  for (const c of f.commits) {
    if (c.type !== 'ChainHeadWitnessed') continue;
    const p = c.payload as {
      witnessedSeq: number;
      witnessedHash: string;
      serverTime: string;
      signature: string;
    };
    push(
      keyOf({
        projectId: c.projectId,
        seq: p.witnessedSeq,
        hash: p.witnessedHash,
        serverTime: p.serverTime,
      }),
      p.signature,
    );
  }
  return {
    keyId: real.keyId,
    publicKeyPem: real.publicKeyPem,
    async sign(message: Uint8Array) {
      const k = Buffer.from(message).toString('hex');
      const q = queue.get(k);
      const next = q?.shift();
      if (next) return base64Decode(next);
      return real.sign(message);
    },
  };
}

/** serverTime and system envelopes from the fixture, by seq. */
export function fixtureHooks(f: FixtureFile): ClockHooks {
  return {
    serverTime: ({ seq }) =>
      (f.commits[seq - 1] as Commit | undefined)?.serverTime ?? new Date().toISOString(),
    systemEnvelope: ({ seq, serverTime }) => {
      const c = f.commits[seq - 1] as Commit | undefined;
      return c
        ? { commitId: c.commitId, clientTime: c.clientTime }
        : { commitId: `sys-${seq}`, clientTime: serverTime };
    },
  };
}

type DocAt = (documentId: string, version: number) => PMNode;

/** Every document version the fixture passes through. */
function documentVersions(commits: readonly Commit[]): DocAt {
  const versions = new Map<string, Map<number, PMNode>>();
  let state = emptyState();
  for (const c of commits) {
    state = applyCommit(state, c);
    for (const id of Object.keys(projectState(state).documents)) {
      const v = documentVersion(state, id) as number;
      let m = versions.get(id);
      if (!m) versions.set(id, (m = new Map()));
      if (!m.has(v)) m.set(v, documentNode(state, id) as PMNode);
    }
  }
  return (id, v) => {
    const n = versions.get(id)?.get(v);
    if (!n) throw new Error(`no ${id}@${v}`);
    return n;
  };
}

type Stamp = { from: number; to: number; readVersion: number; version: number };

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`fixture target does not resolve: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

/**
 * Rewrites a recorded agent draft into the form an agent sends: positions
 * resolved at `readVersion`, with `version === readVersion`. The service maps them.
 */
export function toReadVersionForm(draft: CommitDraft, docAt: DocAt): CommitDraft {
  const p = structuredClone(draft.payload) as Record<string, unknown>;
  const anchor = (
    t: Stamp & {
      anchor: { documentId: string; sentenceId: string; quote: string; occurrence: number };
    },
  ) => {
    const r = ok(resolveAnchor(docAt(t.anchor.documentId, t.readVersion), t.anchor));
    Object.assign(t, { from: r.from, to: r.to, version: t.readVersion });
  };
  const span = (
    t: Stamp & {
      span: { documentId: string; unit: 'sentence' | 'paragraph' | 'section'; ids: string[] };
    },
  ) => {
    const r = ok(resolveSpan(docAt(t.span.documentId, t.readVersion), t.span));
    Object.assign(t, { from: r.from, to: r.to, version: t.readVersion });
  };
  const target = (t: Record<string, unknown> | null | undefined) => {
    if (!t) return;
    if (t.kind === 'span' || 'span' in t) span(t as never);
    else anchor(t as never);
  };
  switch (draft.type) {
    case 'CommentAdded':
    case 'CutProposed':
    case 'QuestionAsked':
    case 'CitationNeededFlagged':
    case 'SourceSurfaced':
    case 'SourceSuggested':
      target(p.target as Record<string, unknown> | null);
      break;
    case 'SuggestionProposed': {
      const s = p.suggestion as { kind: string; target: Record<string, unknown> };
      if (s.kind === 'insertion') {
        const t = s.target as {
          documentId: string;
          position: 'before' | 'after';
          sentenceId: string;
          pos: number;
          readVersion: number;
          version: number;
        };
        t.pos = ok(
          resolveInsertionPoint(docAt(t.documentId, t.readVersion), t.position, t.sentenceId),
        ).pos;
        t.version = t.readVersion;
      } else target(s.target);
      break;
    }
    case 'MoveProposed': {
      const src = p.source as Stamp & {
        span: { documentId: string; unit: 'sentence' | 'paragraph' | 'section'; ids: string[] };
      };
      const dst = p.destination as { position: 'before' | 'after'; id: string; pos: number };
      const r = ok(resolveMove(docAt(src.span.documentId, src.readVersion), src.span, dst));
      Object.assign(src, { from: r.from, to: r.to, version: src.readVersion });
      dst.pos = r.insertAt;
      break;
    }
    case 'SplitProposed': {
      const s = p as unknown as {
        documentId: string;
        paragraphId: string;
        sentenceId: string;
        pos: number;
        readVersion: number;
        version: number;
      };
      s.pos = ok(resolveSplit(docAt(s.documentId, s.readVersion), s.paragraphId, s.sentenceId)).pos;
      s.version = s.readVersion;
      break;
    }
    case 'MergeProposed': {
      const m = p as unknown as {
        documentId: string;
        firstParagraphId: string;
        secondParagraphId: string;
        joinPos: number;
        from: number;
        to: number;
        readVersion: number;
        version: number;
      };
      const r = ok(
        resolveMerge(docAt(m.documentId, m.readVersion), m.firstParagraphId, m.secondParagraphId),
      );
      Object.assign(m, {
        joinPos: r.joinPos,
        from: r.first.pos,
        to: r.second.end,
        version: m.readVersion,
      });
      break;
    }
    default:
      break;
  }
  return { ...draft, payload: p } as CommitDraft;
}

/** Replays a fixture through the HTTP ingest (public and internal endpoints). */
export async function replayFixture(t: TestServer, f: FixtureFile): Promise<void> {
  const docAt = documentVersions(f.commits as Commit[]);
  const tokens = new Map<string, string>();
  const service = t.handle.service;
  const projectId = (f.commits[0] as Commit).projectId;
  const sessionFor = async (
    sessionId: string,
    kind: 'review' | 'discuss' | 'chat',
    requestId: string | null,
    threadId: string | null,
    chat: { chatId: string; messageId: string } | null = null,
  ) => {
    let tok = tokens.get(sessionId);
    if (!tok) {
      const { token } = await service.sessions.open({
        projectId,
        accountId: 'acct-1',
        kind,
        requestId,
        threadId,
        chat,
        sessionId,
      });
      tokens.set(sessionId, (tok = token));
    }
    return tok;
  };
  let failedSessions = 0;
  for (const c of f.commits as Commit[]) {
    const label = `${f.name} seq ${c.seq} ${c.type}`;
    if (c.actor.kind === 'human') {
      const r =
        c.type === 'ProjectCreated'
          ? await api(t, 'POST', '/v1/projects', { draft: draftOf(c) })
          : await api(t, 'POST', `/v1/projects/${projectId}/commits`, draftOf(c));
      if (r.status >= 300 || (r.body as { seq?: number }).seq !== c.seq) {
        throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
      }
      continue;
    }
    if (c.type === 'SuggestionResolved') continue; // the service appends these itself
    if (c.type === 'ChainHeadWitnessed') {
      const ledger = await service.ledger(projectId);
      const w = await ledger.witnessHead((c.payload as { witnessedSeq: number }).witnessedSeq);
      if (w?.seq !== c.seq) throw new Error(`${label}: embedded witness landed at ${w?.seq}`);
      continue;
    }
    let sessionId: string;
    let token: string;
    if (c.type === 'FeedbackSessionStarted') {
      const p = c.payload as {
        feedbackSessionId: string;
        trigger:
          | { kind: 'feedback'; requestId: string }
          | { kind: 'discuss'; threadId: string }
          | { kind: 'chat'; chatId: string; messageId: string };
      };
      sessionId = p.feedbackSessionId;
      const tr = p.trigger;
      token =
        tr.kind === 'feedback'
          ? await sessionFor(sessionId, 'review', tr.requestId, null)
          : tr.kind === 'chat'
            ? await sessionFor(sessionId, 'chat', null, null, {
                chatId: tr.chatId,
                messageId: tr.messageId,
              })
            : await sessionFor(sessionId, 'discuss', null, tr.threadId);
    } else if (c.type === 'FeedbackSessionFailed') {
      const p = c.payload as {
        feedbackSessionId: string | null;
        requestId: string | null;
        threadId: string | null;
        chat?: { chatId: string; messageId: string };
      };
      sessionId = p.feedbackSessionId ?? `never-started-${++failedSessions}`;
      token =
        tokens.get(sessionId) ??
        (await sessionFor(
          sessionId,
          p.chat ? 'chat' : p.threadId ? 'discuss' : 'review',
          p.requestId,
          p.threadId,
          p.chat ?? null,
        ));
    } else {
      sessionId = (c.payload as { feedbackSessionId: string }).feedbackSessionId;
      token = tokens.get(sessionId) as string;
    }
    const draft = toReadVersionForm(draftOf(c), docAt);
    const r = await api(
      t,
      'POST',
      `/internal/sessions/${encodeURIComponent(sessionId)}/events`,
      draft,
      {
        authorization: `Bearer ${token}`,
      },
    );
    if (r.status !== 200 || (r.body as { seq?: number }).seq !== c.seq) {
      throw new Error(`${label}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
}
