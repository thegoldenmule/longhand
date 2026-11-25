/**
 * Typed client for the ledger service API (`apps/server`, README "API reference").
 */
import type {
  Commit,
  CommitDraft,
  EditorProfile,
  EditorProfileInput,
  ProvenanceSummary,
} from '@longhand/schema';
import { subscribeSse, type Backoff, type SseSubscription } from './sse';
import type {
  BundleData,
  CatchUp,
  ProjectSummary,
  RemoteUpdate,
  SessionEvent,
  SessionInfo,
  SessionStart,
  StateSnapshot,
  SurfacedCandidate,
  WitnessKey,
} from './types';

/** How the client gets a bearer token (Cognito access token); omit in `AUTH_MODE=dev`. */
export type TokenSource = string | null | (() => string | null | Promise<string | null>);

/** Options for {@link LonghandClient}. */
export interface ClientOptions {
  /** Ledger service origin, e.g. `http://localhost:3200`. */
  baseUrl: string;
  token?: TokenSource;
  fetch?: typeof fetch;
  /** SSE reconnect backoff. */
  backoff?: Partial<Backoff>;
}

/** An API error: HTTP status plus the service's `{code, message}`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Export formats. */
export type ExportFormat = 'md' | 'docx' | 'pdf';

/** A downloaded export. */
export interface ExportDownload {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

/** The ledger service API. */
export class LonghandClient {
  readonly baseUrl: string;
  private readonly doFetch: typeof fetch;

