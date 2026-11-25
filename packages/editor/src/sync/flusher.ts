/**
 * Drains a {@link CommitQueue} to a {@link CommitTransport}: one draft at a time,
 * in order, removing each only once the ledger acknowledges it.
 *
 * - `ack` / `duplicate` → removed; the owning editor is told (it advances its version).
 * - `offline` (or a thrown error) → draining pauses and retries with backoff, or
 *   immediately when the transport reports it is online again.
 * - `conflict` → the owning editor catches up and rebases, replacing its queued
 *   drafts; drafts nobody owns are reconciled headlessly with `fetchSince`.
 * - `rejected` → removed and reported; the owner resyncs.
 *
 * One flusher per queue. {@link sharedFlusher} returns it.
 */
import type { CommitDraftOf } from '@longhand/schema';
import { Emitter } from '../util';
import { isTextEdited, rebuildTextEdited } from './drafts';
import type { CommitQueue, QueueEntry } from './queue';
import { reconcileHeadless } from './reconcile';
import type { CommitTransport, ConnectionState, SubmitResult } from './transport';

/** An open editor that owns some queued drafts. */
export interface FlushParticipant {
  owns(commitId: string): boolean;
  onAck(entry: QueueEntry, result: Extract<SubmitResult, { status: 'ack' | 'duplicate' }>): void;
  /** Catch up and rebase. When it resolves the queue head may have been replaced. */
  onConflict(entry: QueueEntry, currentVersion: number): Promise<void>;
  onRejected(entry: QueueEntry, reason: string): void;
}

/** Flusher state for status displays. */
export interface FlusherStatus {
  connection: ConnectionState;
  draining: boolean;
  /** Entries waiting in the queue (as of the last drain step). */
  queued: number;
  lastError: string | null;
}

export interface CommitFlusherOptions {
  /** First retry delay after a failure (ms). Default 1000. */
  retryBaseMs?: number;
  /** Maximum retry delay (ms). Default 30000. */
  retryMaxMs?: number;
  /** Conflicts tolerated for one head entry before it is dropped. Default 8. */
  maxConflicts?: number;
}

export class CommitFlusher {
  readonly status = new Emitter<FlusherStatus>();
  /** Every successfully acknowledged entry. */
  readonly acked = new Emitter<{ entry: QueueEntry; seq: number; version?: number }>();
  private participants = new Set<FlushParticipant>();
  private running: Promise<void> | null = null;
  private again = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay: number;
  private conflicts = new Map<string, number>();
  private lastError: string | null = null;
  private queued = 0;
  private unsubs: Array<() => void> = [];
  private destroyed = false;

  constructor(
    readonly queue: CommitQueue,
    readonly transport: CommitTransport,
    private readonly opts: CommitFlusherOptions = {},
  ) {
    this.retryDelay = opts.retryBaseMs ?? 1000;
    this.unsubs.push(
      transport.onConnectionChange((state) => {
        this.emitStatus();
        if (state === 'online') {
          this.retryDelay = this.opts.retryBaseMs ?? 1000;
          this.kick();
        }
      }),
      queue.onChange(() => this.kick()),
    );
  }

  /** Registers an editor. Returns an unregister function. */
  register(p: FlushParticipant): () => void {
    this.participants.add(p);
    return () => this.participants.delete(p);
  }

