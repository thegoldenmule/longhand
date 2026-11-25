/**
 * The project's ledger, client side. It loads every commit (`/commits`), follows
 * the project event stream, and folds with `@longhand/ledger` through one shared
 * `Replay`, so the replay scrubber and the span inspector reuse its snapshots.
 *
 * The editor syncs its own document through `HttpCommitTransport`; everything
 * else in the UI (binder, cards, tint, report) reads this fold, which includes the
 * editor's commits once the ledger has them.
 */
import type { LonghandClient, SessionEvent, SseSubscription } from '@longhand/client';
import { projectState, Replay, type LedgerState } from '@longhand/ledger';
import type { Commit, ProjectState } from '@longhand/schema';

/** What components read. A new object on every change. */
export interface ProjectSnapshot {
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  headSeq: number;
  /** The commits so far (a stable array per snapshot). */
  commits: readonly Commit[];
  /** The shared replay over the commits. */
  replay: Replay;
  /** The fold at the head (the span inspector needs it). */
  ledger: LedgerState | null;
  state: ProjectState | null;
  /** The project event stream is connected. */
  live: boolean;
}

type ProgressListener = (e: SessionEvent) => void;

const PAGE = 5000;

export class ProjectStore {
  /** Backing array: the shared `Replay` reads it, so it only ever grows. */
  private readonly backing: Commit[] = [];
  private readonly ids = new Set<string>();
  readonly replay = new Replay(this.backing);
  private snapshot: ProjectSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly progressListeners = new Set<ProgressListener>();
  private readonly sessions = new Map<string, SseSubscription>();
  private sub: SseSubscription | null = null;
  private catchingUp: Promise<void> | null = null;
  private scheduled = false;
  private disposed = false;

  constructor(
    readonly client: LonghandClient,
    readonly projectId: string,
  ) {
    this.snapshot = this.make('loading', null, false);
  }

  private make(status: ProjectSnapshot['status'], error: string | null, live: boolean) {
    const ledger = this.backing.length ? this.replay.head() : null;
    return {
      status,
      error,
      headSeq: this.backing.length,
      commits: this.backing.slice(),
      replay: this.replay,
      ledger,
      state: ledger ? projectState(ledger) : null,
      live,
    } satisfies ProjectSnapshot;
  }

  getSnapshot = (): ProjectSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Agent progress for every running session (for `ann.pushProgress`). */
  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  /** True once the ledger holds a commit with this id. */
  has(commitId: string): boolean {
    return this.ids.has(commitId);
  }

  private emit(
    status = this.snapshot.status,
    error = this.snapshot.error,
    live = this.snapshot.live,
  ) {
    this.snapshot = this.make(status, error, live);
    for (const l of [...this.listeners]) l();
  }

  /** Coalesces bursts (an agent streaming cards) into one render per frame. */
  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      if (!this.disposed) this.emit();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  async start(): Promise<void> {
    try {
      await this.fetchAfter(0);
      this.emit('ready', null, false);
      for (const s of Object.values(this.snapshot.state?.annotations.agentSessions ?? {})) {
        if (s.status === 'running') this.followSession(s.id);
      }
      this.listen();
    } catch (e) {
      this.emit('error', e instanceof Error ? e.message : String(e), false);
    }
  }

  private async fetchAfter(after: number): Promise<void> {
    let cursor = after;
    for (;;) {
      const page = await this.client.getCommits(this.projectId, cursor, PAGE);
      for (const c of page.commits) this.accept(c, false);
      cursor = this.backing.length;
      if (page.commits.length < PAGE || cursor >= page.headSeq) break;
    }
  }

  private listen(): void {
    this.sub?.close();
    this.sub = this.client.subscribeProject(this.projectId, (c) => this.onCommit(c), {
      after: this.backing.length,
      onOpen: () => {
        if (!this.snapshot.live) this.emit(this.snapshot.status, null, true);
      },
      onError: () => {
        if (this.snapshot.live) this.emit(this.snapshot.status, this.snapshot.error, false);
      },
    });
  }

  private onCommit(c: Commit): void {
    if (this.disposed || c.seq <= this.backing.length) return;
    if (c.seq === this.backing.length + 1) {
      this.accept(c, true);
      this.schedule();
      return;
    }
    // A gap (a dropped event): fetch what is missing, in order.
    this.catchingUp ??= this.fetchAfter(this.backing.length)
      .then(() => this.schedule())
      .catch(() => undefined)
      .finally(() => {
        this.catchingUp = null;
      });
  }

  private accept(c: Commit, live: boolean): void {
    if (c.seq !== this.backing.length + 1) return;
    this.backing.push(c);
    this.ids.add(c.commitId);
    if (live && c.type === 'FeedbackSessionStarted') {
      this.followSession((c.payload as { feedbackSessionId: string }).feedbackSessionId);
    }
  }

  private followSession(sessionId: string): void {
    if (this.sessions.has(sessionId) || this.disposed) return;
    const sub = this.client.subscribeSession(this.projectId, sessionId, (e) => {
      for (const l of [...this.progressListeners]) l(e);
      if (e.kind === 'ended') this.sessions.delete(sessionId);
    });
    this.sessions.set(sessionId, sub);
  }

  dispose(): void {
    this.disposed = true;
    this.sub?.close();
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
    this.listeners.clear();
    this.progressListeners.clear();
  }
}
