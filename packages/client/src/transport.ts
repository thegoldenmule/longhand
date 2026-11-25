/**
 * `HttpCommitTransport`: the editor's `CommitTransport` over the ledger service's
 * HTTP and SSE routes.
 *
 * - `submit` → `POST /v1/projects/:id/commits`: 200 ack/duplicate, 409 conflict
 *   (with the document's current version), other 4xx rejected; network errors,
 *   401, 408, 429 and 5xx are `offline` (the editor keeps the draft queued and
 *   retries).
 * - `subscribe` → `GET …/documents/:doc/stream` (SSE): every step-bearing commit
 *   of the document in ledger order, this client's own included. On reconnect it
 *   resumes from the last version it delivered, so nothing is missed or repeated.
 * - `fetchSince` → `GET …/documents/:doc/updates?since=v`.
 */
import type { CommitDraft } from '@longhand/schema';
import type { LonghandClient } from './api';
import type {
  CatchUp,
  CommitTransport,
  ConnectionState,
  RemoteUpdate,
  SubmitResult,
} from './types';

/** Options for {@link HttpCommitTransport}. */
export interface HttpCommitTransportOptions {
  client: LonghandClient;
  projectId: string;
  /** Called on 401 (the token expired); the draft stays queued. */
  onAuthError?: (status: number) => void;
  /** Observe every submit (logging, tests). */
  onSubmit?: (draft: CommitDraft, result: SubmitResult) => void;
}

const OFFLINE_STATUSES = new Set([401, 408, 425, 429, 500, 502, 503, 504]);

/** The editor's `CommitTransport` over HTTP + SSE. */
export class HttpCommitTransport implements CommitTransport {
  private state: ConnectionState = 'online';
  private readonly listeners = new Set<(s: ConnectionState) => void>();
  private readonly detach: (() => void) | null = null;

  constructor(private readonly opts: HttpCommitTransportOptions) {
    const w = (globalThis as { window?: Window }).window;
    if (w && typeof w.addEventListener === 'function') {
      const on = () => this.set('online');
      const off = () => this.set('offline');
      w.addEventListener('online', on);
      w.addEventListener('offline', off);
      this.detach = () => {
        w.removeEventListener('online', on);
        w.removeEventListener('offline', off);
      };
    }
  }

  private path(suffix: string): string {
    return `/v1/projects/${encodeURIComponent(this.opts.projectId)}${suffix}`;
  }

  private set(next: ConnectionState): void {
    if (next === this.state) return;
    this.state = next;
    for (const l of [...this.listeners]) l(next);
  }

  connection(): ConnectionState {
    return this.state;
  }

  onConnectionChange(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async submit(draft: CommitDraft): Promise<SubmitResult> {
    const result = await this.submitOnce(draft);
    this.opts.onSubmit?.(draft, result);
    return result;
  }

  private async submitOnce(draft: CommitDraft): Promise<SubmitResult> {
    let res: Response;
    try {
      res = await this.opts.client.raw('POST', this.path('/commits'), draft);
    } catch {
      this.set('offline');
      return { status: 'offline' };
    }
    const body = (await res.json().catch(() => null)) as {
      status?: string;
      seq?: number;
      version?: number;
      currentVersion?: number;
      reason?: string;
      error?: { code: string; message: string };
    } | null;
    if (res.status === 401) this.opts.onAuthError?.(401);
    if (OFFLINE_STATUSES.has(res.status)) {
      if (res.status !== 401) this.set('offline');
      return { status: 'offline' };
    }
    this.set('online');
    if (
      res.ok &&
      (body?.status === 'ack' || body?.status === 'duplicate') &&
      typeof body.seq === 'number'
    ) {
      return {
        status: body.status,
        seq: body.seq,
        ...(typeof body.version === 'number' ? { version: body.version } : {}),
      };
    }
    if (
      res.status === 409 &&
      body?.status === 'conflict' &&
      typeof body.currentVersion === 'number'
    ) {
      return { status: 'conflict', currentVersion: body.currentVersion };
    }
    return {
      status: 'rejected',
      reason:
        body?.reason ??
        (body?.error ? `${body.error.code}: ${body.error.message}` : `HTTP ${res.status}`),
    };
  }

  subscribe(documentId: string, listener: (update: RemoteUpdate) => void): () => void {
    let last: number | undefined;
    let lastSeq = 0;
    const sub = this.opts.client.subscribeDocument(this.opts.projectId, documentId, {
      since: () => last,
      onOpen: () => this.set('online'),
      onError: (_e, info) => {
        if (info.willRetry) this.set('offline');
      },
      onUpdate: (u) => {
        // Ledger order: a seq at or below the last delivered one is a reconnect replay.
        if (u.seq <= lastSeq) return;
        lastSeq = u.seq;
        last = u.version;
        listener(u);
      },
    });
    return () => sub.close();
  }

  async fetchSince(documentId: string, version: number): Promise<CatchUp> {
    try {
      const r = await this.opts.client.fetchSince(this.opts.projectId, documentId, version);
      this.set('online');
      return r.kind === 'updates'
        ? { kind: 'updates', updates: r.updates, version: r.version }
        : { kind: 'snapshot', doc: r.doc, version: r.version };
    } catch (e) {
      if (!(e instanceof Error && 'status' in e)) this.set('offline');
      throw e;
    }
  }

  /** Removes the browser online/offline listeners. */
  dispose(): void {
    this.detach?.();
    this.listeners.clear();
  }
}