  constructor(readonly options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** Authorization headers for the current token. */
  async authHeaders(): Promise<Record<string, string>> {
    const t = this.options.token;
    const token = typeof t === 'function' ? await t() : t;
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  /** Low-level request; returns the raw response (throws only on network errors). */
  async raw(
    method: string,
    path: string,
    body?: unknown,
    init: RequestInit = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      ...(await this.authHeaders()),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    return this.doFetch(`${this.baseUrl}${path}`, {
      ...init,
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** JSON request; throws {@link ApiError} on non-2xx. */
  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const err =
        (parsed as {
          error?: { code?: string; message?: string };
          code?: string;
          reason?: string;
        }) ?? {};
      throw new ApiError(
        res.status,
        err.error?.code ?? err.code ?? `http-${res.status}`,
        err.error?.message ?? err.reason ?? `HTTP ${res.status}`,
        parsed,
      );
    }
    return parsed as T;
  }

  private p(projectId: string): string {
    return `/v1/projects/${encodeURIComponent(projectId)}`;
  }

  // -------------------------------------------------------------- account

  me(): Promise<{ accountId: string; actorId: string; authMode: 'dev' | 'cognito' }> {
    return this.json('GET', '/v1/me');
  }

  // -------------------------------------------------------------- editors

  /** The account's named editors, in roster order (the service seeds the starters on first read). */
  async listEditors(): Promise<EditorProfile[]> {
    return (await this.json<{ editors: EditorProfile[] }>('GET', '/v1/editors')).editors;
  }

  /** One editor (404 `unknown-editor` if it is not the account's). */
  async getEditor(editorId: string): Promise<EditorProfile> {
    return (
      await this.json<{ editor: EditorProfile }>(
        'GET',
        `/v1/editors/${encodeURIComponent(editorId)}`,
      )
    ).editor;
  }

  /** Adds an editor (422 `invalid-editor`, 409 `too-many-editors`). */
  async createEditor(input: EditorProfileInput): Promise<EditorProfile> {
    return (await this.json<{ editor: EditorProfile }>('POST', '/v1/editors', input)).editor;
  }

  /** Replaces an editor's name, role, brief, lenses, intensity and questions. */
  async updateEditor(editorId: string, input: EditorProfileInput): Promise<EditorProfile> {
    return (
      await this.json<{ editor: EditorProfile }>(
        'PUT',
        `/v1/editors/${encodeURIComponent(editorId)}`,
        input,
      )
    ).editor;
  }

  /** Deletes an editor. Past feedback requests keep their own record of it. */
  async deleteEditor(editorId: string): Promise<void> {
    await this.json('DELETE', `/v1/editors/${encodeURIComponent(editorId)}`);
  }

  /** Replaces the roster with fresh copies of the starter editors. */
  async resetEditors(): Promise<EditorProfile[]> {
    return (await this.json<{ editors: EditorProfile[] }>('POST', '/v1/editors/reset')).editors;
  }

  // ------------------------------------------------------------- projects

  async listProjects(): Promise<ProjectSummary[]> {
    return (await this.json<{ projects: ProjectSummary[] }>('GET', '/v1/projects')).projects;
  }

  /** Creates a project from a title, or from the client's own `ProjectCreated` draft. */
  createProject(
    input:
      | { title: string; projectId?: string; deviceId?: string; sessionId?: string }
      | { draft: CommitDraft },
  ): Promise<{ projectId: string; seq: number; duplicate: boolean }> {
    return this.json('POST', '/v1/projects', input);
  }

  async getProject(projectId: string) {
    return (
      await this.json<{
        project: {
          projectId: string;
          accountId: string;
          title: string;
          headSeq: number;
          headHash: string;
          halted: string | null;
        };
      }>('GET', this.p(projectId))
    ).project;
  }

  /** The folded `ProjectState` and head. */
  getState(projectId: string): Promise<StateSnapshot> {
    return this.json('GET', `${this.p(projectId)}/state`);
  }

  /** Commits after a seq (paged; `limit` ≤ 5000). */
  getCommits(
    projectId: string,
    after = 0,
    limit = 1000,
  ): Promise<{ headSeq: number; commits: Commit[] }> {
    return this.json('GET', `${this.p(projectId)}/commits?after=${after}&limit=${limit}`);
  }

  /** `fetchSince`: step-bearing commits of a document with `baseVersion >= version`, or a snapshot. */
  fetchSince(projectId: string, documentId: string, version: number): Promise<CatchUp> {
    return this.json(
      'GET',
      `${this.p(projectId)}/documents/${encodeURIComponent(documentId)}/updates?since=${version}`,
    );
  }

  /** Bundle data: commits, witnesses, public key and keyId. */
  bundle(projectId: string): Promise<BundleData> {
    return this.json('GET', `${this.p(projectId)}/bundle`);
  }

  /** The public witness key (no auth). */
  witnessKey(): Promise<WitnessKey> {
    return this.json('GET', '/.well-known/longhand-witness-key');
  }

  // --------------------------------------------------------------- streams

  private sse<T>(
    url: string | (() => string),
    onEvent: (event: string, data: T, id?: string) => void,
    handlers: {
      onOpen?: () => void;
      onError?: (e: unknown, info: { willRetry: boolean; status?: number }) => void;
    } = {},
  ): SseSubscription {
    return subscribeSse({
      url: typeof url === 'function' ? () => `${this.baseUrl}${url()}` : `${this.baseUrl}${url}`,
      headers: () => this.authHeaders(),
      fetch: this.doFetch,
      ...(this.options.backoff ? { backoff: this.options.backoff } : {}),
      onEvent: (e) => onEvent(e.event, (e.data ? JSON.parse(e.data) : null) as T, e.id),
      ...handlers,
    });
  }

  /**
   * Every commit of a project in ledger order (annotation cards stream in this
   * way). Starts after `after` (default: live only); resumes after the last
   * delivered seq on reconnect.
   */
  subscribeProject(
    projectId: string,
    listener: (commit: Commit) => void,
    opts: { after?: number; onOpen?: () => void; onError?: (e: unknown) => void } = {},
  ): SseSubscription {
    let last = opts.after;
    return this.sse<Commit>(
      () => `${this.p(projectId)}/events${last !== undefined ? `?after=${last}` : ''}`,
      (event, commit) => {
        if (event !== 'commit') return;
        if (last !== undefined && commit.seq <= last) return;
        last = commit.seq;
        listener(commit);
      },
      {
        ...(opts.onOpen ? { onOpen: opts.onOpen } : {}),
        ...(opts.onError ? { onError: opts.onError } : {}),
      },
    );
  }

  /** One document's step-bearing commits (`RemoteUpdate`s), live or from `since`. */
  subscribeDocument(
    projectId: string,
    documentId: string,
    handlers: {
      since?: () => number | undefined;
      onUpdate: (u: RemoteUpdate) => void;
      onSnapshot?: (s: { doc: unknown; version: number }) => void;
      onOpen?: () => void;
      onError?: (e: unknown, info: { willRetry: boolean; status?: number }) => void;
    },
  ): SseSubscription {
    return this.sse<RemoteUpdate | { doc: unknown; version: number }>(
      () => {
        const since = handlers.since?.();
        return `${this.p(projectId)}/documents/${encodeURIComponent(documentId)}/stream${since !== undefined ? `?since=${since}` : ''}`;
      },
      (event, data) => {
        if (event === 'update') handlers.onUpdate(data as RemoteUpdate);
        else if (event === 'snapshot')
          handlers.onSnapshot?.(data as { doc: unknown; version: number });
      },
      {
        ...(handlers.onOpen ? { onOpen: handlers.onOpen } : {}),
        ...(handlers.onError ? { onError: handlers.onError } : {}),
      },
    );
  }

  // -------------------------------------------------------------- sessions

  /** Appends the writer's `FeedbackRequested` draft and returns the session serving it. */
  requestFeedback(projectId: string, draft: CommitDraft): Promise<SessionStart> {
    return this.json('POST', `${this.p(projectId)}/feedback`, { draft });
  }

  /** Appends the writer's `DiscussRequested` draft and returns the session answering it. */
  requestDiscuss(projectId: string, draft: CommitDraft): Promise<SessionStart> {
    return this.json('POST', `${this.p(projectId)}/discuss`, { draft });
  }

  async getSession(projectId: string, sessionId: string): Promise<SessionInfo> {
    return (
      await this.json<{ session: SessionInfo }>(
        'GET',
        `${this.p(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
      )
    ).session;
  }

  cancelSession(
    projectId: string,
    sessionId: string,
  ): Promise<{ sessionId: string; phase: string }> {
    return this.json(
      'POST',
      `${this.p(projectId)}/sessions/${encodeURIComponent(sessionId)}/cancel`,
    );
  }

  /** A session's progress (replayed from its start); ends after the `ended` event. */
  subscribeSession(
    projectId: string,
    sessionId: string,
    listener: (e: SessionEvent) => void,
  ): SseSubscription {
    let ended = false;
    const sub = this.sse<SessionEvent>(
      `${this.p(projectId)}/sessions/${encodeURIComponent(sessionId)}/events`,
      (_event, data) => {
        if (ended) return;
        listener(data);
        if (data.kind === 'ended') {
          ended = true;
          sub.close();
        }
      },
    );
    return sub;
  }

  /** Resolves with the `ended` event of a session. */
  waitForSession(
    projectId: string,
    sessionId: string,
    onEvent?: (e: SessionEvent) => void,
  ): Promise<Extract<SessionEvent, { kind: 'ended' }>> {
    return new Promise((resolve) => {
      this.subscribeSession(projectId, sessionId, (e) => {
        onEvent?.(e);
        if (e.kind === 'ended') resolve(e);
      });
    });
  }

  // -------------------------------------------------------------- research

  async searchSources(query: string, limit = 5): Promise<SurfacedCandidate[]> {
    const q = new URLSearchParams({ q: query, limit: String(limit) });
    return (await this.json<{ candidates: SurfacedCandidate[] }>('GET', `/v1/research/search?${q}`))
      .candidates;
  }

  /**
   * A `fetch` for `@longhand/research`'s `pageFetch`: page lookups go through the
   * service's proxy (which refuses private-network targets).
   */
  pageFetch = async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return this.raw('GET', `/v1/research/page?url=${encodeURIComponent(url)}`);
  };

  // ---------------------------------------------------------------- export

  /** Downloads an export (Markdown, DOCX or PDF), optionally with a provenance appendix. */
  async exportProject(
    projectId: string,
    opts: {
      format: ExportFormat;
      documentIds?: string[];
      style?: string;
      author?: string;
      provenance?: ProvenanceSummary | null;
    },
  ): Promise<ExportDownload> {
    const res = await this.raw('POST', `${this.p(projectId)}/export`, opts);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { code: string; message: string };
      } | null;
      throw new ApiError(
        res.status,
        body?.error?.code ?? `http-${res.status}`,
        body?.error?.message ?? `HTTP ${res.status}`,
        body,
      );
    }
    const cd = res.headers.get('content-disposition') ?? '';
    const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? `export.${opts.format}`;
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
      filename,
    };
  }

  /** URL of a GET export (for a plain download link; dev auth only, or add `access_token`). */
  exportUrl(projectId: string, format: ExportFormat): string {
    return `${this.baseUrl}${this.p(projectId)}/export?format=${format}`;
  }
}
