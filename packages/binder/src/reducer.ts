/**
 * The optimistic binder reducer: applies binder drafts to a `BinderModel` so the UI
 * updates before the ledger confirms. It follows the schema's binder semantics, which
 * the ledger fold implements:
 *
 * - A document's area follows its kind (`note` → `notes`, otherwise `manuscript`);
 *   a folder's area is fixed at creation. Nothing moves between areas.
 * - Placement is `{parentId, index}`: `parentId` null is the area root; otherwise it
 *   must be a folder in the same area. `index` is counted after the node is removed
 *   from its old parent, and is clamped to the child count.
 * - A folder never moves into itself or one of its descendants.
 * - Archiving sets a flag and keeps the node in place, so restoring puts it back
 *   where it was. A folder's subtree is hidden while it is archived, but the
 *   children's own flags do not change.
 *
 * The reducer refuses only what the ledger would reject (unknown nodes, bad parents,
 * cycles, duplicate ids). The builders refuse more (no-ops, archived targets).
 * Results are new objects with structural sharing; the input is never mutated.
 */
import {
  EMPTY_DOC_JSON,
  type BinderArea,
  type BinderRef,
  type DocumentState,
  type FolderState,
  type PMNodeJSON,
} from '@longhand/schema';
import { checkPlacement, type BinderDraft, type BinderError } from './drafts';
import { areaForKind, getNode, sameRef, type BinderModel, type Placement } from './model';

/** Options for applying a draft. */
export interface ApplyOptions {
  /**
   * Seq stamped into `createdSeq` / `updatedSeq` / `contentSeq`. Defaults to 0,
   * meaning "pending": the ledger has not assigned one yet.
   */
  seq?: number;
}

/** The reducer's result. */
export type ApplyResult<M extends BinderModel> =
  { ok: true; model: M } | { ok: false; error: BinderError };

const refuse = (code: BinderError['code'], message: string) =>
  ({ ok: false, error: { code, message } }) as const;

function cloneJSON(node: Readonly<PMNodeJSON>): PMNodeJSON {
  return JSON.parse(JSON.stringify(node)) as PMNodeJSON;
}

type Mutable = {
  binder: BinderModel['binder'];
  folders: BinderModel['folders'];
  documents: BinderModel['documents'];
};

/** Replaces a parent's children list, bumping a parent folder's `updatedSeq`. */
function setChildren(
  draft: Mutable,
  area: BinderArea,
  parentId: string | null,
  children: BinderRef[],
  seq: number,
) {
  if (parentId === null) {
    draft.binder = { ...draft.binder, [area]: children };
    return;
  }
  const folder = draft.folders[parentId];
  if (!folder) return;
  draft.folders = { ...draft.folders, [parentId]: { ...folder, children, updatedSeq: seq } };
}

function childList(draft: Mutable, area: BinderArea, parentId: string | null): BinderRef[] {
  if (parentId === null) return draft.binder[area];
  return draft.folders[parentId]?.children ?? [];
}

function insertAt(list: readonly BinderRef[], ref: BinderRef, index: number): BinderRef[] {
  const at = Math.min(Math.max(index, 0), list.length);
  return [...list.slice(0, at), ref, ...list.slice(at)];
}

/** Moves `ref` (already known to exist) to `placement`, updating both parents and the node. */
function relocate(
  model: Mutable,
  ref: BinderRef,
  area: BinderArea,
  from: string | null,
  to: Placement,
  seq: number,
) {
  const without = childList(model, area, from).filter((r) => !sameRef(r, ref));
  setChildren(model, area, from, without, seq);
  const target = childList(model, area, to.parentId);
  setChildren(model, area, to.parentId, insertAt(target, ref, to.index), seq);
}

/**
 * Applies one binder draft. Returns the new model, or the reason the ledger would
 * reject the event. Other fields of `model` (e.g. the rest of `ProjectState`) are
 * carried over unchanged.
 */
