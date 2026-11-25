/**
 * Folding the binder (documents, notes, folders) and the research library
 * (sources, clippings). None of these change manuscript text except
 * `DocumentImported`, whose whole content is provenance class `imported`.
 *
 * Placement is `{parentId, index}`: `index` counts children after the node is
 * removed from its old place, and is clamped to the child count. Nodes never move
 * between areas, and a folder never moves into itself or a descendant.
 */
import {
  docFromJSON,
  emptyDoc,
  type BinderArea,
  type BinderRef,
  type CommitOf,
  type FolderState,
  type PMNode,
} from '@longhand/schema';
import { FoldError } from './issues';
import { prov, runsFromUnits } from './prov';
import { unitsBetween } from './units';
import type { DocInternal, Tx } from './state';

function siblings(tx: Tx, area: BinderArea, parentId: string | null): BinderRef[] {
  if (parentId === null) return tx.s.binder[area];
  return (tx.s.folders[parentId] as FolderState).children;
}

function setSiblings(tx: Tx, area: BinderArea, parentId: string | null, list: BinderRef[]): void {
  if (parentId === null) {
    tx.binder()[area] = list;
    return;
  }
  const f = tx.s.folders[parentId] as FolderState;
  tx.rec('folders')[parentId] = { ...f, children: list, updatedSeq: tx.seq };
}

function insertRef(tx: Tx, area: BinderArea, parentId: string | null, index: number, ref: BinderRef): void {
  const list = [...siblings(tx, area, parentId)];
  list.splice(Math.min(index, list.length), 0, ref);
  setSiblings(tx, area, parentId, list);
}

function removeRef(tx: Tx, area: BinderArea, parentId: string | null, ref: BinderRef): void {
  const list = siblings(tx, area, parentId).filter((r) => !(r.kind === ref.kind && r.id === ref.id));
  setSiblings(tx, area, parentId, list);
}

/** Checks a parent folder for a node of `area`. Records an issue and returns false if invalid. */
function checkParent(tx: Tx, area: BinderArea, parentId: string | null): boolean {
  if (parentId === null) return true;
  const f = tx.s.folders[parentId];
  if (!f) {
    tx.issue('unknown-parent', `no folder ${parentId}`);
    return false;
  }
  if (f.area !== area) {
    tx.issue('area-mismatch', `folder ${parentId} is in ${f.area}, not ${area}`);
    return false;
  }
  return true;
}

function newDoc(
  tx: Tx,
  p: { documentId: string; kind: DocInternal['kind']; title: string; parentId: string | null; index: number },
  node: PMNode,
  imported: DocInternal['imported'],
): void {
  const area: BinderArea = p.kind === 'note' ? 'notes' : 'manuscript';
  if (tx.s.docs[p.documentId]) {
    tx.issue('duplicate-id', `document ${p.documentId} already exists`);
    return;
  }
  if (!checkParent(tx, area, p.parentId)) return;
  insertRef(tx, area, p.parentId, p.index, { kind: 'document', id: p.documentId });
  const ip = prov('imported', tx.seq);
  const runs = imported ? runsFromUnits(unitsBetween(node, 0, node.content.size).map((u) => ({ pos: u.pos, p: ip }))) : [];
  tx.setDoc({
    id: p.documentId,
    kind: p.kind,
    area,
    title: p.title,
    parentId: p.parentId,
    synopsis: '',
    archived: false,
    imported,
    createdSeq: tx.seq,
    contentSeq: tx.seq,
    updatedSeq: tx.seq,
    node,
    version: 0,
    runs,
    tombs: [],
    maps: null,
  });
}

/** Folds `DocumentCreated`. */
export function foldDocumentCreated(tx: Tx, c: CommitOf<'DocumentCreated'>): void {
  newDoc(tx, c.payload, emptyDoc(), null);
}

