/**
 * The human events this package emits. Each builder returns a validated
 * `{ type, payload }` pair; the controller hands it to `editor.submitEvent`, which
 * wraps it in a `CommitDraft` and queues it in order with the writer's text.
 *
 * The annotations package never emits a manuscript event except through
 * `editor.acceptProposal`, which carries no text: the fold derives the steps.
 */
import {
  DiscussRequestedSchema,
  FeedbackRequestedSchema,
  ProposalRejectedSchema,
  SuggestionDismissedSchema,
  TEXT_LIMITS,
  type DismissReason,
  type EventPayloads,
  type FeedbackScope,
  type Intensity,
  type Lens,
  type ProjectState,
} from '@longhand/schema';
import { threadFor } from './model';

/** The human event types this package submits (all non-manuscript). */
export type AnnotationEventType =
  'FeedbackRequested' | 'SuggestionDismissed' | 'ProposalRejected' | 'DiscussRequested';

/** An event ready for `editor.submitEvent(type, payload)`. */
export type AnnotationEvent = {
  [K in AnnotationEventType]: { type: K; payload: EventPayloads[K] };
}[AnnotationEventType];

/** An event of one type. */
export type AnnotationEventOf<K extends AnnotationEventType> = Extract<
  AnnotationEvent,
  { type: K }
>;

/** A random id (UUID where available). */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20)}`;
}

/** What the feedback request form collects. */
export interface FeedbackRequestInput {
  scope: FeedbackScope;
  lenses: readonly Lens[];
  intensity: Intensity;
  /** The writer's free-text ask; blank means none. */
  ask?: string | null;
  requestId?: string;
}

/** Builds a `FeedbackRequested` event. Throws (zod) if the input is invalid. */
export function feedbackRequested(
  input: FeedbackRequestInput,
  makeId: () => string = newId,
): AnnotationEventOf<'FeedbackRequested'> {
  const ask = input.ask?.trim() ? input.ask.trim().slice(0, TEXT_LIMITS.feedbackAskMaxChars) : null;
  const payload = FeedbackRequestedSchema.parse({
    requestId: input.requestId ?? makeId(),
    scope: input.scope,
    lenses: [...new Set(input.lenses)],
    intensity: input.intensity,
    ask,
  });
  return { type: 'FeedbackRequested', payload };
}

/** Builds a `SuggestionDismissed` event (any card except proposals). */
export function suggestionDismissed(
  targetId: string,
  reason: DismissReason | null = null,
  note: string | null = null,
): AnnotationEventOf<'SuggestionDismissed'> {
  const n = note?.trim() ? note.trim().slice(0, TEXT_LIMITS.dismissNoteMaxChars) : null;
  return {
    type: 'SuggestionDismissed',
    payload: SuggestionDismissedSchema.parse({ targetId, reason, note: n }),
  };
}

/** Builds a `ProposalRejected` event. */
export function proposalRejected(
  proposalId: string,
  reason: DismissReason | null = null,
): AnnotationEventOf<'ProposalRejected'> {
  return {
    type: 'ProposalRejected',
    payload: ProposalRejectedSchema.parse({ proposalId, reason }),
  };
}

/**
 * Builds a `DiscussRequested` event. The first message on a target opens a new
 * thread; follow-ups (and retries after a failure) reuse the existing thread.
 */
export function discussRequested(
  state: ProjectState | null,
  targetId: string,
  message: string,
  makeId: () => string = newId,
): AnnotationEventOf<'DiscussRequested'> {
  const thread = threadFor(state, targetId);
  return {
    type: 'DiscussRequested',
    payload: DiscussRequestedSchema.parse({
      threadId: thread?.id ?? makeId(),
      targetId,
      message: message.trim().slice(0, TEXT_LIMITS.discussMessageMaxChars),
    }),
  };
}

/** A retry of a failed review: the same scope, lenses, intensity and ask under a new request id. */
export function retryRequest(
  state: ProjectState,
  requestId: string,
  makeId: () => string = newId,
): AnnotationEventOf<'FeedbackRequested'> | null {
  const req = state.annotations.feedbackRequests[requestId];
  if (!req) return null;
  return feedbackRequested(
    { scope: req.scope, lenses: req.lenses, intensity: req.intensity, ask: req.ask },
    makeId,
  );
}
