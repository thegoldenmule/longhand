/**
 * The binder model and read-only queries over it.
 *
 * `BinderModel` is the slice of `ProjectState` the binder reads and the optimistic
 * reducer writes. `ProjectState` satisfies it structurally, so callers can pass the
 * folded project state straight in.
 */
import type {
  BinderArea,
  BinderRef,
  BinderState,
  DocumentKind,
  DocumentState,
  FolderState,
  ProjectSettings,
} from '@longhand/schema';

/** The part of `ProjectState` the binder reads and writes. */
export interface BinderModel {
  binder: BinderState;
  folders: Record<string, FolderState>;
  documents: Record<string, DocumentState>;
  settings: ProjectSettings;
}

/** Where a node sits, or where it should go: `index` is among the parent's children. */
export interface Placement {
  /** Parent folder id, or null for the root of the area. */
  parentId: string | null;
  /** 0-based index among the parent's children, counted after the moved node is removed. */
  index: number;
}

/** A node's current location in the binder. */
export interface Location extends Placement {
  area: BinderArea;
}

/** Where a drop lands relative to a target node. */
export type DropPosition = 'before' | 'after' | 'inside';

/** Binder areas in display order. */
export const BINDER_AREAS: readonly BinderArea[] = ['manuscript', 'notes'];

/** The area a document of `kind` lives in. */
export function areaForKind(kind: DocumentKind): BinderArea {
  return kind === 'note' ? 'notes' : 'manuscript';
}

/** The document kind created in `area`. */
export function kindForArea(area: BinderArea): DocumentKind {
  return area === 'notes' ? 'note' : 'manuscript';
}