export function applyBinderDraft<M extends BinderModel>(
  model: M,
  draft: BinderDraft,
  options: ApplyOptions = {},
): ApplyResult<M> {
  const seq = options.seq ?? 0;
  const m: Mutable = { binder: model.binder, folders: model.folders, documents: model.documents };
  const done = (): ApplyResult<M> => ({ ok: true, model: { ...model, ...m } });

  switch (draft.type) {
    case 'ProjectSettingsChanged':
      return {
        ok: true,
        model: { ...model, settings: { ...model.settings, ...draft.payload.patch } },
      };

    case 'DocumentCreated': {
      const p = draft.payload;
      if (model.documents[p.documentId])
        return refuse('duplicate-id', 'That document already exists.');
      const area = areaForKind(p.kind);
      const err = checkPlacement(model, area, p, null);
      if (err) return { ok: false, error: err };
      const doc: DocumentState = {
        id: p.documentId,
        kind: p.kind,
        area,
        title: p.title,
        parentId: p.parentId,
        synopsis: '',
        content: cloneJSON(EMPTY_DOC_JSON),
        version: 0,
        provenance: [],
        archived: false,
        imported: null,
        createdSeq: seq,
        contentSeq: seq,
        updatedSeq: seq,
      };
      m.documents = { ...m.documents, [doc.id]: doc };
      const ref: BinderRef = { kind: 'document', id: doc.id };
      setChildren(m, area, p.parentId, insertAt(childList(m, area, p.parentId), ref, p.index), seq);
      return done();
    }

    case 'FolderCreated': {
      const p = draft.payload;
      if (model.folders[p.folderId]) return refuse('duplicate-id', 'That folder already exists.');
      const err = checkPlacement(model, p.area, p, null);
      if (err) return { ok: false, error: err };
      const folder: FolderState = {
        id: p.folderId,
        area: p.area,
        title: p.title,
        parentId: p.parentId,
        children: [],
        synopsis: '',
        archived: false,
        createdSeq: seq,
        updatedSeq: seq,
      };
      m.folders = { ...m.folders, [folder.id]: folder };
      const ref: BinderRef = { kind: 'folder', id: folder.id };
      setChildren(
        m,
        p.area,
        p.parentId,
        insertAt(childList(m, p.area, p.parentId), ref, p.index),
        seq,
      );
      return done();
    }

    case 'DocumentMoved':
    case 'FolderMoved': {
      const ref: BinderRef =
        draft.type === 'FolderMoved'
          ? { kind: 'folder', id: draft.payload.folderId }
          : { kind: 'document', id: draft.payload.documentId };
      const node = getNode(model, ref);
      if (!node) return refuse('not-found', 'That item no longer exists.');
      const placement: Placement = { parentId: draft.payload.parentId, index: draft.payload.index };
      const err = checkPlacement(model, node.area, placement, ref);
      if (err) return { ok: false, error: err };
      relocate(m, ref, node.area, node.parentId, placement, seq);
      if (ref.kind === 'folder') {
        const f = m.folders[ref.id] as FolderState;
        m.folders = {
          ...m.folders,
          [ref.id]: { ...f, parentId: placement.parentId, updatedSeq: seq },
        };
      } else {
        const d = m.documents[ref.id] as DocumentState;
        m.documents = {
          ...m.documents,
          [ref.id]: { ...d, parentId: placement.parentId, updatedSeq: seq },
        };
      }
      return done();
    }

    case 'SynopsisEdited': {
      const p = draft.payload;
      if (p.folderId !== undefined) {
        const folder = model.folders[p.folderId];
        if (!folder) return refuse('not-found', 'That folder no longer exists.');
        m.folders = {
          ...m.folders,
          [folder.id]: { ...folder, synopsis: p.synopsis, updatedSeq: seq },
        };
      } else {
        const doc = model.documents[p.documentId];
        if (!doc) return refuse('not-found', 'That document no longer exists.');
        m.documents = {
          ...m.documents,
          [doc.id]: { ...doc, synopsis: p.synopsis, updatedSeq: seq },
        };
      }
      return done();
    }

    case 'DocumentRenamed':
    case 'DocumentArchived': {
      const id = draft.payload.documentId;
      const doc = model.documents[id];
      if (!doc) return refuse('not-found', 'That document no longer exists.');
      const patch: Partial<DocumentState> =
        draft.type === 'DocumentRenamed'
          ? { title: draft.payload.title }
          : { archived: draft.payload.archived };
      m.documents = { ...m.documents, [id]: { ...doc, ...patch, updatedSeq: seq } };
      return done();
    }

    case 'FolderRenamed':
    case 'FolderArchived': {
      const id = draft.payload.folderId;
      const folder = model.folders[id];
      if (!folder) return refuse('not-found', 'That folder no longer exists.');
      const patch: Partial<FolderState> =
        draft.type === 'FolderRenamed'
          ? { title: draft.payload.title }
          : { archived: draft.payload.archived };
      m.folders = { ...m.folders, [id]: { ...folder, ...patch, updatedSeq: seq } };
      return done();
    }
  }
}

/** A draft the reducer refused while applying a pending queue. */
export interface RejectedDraft {
  draft: BinderDraft;
  error: BinderError;
}

/**
 * Applies pending drafts in order over confirmed state: the optimistic view. Drafts
 * the reducer refuses are skipped and reported (the ledger would reject them too).
 */
export function applyBinderDrafts<M extends BinderModel>(
  model: M,
  drafts: readonly BinderDraft[],
  options: ApplyOptions = {},
): { model: M; rejected: RejectedDraft[] } {
  let cur = model;
  const rejected: RejectedDraft[] = [];
  for (const draft of drafts) {
    const res = applyBinderDraft(cur, draft, options);
    if (res.ok) cur = res.model;
    else rejected.push({ draft, error: res.error });
  }
  return { model: cur, rejected };
}

/**
 * A reducer for React's `useOptimistic` / `useReducer`: applies the draft, or keeps
 * the state unchanged if the reducer refuses it.
 */
export function binderReducer<M extends BinderModel>(model: M, draft: BinderDraft): M {
  const res = applyBinderDraft(model, draft);
  return res.ok ? res.model : model;
}
