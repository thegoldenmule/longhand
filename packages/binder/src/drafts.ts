/**
 * Draft builders: pure functions that read the binder model and return the event a
 * binder action should emit, or a reason it is refused.
 *
 * A `BinderDraft` is `{type, payload}`. It is the part of a commit the binder knows
 * about; `toCommitDraft` (or a drafter from `createCommitDrafter`) wraps it in the
 * commit envelope (`commitId`, `clientTime`, actor, device and session) the ledger
 * service expects. Components emit `BinderDraft`s and never talk to the network.
 */
import {
  EVENTS,
  ID_RE,
  ProjectSettingsSchema,
  SCHEMA_VERSION,
  TEXT_LIMITS,
  TitleSchema,
  type BinderArea,
  type BinderRef,
  type CommitDraft,
  type EventPayload,
  type ProjectSettings,
} from '@longhand/schema';
import {
  childrenOf,
  getNode,
  isEffectivelyArchived,
  isSelfOrDescendant,
  kindForArea,
  locate,
  sameRef,
  type BinderModel,
  type Placement,
} from './model';

/** Event types the binder emits and the optimistic reducer applies. */
export const BINDER_EVENT_TYPES = [
  'ProjectSettingsChanged',
  'DocumentCreated',
  'DocumentRenamed',
  'DocumentMoved',
  'DocumentArchived',
  'SynopsisEdited',
  'FolderCreated',
  'FolderRenamed',
  'FolderMoved',
  'FolderArchived',
] as const;

/** An event type the binder emits. */
export type BinderEventType = (typeof BINDER_EVENT_TYPES)[number];

/** A binder event without its commit envelope. */
export interface BinderDraftOf<K extends BinderEventType> {
  type: K;
  payload: EventPayload<K>;
}

/** Any binder event without its commit envelope. */
export type BinderDraft = { [K in BinderEventType]: BinderDraftOf<K> }[BinderEventType];

/** Why a binder action was refused. */
export type BinderErrorCode =
  | 'not-found'
  | 'invalid-parent'
  | 'cross-area'
  | 'cycle'
  | 'archived'
  | 'invalid-title'
  | 'invalid-synopsis'
  | 'invalid-settings'
  | 'invalid-id'
  | 'duplicate-id'
  | 'invalid-index'
  | 'invalid-payload'
  | 'no-op';

/** A refused binder action, with a message fit to show the writer. */
export interface BinderError {
  code: BinderErrorCode;
  message: string;
}

/** A builder's result. */
export type DraftResult<D> = { ok: true; draft: D } | { ok: false; error: BinderError };

/** True if `type` is a binder event type. */
export function isBinderEventType(type: string): type is BinderEventType {
  return (BINDER_EVENT_TYPES as readonly string[]).includes(type);
}

const fail = (code: BinderErrorCode, message: string): { ok: false; error: BinderError } => ({
  ok: false,
  error: { code, message },
});

function ok<D extends BinderDraft>(draft: D): DraftResult<D> {
  const parsed = EVENTS[draft.type].payload.safeParse(draft.payload);
  if (!parsed.success) {
    // Builders check everything first; this is a last line of defence.
    return fail('invalid-payload', parsed.error.issues[0]?.message ?? 'invalid payload');
  }
  return { ok: true, draft };
}

function newUuid(): string {
  return globalThis.crypto.randomUUID();
}

/** Normalizes a writer-entered title (trims surrounding whitespace). */
export function normalizeTitle(title: string): string {
  return title.trim();
}

function checkTitle(title: string): BinderError | null {
  if (title.length === 0) return { code: 'invalid-title', message: 'A title cannot be empty.' };
  if (title.length > TEXT_LIMITS.titleMaxChars) {
    return {
      code: 'invalid-title',
      message: `A title can be at most ${TEXT_LIMITS.titleMaxChars} characters.`,
    };
  }
  if (!TitleSchema.safeParse(title).success) {
    return { code: 'invalid-title', message: 'That title is not valid.' };
  }
  return null;
}

