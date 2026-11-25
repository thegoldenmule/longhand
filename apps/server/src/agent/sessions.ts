/**
 * Agent sessions: minting session ids and tokens, the server side of the
 * AnnotationSink HTTP contract (`packages/agent/README.md`), running reviews and
 * discuss replies with `@longhand/agent`, progress fan-out, cancel and shutdown.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ClaudeCliAdapter,
  HttpAnnotationSink,
  TOOL_EVENT_TYPES,
  runDiscussSession,
  runFeedbackSession,
  toolForDraft,
  type ModelAdapter,
  type SessionOutcome,
  type SessionProgressEvent,
  type ToolEventDraft,
} from '@longhand/agent';
import {
  CommitDraftSchema,
  capViolation,
  type Actor,
  type CommitDraft,
  type EventPayload,
  type Intensity,
  type ProjectState,
  type SourceSearch,
} from '@longhand/schema';
import type { ProjectLedger } from '../ledger/project';
import { remapAgentDraft } from '../ledger/positions';
import type { ReadModel } from '../storage/readmodel';
import { HttpError, errMsg } from '../util';
import { mockAdapter } from './mock-script';

/** Kind of agent session. */
export type SessionKind = 'review' | 'discuss';

/** Agent event types the events endpoint accepts, per session kind (agent README). */
const REVIEW_TYPES = new Set<string>([
  'FeedbackSessionStarted',
  'CommentAdded',
  'QuestionAsked',
  'SuggestionProposed',
  'MoveProposed',
  'CutProposed',
  'SplitProposed',
  'MergeProposed',
  'CitationNeededFlagged',
  'SourceSurfaced',
  'SourceSuggested',
  'ReviewFinished',
  'FeedbackSessionFailed',
]);
const DISCUSS_TYPES = new Set<string>([
  'FeedbackSessionStarted',
  'DiscussAnswered',
  'FeedbackSessionFailed',
]);
const CLOSING_TYPES = new Set<string>([
  'ReviewFinished',
  'DiscussAnswered',
  'FeedbackSessionFailed',
]);

/** A progress event as the session SSE sends it. */
export type SessionStreamEvent =
  | SessionProgressEvent
  | {
      kind: 'ended';
      feedbackSessionId: string;
      status: 'finished' | 'failed';
      reason: string | null;
    };

/** One session the service minted. */
export interface AgentSession {
  id: string;
  projectId: string;
  accountId: string;
  kind: SessionKind;
  requestId: string | null;
  threadId: string | null;
  intensity: Intensity | null;
  tokenHash: Buffer;
  /** `open`: drafts accepted; `cancelling`: only `FeedbackSessionFailed`; `closed`: nothing. */
  phase: 'open' | 'cancelling' | 'closed';
  /** A model run was started for this session. */
  running: boolean;
  /** The model run reported `init` (it is listening to the abort signal). */
  modelReady: boolean;
  /** Cancel arrived before the model run was ready; abort once it is. */
  abortPending: boolean;
  abort: AbortController;
  done: Promise<SessionOutcome | null>;
  events: SessionStreamEvent[];
  listeners: Set<(e: SessionStreamEvent) => void>;
  ended: boolean;
}

/** How the manager makes model adapters. */
export type AdapterFactory = (ctx: {
  kind: SessionKind;
  lens?: string;
  threadId?: string;
}) => ModelAdapter;

/** Adapter factory for `MODEL_ADAPTER` (`claude` or `mock`). */
export function adapterFactory(
  mode: 'claude' | 'mock',
  opts: { claudeBin?: string; mockStepDelayMs?: number } = {},
): AdapterFactory {
  if (mode === 'mock') {
    return (ctx) =>
      mockAdapter({
        kind: ctx.kind,
        ...(ctx.lens ? { lens: ctx.lens } : {}),
        ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
        ...(opts.mockStepDelayMs ? { stepDelayMs: opts.mockStepDelayMs } : {}),
      });
  }
  return () => new ClaudeCliAdapter(opts.claudeBin ? { command: opts.claudeBin } : {});
}

