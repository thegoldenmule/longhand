/**
 * Commit drafts the agent emits.
 *
 * The agent only ever produces agent-actor drafts (annotation layer) plus one
 * system draft, `FeedbackSessionFailed`, when a session cannot finish. It never
 * produces a manuscript event: there is no code path here that could build one.
 */
import {
  CommitDraftSchema,
  EVENTS,
  SCHEMA_VERSION,
  type CommitDraftOf,
  type EventPayloads,
} from '@longhand/schema';

/** Agent event types the agent package emits. Every one is an annotation-layer event. */
export const AGENT_EVENT_TYPES = [
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
  'DiscussAnswered',
] as const;

/** An agent event type. */
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/** Agent event types a tool call can produce (everything except `FeedbackSessionStarted`, which the runner emits). */
export type ToolEventType = Exclude<AgentEventType, 'FeedbackSessionStarted'>;

/** Agent event types a tool call can produce. */
export const TOOL_EVENT_TYPES: readonly ToolEventType[] = AGENT_EVENT_TYPES.filter(
  (t): t is ToolEventType => t !== 'FeedbackSessionStarted',
);

// Compile-time + load-time guard: every listed type really is agent-only and non-manuscript.
for (const t of AGENT_EVENT_TYPES) {
  if (EVENTS[t].actor !== 'agent' || EVENTS[t].manuscript) {
    throw new Error(`${t} is not an agent annotation event`);
  }
}

/** A commit draft of an agent event. */
export type AgentEventDraft = { [K in AgentEventType]: CommitDraftOf<K> }[AgentEventType];

/** A commit draft produced by a tool call. */
export type ToolEventDraft = { [K in ToolEventType]: CommitDraftOf<K> }[ToolEventType];

/** The one system draft the agent emits. */
export type SessionFailedDraft = CommitDraftOf<'FeedbackSessionFailed'>;

/** Anything the agent hands to an {@link AnnotationSink}. */
export type SinkDraft = AgentEventDraft | SessionFailedDraft;

/** Envelope context shared by every draft of one session. */
export interface DraftContext {
  projectId: string;
  feedbackSessionId: string;
  /** Model alias or id; becomes the agent actor id. */
  model: string;
  now: () => string;
  newId: () => string;
}

/** Builds an agent-actor draft. */
export function agentDraft<K extends AgentEventType>(
  ctx: DraftContext,
  type: K,
  payload: EventPayloads[K],
): CommitDraftOf<K> {
  return {
    commitId: ctx.newId(),
    projectId: ctx.projectId,
    clientTime: ctx.now(),
    actor: { kind: 'agent', id: ctx.model },
    deviceId: 'server',
    sessionId: ctx.feedbackSessionId,
    type,
    schemaVersion: SCHEMA_VERSION,
    payload,
  } as CommitDraftOf<K>;
}

/** Builds the system draft recording a failed session. */
export function sessionFailedDraft(
  ctx: Omit<DraftContext, 'model'>,
  payload: EventPayloads['FeedbackSessionFailed'],
): SessionFailedDraft {
  return {
    commitId: ctx.newId(),
    projectId: ctx.projectId,
    clientTime: ctx.now(),
    actor: { kind: 'system', id: 'agent-runner' },
    deviceId: 'server',
    sessionId: 'system',
    type: 'FeedbackSessionFailed',
    schemaVersion: SCHEMA_VERSION,
    payload: { ...payload, reason: truncate(payload.reason, 500) },
  };
}

/** Validates a draft against `CommitDraftSchema`; returns an error message or null. */
export function draftError(draft: unknown): string | null {
  const r = CommitDraftSchema.safeParse(draft);
  if (r.success) return null;
  return r.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** True if `type` is an agent event type this package may emit. */
export function isAgentEventType(type: string): type is AgentEventType {
  return (AGENT_EVENT_TYPES as readonly string[]).includes(type);
}

/** True if `type` is produced by a tool call. */
export function isToolEventType(type: string): type is ToolEventType {
  return (TOOL_EVENT_TYPES as readonly string[]).includes(type);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
