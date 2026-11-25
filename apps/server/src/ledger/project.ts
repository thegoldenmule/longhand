/**
 * One project's ledger, in memory: the folded state, the chain, the witnesses and
 * the per-document step history, plus the append lock and the ingest sequence.
 *
 * Ingest (under the project's lock), exactly as `packages/ledger/README.md` says:
 *
 * 1. `validateDraft(state, draft, actor, { serverTime, accountId })`;
 * 2. `appendToChain(head, draft, serverTime)` with the same serverTime (its hash
 *    must equal the validated commit's);
 * 3. store the commit in the project's Durable Stream;
 * 4. witness it (and store the witness in the stream);
 * 5. after a human commit, append each `v.resolutions` entry as a system
 *    `SuggestionResolved` (each goes through the same sequence).
 *
 * The invariant — no agent or system event changes manuscript text — is checked
 * three times: `validateDraft` refuses it, the folded state is compared before
 * the append, and the commit exactly as stored is re-folded and compared after
 * the append. A violation after the append halts the project (every later write
 * is refused) and is logged loudly; it is never reported as a client error.
 */
import { randomUUID } from 'node:crypto';
import {
  ChainError,
  appendToChain,
  applyCommit,
  documentNode,
  documentVersion,
  emptyState,
  headHash,
  projectState,
  signWitness,
  validateDraft,
  verifyChain,
  type LedgerState,
  type ValidationError,
} from '@longhand/ledger';
import {
  SCHEMA_VERSION,
  base64Encode,
  isManuscriptEventType,
  verifyCommitHash,
  witnessMessage,
  type Actor,
  type Commit,
  type CommitDraft,
  type EventPayload,
  type EventType,
  type ProjectState,
  type Witness,
} from '@longhand/schema';
import type { Signer } from '../signer';
import type { LedgerStore, StreamRecord } from '../storage/streams';
import { HttpError, InvariantViolation, Mutex, errMsg } from '../util';
import { ProjectHistory, type RemoteUpdate } from './history';

/** The actor the service uses for its own commits. */
export const SYSTEM_ACTOR: Actor = { kind: 'system', id: 'ledger' };

/** When to embed a `ChainHeadWitnessed` in the chain. */
export interface WitnessCadence {
  /** Embed after this many commits since the last embedded witness (0 = never by count). */
  everyCommits: number;
}

/** Hooks for deterministic replays (tests). Production uses the defaults. */
export interface ClockHooks {
  /** Server time for the commit about to get `seq`. Default: now (never before the head's serverTime). */
  serverTime?: (ctx: { projectId: string; seq: number }) => string;
  /** Envelope of a system commit the service creates. Default: a random UUID and clientTime = serverTime. */
  systemEnvelope?: (ctx: {
    projectId: string;
    seq: number;
    type: EventType;
    serverTime: string;
  }) => {
    commitId: string;
    clientTime: string;
  };
}

/** What a project ledger needs. */
export interface ProjectDeps {
  store: LedgerStore;
  signer: Signer;
  cadence: WitnessCadence;
  hooks?: ClockHooks;
  log?: (msg: string) => void;
}

/** One appended commit, as listeners see it. */
export interface AppendedCommit {
  commit: Commit;
  witness: Witness;
  /** Present for step-bearing commits. */
  update: RemoteUpdate | null;
  /** Public state after the commit. */
  state: ProjectState;
}

/** Outcome of an ingest. */
export type IngestOutcome =
  | { status: 'ack'; seq: number; commit: Commit; version?: number }
  | { status: 'duplicate'; seq: number; commit: Commit; version?: number }
  | { status: 'rejected'; errors: ValidationError[] };

/**
 * A pre-append step run under the lock (agent position mapping, session checks).
 * Return the draft to append, or throw an `HttpError`.
 */
export type Prepare = (ledger: ProjectLedger, draft: CommitDraft) => CommitDraft;

/** One project's ledger. */
export class ProjectLedger {
  private stateValue: LedgerState = emptyState();
  private readonly commitsList: Commit[] = [];
  private readonly witnessBySeq = new Map<number, Witness>();
  private readonly seqByCommitId = new Map<string, number>();
  readonly history = new ProjectHistory();
  private readonly listeners = new Set<(a: AppendedCommit) => void>();
  readonly lock = new Mutex();
  /** Records in the stream (the next record's writer seq). */
  private records = 0;
  /** Set when a stream write failed mid-way: the next write reloads from the stream first. */
  private dirty = false;
  /** Set on an invariant violation: the project accepts no more writes. */
  private halted: string | null = null;
  private lastEmbeddedSeq = 0;

