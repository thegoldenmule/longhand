/**
 * A `CommitTransport` that behaves like the ledger service for the demo page and
 * the jsdom tests: every submitted draft is checked with `validateDraft` and
 * folded with the real `@longhand/ledger` fold, so trace-over resolutions and
 * proposal acceptance run exactly as they would on the server. It appends the
 * `SuggestionResolved` events the fold derives, fans step-bearing commits out to
 * subscribers (including the sender) and publishes the folded `ProjectState`.
 *
 * Step-bearing commits carry the steps `validateDraft` reports in `derivedSteps`:
 * a `TextEdited`'s own steps, or the steps the fold derived for an accepted
 * proposal (as the ledger service sends them).
 */
import type {
  CatchUp,
  CommitTransport,
  ConnectionState,
  RemoteUpdate,
  SubmitResult,
} from '@longhand/editor';
import {
  documentNode,
  documentVersion,
  emptyState,
  foldCommits,
  projectState,
  validateDraft,
  type LedgerState,
} from '@longhand/ledger';
import type { Actor, Commit, CommitDraft, ProjectState } from '@longhand/schema';

/** Options for {@link FoldingTransport}. */
export interface FoldingTransportOptions {
  /** The ledger to start from (already hashed commits, e.g. a fixture prefix). */
  commits?: readonly Commit[];
  /** Delay before results and updates are delivered, ms. Default 0. */
  latencyMs?: number;
  /** Server clock. Default: wall clock, kept strictly increasing. */
  now?: () => number;
}

type StateListener = (state: ProjectState, commit: Commit | null) => void;

/** An in-memory ledger service backed by the real fold. */
export class FoldingTransport implements CommitTransport {
  state: LedgerState;
  readonly commits: Commit[] = [];
  readonly rejected: Array<{ draft: CommitDraft; reason: string }> = [];
  latencyMs: number;
  private readonly now: () => number;
  private lastServer = 0;
  private readonly updates = new Map<string, RemoteUpdate[]>();
  private readonly floor = new Map<string, number>();
  private readonly subs = new Map<string, Set<(u: RemoteUpdate) => void>>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly commitListeners = new Set<(c: Commit) => void>();
  private readonly seen = new Map<string, Commit>();

  constructor(opts: FoldingTransportOptions = {}) {
    this.latencyMs = opts.latencyMs ?? 0;
    this.now = opts.now ?? (() => Date.now());
    const seed = [...(opts.commits ?? [])];
    this.state = seed.length ? foldCommits(seed) : emptyState();
    this.commits.push(...seed);
    for (const c of seed) {
      this.seen.set(c.commitId, c);
      this.lastServer = Math.max(this.lastServer, Date.parse(c.serverTime));
    }
    for (const d of Object.values(projectState(this.state).documents))
      this.floor.set(d.id, d.version);
  }

  /** The folded state. */
  projectState(): ProjectState {
    return projectState(this.state);
  }

