/**
 * The human events this package emits. Each builder returns a validated
 * `{ type, payload }` pair; the controller hands it to `editor.submitEvent`, which
 * wraps it in a `CommitDraft` and queues it in order with the writer's text.
 *
 * The annotations package never emits a manuscript event except through
 * `editor.acceptProposal`, which carries no text: the fold derives the steps.
 */
import {
  ChatMessageSentSchema,
  DiscussRequestedSchema,
  FeedbackRequestedSchema,
  ProposalRejectedSchema,
  SuggestionDismissedSchema,
  TEXT_LIMITS,
  feedbackEditorOf,
  type DismissReason,
  type EditorProfile,
  type EventPayloads,
  type FeedbackEditor,
  type FeedbackScope,
  type Intensity,
  type Lens,
  type ProjectState,
} from '@longhand/schema';
import { threadFor } from './model';

/** The human event types this package submits (all non-manuscript). */
export type AnnotationEventType =
  | 'FeedbackRequested'
  | 'SuggestionDismissed'
  | 'ProposalRejected'
  | 'DiscussRequested'
  | 'ChatMessageSent';

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
  /** The named editor asked, as it is now (its lenses and intensity are `lenses` and `intensity`). */
  editor?: FeedbackEditor;
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
    ...(input.editor ? { editor: input.editor } : {}),
  });
  return { type: 'FeedbackRequested', payload };
}

/**
 * Builds the `FeedbackRequested` for asking a named editor: its lenses and
 * intensity, and a record of its id, name and brief as they are now.
 */
export function feedbackRequestFor(
  profile: EditorProfile,
  input: { scope: FeedbackScope; ask?: string | null; requestId?: string },
  makeId: () => string = newId,
): AnnotationEventOf<'FeedbackRequested'> {
  return feedbackRequested(
    {
      scope: input.scope,
      lenses: profile.lenses,
      intensity: profile.intensity,
      ask: input.ask ?? null,
      editor: feedbackEditorOf(profile),
      ...(input.requestId ? { requestId: input.requestId } : {}),
    },
    makeId,
  );
}

/** What the chat composer sends. */
export interface ChatMessageInput {
  /** The conversation; null starts a new chat. */
  chatId: string | null;
  text: string;
  /** The editor asked: its lenses and intensity bound any notes, and it is recorded as it is now. */
  editor: Pick<EditorProfile, 'id' | 'name' | 'role' | 'brief' | 'lenses' | 'intensity'>;
  scope: FeedbackScope;
  /** The margin note asked about (Discuss in the chat). */
  aboutId?: string | null;
  messageId?: string;
}

/** Builds a `ChatMessageSent` event. Throws (zod) if the input is invalid. */
export function chatMessageSent(
  input: ChatMessageInput,
  makeId: () => string = newId,
): AnnotationEventOf<'ChatMessageSent'> {
  const e = input.editor;
  const payload = ChatMessageSentSchema.parse({
    chatId: input.chatId ?? makeId(),
    messageId: input.messageId ?? makeId(),
    text: input.text.trim().slice(0, TEXT_LIMITS.chatMessageMaxChars),
    editor: feedbackEditorOf({ ...e, questions: [] } as EditorProfile),
    lenses: [...new Set(e.lenses)],
    intensity: e.intensity,
    context: { scope: input.scope, aboutId: input.aboutId ?? null },
  });
  return { type: 'ChatMessageSent', payload };
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

/** A retry of a failed review: the same scope, lenses, intensity, ask and editor under a new request id. */
export function retryRequest(
  state: ProjectState,
  requestId: string,
  makeId: () => string = newId,
): AnnotationEventOf<'FeedbackRequested'> | null {
  const req = state.annotations.feedbackRequests[requestId];
  if (!req) return null;
  return feedbackRequested(
    {
      scope: req.scope,
      lenses: req.lenses,
      intensity: req.intensity,
      ask: req.ask,
      ...(req.editor ? { editor: req.editor } : {}),
    },
    makeId,
  );
}