  private constructor(
    readonly projectId: string,
    readonly accountId: string,
    readonly path: string,
    private readonly deps: ProjectDeps,
  ) {}

  /** Loads (folds) a project from its stream. Witnesses any commit the stream has no witness for. */
  static async load(
    projectId: string,
    accountId: string,
    path: string,
    deps: ProjectDeps,
  ): Promise<ProjectLedger> {
    const p = new ProjectLedger(projectId, accountId, path, deps);
    await p.reload();
    return p;
  }

  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => console.log(m)))(`[ledger ${this.projectId}] ${msg}`);
  }

  /** Re-folds the whole stream into fresh in-memory state. */
  private async reload(): Promise<void> {
    const records = await this.deps.store.readAll<StreamRecord>(this.path);
    const commits: Commit[] = [];
    const witnesses = new Map<number, Witness>();
    for (const r of records) {
      if (r.kind === 'commit') commits.push(r.commit);
      else if (r.kind === 'witness') witnesses.set(r.witness.seq, r.witness);
    }
    if (commits.length > 0) {
      const v = verifyChain(commits);
      if (!v.ok) {
        throw new InvariantViolation(
          `stream ${this.path} does not verify: ${v.problems.map((x) => `${x.code}@${x.seq}`).join(', ')}`,
        );
      }
    }
    let state = emptyState();
    const history = new ProjectHistory();
    for (const c of commits) {
      const prev = state;
      state = applyCommit(prev, c);
      this.assertNoTextChange(prev, state, c);
      history.observe(c, projectState(prev), this.docLookup(prev, state));
    }
    this.stateValue = state;
    this.commitsList.length = 0;
    this.commitsList.push(...commits);
    this.seqByCommitId.clear();
    for (const c of commits) this.seqByCommitId.set(c.commitId, c.seq);
    this.witnessBySeq.clear();
    for (const [k, w] of witnesses) this.witnessBySeq.set(k, w);
    this.history.docs.clear();
    for (const [k, d] of history.docs) this.history.docs.set(k, d);
    this.records = records.length;
    this.lastEmbeddedSeq = 0;
    for (const c of commits) if (c.type === 'ChainHeadWitnessed') this.lastEmbeddedSeq = c.seq;
    this.dirty = false;
    // A crash between storing a commit and its witness leaves it unwitnessed: sign it now.
    for (const c of commits) {
      if (!this.witnessBySeq.has(c.seq)) {
        const w = await signWitness(this.deps.signer, c);
        await this.deps.store.append(
          this.path,
          { kind: 'witness', witness: w } satisfies StreamRecord,
          this.records,
        );
        this.records += 1;
        this.witnessBySeq.set(c.seq, w);
        this.log(`witnessed seq ${c.seq} on load`);
      }
    }
  }

  private docLookup(prev: LedgerState, next: LedgerState) {
    return {
      prevDoc: (id: string) => documentNode(prev, id),
      nextDoc: (id: string) => documentNode(next, id),
      prevVersion: (id: string) => documentVersion(prev, id),
      nextVersion: (id: string) => documentVersion(next, id),
    };
  }

  // ------------------------------------------------------------------ reading

  get state(): LedgerState {
    return this.stateValue;
  }

  get publicState(): ProjectState {
    return projectState(this.stateValue);
  }

  get headSeq(): number {
    return this.commitsList.length;
  }

  get head(): Commit | null {
    return this.commitsList.at(-1) ?? null;
  }

  get commits(): readonly Commit[] {
    return this.commitsList;
  }

  get witnesses(): Witness[] {
    return this.commitsList
      .map((c) => this.witnessBySeq.get(c.seq))
      .filter((w): w is Witness => Boolean(w));
  }

  get haltedReason(): string | null {
    return this.halted;
  }

  commitById(commitId: string): Commit | undefined {
    const seq = this.seqByCommitId.get(commitId);
    return seq ? this.commitsList[seq - 1] : undefined;
  }

  /** Commits with `seq > after`. */
  commitsAfter(after: number): Commit[] {
    return this.commitsList.slice(Math.max(0, after));
  }

  /** Subscribes to appended commits (in ledger order). */
  subscribe(listener: (a: AppendedCommit) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Version a commit left its document at (step-bearing commits). */
  versionAfter(commit: Commit): number | undefined {
    const documentId = (commit.payload as { documentId?: unknown }).documentId;
    if (typeof documentId !== 'string') return undefined;
    return this.history.get(documentId)?.byCommitId(commit.commitId)?.version;
  }

  // ------------------------------------------------------------------- writing

  /**
   * Ingests one draft: dedupe by `commitId`, then `prepare` (under the lock), then
   * the ingest sequence.
   */
  ingest(draft: CommitDraft, actor: Actor, prepare?: Prepare): Promise<IngestOutcome> {
    return this.lock.run(async () => {
      if (this.halted)
        throw new HttpError(503, 'project-halted', `This project is halted: ${this.halted}`);
      if (this.dirty) await this.reload();
      const existing =
        typeof draft?.commitId === 'string' ? this.commitById(draft.commitId) : undefined;
      if (existing) {
        const version = this.versionAfter(existing);
        return {
          status: 'duplicate',
          seq: existing.seq,
          commit: existing,
          ...(version !== undefined ? { version } : {}),
        };
      }
      const prepared = prepare ? prepare(this, draft) : draft;
      return this.appendLocked(prepared, actor);
    });
  }

  /** Appends a system commit the service creates (under the lock). */
  appendSystem<K extends EventType>(type: K, payload: EventPayload<K>): Promise<IngestOutcome> {
    return this.lock.run(async () => {
      if (this.halted)
        throw new HttpError(503, 'project-halted', `This project is halted: ${this.halted}`);
      if (this.dirty) await this.reload();
      return this.appendLocked(this.systemDraft(type, payload), SYSTEM_ACTOR);
    });
  }

  /**
   * Embeds a witness in the chain (`ChainHeadWitnessed`) for `seq` (default: the
   * head). Does nothing when the head is already an embedded witness.
   */
  witnessHead(seq?: number): Promise<Commit | null> {
    return this.lock.run(async () => {
      if (this.halted || this.commitsList.length === 0) return null;
      if (this.dirty) await this.reload();
      return this.embedWitness(seq);
    });
  }

  private async embedWitness(seq?: number): Promise<Commit | null> {
    const target = seq ? this.commitsList[seq - 1] : this.head;
    if (!target) return null;
    if (seq === undefined && target.type === 'ChainHeadWitnessed') return null;
    const sig = await this.deps.signer.sign(witnessMessage(target));
    const r = await this.appendLocked(
      this.systemDraft('ChainHeadWitnessed', {
        witnessedSeq: target.seq,
        witnessedHash: target.hash,
        serverTime: target.serverTime,
        signature: base64Encode(sig),
        keyId: this.deps.signer.keyId,
      }),
      SYSTEM_ACTOR,
      { cadence: false },
    );
    if (r.status !== 'ack') throw new Error(`ChainHeadWitnessed refused: ${JSON.stringify(r)}`);
    return r.commit;
  }

  /** True when commits were appended since the last embedded witness. */
  get unembedded(): number {
    return this.headSeq - this.lastEmbeddedSeq;
  }

  private nextServerTime(seq: number): string {
    const hook = this.deps.hooks?.serverTime;
    if (hook) return hook({ projectId: this.projectId, seq });
    const now = new Date();
    const prev = this.head ? Date.parse(this.head.serverTime) : 0;
    return new Date(Math.max(now.getTime(), prev)).toISOString();
  }

  private systemDraft<K extends EventType>(type: K, payload: EventPayload<K>): CommitDraft {
    const seq = this.headSeq + 1;
    const serverTime = this.nextServerTime(seq);
    const env = this.deps.hooks?.systemEnvelope?.({
      projectId: this.projectId,
      seq,
      type,
      serverTime,
    }) ?? {
      commitId: randomUUID(),
      clientTime: serverTime,
    };
    return {
      commitId: env.commitId,
      projectId: this.projectId,
      clientTime: env.clientTime,
      actor: SYSTEM_ACTOR,
      deviceId: 'server',
      sessionId: 'system',
      schemaVersion: SCHEMA_VERSION,
      type,
      payload,
    } as unknown as CommitDraft;
  }

  /** The ingest sequence. Caller holds the lock. */
  private async appendLocked(
    draft: CommitDraft,
    actor: Actor,
    opts: { cadence?: boolean } = {},
  ): Promise<IngestOutcome> {
    const seq = this.headSeq + 1;
    const serverTime = this.nextServerTime(seq);
    const prevState = this.stateValue;

    // 1. validate
    const v = validateDraft(prevState, draft, actor, { serverTime, accountId: this.accountId });
    if (!v.ok) return { status: 'rejected', errors: v.errors };

    // 2. chain (same serverTime)
    let commit: Commit;
    try {
      commit = appendToChain(this.head, draft, serverTime, { accountId: this.accountId });
    } catch (e) {
      if (e instanceof ChainError)
        return { status: 'rejected', errors: [{ code: 'invalid-draft', message: e.message }] };
      throw e;
    }
    if (commit.hash !== v.commit.hash || commit.seq !== seq) {
      throw new InvariantViolation(`appendToChain and validateDraft disagree at seq ${seq}`);
    }
    // Invariant, before the append.
    this.assertNoTextChange(prevState, v.state, commit);

    // 3. store
    const index = this.records;
    try {
      await this.deps.store.append(
        this.path,
        { kind: 'commit', commit } satisfies StreamRecord,
        index,
      );
    } catch (e) {
      this.dirty = true;
      throw new HttpError(
        503,
        'storage-unavailable',
        `The ledger could not store the commit: ${errMsg(e)}`,
      );
    }
    this.records = index + 1;

    // Invariant, after the append: re-fold the commit exactly as stored.
    const stored = JSON.parse(JSON.stringify({ commit })).commit as Commit;
    let next: LedgerState;
    try {
      if (!verifyCommitHash(stored)) throw new Error('stored commit does not hash');
      next = applyCommit(prevState, stored);
      this.assertNoTextChange(prevState, next, stored);
      if (headHash(next) !== headHash(v.state)) {
        throw new Error('re-folding the stored commit gives a different head');
      }
    } catch (e) {
      this.halt(`seq ${seq} (${commit.type}): ${errMsg(e)}`);
      throw e instanceof InvariantViolation ? e : new InvariantViolation(errMsg(e));
    }
    this.stateValue = next;
    this.commitsList.push(stored);
    this.seqByCommitId.set(stored.commitId, stored.seq);
    if (stored.type === 'ChainHeadWitnessed') this.lastEmbeddedSeq = stored.seq;
    const update = this.history.observe(
      stored,
      projectState(prevState),
      this.docLookup(prevState, next),
    );

    // 4. witness
    const witness = await signWitness(this.deps.signer, stored);
    try {
      await this.deps.store.append(
        this.path,
        { kind: 'witness', witness } satisfies StreamRecord,
        this.records,
      );
      this.records += 1;
    } catch (e) {
      // The commit is stored; the next write reloads and re-witnesses it.
      this.dirty = true;
      this.log(`witness for seq ${seq} not stored: ${errMsg(e)}`);
    }
    this.witnessBySeq.set(seq, witness);
    this.emit({ commit: stored, witness, update, state: projectState(next) });

    // 5. resolutions: written after the triggering human commit (BUILD.md). An agent
    // annotation that is stale on arrival is already stale in the fold.
    for (const r of actor.kind === 'human' ? v.resolutions : []) {
      const res = await this.appendLocked(this.systemDraft('SuggestionResolved', r), SYSTEM_ACTOR, {
        cadence: false,
      });
      if (res.status !== 'ack') {
        throw new InvariantViolation(
          `SuggestionResolved for ${r.targetId} refused: ${JSON.stringify(res)}`,
        );
      }
    }

    // Periodic embedded witness, by count.
    const every = this.deps.cadence.everyCommits;
    if (opts.cadence !== false && every > 0 && this.unembedded >= every) {
      await this.embedWitness();
    }
    const version = update?.version;
    return { status: 'ack', seq, commit: stored, ...(version !== undefined ? { version } : {}) };
  }

  private emit(a: AppendedCommit): void {
    for (const l of [...this.listeners]) {
      try {
        l(a);
      } catch (e) {
        this.log(`listener failed: ${errMsg(e)}`);
      }
    }
  }

  private halt(reason: string): void {
    this.halted = reason;
    console.error(
      `\n[ledger ${this.projectId}] !!! ${new InvariantViolation(reason).message}\n` +
        '[ledger] the project accepts no more writes until an operator investigates.\n',
    );
  }

  /**
   * The one rule: only a human manuscript event may change manuscript text, and
   * only in its own document. Throws `InvariantViolation`.
   */
  private assertNoTextChange(prev: LedgerState, next: LedgerState, commit: Commit): void {
    const manuscript = commit.actor.kind === 'human' && isManuscriptEventType(commit.type);
    const own = (commit.payload as { documentId?: unknown }).documentId;
    for (const id of Object.keys(projectState(next).documents)) {
      const a = documentNode(prev, id);
      const b = documentNode(next, id);
      if (manuscript && id === own) continue;
      if (!a) {
        // A new document: it must start without text unless a human imported it.
        if (b && b.textContent.length > 0 && !(manuscript && id === own)) {
          throw new InvariantViolation(
            `${commit.actor.kind} ${commit.type} created document ${id} with text`,
          );
        }
        continue;
      }
      if (a !== b && !(b && a.eq(b))) {
        throw new InvariantViolation(
          `${commit.actor.kind} ${commit.type} (seq ${commit.seq}) changed the text of document ${id}`,
        );
      }
    }
  }
}
