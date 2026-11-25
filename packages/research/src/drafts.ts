/**
 * Commit draft builders for the research events the writer emits: `SourceAdded`,
 * `SourceUpdated`, `ClippingSaved`, `ClippingRemoved` and the `CitationInserted`
 * companion of a citation's `TextEdited` run. Every builder validates its payload
 * with the schema and throws a `ZodError` if it is invalid.
 */
import {
  SCHEMA_VERSION,
  parsePayload,
  type Actor,
  type CommitDraftOf,
  type CslItem,
  type EventPayload,
  type SourceOrigin,
  type SurfacedCandidate,
} from '@longhand/schema';

/** Envelope fields a client fills in for every human commit. */
export interface DraftContext {
  projectId: string;
  /** Must be a human actor: every research event the writer emits is human-only. */
  actor: Actor;
  deviceId: string;
  /** The editor session. */
  sessionId: string;
  /** Clock for `clientTime`. Defaults to `new Date()`. */
  now?: () => Date;
  /** Id generator for commit and entity ids. Defaults to `crypto.randomUUID()`. */
  newId?: () => string;
}

/** A draft of one of the research events. */
export type ResearchDraft =
  | CommitDraftOf<'SourceAdded'>
  | CommitDraftOf<'SourceUpdated'>
  | CommitDraftOf<'ClippingSaved'>
  | CommitDraftOf<'ClippingRemoved'>
  | CommitDraftOf<'CitationInserted'>
  | CommitDraftOf<'SuggestionDismissed'>;

/** Generates a Longhand id (a UUID). */
export function newId(ctx?: Pick<DraftContext, 'newId'>): string {
  if (ctx?.newId) return ctx.newId();
  return globalThis.crypto.randomUUID();
}

type ResearchEvent = ResearchDraft['type'];

/** Wraps a validated payload in a commit draft envelope. */
export function makeDraft<K extends ResearchEvent>(
  ctx: DraftContext,
  type: K,
  payload: EventPayload<K>,
): CommitDraftOf<K> {
  if (ctx.actor.kind !== 'human') {
    throw new Error(`${type} is a human event; got actor kind ${ctx.actor.kind}`);
  }
  return {
    commitId: newId(ctx),
    projectId: ctx.projectId,
    clientTime: (ctx.now ?? (() => new Date()))().toISOString(),
    actor: ctx.actor,
    deviceId: ctx.deviceId,
    sessionId: ctx.sessionId,
    type,
    schemaVersion: SCHEMA_VERSION,
    payload: parsePayload(type, payload),
  } as CommitDraftOf<K>;
}

/** Arguments of {@link sourceAddedDraft}. */
export interface SourceAddedInput {
  csl: CslItem;
  origin: SourceOrigin;
  /** Defaults to a new id. */
  sourceId?: string;
  /** Set when the writer verified and added an AI-surfaced candidate. */
  fromSurfaced?: { surfacedId: string; candidateIndex: number } | null;
}

/** `SourceAdded`: the writer adds a source. The CSL `id` is set to the source id. */
export function sourceAddedDraft(
  ctx: DraftContext,
  input: SourceAddedInput,
): CommitDraftOf<'SourceAdded'> {
  const sourceId = input.sourceId ?? newId(ctx);
  return makeDraft(ctx, 'SourceAdded', {
    sourceId,
    csl: { ...input.csl, id: sourceId },
    origin: input.origin,
    fromSurfacedId: input.fromSurfaced?.surfacedId ?? null,
    candidateIndex: input.fromSurfaced?.candidateIndex ?? null,
  });
}

/**
 * `SourceAdded` for an AI-surfaced candidate the writer checked. `csl` is the
 * metadata the writer confirmed (defaults to the candidate's, unedited); origin is
 * `surfaced` with the candidate's URL.
 */
export function surfacedSourceAddedDraft(
  ctx: DraftContext,
  surfacedId: string,
  candidateIndex: number,
  candidate: SurfacedCandidate,
  csl: CslItem = candidate.csl,
  sourceId?: string,
): CommitDraftOf<'SourceAdded'> {
  return sourceAddedDraft(ctx, {
    csl,
    origin: { kind: 'surfaced', value: candidate.url ?? candidate.csl.URL ?? null },
    fromSurfaced: { surfacedId, candidateIndex },
    ...(sourceId === undefined ? {} : { sourceId }),
  });
}

/** `SourceUpdated`: replace metadata, set the note, or archive / restore. */
export function sourceUpdatedDraft(
  ctx: DraftContext,
  sourceId: string,
  change: { csl?: CslItem; note?: string; archived?: boolean },
): CommitDraftOf<'SourceUpdated'> {
  const payload: EventPayload<'SourceUpdated'> = { sourceId };
  if (change.csl !== undefined) payload.csl = { ...change.csl, id: sourceId };
  if (change.note !== undefined) payload.note = change.note;
  if (change.archived !== undefined) payload.archived = change.archived;
  return makeDraft(ctx, 'SourceUpdated', payload);
}

/**
 * Normalizes clipping text so that placing it reproduces it exactly: CRLF / CR
 * become `\n` (the paragraph separator), blank lines collapse (an empty paragraph
 * contributes no inline text, so `"a\n\nb"` would place as `"a\nb"` and the fold
 * would downgrade it), and leading / trailing line breaks are dropped.
 */
export function normalizeClippingText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .join('\n');
}

/** Arguments of {@link clippingSavedDraft}. */
export interface ClippingInput {
  sourceId: string;
  text: string;
  locator?: string | null;
  note?: string | null;
  /** Defaults to a new id. */
  clippingId?: string;
}

/** `ClippingSaved`: a quote with its location, saved to a source. */
export function clippingSavedDraft(
  ctx: DraftContext,
  input: ClippingInput,
): CommitDraftOf<'ClippingSaved'> {
  const locator = input.locator?.trim() ? input.locator.trim() : null;
  const note = input.note?.trim() ? input.note : null;
  return makeDraft(ctx, 'ClippingSaved', {
    clippingId: input.clippingId ?? newId(ctx),
    sourceId: input.sourceId,
    text: normalizeClippingText(input.text),
    locator,
    note,
  });
}

/** `ClippingRemoved`. Quote blocks already placed are unaffected. */
export function clippingRemovedDraft(
  ctx: DraftContext,
  clippingId: string,
): CommitDraftOf<'ClippingRemoved'> {
  return makeDraft(ctx, 'ClippingRemoved', { clippingId });
}

/**
 * `CitationInserted`: the companion of the `TextEdited` run (method `citation`)
 * that inserts the citation node. It must be committed first (lower seq).
 */
export function citationInsertedDraft(
  ctx: DraftContext,
  payload: EventPayload<'CitationInserted'>,
): CommitDraftOf<'CitationInserted'> {
  return makeDraft(ctx, 'CitationInserted', payload);
}

/**
 * `SuggestionDismissed` for a research card: an AI-surfaced source set
 * (`SourceSurfaced.surfacedId`), a source suggestion or a citation-needed flag.
 */
export function researchCardDismissedDraft(
  ctx: DraftContext,
  targetId: string,
  reason: EventPayload<'SuggestionDismissed'>['reason'] = null,
  note: string | null = null,
): CommitDraftOf<'SuggestionDismissed'> {
  return makeDraft(ctx, 'SuggestionDismissed', { targetId, reason, note });
}