  /** Listens to every new folded state (after each append). */
  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Listens to every appended commit (synchronously, in order). */
  onCommit(listener: (c: Commit) => void): () => void {
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  /** Commits of one type. */
  ofType<T extends Commit['type']>(type: T): Array<Extract<Commit, { type: T }>> {
    return this.commits.filter((c): c is Extract<Commit, { type: T }> => c.type === type);
  }

  private serverTime(): string {
    const t = Math.max(this.now(), this.lastServer + 1);
    this.lastServer = t;
    return new Date(t).toISOString();
  }

  private later(fn: () => void): void {
    if (this.latencyMs > 0) setTimeout(fn, this.latencyMs);
    else queueMicrotask(fn);
  }

  /**
   * Validates, folds and appends a draft of any actor (the demo's mock agent uses
   * this for agent and system events). Returns the result the editor would get.
   */
  append(draft: CommitDraft): SubmitResult {
    const dup = this.seen.get(draft.commitId);
    if (dup) {
      const documentId = (dup.payload as { documentId?: string }).documentId;
      const version = documentId ? documentVersion(this.state, documentId) : undefined;
      return { status: 'duplicate', seq: dup.seq, ...(version !== undefined ? { version } : {}) };
    }
    const before = this.state;
    const serverTime = this.serverTime();
    const v = validateDraft(before, draft, draft.actor as Actor, { serverTime });
    if (!v.ok) {
      const reason = v.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
      if (
        v.errors.some((e) => e.code === 'stale-base-version' || e.code === 'future-base-version')
      ) {
        const documentId = (draft.payload as { documentId: string }).documentId;
        return { status: 'conflict', currentVersion: documentVersion(before, documentId) ?? 0 };
      }
      this.rejected.push({ draft, reason });
      return { status: 'rejected', reason };
    }
    const commit = v.commit;
    this.state = v.state;
    this.commits.push(commit);
    this.seen.set(commit.commitId, commit);
    let version: number | undefined;
    if (commit.type === 'TextEdited' || commit.type === 'ProposalAccepted') {
      const documentId = commit.payload.documentId;
      const baseVersion = documentVersion(before, documentId) ?? 0;
      version = documentVersion(this.state, documentId) ?? baseVersion;
      const steps = v.derivedSteps[documentId] ?? [];
      const update: RemoteUpdate = {
        documentId,
        commitId: commit.commitId,
        seq: commit.seq,
        type: commit.type,
        baseVersion,
        version,
        steps,
      };
      let list = this.updates.get(documentId);
      if (!list) this.updates.set(documentId, (list = []));
      list.push(update);
      this.later(() => {
        for (const l of this.subs.get(documentId) ?? []) l(update);
      });
    }
    for (const l of this.commitListeners) l(commit);
    for (const r of v.resolutions) {
      this.append({
        commitId: `resolved-${commit.seq}-${r.targetId}`,
        projectId: commit.projectId,
        clientTime: serverTime,
        actor: { kind: 'system', id: 'ledger' },
        deviceId: 'server',
        sessionId: 'system',
        type: 'SuggestionResolved',
        schemaVersion: commit.schemaVersion,
        payload: r,
      } as CommitDraft);
    }
    this.publish(commit);
    return { status: 'ack', seq: commit.seq, ...(version !== undefined ? { version } : {}) };
  }

  private publishScheduled = false;
  private publish(commit: Commit): void {
    if (this.publishScheduled) return;
    this.publishScheduled = true;
    this.later(() => {
      this.publishScheduled = false;
      const ps = this.projectState();
      for (const l of this.stateListeners) l(ps, commit);
    });
  }

  // CommitTransport ----------------------------------------------------------

  submit(draft: CommitDraft): Promise<SubmitResult> {
    const result = this.append(draft);
    return new Promise((resolve) => this.later(() => resolve(result)));
  }

  subscribe(documentId: string, listener: (u: RemoteUpdate) => void): () => void {
    let set = this.subs.get(documentId);
    if (!set) this.subs.set(documentId, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  async fetchSince(documentId: string, version: number): Promise<CatchUp> {
    const floor = this.floor.get(documentId) ?? 0;
    const current = documentVersion(this.state, documentId) ?? 0;
    if (version < floor) {
      const node = documentNode(this.state, documentId);
      return {
        kind: 'snapshot',
        doc: (node?.toJSON() ?? { type: 'doc', content: [{ type: 'paragraph' }] }) as never,
        version: current,
      };
    }
    const updates = (this.updates.get(documentId) ?? []).filter((u) => u.baseVersion >= version);
    return { kind: 'updates', updates, version: current };
  }

  connection(): ConnectionState {
    return 'online';
  }

  onConnectionChange(): () => void {
    return () => undefined;
  }
}

/** The commits of a ledger up to and including its first `ReviewFinished`. */
export function untilFirstReview(commits: readonly Commit[]): Commit[] {
  const i = commits.findIndex((c) => c.type === 'ReviewFinished');
  return i < 0 ? [...commits] : commits.slice(0, i + 1);
}
