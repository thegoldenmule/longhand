/**
 * Where accepted agent drafts go: the {@link AnnotationSink} interface, an HTTP
 * implementation that POSTs to the ledger service, and an in-memory sink for tests.
 *
 * ## HTTP contract (implemented by the ledger service)
 *
 * `POST {baseUrl}/internal/sessions/{feedbackSessionId}/events`
 *
 * - `Authorization: Bearer {sessionToken}`: a per-session token the service issued
 *   when it started the session. It authorizes drafts for that one session only.
 * - `Content-Type: application/json`, body = one `CommitDraft` (see README).
 * - `200 {"ok":true,"seq":n,"commitId":"…","duplicate":false}` on append, and
 *   `duplicate:true` (same `seq`) when `commitId` was already appended.
 * - `4xx {"ok":false,"error":{"code":"…","message":"…"}}` on rejection; the message
 *   is shown to the model, so write it for the model.
 * - `5xx` / network errors are retried with the same `commitId`.
 */
import { CommitDraftSchema } from '@longhand/schema';
import type { SinkDraft } from './drafts';

/** Result of appending one draft. */
export type AppendResult =
  { ok: true; seq: number; commitId: string; duplicate: boolean } | { ok: false; error: SinkError };

/** Why a draft was not appended. */
export interface SinkError {
  /** Machine-readable code (`invalid-draft`, `unauthorized`, `forbidden`, `unknown-session`, `session-closed`, a tool/anchor error code, `unavailable`…). */
  code: string;
  /** Human/model-readable message. */
  message: string;
  /** True when the same draft may succeed if sent again later (network or 5xx). */
  retryable: boolean;
}

/** Receives the agent's drafts. Implementations must be idempotent on `commitId`. */
export interface AnnotationSink {
  append(draft: SinkDraft): Promise<AppendResult>;
}

/** Path of the events endpoint for a session. */
export function sessionEventsPath(feedbackSessionId: string): string {
  return `/internal/sessions/${encodeURIComponent(feedbackSessionId)}/events`;
}

/** Options for {@link HttpAnnotationSink}. */
export interface HttpAnnotationSinkOptions {
  /** Ledger service origin, e.g. `http://127.0.0.1:3200`. */
  baseUrl: string;
  feedbackSessionId: string;
  /** Per-session bearer token issued by the ledger service. */
  token: string;
  /** Attempts for retryable failures (default 3). */
  maxAttempts?: number;
  /** Per-request timeout in ms (default 15000). */
  requestTimeoutMs?: number;
  /** Base backoff in ms (default 200, doubled per attempt). */
  backoffMs?: number;
  fetch?: typeof fetch;
}

/** POSTs drafts to the ledger service (see the module docs for the contract). */
export class HttpAnnotationSink implements AnnotationSink {
  private readonly url: string;
  private readonly opts: Required<Omit<HttpAnnotationSinkOptions, 'fetch'>> & {
    fetch: typeof fetch;
  };

  constructor(options: HttpAnnotationSinkOptions) {
    this.opts = {
      maxAttempts: 3,
      requestTimeoutMs: 15000,
      backoffMs: 200,
      fetch: globalThis.fetch.bind(globalThis),
      ...options,
    };
    this.url = new URL(
      sessionEventsPath(options.feedbackSessionId),
      options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`,
    ).toString();
  }

  async append(draft: SinkDraft): Promise<AppendResult> {
    let last: SinkError = { code: 'unavailable', message: 'not attempted', retryable: true };
    for (let attempt = 0; attempt < this.opts.maxAttempts; attempt++) {
      if (attempt > 0) await sleep(this.opts.backoffMs * 2 ** (attempt - 1));
      const r = await this.once(draft);
      if (r.ok || !r.error.retryable) return r;
      last = r.error;
    }
    return { ok: false, error: last };
  }

  private async once(draft: SinkDraft): Promise<AppendResult> {
    let res: Response;
    try {
      res = await this.opts.fetch(this.url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(draft),
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
      });
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'unavailable',
          message: `ledger unreachable: ${errMsg(e)}`,
          retryable: true,
        },
      };
    }
    const body: unknown = await res.json().catch(() => null);
    return interpretResponse(res.status, body, draft.commitId);
  }
}

/** Maps an HTTP status + JSON body from the events endpoint to an {@link AppendResult}. */
export function interpretResponse(status: number, body: unknown, commitId: string): AppendResult {
  const b = (body ?? {}) as {
    ok?: unknown;
    seq?: unknown;
    commitId?: unknown;
    duplicate?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  if (status >= 200 && status < 300 && b.ok === true && typeof b.seq === 'number') {
    return {
      ok: true,
      seq: b.seq,
      commitId: typeof b.commitId === 'string' ? b.commitId : commitId,
      duplicate: b.duplicate === true,
    };
  }
  const retryable = status >= 500 || status === 429 || status === 0;
  const code =
    typeof b.error?.code === 'string' ? b.error.code : retryable ? 'unavailable' : `http-${status}`;
  const message =
    typeof b.error?.message === 'string'
      ? b.error.message
      : `ledger service answered HTTP ${status}`;
  return { ok: false, error: { code, message, retryable } };
}

/** An accepted draft as recorded by {@link InMemoryAnnotationSink}. */
export interface RecordedDraft {
  seq: number;
  draft: SinkDraft;
}

/**
 * In-memory sink for tests and local runs. Validates every draft with
 * `CommitDraftSchema`, dedupes by `commitId` and assigns increasing seqs.
 * `reject` lets a test refuse chosen drafts.
 */
export class InMemoryAnnotationSink implements AnnotationSink {
  readonly drafts: RecordedDraft[] = [];
  private nextSeq: number;
  private readonly byCommit = new Map<string, number>();

  constructor(
    private readonly options: {
      startSeq?: number;
      reject?: (draft: SinkDraft) => SinkError | null;
    } = {},
  ) {
    this.nextSeq = options.startSeq ?? 1;
  }

  async append(draft: SinkDraft): Promise<AppendResult> {
    const dup = this.byCommit.get(draft.commitId);
    if (dup !== undefined) return { ok: true, seq: dup, commitId: draft.commitId, duplicate: true };
    const parsed = CommitDraftSchema.safeParse(draft);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'invalid-draft',
          message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          retryable: false,
        },
      };
    }
    const rejected = this.options.reject?.(draft) ?? null;
    if (rejected) return { ok: false, error: rejected };
    const seq = this.nextSeq++;
    this.byCommit.set(draft.commitId, seq);
    this.drafts.push({ seq, draft: structuredClone(draft) });
    return { ok: true, seq, commitId: draft.commitId, duplicate: false };
  }

  /** Recorded drafts of one type. */
  ofType<T extends SinkDraft['type']>(type: T): Array<Extract<SinkDraft, { type: T }>> {
    return this.drafts
      .map((d) => d.draft)
      .filter((d): d is Extract<SinkDraft, { type: T }> => d.type === type);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