/**
 * Structural placement check shared by the builders and the reducer: the parent
 * exists, is a folder in the same area, and (for folders) is not the node itself or
 * one of its descendants. `moving` is null for a node being created.
 */
export function checkPlacement(
  model: Pick<BinderModel, 'binder' | 'folders' | 'documents'>,
  area: BinderArea,
  placement: Placement,
  moving: BinderRef | null,
): BinderError | null {
  if (!Number.isInteger(placement.index) || placement.index < 0) {
    return { code: 'invalid-index', message: 'The position must be a whole number, 0 or more.' };
  }
  const { parentId } = placement;
  if (parentId === null) return null;
  const parent = model.folders[parentId];
  if (!parent) {
    return model.documents[parentId]
      ? { code: 'invalid-parent', message: 'Items can only be placed inside folders.' }
      : { code: 'not-found', message: 'That folder no longer exists.' };
  }
  if (parent.area !== area) {
    return {
      code: 'cross-area',
      message: 'Items cannot move between the Manuscript and Notes areas.',
    };
  }
  if (moving?.kind === 'folder' && isSelfOrDescendant(model, parentId, moving.id)) {
    return { code: 'cycle', message: 'A folder cannot be moved inside itself.' };
  }
  return null;
}

/** Clamps a placement's index to the parent's child count (after removing `moving`). */
function clampPlacement(
  model: BinderModel,
  area: BinderArea,
  placement: Placement,
  moving: BinderRef | null,
): Placement {
  const siblings = childrenOf(model, area, placement.parentId) ?? [];
  const count = moving ? siblings.filter((r) => !sameRef(r, moving)).length : siblings.length;
  return { parentId: placement.parentId, index: Math.min(placement.index, count) };
}

function checkNewId(model: BinderModel, id: string): BinderError | null {
  if (!ID_RE.test(id))
    return { code: 'invalid-id', message: 'Ids are 1–64 of A–Z, a–z, 0–9, _ or -.' };
  if (model.folders[id] || model.documents[id]) {
    return { code: 'duplicate-id', message: 'That id is already in use.' };
  }
  return null;
}

function checkParentOpen(model: BinderModel, parentId: string | null): BinderError | null {
  if (parentId !== null && isEffectivelyArchived(model, { kind: 'folder', id: parentId })) {
    return { code: 'archived', message: 'That folder is archived. Restore it first.' };
  }
  return null;
}

/** Options for creating a document or folder. */
export interface CreateOptions {
  area: BinderArea;
  title: string;
  /** Parent folder, or null (the default) for the area root. */
  parentId?: string | null;
  /** Position among the parent's children; defaults to the end. Clamped. */
  index?: number;
  /** The new node's id; defaults to `crypto.randomUUID()`. */
  id?: string;
}

function prepareCreate(model: BinderModel, opts: CreateOptions) {
  const id = opts.id ?? newUuid();
  const title = normalizeTitle(opts.title);
  const parentId = opts.parentId ?? null;
  const index = opts.index ?? Number.MAX_SAFE_INTEGER;
  const err =
    checkNewId(model, id) ??
    checkTitle(title) ??
    checkPlacement(model, opts.area, { parentId, index }, null) ??
    checkParentOpen(model, parentId);
  if (err) return { ok: false, error: err } as const;
  const placement = clampPlacement(model, opts.area, { parentId, index }, null);
  return { ok: true, id, title, placement } as const;
}

/**
 * Creates a document. Its kind follows the area: `manuscript` documents in the
 * Manuscript area, `note`s in Notes.
 */
export function createDocument(
  model: BinderModel,
  opts: CreateOptions,
): DraftResult<BinderDraftOf<'DocumentCreated'>> {
  const prep = prepareCreate(model, opts);
  if (!prep.ok) return prep;
  return ok({
    type: 'DocumentCreated',
    payload: {
      documentId: prep.id,
      kind: kindForArea(opts.area),
      title: prep.title,
      parentId: prep.placement.parentId,
      index: prep.placement.index,
    },
  });
}