/** True if two refs name the same node. */
export function sameRef(a: BinderRef | null | undefined, b: BinderRef | null | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

/** A stable string key for a ref (`folder:id` / `document:id`). */
export function refKey(ref: BinderRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** The folder or document a ref names, or undefined. */
export function getNode(
  model: Pick<BinderModel, 'folders' | 'documents'>,
  ref: BinderRef,
): FolderState | DocumentState | undefined {
  return ref.kind === 'folder' ? model.folders[ref.id] : model.documents[ref.id];
}

/** The area a node lives in, or undefined if it does not exist. */
export function areaOf(model: Pick<BinderModel, 'folders' | 'documents'>, ref: BinderRef) {
  return getNode(model, ref)?.area;
}

/**
 * The ordered children of a parent: a folder's `children`, or an area's root list
 * when `parentId` is null. Undefined if the folder does not exist.
 */
export function childrenOf(
  model: Pick<BinderModel, 'binder' | 'folders'>,
  area: BinderArea,
  parentId: string | null,
): readonly BinderRef[] | undefined {
  if (parentId === null) return model.binder[area];
  return model.folders[parentId]?.children;
}

/** Where a node is now, or undefined if it does not exist or is not in its parent's list. */
export function locate(
  model: Pick<BinderModel, 'binder' | 'folders' | 'documents'>,
  ref: BinderRef,
): Location | undefined {
  const node = getNode(model, ref);
  if (!node) return undefined;
  const siblings = childrenOf(model, node.area, node.parentId);
  if (!siblings) return undefined;
  const index = siblings.findIndex((r) => sameRef(r, ref));
  if (index < 0) return undefined;
  return { area: node.area, parentId: node.parentId, index };
}

/** Folder ids from the node's parent up to the area root (nearest first). */
export function ancestorIds(
  model: Pick<BinderModel, 'folders' | 'documents'>,
  ref: BinderRef,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let parentId = getNode(model, ref)?.parentId ?? null;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    out.push(parentId);
    parentId = model.folders[parentId]?.parentId ?? null;
  }
  return out;
}

/** True if `folderId` is `ancestorId` or lies inside it. */
export function isSelfOrDescendant(
  model: Pick<BinderModel, 'folders'>,
  folderId: string,
  ancestorId: string,
): boolean {
  const seen = new Set<string>();
  let cur: string | null = folderId;
  while (cur !== null && !seen.has(cur)) {
    if (cur === ancestorId) return true;
    seen.add(cur);
    cur = model.folders[cur]?.parentId ?? null;
  }
  return false;
}

/** True if the node or any folder above it is archived. */
export function isEffectivelyArchived(
  model: Pick<BinderModel, 'folders' | 'documents'>,
  ref: BinderRef,
): boolean {
  const node = getNode(model, ref);
  if (!node) return false;
  if (node.archived) return true;
  return ancestorIds(model, ref).some((id) => model.folders[id]?.archived);
}

/** Every ref in a folder's subtree (depth first, the folder excluded). */
export function descendants(model: Pick<BinderModel, 'folders'>, folderId: string): BinderRef[] {
  const out: BinderRef[] = [];
  const seen = new Set<string>([folderId]);
  const walk = (id: string) => {
    for (const child of model.folders[id]?.children ?? []) {
      out.push(child);
      if (child.kind === 'folder' && !seen.has(child.id)) {
        seen.add(child.id);
        walk(child.id);
      }
    }
  };
  walk(folderId);
  return out;
}

/** Children of a parent that are not archived, in order. */
export function visibleChildren(
  model: Pick<BinderModel, 'binder' | 'folders' | 'documents'>,
  area: BinderArea,
  parentId: string | null,
): BinderRef[] {
  return (childrenOf(model, area, parentId) ?? []).filter((r) => {
    const node = getNode(model, r);
    return node !== undefined && !node.archived;
  });
}

/**
 * The id of the manuscript's only document, if the manuscript is exactly one
 * document: one live node at the root of the Manuscript area, and it is a document.
 * Notes don't count, archived nodes don't count, and a live folder means null.
 */
export function soleManuscriptDocument(
  model: Pick<BinderModel, 'binder' | 'folders' | 'documents'>,
): string | null {
  const kids = visibleChildren(model, 'manuscript', null);
  const only = kids.length === 1 ? kids[0] : undefined;
  return only?.kind === 'document' ? only.id : null;
}

/** Title of a node ('' if missing). */
export function titleOf(model: Pick<BinderModel, 'folders' | 'documents'>, ref: BinderRef): string {
  return getNode(model, ref)?.title ?? '';
}

/**
 * The placement that puts `moving` before, after or inside `target`, with `index`
 * counted after `moving` is removed from its current parent (the event semantics).
 * Undefined if `target` does not exist, or if `inside` is asked of a document.
 *
 * It does not check validity (area, cycles); the move builder does.
 */
export function placementForDrop(
  model: BinderModel,
  moving: BinderRef,
  target: BinderRef,
  position: DropPosition,
): Placement | undefined {
  if (position === 'inside') {
    if (target.kind !== 'folder') return undefined;
    const folder = model.folders[target.id];
    if (!folder) return undefined;
    const rest = folder.children.filter((r) => !sameRef(r, moving));
    return { parentId: target.id, index: rest.length };
  }
  const targetNode = getNode(model, target);
  if (!targetNode) return undefined;
  const siblings = childrenOf(model, targetNode.area, targetNode.parentId);
  if (!siblings) return undefined;
  const rest = siblings.filter((r) => !sameRef(r, moving));
  const at = rest.findIndex((r) => sameRef(r, target));
  if (at < 0) return undefined;
  return { parentId: targetNode.parentId, index: position === 'before' ? at : at + 1 };
}

/** The placement at the end of a parent's children (after removing `moving`, if given). */
export function placementAtEnd(
  model: BinderModel,
  area: BinderArea,
  parentId: string | null,
  moving?: BinderRef,
): Placement {
  const siblings = childrenOf(model, area, parentId) ?? [];
  const count = moving ? siblings.filter((r) => !sameRef(r, moving)).length : siblings.length;
  return { parentId, index: count };
}

/** A keyboard move step: swap up or down among visible siblings, nest into the folder above, or move out of the parent. */
export type MoveStep = 'up' | 'down' | 'in' | 'out';

/**
 * The placement one keyboard step away from where `ref` is now, or undefined if the
 * step goes nowhere (top of the area, no folder above, already at the root).
 *
 * - `up` / `down`: swap with the previous / next visible sibling; past the first or
 *   last sibling, leave the parent folder and land just before / after it.
 * - `in`: move to the end of the visible folder just above.
 * - `out`: leave the parent folder and land just after it.
 *
 * Archived siblings are skipped but keep their places in the children lists.
 */
export function stepPlacement(
  model: BinderModel,
  ref: BinderRef,
  step: MoveStep,
): Placement | undefined {
  const node = getNode(model, ref);
  if (!node) return undefined;
  const visible = visibleChildren(model, node.area, node.parentId);
  const at = visible.findIndex((r) => sameRef(r, ref));
  if (at < 0) return undefined;
  const parent: BinderRef | null =
    node.parentId === null ? null : { kind: 'folder', id: node.parentId };
  switch (step) {
    case 'up': {
      const prev = visible[at - 1];
      if (prev) return placementForDrop(model, ref, prev, 'before');
      return parent ? placementForDrop(model, ref, parent, 'before') : undefined;
    }
    case 'down': {
      const next = visible[at + 1];
      if (next) return placementForDrop(model, ref, next, 'after');
      return parent ? placementForDrop(model, ref, parent, 'after') : undefined;
    }
    case 'in': {
      const prev = visible[at - 1];
      if (prev?.kind !== 'folder') return undefined;
      return placementForDrop(model, ref, prev, 'inside');
    }
    case 'out':
      return parent ? placementForDrop(model, ref, parent, 'after') : undefined;
  }
}

/**
 * Describes where a node sits for a screen reader, e.g.
 * `position 2 of 3 in ‘Part One’` or `position 1 of 4 at the top of Manuscript`.
 */
export function describeLocation(model: BinderModel, ref: BinderRef): string {
  const node = getNode(model, ref);
  if (!node) return '';
  const visible = visibleChildren(model, node.area, node.parentId);
  const at = visible.findIndex((r) => sameRef(r, ref)) + 1;
  const where =
    node.parentId === null
      ? `at the top of ${node.area === 'notes' ? 'Notes' : 'Manuscript'}`
      : `in ‘${model.folders[node.parentId]?.title ?? ''}’`;
  return `position ${at} of ${visible.length} ${where}`;
}

/** A row of the flattened tree: what a tree view renders. */
export interface FlatNode {
  ref: BinderRef;
  /** 1-based nesting level (area root children are level 1). */
  level: number;
  parentId: string | null;
  /** 1-based position among visible siblings. */
  posInSet: number;
  setSize: number;
  /** For folders: number of visible children. */
  childCount: number;
}

/**
 * Flattens an area's visible (non-archived) nodes in display order. Folders not in
 * `expanded` contribute only themselves.
 */
export function flattenVisible(
  model: BinderModel,
  area: BinderArea,
  expanded: ReadonlySet<string>,
): FlatNode[] {
  const out: FlatNode[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, level: number) => {
    const kids = visibleChildren(model, area, parentId);
    kids.forEach((ref, i) => {
      const childCount = ref.kind === 'folder' ? visibleChildren(model, area, ref.id).length : 0;
      out.push({ ref, level, parentId, posInSet: i + 1, setSize: kids.length, childCount });
      if (ref.kind === 'folder' && expanded.has(ref.id) && !seen.has(ref.id)) {
        seen.add(ref.id);
        walk(ref.id, level + 1);
      }
    });
  };
  walk(null, 1);
  return out;
}

/** Every archived node (including those inside archived folders), in area then tree order. */
export function archivedNodes(model: BinderModel): Array<{ ref: BinderRef; area: BinderArea }> {
  const out: Array<{ ref: BinderRef; area: BinderArea }> = [];
  for (const area of BINDER_AREAS) {
    const seen = new Set<string>();
    const walk = (refs: readonly BinderRef[]) => {
      for (const ref of refs) {
        const node = getNode(model, ref);
        if (!node) continue;
        if (node.archived) out.push({ ref, area });
        if (ref.kind === 'folder' && !seen.has(ref.id)) {
          seen.add(ref.id);
          walk(model.folders[ref.id]?.children ?? []);
        }
      }
    };
    walk(model.binder[area]);
  }
  return out;
}
