/**
 * Session runner: one feedback review or one discuss reply, end to end.
 *
 * 1. Build the prompt context and snapshot from the `ProjectState`.
 * 2. Append `FeedbackSessionStarted` (agent) to the sink.
 * 3. Start the loopback relay, write the tool-server config and `--mcp-config`
 *    to a private temp dir, and run the model adapter.
 * 4. Annotations stream to the sink through the relay as the model makes them.
 * 5. The session is finished when `ReviewFinished` / `DiscussAnswered` was
 *    accepted; otherwise append `FeedbackSessionFailed` (system) with the reason.
 */
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DiscussRequestedSchema,
  FeedbackRequestedSchema,
  toolsForSession,
  type ProjectState,
  type SourceSearch,
} from '@longhand/schema';
import type { ModelAdapter, ModelEvent, ModelRunResult } from './adapters/types';
import {
  buildDiscussContext,
  buildReviewContext,
  type DiscussRequest,
  type FeedbackRequest,
  type ModelChoice,
  type PromptContext,
  type ReviewContextInput,
} from './context';
import { agentDraft, sessionFailedDraft, type ToolEventDraft } from './drafts';
import { mcpConfigJson, toolServerLaunch, type ToolServerConfig } from './mcp/config';
import { MCP_TOOL_PREFIX } from './mcp/server';
import { SessionRelay } from './relay';
import { errMsg, type AnnotationSink } from './sink';

/** Default wall-clock limits per kind of session (ms). */
export const DEFAULT_TIMEOUTS = Object.freeze({
  fullReview: 15 * 60_000,
  selection: 5 * 60_000,
  discuss: 3 * 60_000,
});

/**
 * Progress reported while a session runs (for streaming items into the UI).
 * Every event names its session: `feedbackSessionId` is the id the runner was
 * given (or picked) and is set on every event from `started` on. Only a `failed`
 * reported before `FeedbackSessionStarted` was appended has `null`, matching that
 * `FeedbackSessionFailed` payload (no such session exists in the ledger).
 */
export type SessionProgressEvent =
  | { kind: 'started'; feedbackSessionId: string; model: string; seq: number }
  | { kind: 'model'; feedbackSessionId: string; event: ModelEvent }
  | { kind: 'annotation'; feedbackSessionId: string; seq: number; draft: ToolEventDraft }
  | { kind: 'finished'; feedbackSessionId: string }
  | { kind: 'failed'; feedbackSessionId: string | null; reason: string };

/** Options shared by both kinds of session. */
export interface SessionRunOptions {
  state: ProjectState;
  sink: AnnotationSink;
  adapter: ModelAdapter;
  search?: SourceSearch | null;
  /** Session id (the ledger service usually picks it, with its token). Default: a new UUID. */
  feedbackSessionId?: string;
  /** Overrides the model entirely. */
  model?: string;
  models?: Partial<ModelChoice>;
  /** Wall-clock limit for the model run (default per kind, see {@link DEFAULT_TIMEOUTS}). */
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (event: SessionProgressEvent) => void;
  now?: () => string;
  newId?: () => string;
  /** Where to create the session temp dir (default `os.tmpdir()`). */
  tmpRoot?: string;
  /** Keep the temp dir for debugging. */
  keepTempFiles?: boolean;
  /**
   * After the finishing tool is accepted, how long the model may take to end its
   * turn before the run is stopped (default 60000 ms). The session counts as
   * finished either way.
   */
  finishGraceMs?: number;
}

/** Options for {@link runFeedbackSession}. */
export interface FeedbackSessionOptions extends SessionRunOptions {
  request: FeedbackRequest;
  /** Selection mapped to the document's current version, if it moved on since the request. */
  selection?: { from: number; to: number };
  context?: Pick<ReviewContextInput, 'maxTargetChars' | 'historyLimit' | 'nearbyCount'>;
}

/** Options for {@link runDiscussSession}. */
export interface DiscussSessionOptions extends SessionRunOptions {
  request: DiscussRequest;
}

/** How a session ended. */
export interface SessionOutcome {
  status: 'finished' | 'failed';
  feedbackSessionId: string;
  model: string;
  /** Failure reason (also written as `FeedbackSessionFailed`). */
  reason: string | null;
  /** Seq of `FeedbackSessionStarted`, if it was appended. */
  startedSeq: number | null;
  /** Seq of `FeedbackSessionFailed`, if one was appended. */
  failedSeq: number | null;
  /** Annotation drafts the sink accepted, in order (includes ReviewFinished / DiscussAnswered). */
  annotations: Array<{ seq: number; draft: ToolEventDraft }>;
  /** Tool calls the server rejected (the model may have retried them). */
  rejectedCalls: number;
  run: ModelRunResult | null;
  context: PromptContext | null;
  warnings: string[];
}