/** Creates a folder. */
export function createFolder(
  model: BinderModel,
  opts: CreateOptions,
): DraftResult<BinderDraftOf<'FolderCreated'>> {
  const prep = prepareCreate(model, opts);
  if (!prep.ok) return prep;
  return ok({
    type: 'FolderCreated',
    payload: {
      folderId: prep.id,
      area: opts.area,
      title: prep.title,
      parentId: prep.placement.parentId,
      index: prep.placement.index,
    },
  });
}

const notFound = (ref: BinderRef) =>
  fail(
    'not-found',
    ref.kind === 'folder' ? 'That folder no longer exists.' : 'That document no longer exists.',
  );

/** Renames a document or folder. Refuses an unchanged title (`no-op`). */
export function renameNode(
  model: BinderModel,
  ref: BinderRef,
  title: string,
): DraftResult<BinderDraftOf<'DocumentRenamed'> | BinderDraftOf<'FolderRenamed'>> {
  const node = getNode(model, ref);
  if (!node) return notFound(ref);
  const next = normalizeTitle(title);
  const err = checkTitle(next);
  if (err) return { ok: false, error: err };
  if (next === node.title) return fail('no-op', 'The title is unchanged.');
  return ref.kind === 'folder'
    ? ok({ type: 'FolderRenamed', payload: { folderId: ref.id, title: next } })
    : ok({ type: 'DocumentRenamed', payload: { documentId: ref.id, title: next } });
}

/**
 * Moves or reorders a node within its area. `placement.index` is counted after the
 * node is removed from its current parent, and is clamped. Refuses moves into a
 * document, another area, a missing or archived folder, the folder itself or one of
 * its descendants, and moves that change nothing (`no-op`).
 */
export function moveNode(
  model: BinderModel,
  ref: BinderRef,
  placement: Placement,
): DraftResult<BinderDraftOf<'DocumentMoved'> | BinderDraftOf<'FolderMoved'>> {
  const node = getNode(model, ref);
  if (!node) return notFound(ref);
  const here = locate(model, ref);
  if (!here) return notFound(ref);
  const err =
    checkPlacement(model, node.area, placement, ref) ?? checkParentOpen(model, placement.parentId);
  if (err) return { ok: false, error: err };
  const target = clampPlacement(model, node.area, placement, ref);
  if (target.parentId === here.parentId && target.index === here.index) {
    return fail('no-op', 'The item is already there.');
  }
  return ref.kind === 'folder'
    ? ok({ type: 'FolderMoved', payload: { folderId: ref.id, ...target } })
    : ok({ type: 'DocumentMoved', payload: { documentId: ref.id, ...target } });
}

/** Archives (`archived: true`) or restores (`false`) a node. Refuses a no-op. */
export function setArchived(
  model: BinderModel,
  ref: BinderRef,
  archived: boolean,
): DraftResult<BinderDraftOf<'DocumentArchived'> | BinderDraftOf<'FolderArchived'>> {
  const node = getNode(model, ref);
  if (!node) return notFound(ref);
  if (node.archived === archived) {
    return fail('no-op', archived ? 'It is already archived.' : 'It is not archived.');
  }
  return ref.kind === 'folder'
    ? ok({ type: 'FolderArchived', payload: { folderId: ref.id, archived } })
    : ok({ type: 'DocumentArchived', payload: { documentId: ref.id, archived } });
}

/** Archives a node. */
export const archiveNode = (model: BinderModel, ref: BinderRef) => setArchived(model, ref, true);

/** Restores an archived node. */
export const restoreNode = (model: BinderModel, ref: BinderRef) => setArchived(model, ref, false);

