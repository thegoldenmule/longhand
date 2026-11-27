/**
 * The ledger service: projects, ingest, the read model, sessions and witnessing,
 * independent of HTTP (the routes in `http/app.ts` call into it).
 */
import { randomUUID } from 'node:crypto';
import { emptyState, validateDraft } from '@longhand/ledger';
import {
  SCHEMA_VERSION,
  type Actor,
  type Commit,
  type CommitDraft,
  type EventPayload,
  type ProjectState,
  type SourceSearch,
  type Witness,
} from '@longhand/schema';
import type { Principal } from './auth';
import { SessionManager, type AdapterFactory, type AgentSession } from './agent/sessions';
import {
  ProjectLedger,
  type AppendedCommit,
  type ClockHooks,
  type IngestOutcome,
} from './ledger/project';
import type { ReadModel } from './storage/readmodel';
import type { LedgerStore, RegistryRecord, StreamRecord } from './storage/streams';
import type { Signer } from './signer';
import { HttpError, Mutex, errMsg } from './util';

/** When the service embeds `ChainHeadWitnessed` (see README "Witnessing"). */
export interface CadenceConfig {
  /** Embed after this many commits since the last embedded witness. 0 disables. Default 256. */
  everyCommits: number;
  /** Also embed every this many ms when commits arrived since the last one. 0 disables. Default 10 min. */
  intervalMs: number;
}

/** Default cadence: every 256 commits, or every 10 minutes of activity. */
export const DEFAULT_CADENCE: CadenceConfig = { everyCommits: 256, intervalMs: 10 * 60_000 };

/** Service configuration. */
export interface ServiceOptions {
  store: LedgerStore;
  readModel: ReadModel;
  signer: Signer;
  adapters: AdapterFactory;
  search: SourceSearch | null;
  cadence?: Partial<CadenceConfig>;
  hooks?: ClockHooks;
  /** Start an agent session for every appended FeedbackRequested / DiscussRequested (default true). */
  autoStartSessions?: boolean;
  /** Write a ProjectState snapshot every N commits (default 50). */
  snapshotEvery?: number;
  /** Fold every project at startup instead of on first use (default false). */
  preload?: boolean;
  models?: { full?: string; quick?: string };
  sessionTimeoutMs?: number;
  finishGraceMs?: number;
  log?: (msg: string) => void;
}

/** Human events that start an agent session. */
export type SessionTriggerType = 'FeedbackRequested' | 'DiscussRequested' | 'ChatMessageSent';
const SESSION_TRIGGERS = new Set<string>([
  'FeedbackRequested',
  'DiscussRequested',
  'ChatMessageSent',
]);

/** A commit counts as arriving late (queued offline) above this lag. */
export const LATE_ARRIVAL_MS = 2 * 60_000;

/** Result of a public submit (mapped to the editor's `SubmitResult` by the HTTP layer). */
export type SubmitOutcome =
  | { status: 'ack'; seq: number; version?: number }
  | { status: 'duplicate'; seq: number; version?: number }
  | { status: 'conflict'; currentVersion: number; code: string; reason: string }
  | {
      status: 'rejected';
      code: string;
      reason: string;
      errors: Array<{ code: string; message: string; path?: string }>;
    };

/** Raw verification pieces for one project (the report lane builds the bundle on top). */
export interface BundleData {
  projectId: string;
  accountId: string;
  headSeq: number;
  headHash: string;
  commits: readonly Commit[];
  witnesses: Witness[];
  publicKeyPem: string;
  keyId: string;
  /** Seqs without a stored witness (normally none). */
  unwitnessedSeqs: number[];
  /** Commits whose serverTime is more than {@link LATE_ARRIVAL_MS} after their clientTime (offline queue). */
  lateArrivals: Array<{ seq: number; clientTime: string; serverTime: string; lagMs: number }>;
}

interface ProjectMeta {
  projectId: string;
  accountId: string;
  path: string;
}

/** The ledger service. */
export class LedgerService {
  readonly sessions: SessionManager;
  private readonly ledgers = new Map<string, Promise<ProjectLedger>>();
  private readonly metas = new Map<string, ProjectMeta>();
  private readonly registryLock = new Mutex();
  private registryCount = 0;
  private readonly pgQueues = new Map<string, Promise<void>>();
  private readonly lastSynced = new Map<string, ProjectState | null>();
  private readonly sessionsByTrigger = new Map<string, Promise<AgentSession>>();
  private readonly cadence: CadenceConfig;
  private timer: NodeJS.Timeout | null = null;
  private baseUrl = 'http://127.0.0.1:3200';
  private closed = false;