/** Runs a review for a `FeedbackRequested`. Never throws for model or sink failures. */
export function runFeedbackSession(options: FeedbackSessionOptions): Promise<SessionOutcome> {
  const request = FeedbackRequestedSchema.parse(options.request);
  const kind = request.scope.kind === 'selection' ? 'selection' : 'fullReview';
  return runSession(options, {
    sessionKind: 'review',
    trigger: { kind: 'feedback', requestId: request.requestId },
    failIds: { requestId: request.requestId, threadId: null },
    defaultTimeout: DEFAULT_TIMEOUTS[kind],
    finishTool: 'finish_review',
    build: (feedbackSessionId) =>
      buildReviewContext({
        state: options.state,
        request,
        feedbackSessionId,
        model: options.model,
        models: options.models,
        selection: options.selection,
        ...options.context,
      }),
  });
}

/** Runs a discuss reply for a `DiscussRequested`. Never throws for model or sink failures. */
export function runDiscussSession(options: DiscussSessionOptions): Promise<SessionOutcome> {
  const request = DiscussRequestedSchema.parse(options.request);
  return runSession(options, {
    sessionKind: 'discuss',
    trigger: { kind: 'discuss', threadId: request.threadId },
    failIds: { requestId: null, threadId: request.threadId },
    defaultTimeout: DEFAULT_TIMEOUTS.discuss,
    finishTool: 'answer_discussion',
    build: (feedbackSessionId) =>
      buildDiscussContext({
        state: options.state,
        request,
        feedbackSessionId,
        model: options.model,
        models: options.models,
      }),
  });
}

interface SessionSpec {
  sessionKind: 'review' | 'discuss';
  trigger: { kind: 'feedback'; requestId: string } | { kind: 'discuss'; threadId: string };
  failIds: { requestId: string | null; threadId: string | null };
  defaultTimeout: number;
  finishTool: 'finish_review' | 'answer_discussion';
  build: (feedbackSessionId: string) => PromptContext;
}

