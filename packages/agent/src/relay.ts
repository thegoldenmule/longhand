/**
 * The session relay: a loopback HTTP server the runner starts for each session.
 *
 * The MCP tool server runs as a child of the `claude` CLI, so it cannot call the
 * runner's in-process {@link AnnotationSink} or {@link SourceSearch} directly. It
 * talks to this relay instead, over the same events contract as the ledger
 * service (`POST /internal/sessions/:id/events`, bearer token). The relay is the
 * second line of defense: it re-validates every draft (schema, actor, session,
 * allowed type for the session kind, caps, closed session) before forwarding it to
 * the real sink, so nothing but valid annotation events can reach the sink.
 *
 * `POST /internal/sessions/:id/search` with `{query, limit}` proxies to the
 * injected `SourceSearch` and answers `{ok: true, items: CslItem[]}`.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  capViolation,
  countCall,
  type AgentSessionKind,
  type CslItem,
  type Intensity,
  type SessionCounts,
  type ToolName,
} from '@longhand/schema';
import { draftError, isToolEventType, type ToolEventDraft } from './drafts';
import { errMsg, sessionEventsPath, type AnnotationSink } from './sink';
import type { SourceSearch } from './search';

/** The tool whose call produces a draft (inverse of `TOOLS[name].emits`). */
export function toolForDraft(draft: ToolEventDraft): ToolName {
  switch (draft.type) {
    case 'CommentAdded':
      return 'comment';
    case 'QuestionAsked':
      return 'ask_question';
    case 'SuggestionProposed':
      return draft.payload.suggestion.kind === 'word-choice'
        ? 'suggest_word_choice'
        : draft.payload.suggestion.kind === 'insertion'
          ? 'suggest_insertion'
          : 'suggest_rephrase';
    case 'MoveProposed':
      return 'propose_move';
    case 'CutProposed':
      return 'propose_cut';
    case 'SplitProposed':
      return 'propose_split';
    case 'MergeProposed':
      return 'propose_merge';
    case 'CitationNeededFlagged':
      return 'flag_citation_needed';
    case 'SourceSurfaced':
      return 'search_sources';
    case 'SourceSuggested':
      return 'suggest_source';
    case 'ReviewFinished':
      return 'finish_review';
    case 'DiscussAnswered':
      return 'answer_discussion';
  }
}

/** Options for {@link SessionRelay}. */
export interface SessionRelayOptions {
  projectId: string;
  feedbackSessionId: string;
  sessionKind: AgentSessionKind;
  intensity: Intensity;
  sink: AnnotationSink;
  search?: SourceSearch | null;
  initialCounts?: SessionCounts;
  /** Called after the sink accepted a draft. */
  onAccepted?: (draft: ToolEventDraft, seq: number) => void;
}

interface JsonReply {
  status: number;
  body: unknown;
}

const MAX_BODY_BYTES = 1_000_000;