  constructor(readonly opts: ServiceOptions) {
    this.cadence = { ...DEFAULT_CADENCE, ...opts.cadence };
    this.sessions = new SessionManager({
      ledger: (id) => this.ledger(id),
      internalBaseUrl: () => this.baseUrl,
      adapters: opts.adapters,
      search: opts.search,
      readModel: opts.readModel,
      ...(opts.models ? { models: opts.models } : {}),
      ...(opts.sessionTimeoutMs ? { timeoutMs: opts.sessionTimeoutMs } : {}),
      ...(opts.finishGraceMs !== undefined ? { finishGraceMs: opts.finishGraceMs } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
  }

  private log(msg: string): void {
    (this.opts.log ?? ((m: string) => console.log(m)))(msg);
  }

  get signer(): Signer {
    return this.opts.signer;
  }

  /** Where agent sessions post their drafts (this service's own origin). */
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '');
  }

  /** Reads the registry and (optionally) folds every project. */
  async start(): Promise<void> {
    const store = this.opts.store;
    await store.ensure(store.registryPath);
    const records = await store.readAll<RegistryRecord>(store.registryPath);
    this.registryCount = records.length;
    for (const r of records) {
      if (r.kind === 'project')
        this.metas.set(r.projectId, {
          projectId: r.projectId,
          accountId: r.accountId,
          path: r.path,
        });
    }
    if (this.opts.preload) {
      for (const id of this.metas.keys())
        await this.ledger(id).catch((e) => this.log(`[service] ${id}: ${errMsg(e)}`));
    }
    if (this.cadence.intervalMs > 0) {
      this.timer = setInterval(() => void this.witnessTick(), this.cadence.intervalMs);
      this.timer.unref();
    }
  }

  /** Embeds a witness in every loaded project that had commits since its last one. */
  async witnessTick(): Promise<void> {
    for (const p of this.ledgers.values()) {
      const ledger = await p.catch(() => null);
      if (!ledger || ledger.unembedded === 0 || ledger.head?.type === 'ChainHeadWitnessed')
        continue;
      await ledger
        .witnessHead()
        .catch((e) => this.log(`[witness] ${ledger.projectId}: ${errMsg(e)}`));
    }
  }

  // ---------------------------------------------------------------- projects

  /** Loads a project's ledger (folding its stream on first use). No account check. */
  ledger(projectId: string): Promise<ProjectLedger> {
    let p = this.ledgers.get(projectId);
    if (!p) {
      p = this.loadLedger(projectId);
      this.ledgers.set(projectId, p);
      p.catch(() => this.ledgers.delete(projectId));
    }
    return p;
  }

  private async meta(projectId: string): Promise<ProjectMeta | null> {
    const m = this.metas.get(projectId);
    if (m) return m;
    const row = await this.opts.readModel.getProject(projectId);
    if (!row) return null;
    const meta = { projectId, accountId: row.accountId, path: row.streamPath };
    this.metas.set(projectId, meta);
    return meta;
  }

  private async loadLedger(projectId: string): Promise<ProjectLedger> {
    const meta = await this.meta(projectId);
    if (!meta) throw new HttpError(404, 'unknown-project', `There is no project ${projectId}.`);
    const ledger = await ProjectLedger.load(meta.projectId, meta.accountId, meta.path, {
      store: this.opts.store,
      signer: this.opts.signer,
      cadence: { everyCommits: this.cadence.everyCommits },
      ...(this.opts.hooks ? { hooks: this.opts.hooks } : {}),
      ...(this.opts.log ? { log: this.opts.log } : {}),
    });
    this.lastSynced.set(projectId, null);
    if (ledger.headSeq > 0) this.enqueueFullSync(ledger);
    ledger.subscribe((a) => this.onAppended(ledger, a));
    // Sessions that were running when the service stopped can never finish: fail them.
    if (ledger.headSeq > 0) {
      for (const s of Object.values(ledger.publicState.annotations.agentSessions)) {
        if (s.status !== 'running' || this.sessions.get(s.id)) continue;
        await ledger
          .appendSystem('FeedbackSessionFailed', {
            feedbackSessionId: s.id,
            requestId: s.requestId,
            threadId: s.threadId,
            reason: 'The ledger service restarted while this session was running.',
          })
          .catch((e) =>
            this.log(`[service] could not fail orphaned session ${s.id}: ${errMsg(e)}`),
          );
      }
    }
    return ledger;
  }

  /** A project the principal may access (404 otherwise, so ids do not leak across accounts). */
  async ledgerFor(principal: Principal, projectId: string): Promise<ProjectLedger> {
    const meta = await this.meta(projectId);
    if (!meta || meta.accountId !== principal.accountId) {
      throw new HttpError(404, 'unknown-project', `There is no project ${projectId}.`);
    }
    return this.ledger(projectId);
  }

  /** Projects of an account (from the read model). */
  async listProjects(principal: Principal) {
    await this.flush();
    return this.opts.readModel.listProjects(principal.accountId);
  }

  /**
   * Creates a project: `ProjectCreated` at seq 1. Takes the client's draft, or
   * builds one from a title.
   */
  async createProject(
    principal: Principal,
    input: {
      draft?: CommitDraft;
      title?: string;
      projectId?: string;
      deviceId?: string;
      sessionId?: string;
    },
  ): Promise<{ projectId: string; seq: number; duplicate: boolean }> {
    const actor: Actor = { kind: 'human', id: principal.actorId };
    const draft: CommitDraft =
      input.draft ??
      ({
        commitId: randomUUID(),
        projectId: input.projectId ?? randomUUID(),
        clientTime: new Date().toISOString(),
        actor,
        deviceId: input.deviceId ?? 'api',
        sessionId: input.sessionId ?? 'api',
        schemaVersion: SCHEMA_VERSION,
        type: 'ProjectCreated',
        payload: { title: input.title ?? 'Untitled' },
      } as CommitDraft);
    if (draft?.type !== 'ProjectCreated') {
      throw new HttpError(
        422,
        'invalid-draft',
        'A new project starts with a ProjectCreated draft.',
      );
    }
    const projectId = draft.projectId;
    const existing = await this.meta(projectId);
    if (existing) {
      if (existing.accountId === principal.accountId) {
        const ledger = await this.ledger(projectId);
        const c = ledger.commitById(draft.commitId);
        if (c) return { projectId, seq: c.seq, duplicate: true };
      }
      throw new HttpError(409, 'project-exists', `A project with id ${projectId} already exists.`);
    }
    const v = validateDraft(emptyState(), draft, actor, { accountId: principal.accountId });
    if (!v.ok) {
      const e = v.errors[0] as { code: string; message: string };
      throw new HttpError(
        e.code === 'actor-mismatch' || e.code === 'actor-not-permitted' ? 403 : 422,
        e.code,
        e.message,
        {
          errors: v.errors,
        },
      );
    }
    const meta: ProjectMeta = {
      projectId,
      accountId: principal.accountId,
      path: this.opts.store.projectPath(principal.accountId, projectId),
    };
    await this.registryLock.run(async () => {
      if (this.metas.has(projectId))
        throw new HttpError(
          409,
          'project-exists',
          `A project with id ${projectId} already exists.`,
        );
      await this.opts.store.ensure(meta.path);
      const record: RegistryRecord = {
        kind: 'project',
        projectId,
        accountId: meta.accountId,
        path: meta.path,
        createdAt: new Date().toISOString(),
      };
      await this.opts.store.append(this.opts.store.registryPath, record, this.registryCount);
      this.registryCount += 1;
      this.metas.set(projectId, meta);
    });
    const ledger = await this.ledger(projectId);
    const out = await ledger.ingest(draft, actor);
    if (out.status === 'rejected') {
      const e = out.errors[0] as { code: string; message: string };
      throw new HttpError(422, e.code, e.message, { errors: out.errors });
    }
    await this.flushProject(projectId);
    return { projectId, seq: out.seq, duplicate: out.status === 'duplicate' };
  }

  // ------------------------------------------------------------------ ingest

  /** Submits a human draft (the CommitTransport `submit`). */
  async submit(
    principal: Principal,
    projectId: string,
    draft: CommitDraft,
  ): Promise<SubmitOutcome> {
    const ledger = await this.ledgerFor(principal, projectId);
    const actor: Actor = { kind: 'human', id: principal.actorId };
    const out = await ledger.ingest(draft, actor);
    return this.toSubmitOutcome(ledger, draft, out);
  }

  private toSubmitOutcome(
    ledger: ProjectLedger,
    draft: CommitDraft,
    out: IngestOutcome,
  ): SubmitOutcome {
    if (out.status === 'ack' || out.status === 'duplicate') {
      if (out.status === 'ack') this.maybeStartSession(ledger, out.commit);
      return {
        status: out.status,
        seq: out.seq,
        ...(out.version !== undefined ? { version: out.version } : {}),
      };
    }
    const e = out.errors[0] ?? { code: 'invalid-draft', message: 'rejected' };
    if (e.code === 'stale-base-version' || e.code === 'future-base-version') {
      const documentId = (draft.payload as { documentId?: string }).documentId ?? '';
      return {
        status: 'conflict',
        currentVersion: ledger.history.get(documentId)?.version ?? 0,
        code: e.code,
        reason: e.message,
      };
    }
    return {
      status: 'rejected',
      code: e.code,
      reason: `${e.code}: ${e.message}`,
      errors: out.errors,
    };
  }

  // ---------------------------------------------------------------- sessions

  private triggerKey(
    projectId: string,
    kind: 'request' | 'thread' | 'chat',
    id: string,
    seq?: number,
  ): string {
    return `${projectId}:${kind}:${id}${seq === undefined ? '' : `:${seq}`}`;
  }

  private maybeStartSession(ledger: ProjectLedger, commit: Commit): void {
    if (this.opts.autoStartSessions === false) return;
    if (!SESSION_TRIGGERS.has(commit.type)) return;
    void this.startSessionFor(ledger, commit).catch((e) =>
      this.log(`[sessions] could not start a session for seq ${commit.seq}: ${errMsg(e)}`),
    );
  }

  /** Starts (once) the agent session serving a FeedbackRequested, DiscussRequested or ChatMessageSent commit. */
  startSessionFor(ledger: ProjectLedger, commit: Commit): Promise<AgentSession> {
    const pid = ledger.projectId;
    let key: string;
    let start: () => Promise<AgentSession>;
    const base = { projectId: pid, accountId: ledger.accountId };
    if (commit.type === 'FeedbackRequested') {
      const request = commit.payload as EventPayload<'FeedbackRequested'>;
      key = this.triggerKey(pid, 'request', request.requestId);
      start = () => this.sessions.startReview({ ...base, request });
    } else if (commit.type === 'ChatMessageSent') {
      const request = commit.payload as EventPayload<'ChatMessageSent'>;
      key = this.triggerKey(pid, 'chat', `${request.chatId}/${request.messageId}`);
      start = () => this.sessions.startChat({ ...base, request });
    } else {
      const request = commit.payload as EventPayload<'DiscussRequested'>;
      key = this.triggerKey(pid, 'thread', request.threadId, commit.seq);
      start = () => this.sessions.startDiscuss({ ...base, request });
    }
    const existing = this.sessionsByTrigger.get(key);
    if (existing) return existing;
    const started = start();
    // Registered synchronously, so a racing call does not start a second session.
    this.sessionsByTrigger.set(key, started);
    started.catch(() => this.sessionsByTrigger.delete(key));
    return started;
  }

  /**
   * `POST /feedback`, `POST /discuss` and `POST /chat`: appends the writer's draft
   * and returns the session serving it.
   */
  async requestSession(
    principal: Principal,
    projectId: string,
    draft: CommitDraft,
    type: SessionTriggerType,
  ): Promise<{ outcome: SubmitOutcome; session: AgentSession | null }> {
    if (draft?.type !== type)
      throw new HttpError(422, 'invalid-draft', `Expected a ${type} draft.`);
    const ledger = await this.ledgerFor(principal, projectId);
    const out = await ledger.ingest(draft, { kind: 'human', id: principal.actorId });
    if (out.status === 'rejected')
      return { outcome: this.toSubmitOutcome(ledger, draft, out), session: null };
    const session = await this.startSessionFor(ledger, out.commit);
    return {
      outcome: { status: out.status, seq: out.seq },
      session,
    };
  }

  /** A session of the principal's project. */
  sessionFor(principal: Principal, projectId: string, sessionId: string): AgentSession {
    const s = this.sessions.get(sessionId);
    if (!s || s.projectId !== projectId || s.accountId !== principal.accountId) {
      throw new HttpError(404, 'unknown-session', `There is no session ${sessionId}.`);
    }
    return s;
  }

  // ---------------------------------------------------------------- bundle

  /** Commits, witnesses and the witness key for a project. */
  async bundleData(principal: Principal, projectId: string): Promise<BundleData> {
    const ledger = await this.ledgerFor(principal, projectId);
    return this.bundleOf(ledger);
  }

  bundleOf(ledger: ProjectLedger): BundleData {
    const commits = ledger.commits;
    const witnesses = ledger.witnesses;
    const have = new Set(witnesses.map((w) => w.seq));
    return {
      projectId: ledger.projectId,
      accountId: ledger.accountId,
      headSeq: ledger.headSeq,
      headHash: ledger.head?.hash ?? '0'.repeat(64),
      commits,
      witnesses,
      publicKeyPem: this.opts.signer.publicKeyPem,
      keyId: this.opts.signer.keyId,
      unwitnessedSeqs: commits.filter((c) => !have.has(c.seq)).map((c) => c.seq),
      lateArrivals: commits
        .map((c) => ({
          seq: c.seq,
          clientTime: c.clientTime,
          serverTime: c.serverTime,
          lagMs: Date.parse(c.serverTime) - Date.parse(c.clientTime),
        }))
        .filter((x) => x.lagMs > LATE_ARRIVAL_MS),
    };
  }

  // ------------------------------------------------------------ read model

  private enqueue(projectId: string, job: () => Promise<void>): void {
    const prev = this.pgQueues.get(projectId) ?? Promise.resolve();
    const next = prev.then(job).catch((e) => this.log(`[readmodel] ${projectId}: ${errMsg(e)}`));
    this.pgQueues.set(projectId, next);
  }

  private onAppended(ledger: ProjectLedger, a: AppendedCommit): void {
    const rm = this.opts.readModel;
    const every = this.opts.snapshotEvery ?? 50;
    this.enqueue(ledger.projectId, async () => {
      await this.writeProjectRow(ledger, a.state, a.commit);
      await rm.insertCommits([a.commit]);
      await rm.insertWitnesses([a.witness]);
      await rm.syncState(this.lastSynced.get(ledger.projectId) ?? null, a.state);
      this.lastSynced.set(ledger.projectId, a.state);
      if (a.commit.seq % every === 0) await rm.writeSnapshot(a.state);
    });
  }

  private async writeProjectRow(
    ledger: ProjectLedger,
    state: ProjectState,
    head: Commit,
  ): Promise<void> {
    const first = ledger.commits[0] as Commit;
    await this.opts.readModel.upsertProject({
      projectId: ledger.projectId,
      accountId: ledger.accountId,
      title: state.settings.title,
      streamPath: ledger.path,
      createdAt: first.serverTime,
      headSeq: head.seq,
      headHash: head.hash,
      updatedAt: head.serverTime,
    });
  }

  /** Brings the read model up to the ledger (after a load). */
  private enqueueFullSync(ledger: ProjectLedger): void {
    const rm = this.opts.readModel;
    this.enqueue(ledger.projectId, async () => {
      const state = ledger.publicState;
      const head = ledger.head as Commit;
      await this.writeProjectRow(ledger, state, head);
      await rm.insertCommits(ledger.commits);
      await rm.insertWitnesses(ledger.witnesses);
      await rm.syncState(null, state);
      await rm.writeSnapshot(state);
      this.lastSynced.set(ledger.projectId, state);
    });
  }

  /** Waits until the read model has caught up with one project. */
  async flushProject(projectId: string): Promise<void> {
    await this.pgQueues.get(projectId);
  }

  /** Waits for every read-model write, and writes a snapshot of each loaded project at its head. */
  async flush(opts: { snapshots?: boolean } = {}): Promise<void> {
    await Promise.all([...this.pgQueues.values()]);
    if (opts.snapshots) {
      for (const p of this.ledgers.values()) {
        const l = await p.catch(() => null);
        if (l && l.headSeq > 0)
          this.enqueue(l.projectId, () => this.opts.readModel.writeSnapshot(l.publicState));
      }
      await Promise.all([...this.pgQueues.values()]);
    }
  }

  /**
   * Rebuilds the whole read model from the streams: empties it, then folds every
   * project in the registry and writes its rows.
   */
  async rebuild(): Promise<{ projects: number; commits: number }> {
    await this.flush();
    const rm = this.opts.readModel;
    await rm.truncateAll();
    const store = this.opts.store;
    const registry = await store.readAll<RegistryRecord>(store.registryPath);
    let commits = 0;
    let projects = 0;
    for (const r of registry) {
      if (r.kind !== 'project') continue;
      const records = await store.readAll<StreamRecord>(r.path);
      if (!records.some((x) => x.kind === 'commit')) continue;
      this.metas.set(r.projectId, { projectId: r.projectId, accountId: r.accountId, path: r.path });
      this.ledgers.delete(r.projectId);
      const ledger = await this.ledger(r.projectId);
      await this.flushProject(r.projectId);
      commits += ledger.headSeq;
      projects += 1;
    }
    return { projects, commits };
  }

  // --------------------------------------------------------------- shutdown

  /** True once {@link close} started: public routes answer 503 while sessions wind down. */
  get closing(): boolean {
    return this.closed;
  }

  /** Stops timers without any cleanup (crash simulation in tests). */
  abandon(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** Stops sessions (recording their end), flushes the read model and snapshots. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.sessions.shutdown();
    await this.flush({ snapshots: true });
  }
}