async function runSession(o: SessionRunOptions, spec: SessionSpec): Promise<SessionOutcome> {
  const feedbackSessionId = o.feedbackSessionId ?? randomUUID();
  const now = o.now ?? (() => new Date().toISOString());
  const newId = o.newId ?? randomUUID;
  const progress = (e: SessionProgressEvent) => {
    try {
      o.onProgress?.(e);
    } catch {
      // Progress listeners never break a session.
    }
  };
  const outcome: SessionOutcome = {
    status: 'failed',
    feedbackSessionId,
    model: o.model ?? '',
    reason: null,
    startedSeq: null,
    failedSeq: null,
    annotations: [],
    rejectedCalls: 0,
    run: null,
    context: null,
    warnings: [],
  };
  const failWith = async (reason: string): Promise<SessionOutcome> => {
    outcome.status = 'failed';
    outcome.reason = reason;
    const draft = sessionFailedDraft(
      { projectId: o.state.projectId, feedbackSessionId, now, newId },
      {
        feedbackSessionId: outcome.startedSeq === null ? null : feedbackSessionId,
        requestId: spec.failIds.requestId,
        threadId: spec.failIds.threadId,
        reason,
      },
    );
    const r = await o.sink.append(draft).catch((e: unknown) => ({
      ok: false as const,
      error: { code: 'unavailable', message: errMsg(e), retryable: true },
    }));
    if (r.ok) outcome.failedSeq = r.seq;
    else outcome.warnings.push(`could not record FeedbackSessionFailed: ${r.error.message}`);
    progress({
      kind: 'failed',
      feedbackSessionId: outcome.startedSeq === null ? null : feedbackSessionId,
      reason,
    });
    return outcome;
  };

  // 1. Context.
  let context: PromptContext;
  try {
    context = spec.build(feedbackSessionId);
  } catch (e) {
    return failWith(`could not build the session context: ${errMsg(e)}`);
  }
  outcome.context = context;
  outcome.model = context.model;
  outcome.warnings.push(...context.warnings);

  // 2. FeedbackSessionStarted.
  const ctx = {
    projectId: o.state.projectId,
    feedbackSessionId,
    model: context.model,
    now,
    newId,
  };
  const started = await o.sink
    .append(
      agentDraft(ctx, 'FeedbackSessionStarted', {
        feedbackSessionId,
        trigger: spec.trigger,
        model: context.model,
        systemPromptVersion: context.systemPromptVersion,
      }),
    )
    .catch((e: unknown) => ({
      ok: false as const,
      error: { code: 'unavailable', message: errMsg(e), retryable: true },
    }));
  if (!started.ok) {
    return failWith(`could not start the session: ${started.error.message}`);
  }
  outcome.startedSeq = started.seq;
  progress({ kind: 'started', feedbackSessionId, model: context.model, seq: started.seq });

  // 3. Relay + tool server config + model run.
  const relay = new SessionRelay({
    projectId: o.state.projectId,
    feedbackSessionId,
    sessionKind: spec.sessionKind,
    intensity: context.snapshot.intensity,
    sink: o.sink,
    search: o.search ?? null,
    initialCounts: context.snapshot.counts,
    onAccepted: (draft, seq) => {
      progress({ kind: 'annotation', feedbackSessionId, seq, draft });
      if (draft.type === 'ReviewFinished' || draft.type === 'DiscussAnswered') {
        graceTimer = setTimeout(() => runAbort.abort(), o.finishGraceMs ?? 60_000);
        graceTimer.unref();
      }
    },
  });
  // Aborts the model run on the caller's signal, or once the finish grace runs out.
  const runAbort = new AbortController();
  let graceTimer: NodeJS.Timeout | null = null;
  const onCallerAbort = () => runAbort.abort();
  if (o.signal?.aborted) runAbort.abort();
  o.signal?.addEventListener('abort', onCallerAbort, { once: true });
  let dir: string | null = null;
  try {
    const relayAddr = await relay.start();
    dir = await mkdtemp(join(o.tmpRoot ?? tmpdir(), 'longhand-session-'));
    await chmod(dir, 0o700);
    const config: ToolServerConfig = {
      configVersion: 1,
      snapshot: context.snapshot,
      relay: relayAddr,
      search: Boolean(o.search),
    };
    const configPath = join(dir, 'tool-server.json');
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    const launch = toolServerLaunch(configPath);
    const mcpPath = join(dir, 'mcp.json');
    await writeFile(mcpPath, mcpConfigJson(launch), { mode: 0o600 });

    const run = await o.adapter.run({
      sessionKind: spec.sessionKind,
      model: context.model,
      systemPrompt: context.systemPrompt,
      prompt: context.prompt,
      mcp: { launch, configPath: mcpPath },
      allowedTools: toolsForSession(spec.sessionKind).map((t) => `${MCP_TOOL_PREFIX}${t}`),
      cwd: dir,
      timeoutMs: o.timeoutMs ?? spec.defaultTimeout,
      signal: runAbort.signal,
      onEvent: (event) => progress({ kind: 'model', feedbackSessionId, event }),
    });
    outcome.run = run;
    outcome.rejectedCalls = run.toolCalls.filter((c) => c.result?.isError).length;
  } catch (e) {
    outcome.warnings.push(`session error: ${errMsg(e)}`);
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
    o.signal?.removeEventListener('abort', onCallerAbort);
    relay.closeSession();
    await relay.close();
    if (dir && !o.keepTempFiles) await rm(dir, { recursive: true, force: true });
  }
  outcome.annotations = [...relay.accepted];
  outcome.warnings.push(
    ...relay.rejected.map((r) => `relay rejected a draft (${r.code}): ${r.message}`),
  );

  // 4. Outcome.
  const finished = relay.accepted.some(
    (a) => a.draft.type === 'ReviewFinished' || a.draft.type === 'DiscussAnswered',
  );
  if (finished) {
    outcome.status = 'finished';
    progress({ kind: 'finished', feedbackSessionId });
    return outcome;
  }
  const run = outcome.run;
  const reason = !run
    ? (outcome.warnings[outcome.warnings.length - 1] ?? 'the session could not run')
    : run.status === 'timeout'
      ? `timed out after ${Math.round((o.timeoutMs ?? spec.defaultTimeout) / 1000)} s without ${spec.finishTool}`
      : run.status === 'aborted'
        ? 'the session was cancelled'
        : run.status === 'error'
          ? (run.error ?? 'the model run failed')
          : `the model ended without calling ${spec.finishTool}`;
  return failWith(reason);
}