/** One session's loopback relay. */
export class SessionRelay {
  /** Drafts the sink accepted, in order. */
  readonly accepted: Array<{ seq: number; draft: ToolEventDraft }> = [];
  /** Drafts the relay or the sink refused. */
  readonly rejected: Array<{ code: string; message: string }> = [];
  private counts: SessionCounts;
  private finishedValue = false;
  private server: Server | null = null;
  private readonly token = randomBytes(24).toString('base64url');
  private readonly byCommit = new Map<string, JsonReply>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: SessionRelayOptions) {
    this.counts = { ...(opts.initialCounts ?? emptyCounts()) };
  }

  /** True once `ReviewFinished` / `DiscussAnswered` was accepted. */
  get finished(): boolean {
    return this.finishedValue;
  }

  /** Counts of accepted annotation drafts. */
  get sessionCounts(): SessionCounts {
    return { ...this.counts };
  }

  /** Starts listening on 127.0.0.1 on a free port. */
  async start(): Promise<{ baseUrl: string; token: string }> {
    const server = createServer((req, res) => {
      void this.route(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}`, token: this.token };
  }

  async close(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  /** Marks the session closed: later drafts get `409 session-closed`. */
  closeSession(): void {
    this.finishedValue = true;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let reply: JsonReply;
    try {
      reply = await this.dispatch(req);
    } catch (e) {
      reply = { status: 500, body: { ok: false, error: { code: 'internal', message: errMsg(e) } } };
    }
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  }

  private async dispatch(req: IncomingMessage): Promise<JsonReply> {
    if (!this.authorized(req.headers.authorization)) {
      return err(401, 'unauthorized', 'missing or wrong session token');
    }
    const base = sessionEventsPath(this.opts.feedbackSessionId).replace(/\/events$/, '');
    const url = req.url ?? '';
    if (req.method !== 'POST') return err(405, 'method-not-allowed', 'POST only');
    const body = await readJson(req);
    if (body === undefined) return err(400, 'invalid-json', 'body is not JSON');
    if (url === `${base}/events`) {
      // Serialize appends so caps and the finished flag are checked atomically.
      const run = this.chain.then(() => this.events(body));
      this.chain = run.catch(() => undefined);
      return run;
    }
    if (url === `${base}/search`) return this.searchSources(body);
    return err(404, 'unknown-session', `no such endpoint ${url}`);
  }

  private authorized(header: string | undefined): boolean {
    const expected = Buffer.from(`Bearer ${this.token}`);
    const got = Buffer.from(header ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  }

  private async events(body: unknown): Promise<JsonReply> {
    const commitId = (body as { commitId?: unknown } | null)?.commitId;
    if (typeof commitId === 'string') {
      const prior = this.byCommit.get(commitId);
      if (prior) return prior;
    }
    const reply = await this.validateAndForward(body);
    if (typeof commitId === 'string' && reply.status === 200) this.byCommit.set(commitId, reply);
    if (reply.status !== 200) {
      const e = (reply.body as { error: { code: string; message: string } }).error;
      this.rejected.push(e);
    }
    return reply;
  }

  private async validateAndForward(body: unknown): Promise<JsonReply> {
    const invalid = draftError(body);
    if (invalid) return err(400, 'invalid-draft', invalid);
    const draft = body as ToolEventDraft;
    const o = this.opts;
    if (!isToolEventType(draft.type)) {
      return err(403, 'forbidden', `${draft.type} may not be sent by the tool server`);
    }
    if (
      draft.actor.kind !== 'agent' ||
      draft.sessionId !== o.feedbackSessionId ||
      draft.projectId !== o.projectId ||
      draft.payload.feedbackSessionId !== o.feedbackSessionId
    ) {
      return err(403, 'forbidden', 'draft does not belong to this session');
    }
    const discussOnly = draft.type === 'DiscussAnswered';
    if ((o.sessionKind === 'discuss') !== discussOnly) {
      return err(403, 'forbidden', `${draft.type} is not allowed in a ${o.sessionKind} session`);
    }
    if (this.finishedValue) return err(409, 'session-closed', 'the session is finished');
    const tool = toolForDraft(draft);
    const cap = capViolation(tool, this.counts, o.intensity);
    if (cap) return err(422, 'cap-reached', cap);
    const r = await o.sink.append(draft);
    if (!r.ok) {
      return err(r.error.retryable ? 503 : 422, r.error.code, r.error.message);
    }
    if (!r.duplicate) {
      this.counts = countCall(tool, this.counts);
      this.accepted.push({ seq: r.seq, draft });
      if (draft.type === 'ReviewFinished' || draft.type === 'DiscussAnswered') {
        this.finishedValue = true;
      }
      o.onAccepted?.(draft, r.seq);
    }
    return {
      status: 200,
      body: { ok: true, seq: r.seq, commitId: r.commitId, duplicate: r.duplicate },
    };
  }

  private async searchSources(body: unknown): Promise<JsonReply> {
    const search = this.opts.search;
    if (!search) return err(501, 'search-unavailable', 'no source search configured');
    const b = body as { query?: unknown; limit?: unknown } | null;
    if (typeof b?.query !== 'string' || typeof b.limit !== 'number') {
      return err(400, 'invalid-request', 'expected {query, limit}');
    }
    try {
      const items = await search.search(b.query, Math.max(1, Math.min(10, b.limit)));
      return { status: 200, body: { ok: true, items } };
    } catch (e) {
      return err(502, 'search-failed', errMsg(e));
    }
  }
}

/** `SourceSearch` client used by the tool server to reach the relay. */
export class RelaySourceSearch implements SourceSearch {
  constructor(
    private readonly baseUrl: string,
    private readonly feedbackSessionId: string,
    private readonly token: string,
  ) {}

  async search(query: string, limit: number): Promise<CslItem[]> {
    const path = sessionEventsPath(this.feedbackSessionId).replace(/\/events$/, '/search');
    const res = await fetch(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(30000),
    });
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      items?: CslItem[];
      error?: { message?: string };
    } | null;
    if (!res.ok || !body?.ok || !Array.isArray(body.items)) {
      throw new Error(body?.error?.message ?? `search relay answered HTTP ${res.status}`);
    }
    return body.items;
  }
}

function err(status: number, code: string, message: string): JsonReply {
  return { status, body: { ok: false, error: { code, message } } };
}

function emptyCounts(): SessionCounts {
  return { items: 0, suggestions: 0, insertions: 0, proposals: 0, questions: 0, searches: 0 };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(b);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}