/** Replaces the corkboard synopsis of a document or a folder. Refuses an unchanged synopsis. */
export function editSynopsis(
  model: BinderModel,
  ref: BinderRef,
  synopsis: string,
): DraftResult<BinderDraftOf<'SynopsisEdited'>> {
  const node = getNode(model, ref);
  if (!node) return notFound(ref);
  if (synopsis.length > TEXT_LIMITS.synopsisMaxChars) {
    return fail(
      'invalid-synopsis',
      `A synopsis can be at most ${TEXT_LIMITS.synopsisMaxChars} characters.`,
    );
  }
  if (synopsis === node.synopsis) return fail('no-op', 'The synopsis is unchanged.');
  return ok({
    type: 'SynopsisEdited',
    payload:
      ref.kind === 'folder' ? { folderId: ref.id, synopsis } : { documentId: ref.id, synopsis },
  });
}

/**
 * Changes project settings. Only the fields that differ from the current settings
 * go into the patch; refuses a patch that changes nothing. Titles are trimmed.
 */
export function changeProjectSettings(
  model: Pick<BinderModel, 'settings'>,
  patch: Partial<ProjectSettings>,
): DraftResult<BinderDraftOf<'ProjectSettingsChanged'>> {
  const diff: Partial<ProjectSettings> = {};
  const record = diff as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch) as Array<[keyof ProjectSettings, unknown]>) {
    if (value === undefined) continue;
    const next = key === 'title' && typeof value === 'string' ? normalizeTitle(value) : value;
    if (next !== model.settings[key]) record[key] = next;
  }
  if (Object.keys(diff).length === 0) return fail('no-op', 'Nothing changed.');
  if (diff.title !== undefined) {
    const err = checkTitle(diff.title);
    if (err) return { ok: false, error: err };
  }
  const parsed = ProjectSettingsSchema.partial().safeParse(diff);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path[0];
    return fail(
      'invalid-settings',
      field ? `${String(field)}: ${issue?.message ?? 'invalid'}` : 'Those settings are not valid.',
    );
  }
  return ok({ type: 'ProjectSettingsChanged', payload: { patch: diff } });
}

/** Envelope fields a client supplies for a human commit. */
export interface CommitEnvelopeInput {
  /** Idempotency key (UUID). */
  commitId: string;
  projectId: string;
  /** `Date#toISOString()` of when the action happened. */
  clientTime: string;
  /** The human actor's id (account user id). */
  actorId: string;
  deviceId: string;
  sessionId: string;
}

/** Wraps a binder draft in a human commit envelope, ready for the ledger service. */
export function toCommitDraft(draft: BinderDraft, envelope: CommitEnvelopeInput): CommitDraft {
  return {
    commitId: envelope.commitId,
    projectId: envelope.projectId,
    clientTime: envelope.clientTime,
    actor: { kind: 'human', id: envelope.actorId },
    deviceId: envelope.deviceId,
    sessionId: envelope.sessionId,
    schemaVersion: SCHEMA_VERSION,
    type: draft.type,
    payload: draft.payload,
  } as CommitDraft;
}

/** Session context for {@link createCommitDrafter}. */
export interface DrafterContext {
  projectId: string;
  actorId: string;
  deviceId: string;
  sessionId: string;
  /** Clock; defaults to `new Date()`. */
  now?: () => Date;
  /** Commit id generator; defaults to `crypto.randomUUID()`. */
  newId?: () => string;
}

/** Returns a function that wraps binder drafts in envelopes for one editor session. */
export function createCommitDrafter(ctx: DrafterContext): (draft: BinderDraft) => CommitDraft {
  const now = ctx.now ?? (() => new Date());
  const newId = ctx.newId ?? newUuid;
  return (draft) =>
    toCommitDraft(draft, {
      commitId: newId(),
      projectId: ctx.projectId,
      clientTime: now().toISOString(),
      actorId: ctx.actorId,
      deviceId: ctx.deviceId,
      sessionId: ctx.sessionId,
    });
}