/** Folds `DocumentImported`. */
export function foldDocumentImported(tx: Tx, c: CommitOf<'DocumentImported'>): void {
  const p = c.payload;
  let node: PMNode;
  try {
    node = docFromJSON(p.content);
  } catch (e) {
    throw new FoldError(c.seq, 'invalid-content', `imported content is not a valid document: ${(e as Error).message}`);
  }
  newDoc(tx, p, node, { seq: c.seq, sourceFormat: p.sourceFormat, sourceName: p.sourceName, sourceHash: p.sourceHash });
}

function docOrIssue(tx: Tx, id: string): DocInternal | null {
  const d = tx.s.docs[id];
  if (!d) tx.issue('unknown-document', `no document ${id}`);
  return d ?? null;
}

/** Folds `DocumentRenamed`. */
export function foldDocumentRenamed(tx: Tx, c: CommitOf<'DocumentRenamed'>): void {
  const d = docOrIssue(tx, c.payload.documentId);
  if (d) tx.setDoc({ ...d, title: c.payload.title, updatedSeq: c.seq });
}

/** Folds `DocumentArchived`. */
export function foldDocumentArchived(tx: Tx, c: CommitOf<'DocumentArchived'>): void {
  const d = docOrIssue(tx, c.payload.documentId);
  if (d) tx.setDoc({ ...d, archived: c.payload.archived, updatedSeq: c.seq });
}

/** Folds `SynopsisEdited`. */
export function foldSynopsisEdited(tx: Tx, c: CommitOf<'SynopsisEdited'>): void {
  const d = docOrIssue(tx, c.payload.documentId);
  if (d) tx.setDoc({ ...d, synopsis: c.payload.synopsis, updatedSeq: c.seq });
}

/** Folds `DocumentMoved`. */
export function foldDocumentMoved(tx: Tx, c: CommitOf<'DocumentMoved'>): void {
  const p = c.payload;
  const d = docOrIssue(tx, p.documentId);
  if (!d || !checkParent(tx, d.area, p.parentId)) return;
  const ref: BinderRef = { kind: 'document', id: d.id };
  removeRef(tx, d.area, d.parentId, ref);
  insertRef(tx, d.area, p.parentId, p.index, ref);
  tx.setDoc({ ...d, parentId: p.parentId, updatedSeq: c.seq });
}

/** Folds `FolderCreated`. */
export function foldFolderCreated(tx: Tx, c: CommitOf<'FolderCreated'>): void {
  const p = c.payload;
  if (tx.s.folders[p.folderId]) {
    tx.issue('duplicate-id', `folder ${p.folderId} already exists`);
    return;
  }
  if (!checkParent(tx, p.area, p.parentId)) return;
  tx.rec('folders')[p.folderId] = {
    id: p.folderId,
    area: p.area,
    title: p.title,
    parentId: p.parentId,
    children: [],
    archived: false,
    createdSeq: c.seq,
    updatedSeq: c.seq,
  };
  insertRef(tx, p.area, p.parentId, p.index, { kind: 'folder', id: p.folderId });
}

function folderOrIssue(tx: Tx, id: string): FolderState | null {
  const f = tx.s.folders[id];
  if (!f) tx.issue('unknown-parent', `no folder ${id}`);
  return f ?? null;
}

/** Folds `FolderRenamed`. */
export function foldFolderRenamed(tx: Tx, c: CommitOf<'FolderRenamed'>): void {
  const f = folderOrIssue(tx, c.payload.folderId);
  if (f) tx.rec('folders')[f.id] = { ...f, title: c.payload.title, updatedSeq: c.seq };
}

/** Folds `FolderArchived`. */
export function foldFolderArchived(tx: Tx, c: CommitOf<'FolderArchived'>): void {
  const f = folderOrIssue(tx, c.payload.folderId);
  if (f) tx.rec('folders')[f.id] = { ...f, archived: c.payload.archived, updatedSeq: c.seq };
}