/** What the manager needs from the service. */
export interface SessionManagerDeps {
  /** Loads a project ledger (scoped to its account). */
  ledger(projectId: string): Promise<ProjectLedger>;
  /** Origin of this service, for `HttpAnnotationSink` (e.g. `http://127.0.0.1:3200`). */
  internalBaseUrl(): string;
  adapters: AdapterFactory;
  search: SourceSearch | null;
  readModel: ReadModel | null;
  models?: { full?: string; quick?: string };
  timeoutMs?: number;
  finishGraceMs?: number;
  log?: (msg: string) => void;
}

const MAX_EVENTS = 1000;

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

/** Mints, authenticates, runs and stops agent sessions. */
export class SessionManager {
  private readonly sessions = new Map<string, AgentSession>();
  private stopping = false;

  constructor(private readonly deps: SessionManagerDeps) {}

  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => console.log(m)))(`[sessions] ${msg}`);
  }

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id);
  }

  /** Sessions still running. */
  running(): AgentSession[] {
    return [...this.sessions.values()].filter((s) => s.phase !== 'closed');
  }

  /**
   * Mints a session id and token without running anything (the runner below uses
   * it; tests use it to replay recorded sessions through the events endpoint).
   */
  async open(opts: {
    projectId: string;
    accountId: string;
    kind: SessionKind;
    requestId?: string | null;
    threadId?: string | null;
    intensity?: Intensity | null;
    sessionId?: string;
  }): Promise<{ session: AgentSession; token: string }> {
    if (this.stopping) throw new HttpError(503, 'shutting-down', 'The service is shutting down.');
    const id = opts.sessionId ?? randomUUID();
    if (this.sessions.has(id)) throw new HttpError(409, 'session-exists', `Session ${id} exists.`);
    const token = randomBytes(32).toString('base64url');
    const session: AgentSession = {
      id,
      projectId: opts.projectId,
      accountId: opts.accountId,
      kind: opts.kind,
      requestId: opts.requestId ?? null,
      threadId: opts.threadId ?? null,
      intensity: opts.intensity ?? null,
      tokenHash: hashToken(token),
      phase: 'open',
      abort: new AbortController(),
      done: Promise.resolve(null),
      events: [],
      listeners: new Set(),
      ended: false,
      running: false,
      modelReady: false,
      abortPending: false,
    };
    this.sessions.set(id, session);
    await this.deps.readModel
      ?.insertSessionToken({
        sessionId: id,
        projectId: opts.projectId,
        accountId: opts.accountId,
        kind: opts.kind,
        tokenHash: session.tokenHash.toString('hex'),
      })
      .catch((e) => this.log(`session token not recorded: ${errMsg(e)}`));
    return { session, token };
  }

  /** Marks a session closed (no more drafts). */
  close(session: AgentSession): void {
    if (session.phase === 'closed') return;
    session.phase = 'closed';
    void this.deps.readModel?.closeSessionToken(session.id).catch(() => undefined);
  }

  // ------------------------------------------------------- the events endpoint

  /**
   * `POST /internal/sessions/:id/events` (agent README, "What the service must
   * do"): authenticate, dedupe, validate, order, map positions, check caps, append.
   */
  async receive(
    sessionId: string,
    authorization: string | null,
    body: unknown,
  ): Promise<{ seq: number; commitId: string; duplicate: boolean }> {
    // 1. Authenticate.
    const session = this.sessions.get(sessionId);
    if (!session) throw new HttpError(404, 'unknown-session', `There is no session ${sessionId}.`);
    const m = authorization ? /^Bearer\s+(.+)$/i.exec(authorization.trim()) : null;
    if (!m) throw new HttpError(401, 'unauthorized', 'A session bearer token is required.');
    const given = hashToken((m[1] as string).trim());
    if (given.length !== session.tokenHash.length || !timingSafeEqual(given, session.tokenHash)) {
      throw new HttpError(401, 'unauthorized', 'The session token is not valid for this session.');
    }
    const projectId = (body as { projectId?: unknown } | null)?.projectId;
    if (projectId !== session.projectId) {
      throw new HttpError(403, 'forbidden', 'This draft is for another project than the session.');
    }
    const ledger = await this.deps.ledger(session.projectId);
    const commitId = (body as { commitId?: unknown }).commitId;

    const prepare = (l: ProjectLedger, raw: CommitDraft): CommitDraft => {
      // 3. Validate.
      const parsed = CommitDraftSchema.safeParse(raw);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        throw new HttpError(400, 'invalid-draft', `The draft is not a valid commit: ${detail}`);
      }
      const draft = parsed.data as CommitDraft;
      const allowed = session.kind === 'discuss' ? DISCUSS_TYPES : REVIEW_TYPES;
      if (!allowed.has(draft.type)) {
        throw new HttpError(
          403,
          'forbidden',
          `${draft.type} is not allowed in a ${session.kind} session.`,
        );
      }
      const isFailure = draft.type === 'FeedbackSessionFailed';
      if (isFailure ? draft.actor.kind !== 'system' : draft.actor.kind !== 'agent') {
        throw new HttpError(
          403,
          'forbidden',
          `${draft.type} must come from the ${isFailure ? 'system' : 'agent'}.`,
        );
      }
      if (draft.sessionId !== (isFailure ? 'system' : session.id)) {
        throw new HttpError(403, 'forbidden', 'The envelope sessionId does not match the session.');
      }
      const payloadSession = (draft.payload as { feedbackSessionId?: string | null })
        .feedbackSessionId;
      if (payloadSession !== session.id && !(isFailure && payloadSession === null)) {
        throw new HttpError(
          403,
          'forbidden',
          'The payload feedbackSessionId does not match the session.',
        );
      }

      // 4. Order.
      const state = l.publicState;
      const folded = state.annotations.agentSessions[session.id];
      if (session.phase === 'closed' || (session.phase === 'cancelling' && !isFailure)) {
        throw new HttpError(
          409,
          'session-closed',
          'This session is closed; it accepts no more annotations.',
        );
      }
      if (draft.type === 'FeedbackSessionStarted') {
        if (folded) throw new HttpError(409, 'session-closed', 'This session has already started.');
        const trigger = draft.payload.trigger;
        const ok =
          session.kind === 'discuss'
            ? trigger.kind === 'discuss' && trigger.threadId === session.threadId
            : trigger.kind === 'feedback' && trigger.requestId === session.requestId;
        if (!ok)
          throw new HttpError(403, 'forbidden', 'The session was started for another request.');
      } else if (isFailure) {
        if (folded && folded.status !== 'running') {
          throw new HttpError(409, 'session-closed', `This session is already ${folded.status}.`);
        }
        if (!folded && payloadSession !== null) {
          throw new HttpError(
            409,
            'session-not-started',
            'The session never started; send feedbackSessionId null.',
          );
        }
      } else {
        if (!folded)
          throw new HttpError(409, 'session-not-started', 'Send FeedbackSessionStarted first.');
        if (folded.status !== 'running') {
          throw new HttpError(
            409,
            'session-closed',
            `This session is ${folded.status}; it accepts no more annotations.`,
          );
        }
      }

      // 5. Positions: re-resolve at readVersion, map to the current version.
      const mapped = remapAgentDraft(draft, l.history);
      if (!mapped.ok) {
        throw new HttpError(
          422,
          mapped.error.code,
          `The anchor did not resolve: ${mapped.error.message}`,
        );
      }

      // 6. Caps.
      if (
        (TOOL_EVENT_TYPES as readonly string[]).includes(draft.type) &&
        folded &&
        session.kind === 'review'
      ) {
        const intensity = session.intensity ?? requestIntensity(state, session.requestId);
        if (intensity) {
          const violation = capViolation(
            toolForDraft(draft as ToolEventDraft),
            folded.counts,
            intensity,
          );
          if (violation) throw new HttpError(422, 'cap-reached', violation);
        }
      }
      return mapped.value;
    };

    // 2. Dedupe happens first inside ingest; 7. append and witness.
    const outcome = await ledger.ingest(body as CommitDraft, actorOf(body), prepare);
    if (outcome.status === 'rejected') {
      const e = outcome.errors[0] ?? { code: 'invalid-draft', message: 'rejected' };
      const status = e.code === 'actor-not-permitted' || e.code === 'actor-mismatch' ? 403 : 422;
      throw new HttpError(status, e.code, `The ledger refused it: ${e.message}`);
    }
    if (outcome.status === 'ack' && CLOSING_TYPES.has(outcome.commit.type)) this.close(session);
    return {
      seq: outcome.seq,
      commitId: typeof commitId === 'string' ? commitId : outcome.commit.commitId,
      duplicate: outcome.status === 'duplicate',
    };
  }

  // --------------------------------------------------------------- running

  private progress(session: AgentSession, e: SessionStreamEvent): void {
    if (e.kind === 'model' && e.event.type === 'init') {
      session.modelReady = true;
      if (session.abortPending) session.abort.abort();
    }
    session.events.push(e);
    if (session.events.length > MAX_EVENTS)
      session.events.splice(0, session.events.length - MAX_EVENTS);
    for (const l of [...session.listeners]) {
      try {
        l(e);
      } catch {
        // listeners never break a session
      }
    }
  }

  /** Subscribes to a session's progress (replays what happened so far). */
  subscribe(session: AgentSession, listener: (e: SessionStreamEvent) => void): () => void {
    for (const e of session.events) listener(e);
    if (session.ended) return () => undefined;
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  /** Starts a review for a folded `FeedbackRequested`. */
  async startReview(opts: {
    projectId: string;
    accountId: string;
    request: EventPayload<'FeedbackRequested'>;
    model?: string;
  }): Promise<AgentSession> {
    const ledger = await this.deps.ledger(opts.projectId);
    const { session, token } = await this.open({
      projectId: opts.projectId,
      accountId: opts.accountId,
      kind: 'review',
      requestId: opts.request.requestId,
      intensity: opts.request.intensity,
    });
    const state = ledger.publicState;
    // Pass the selection the fold mapped to the current version.
    const folded = state.annotations.feedbackRequests[opts.request.requestId]?.scope;
    const selection =
      folded && folded.kind === 'selection' ? { from: folded.from, to: folded.to } : undefined;
    const adapter = this.deps.adapters({ kind: 'review', lens: opts.request.lenses[0] });
    session.done = this.supervise(session, () =>
      runFeedbackSession({
        state,
        request: opts.request,
        sink: this.sink(session, token),
        adapter,
        search: this.deps.search,
        feedbackSessionId: session.id,
        ...(selection ? { selection } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(this.deps.models ? { models: this.modelChoice() } : {}),
        ...(this.deps.timeoutMs ? { timeoutMs: this.deps.timeoutMs } : {}),
        ...(this.deps.finishGraceMs !== undefined
          ? { finishGraceMs: this.deps.finishGraceMs }
          : {}),
        signal: session.abort.signal,
        onProgress: (e) => this.progress(session, e),
      }),
    );
    return session;
  }

  /** Starts a discuss reply for a folded `DiscussRequested`. */
  async startDiscuss(opts: {
    projectId: string;
    accountId: string;
    request: EventPayload<'DiscussRequested'>;
    model?: string;
  }): Promise<AgentSession> {
    const ledger = await this.deps.ledger(opts.projectId);
    const { session, token } = await this.open({
      projectId: opts.projectId,
      accountId: opts.accountId,
      kind: 'discuss',
      threadId: opts.request.threadId,
    });
    const adapter = this.deps.adapters({ kind: 'discuss', threadId: opts.request.threadId });
    session.done = this.supervise(session, () =>
      runDiscussSession({
        state: ledger.publicState,
        request: opts.request,
        sink: this.sink(session, token),
        adapter,
        search: this.deps.search,
        feedbackSessionId: session.id,
        ...(opts.model ? { model: opts.model } : {}),
        ...(this.deps.models ? { models: this.modelChoice() } : {}),
        ...(this.deps.finishGraceMs !== undefined
          ? { finishGraceMs: this.deps.finishGraceMs }
          : {}),
        signal: session.abort.signal,
        onProgress: (e) => this.progress(session, e),
      }),
    );
    return session;
  }

  private modelChoice() {
    const m = this.deps.models ?? {};
    return {
      ...(m.full ? { fullReview: m.full } : {}),
      ...(m.quick ? { selection: m.quick, discuss: m.quick } : {}),
    };
  }

  private sink(session: AgentSession, token: string): HttpAnnotationSink {
    return new HttpAnnotationSink({
      baseUrl: this.deps.internalBaseUrl(),
      feedbackSessionId: session.id,
      token,
    });
  }

  /** Runs a session and makes sure the ledger records how it ended. */
  private async supervise(
    session: AgentSession,
    run: () => Promise<SessionOutcome>,
  ): Promise<SessionOutcome | null> {
    session.running = true;
    let outcome: SessionOutcome | null = null;
    let reason: string | null;
    try {
      outcome = await run();
      reason = outcome.reason;
    } catch (e) {
      reason = `the session runner crashed: ${errMsg(e)}`;
      this.log(`${session.id}: ${reason}`);
    }
    // If the runner could not record the end (sink down, cancelled mid-write), record it here.
    try {
      const ledger = await this.deps.ledger(session.projectId);
      const folded = ledger.publicState.annotations.agentSessions[session.id];
      const unrecordedNeverStarted = !folded && !outcome?.failedSeq;
      if ((folded && folded.status === 'running') || unrecordedNeverStarted) {
        const why =
          reason ??
          (session.abort.signal.aborted
            ? 'the session was cancelled'
            : 'the session ended without finishing');
        await ledger.appendSystem('FeedbackSessionFailed', {
          feedbackSessionId: folded ? session.id : null,
          requestId: session.requestId,
          threadId: session.threadId,
          reason: why.slice(0, 500),
        });
      }
    } catch (e) {
      this.log(`${session.id}: could not record the session end: ${errMsg(e)}`);
    }
    this.close(session);
    const status = outcome?.status ?? 'failed';
    session.ended = true;
    this.progress(session, {
      kind: 'ended',
      feedbackSessionId: session.id,
      status,
      reason: status === 'finished' ? null : reason,
    });
    session.listeners.clear();
    return outcome;
  }

  /** Cancels a running session; resolves once the ledger recorded its end. */
  async cancel(session: AgentSession): Promise<void> {
    if (session.phase === 'open') session.phase = 'cancelling';
    if (!session.running || session.ended) {
      this.close(session);
      return;
    }
    // A model adapter that has not started yet may miss an already-aborted signal
    // (MockModelAdapter does), so abort once it reports `init`, or after 5 s.
    if (session.modelReady) session.abort.abort();
    else {
      session.abortPending = true;
      setTimeout(() => session.abort.abort(), 5000).unref();
    }
    await session.done;
  }

  /** Cancels every running session (service shutdown). */
  async shutdown(timeoutMs = 15_000): Promise<void> {
    this.stopping = true;
    const running = this.running();
    if (running.length === 0) return;
    this.log(`stopping ${running.length} running session(s)`);
    await Promise.race([
      Promise.all(running.map((s) => this.cancel(s))),
      new Promise((r) => setTimeout(r, timeoutMs).unref()),
    ]);
  }
}

function requestIntensity(state: ProjectState, requestId: string | null): Intensity | null {
  return requestId ? (state.annotations.feedbackRequests[requestId]?.intensity ?? null) : null;
}

function actorOf(body: unknown): Actor {
  const a = (body as { actor?: Actor } | null)?.actor;
  return a && typeof a === 'object' && typeof a.kind === 'string' && typeof a.id === 'string'
    ? a
    : { kind: 'agent', id: 'unknown' };
}