  /** Starts draining if not already. */
  kick(): void {
    if (this.destroyed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.drainLoop().finally(() => {
      this.running = null;
      this.emitStatus();
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
    this.emitStatus();
  }

  /** Resolves when the current drain pass (and any requested re-run) finishes. */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  current(): FlusherStatus {
    return {
      connection: this.transport.connection(),
      draining: this.running !== null,
      queued: this.queued,
      lastError: this.lastError,
    };
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private emitStatus(): void {
    this.status.emit(this.current());
  }

  private owner(commitId: string): FlushParticipant | undefined {
    for (const p of this.participants) if (p.owns(commitId)) return p;
    return undefined;
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.destroyed) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, this.opts.retryMaxMs ?? 30000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, delay);
  }

  private async drainLoop(): Promise<void> {
    for (;;) {
      if (this.destroyed) return;
      const entries = await this.queue.list();
      this.queued = entries.length;
      const head = entries[0];
      if (!head) {
        this.emitStatus();
        return;
      }
      if (this.transport.connection() === 'offline') {
        this.emitStatus();
        return;
      }
      let result: SubmitResult;
      try {
        result = await this.transport.submit(head.draft);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        result = { status: 'offline' };
      }
      switch (result.status) {
        case 'ack':
        case 'duplicate': {
          await this.queue.remove(head.commitId);
          this.conflicts.delete(head.commitId);
          this.lastError = null;
          this.retryDelay = this.opts.retryBaseMs ?? 1000;
          this.acked.emit({ entry: head, seq: result.seq, ...(result.version !== undefined ? { version: result.version } : {}) });
          this.owner(head.commitId)?.onAck(head, result);
          break;
        }
        case 'offline':
          this.emitStatus();
          this.scheduleRetry();
          return;
        case 'conflict': {
          const n = (this.conflicts.get(head.commitId) ?? 0) + 1;
          this.conflicts.set(head.commitId, n);
          if (n > (this.opts.maxConflicts ?? 8)) {
            await this.reject(head, `gave up after ${n - 1} conflicts`);
            break;
          }
          try {
            const owner = this.owner(head.commitId);
            if (owner) await owner.onConflict(head, result.currentVersion);
            else await this.reconcile(head, entries);
          } catch (err) {
            this.lastError = err instanceof Error ? err.message : String(err);
            this.scheduleRetry();
            return;
          }
          break;
        }
        case 'rejected':
          await this.reject(head, result.reason);
          break;
      }
    }
  }

  private async reject(head: QueueEntry, reason: string): Promise<void> {
    this.lastError = reason;
    await this.queue.remove(head.commitId);
    this.conflicts.delete(head.commitId);
    console.error(`[longhand/editor] ledger rejected ${head.type} ${head.commitId}: ${reason}`);
    this.owner(head.commitId)?.onRejected(head, reason);
  }

  /** Headless conflict resolution for drafts no open editor owns. */
  private async reconcile(head: QueueEntry, entries: QueueEntry[]): Promise<void> {
    const documentId = head.documentId;
    if (!documentId || !isTextEdited(head.draft)) {
      // A non-text event with a stale baseVersion (ProposalAccepted): it cannot be rebased.
      await this.reject(head, 'version conflict on a non-text event');
      return;
    }
    const drafts = entries
      .filter((e) => e.documentId === documentId && isTextEdited(e.draft) && !this.owner(e.commitId))
      .map((e) => e.draft as CommitDraftOf<'TextEdited'>);
    const base = head.draft.payload.baseVersion;
    const catchUp = await this.transport.fetchSince(documentId, base);
    if (catchUp.kind === 'snapshot') {
      await this.reject(head, 'ledger returned a snapshot; queued steps cannot be rebased');
      return;
    }
    const r = reconcileHeadless(drafts, catchUp.updates, base);
    for (const id of r.applied) await this.queue.remove(id);
    let version = r.version;
    for (const p of r.remaining) {
      const rebuilt = rebuildTextEdited(p.draft, p.steps, p.kept, version);
      await this.queue.replace(p.draft.commitId, rebuilt);
      if (rebuilt) version += rebuilt.payload.steps.length;
    }
  }
}

const shared = new WeakMap<CommitQueue, WeakMap<CommitTransport, CommitFlusher>>();

/** The flusher for a queue/transport pair (created on first use). */
export function sharedFlusher(queue: CommitQueue, transport: CommitTransport): CommitFlusher {
  let byTransport = shared.get(queue);
  if (!byTransport) shared.set(queue, (byTransport = new WeakMap()));
  let f = byTransport.get(transport);
  if (!f) byTransport.set(transport, (f = new CommitFlusher(queue, transport)));
  return f;
}