/** Folds `FolderMoved`. */
export function foldFolderMoved(tx: Tx, c: CommitOf<'FolderMoved'>): void {
  const p = c.payload;
  const f = folderOrIssue(tx, p.folderId);
  if (!f || !checkParent(tx, f.area, p.parentId)) return;
  for (let cur = p.parentId; cur !== null; cur = (tx.s.folders[cur] as FolderState).parentId) {
    if (cur === f.id) {
      tx.issue('cycle', `folder ${f.id} cannot move into itself or a descendant`);
      return;
    }
  }
  const ref: BinderRef = { kind: 'folder', id: f.id };
  removeRef(tx, f.area, f.parentId, ref);
  insertRef(tx, f.area, p.parentId, p.index, ref);
  const latest = tx.s.folders[f.id] as FolderState;
  tx.rec('folders')[f.id] = { ...latest, parentId: p.parentId, updatedSeq: c.seq };
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/** Folds `SourceAdded`. */
export function foldSourceAdded(tx: Tx, c: CommitOf<'SourceAdded'>): void {
  const p = c.payload;
  if (tx.s.sources[p.sourceId]) {
    tx.issue('duplicate-id', `source ${p.sourceId} already exists`);
    return;
  }
  if (p.fromSurfacedId !== null) {
    const surf = tx.s.ann.surfacedSources[p.fromSurfacedId];
    const idx = p.candidateIndex as number;
    if (!surf) {
      tx.issue('unknown-target', `no surfaced source ${p.fromSurfacedId}`);
      return;
    }
    if (idx >= surf.candidates.length) {
      tx.issue('unknown-target', `surfaced source ${surf.id} has no candidate ${idx}`);
      return;
    }
    tx.ann('surfacedSources')[surf.id] = {
      ...surf,
      accepted: [...surf.accepted, { candidateIndex: idx, sourceId: p.sourceId }],
    };
  }
  tx.rec('sources')[p.sourceId] = {
    id: p.sourceId,
    csl: p.csl,
    origin: p.origin,
    fromSurfacedId: p.fromSurfacedId,
    candidateIndex: p.candidateIndex,
    note: '',
    archived: false,
    addedSeq: c.seq,
    updatedSeq: c.seq,
  };
}

/** Folds `SourceUpdated`. */
export function foldSourceUpdated(tx: Tx, c: CommitOf<'SourceUpdated'>): void {
  const p = c.payload;
  const s = tx.s.sources[p.sourceId];
  if (!s) {
    tx.issue('unknown-source', `no source ${p.sourceId}`);
    return;
  }
  tx.rec('sources')[s.id] = {
    ...s,
    csl: p.csl ?? s.csl,
    note: p.note ?? s.note,
    archived: p.archived ?? s.archived,
    updatedSeq: c.seq,
  };
}

/** Folds `ClippingSaved`. */
export function foldClippingSaved(tx: Tx, c: CommitOf<'ClippingSaved'>): void {
  const p = c.payload;
  if (tx.s.clippings[p.clippingId]) {
    tx.issue('duplicate-id', `clipping ${p.clippingId} already exists`);
    return;
  }
  if (!tx.s.sources[p.sourceId]) {
    tx.issue('unknown-source', `no source ${p.sourceId}`);
    return;
  }
  tx.rec('clippings')[p.clippingId] = {
    id: p.clippingId,
    sourceId: p.sourceId,
    text: p.text,
    locator: p.locator,
    note: p.note,
    savedSeq: c.seq,
    removed: false,
  };
}

/** Folds `ClippingRemoved`. */
export function foldClippingRemoved(tx: Tx, c: CommitOf<'ClippingRemoved'>): void {
  const k = tx.s.clippings[c.payload.clippingId];
  if (!k) {
    tx.issue('unknown-target', `no clipping ${c.payload.clippingId}`);
    return;
  }
  if (k.removed) {
    tx.issue('not-open', `clipping ${k.id} was already removed`);
    return;
  }
  tx.rec('clippings')[k.id] = { ...k, removed: true };
}
