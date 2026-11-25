import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { TEXT_LIMITS, type BinderArea, type BinderRef } from '@longhand/schema';
import {
  archiveNode,
  createDocument,
  createFolder,
  moveNode,
  renameNode,
  restoreNode,
  type BinderDraft,
  type BinderError,
  type DraftResult,
} from '../drafts';
import {
  BINDER_AREAS,
  archivedNodes,
  describeLocation,
  flattenVisible,
  getNode,
  isEffectivelyArchived,
  locate,
  placementAtEnd,
  placementForDrop,
  refKey,
  sameRef,
  stepPlacement,
  titleOf,
  visibleChildren,
  type BinderModel,
  type DropPosition,
  type FlatNode,
  type MoveStep,
  type Placement,
} from '../model';
import { applyBinderDraft } from '../reducer';
import { nodeWordCount } from '../wordCount';
import {
  AREA_LABELS,
  LiveRegion,
  allowDrop,
  cx,
  formatCount,
  pointerFraction,
  quoted,
  startDrag,
  useAnnouncer,
  useDeferredFocus,
} from './shared';

/** Props of {@link BinderTree}. */
export interface BinderTreeProps {
  /** Binder state: `ProjectState` or any `BinderModel` (apply pending drafts first for an optimistic view). */
  model: BinderModel;
  /** Called with every binder event the writer makes. The tree never talks to the network. */
  onDraft: (draft: BinderDraft) => void;
  /** The selected document or folder (e.g. the one open in the editor or corkboard). */
  selected?: BinderRef | null;
  /** Called when the writer picks a node (click, Enter or Space). */
  onSelect?: (ref: BinderRef) => void;
  /** Areas to show, in order. Defaults to Manuscript then Notes. */
  areas?: readonly BinderArea[];
  /** Show a word count on every row (folders sum their non-archived subtree). */
  showWordCounts?: boolean;
  /** Per-document word counts to show instead of counting `content` (e.g. live editor counts). */
  wordCounts?: Readonly<Record<string, number>>;
  /** Folders expanded at first render: `'all'` (default) or a list of folder ids. */
  defaultExpanded?: 'all' | readonly string[];
  /** Id generator for new documents and folders (defaults to `crypto.randomUUID()`). */
  newId?: () => string;
  /** Called when an action is refused (the message is also announced). */
  onError?: (error: BinderError) => void;
  /** Accessible label of the whole binder. */
  label?: string;
  className?: string;
}

interface MoveState {
  ref: BinderRef;
  area: BinderArea;
  placement: Placement;
}

interface DropState {
  /** Row key, or `end:<area>` for the area's trailing drop zone. */
  key: string;
  position: DropPosition;
  placement: Placement;
}

const STEP_KEYS: Readonly<Record<string, MoveStep>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowRight: 'in',
  ArrowLeft: 'out',
};

const STEP_STUCK: Readonly<Record<MoveStep, string>> = {
  up: 'Already at the top.',
  down: 'Already at the bottom.',
  in: 'There is no folder just above to move into.',
  out: 'Already at the top level.',
};

function parseKey(key: string): BinderRef {
  const at = key.indexOf(':');
  return { kind: key.slice(0, at) === 'folder' ? 'folder' : 'document', id: key.slice(at + 1) };
}

function moveDraftFor(ref: BinderRef, placement: Placement): BinderDraft {
  return ref.kind === 'folder'
    ? { type: 'FolderMoved', payload: { folderId: ref.id, ...placement } }
    : { type: 'DocumentMoved', payload: { documentId: ref.id, ...placement } };
}

/**
 * The project binder: Manuscript and Notes areas as ARIA trees of nested folders and
 * documents, with selection, inline rename, create, archive (and an archive view to
 * restore from), drag to reorder and nest, a keyboard move mode and optional word
 * counts.
 *
 * Keyboard (on a row): arrows navigate (Right/Left expand, collapse and step in and
 * out), Home/End jump, Enter or Space selects, F2 renames, Delete archives, and M
 * starts a move: arrows then move the item (Up/Down reorder and step out past the
 * ends, Right nests into the folder above, Left moves out), Enter drops, Escape
 * cancels.
 */
export function BinderTree(props: BinderTreeProps) {
  const {
    model,
    onDraft,
    selected = null,
    onSelect,
    areas = BINDER_AREAS,
    showWordCounts = false,
    wordCounts,
    defaultExpanded = 'all',
    newId,
    onError,
    label = 'Binder',
    className,
  } = props;

  const baseId = useId();
  const domId = (part: string) => `${baseId}-${part.replace(/[^A-Za-z0-9_-]/g, '_')}`;

  // Expansion: in 'all' mode the set holds collapsed folders, otherwise expanded ones,
  // so folders that arrive later follow the default.
  const allMode = defaultExpanded === 'all';
  const [toggled, setToggled] = useState<ReadonlySet<string>>(
    () => new Set(allMode ? [] : defaultExpanded),
  );
  const isExpanded = useCallback(
    (id: string) => (allMode ? !toggled.has(id) : toggled.has(id)),
    [allMode, toggled],
  );
  const setExpanded = useCallback(
    (id: string, open: boolean) => {
      setToggled((prev) => {
        if ((allMode ? !prev.has(id) : prev.has(id)) === open) return prev;
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [allMode],
  );

  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [renaming, setRenamingState] = useState<{ ref: BinderRef; value: string } | null>(null);
  const renamingRef = useRef(renaming);
  const setRenaming = (next: { ref: BinderRef; value: string } | null) => {
    renamingRef.current = next;
    setRenamingState(next);
  };
  const [pendingRename, setPendingRename] = useState<BinderRef | null>(null);
  const [moving, setMoving] = useState<MoveState | null>(null);
  const [drag, setDrag] = useState<{ ref: BinderRef; area: BinderArea } | null>(null);
  const [drop, setDrop] = useState<DropState | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [message, announce] = useAnnouncer();
  const { register, focusSoon } = useDeferredFocus();
  const renameInput = useRef<HTMLInputElement>(null);

  // While moving with the keyboard, render the tree as if the move had happened.
  const view = useMemo(() => {
    if (!moving) return model;
    const res = applyBinderDraft(model, moveDraftFor(moving.ref, moving.placement));
    return res.ok ? res.model : model;
  }, [model, moving]);

  const expandedSet = useMemo(
    () => new Set(Object.keys(view.folders).filter(isExpanded)),
    [view.folders, isExpanded],
  );
  const rowsByArea = useMemo(() => {
    const out = {} as Record<BinderArea, FlatNode[]>;
    for (const area of BINDER_AREAS) out[area] = flattenVisible(view, area, expandedSet);
    return out;
  }, [view, expandedSet]);

  // A node created here enters rename mode once it shows up in the model.
  useEffect(() => {
    if (pendingRename && getNode(model, pendingRename)) {
      setRenaming({ ref: pendingRename, value: titleOf(model, pendingRename) });
      setPendingRename(null);
    }
  }, [model, pendingRename]);

  const renamingKey = renaming ? refKey(renaming.ref) : null;
  useEffect(() => {
    if (renamingKey && renameInput.current) {
      renameInput.current.focus();
      renameInput.current.select();
    }
  }, [renamingKey]);

  const emit = (res: DraftResult<BinderDraft>, success?: string): boolean => {
    if (res.ok) {
      onDraft(res.draft);
      if (success) announce(success);
      return true;
    }
    if (res.error.code !== 'no-op') {
      onError?.(res.error);
      announce(res.error.message);
    }
    return false;
  };

  const focusRow = (key: string) => {
    setFocusKey(key);
    focusSoon(key);
  };

  /** The node actions apply to in an area: the focused row, else the selection. */
  const currentIn = (area: BinderArea): BinderRef | null => {
    for (const ref of [focusKey ? parseKey(focusKey) : null, selected]) {
      if (!ref) continue;
      const node = getNode(model, ref);
      if (node && node.area === area && !isEffectivelyArchived(model, ref)) return ref;
    }
    return null;
  };

  // ---- actions -------------------------------------------------------------

  const create = (area: BinderArea, kind: BinderRef['kind']) => {
    const cur = currentIn(area);
    let parentId: string | null = null;
    let index: number | undefined;
    if (cur?.kind === 'folder') {
      parentId = cur.id;
      setExpanded(cur.id, true);
    } else if (cur) {
      const loc = locate(model, cur);
      if (loc) {
        parentId = loc.parentId;
        index = loc.index + 1;
      }
    }
    const title =
      kind === 'folder' ? 'New folder' : area === 'notes' ? 'Untitled note' : 'Untitled';
    const opts = { area, title, parentId, index, id: newId?.() };
    const res = kind === 'folder' ? createFolder(model, opts) : createDocument(model, opts);
    if (!emit(res, `Created ${quoted(title)}. Type a name and press Enter.`) || !res.ok) return;
    const id =
      res.draft.type === 'FolderCreated'
        ? res.draft.payload.folderId
        : res.draft.payload.documentId;
    const ref: BinderRef = { kind, id };
    setFocusKey(refKey(ref));
    setPendingRename(ref);
  };

  const startRename = (ref: BinderRef) => {
    if (moving) return;
    setRenaming({ ref, value: titleOf(model, ref) });
  };

  const commitRename = () => {
    const r = renamingRef.current;
    if (!r) return;
    setRenaming(null);
    emit(renameNode(model, r.ref, r.value), `Renamed to ${quoted(r.value.trim())}.`);
    focusRow(refKey(r.ref));
  };

  const cancelRename = () => {
    const r = renamingRef.current;
    if (!r) return;
    setRenaming(null);
    focusRow(refKey(r.ref));
  };

  const archive = (ref: BinderRef) => {
    const area = getNode(model, ref)?.area;
    if (!area) return;
    const rows = rowsByArea[area];
    const at = rows.findIndex((r) => sameRef(r.ref, ref));
    const level = rows[at]?.level ?? 1;
    let next = rows.slice(at + 1).find((r) => r.level <= level) ?? rows[at - 1];
    if (next && sameRef(next.ref, ref)) next = undefined;
    const ok = emit(
      archiveNode(model, ref),
      `Archived ${quoted(titleOf(model, ref))}. You can restore it from the archive.`,
    );
    if (ok && next) focusRow(refKey(next.ref));
  };

  const restore = (ref: BinderRef) => {
    const hiddenBy = archivedAncestorTitle(model, ref);
    emit(
      restoreNode(model, ref),
      `Restored ${quoted(titleOf(model, ref))}.` +
        (hiddenBy ? ` It is inside ${quoted(hiddenBy)}, which is still archived.` : ''),
    );
  };

  // ---- keyboard move mode --------------------------------------------------

  const startMove = (ref: BinderRef, area: BinderArea) => {
    const loc = locate(model, ref);
    if (!loc) return;
    setMoving({ ref, area, placement: { parentId: loc.parentId, index: loc.index } });
    announce(
      `Moving ${quoted(titleOf(model, ref))}, ${describeLocation(model, ref)}. ` +
        'Arrow keys move it, Enter drops it, Escape cancels.',
    );
  };

  const handleMoveKey = (e: KeyboardEvent, m: MoveState) => {
    const key = refKey(m.ref);
    const step = STEP_KEYS[e.key];
    if (step) {
      e.preventDefault();
      const placement = stepPlacement(view, m.ref, step);
      if (!placement) {
        announce(STEP_STUCK[step]);
        return;
      }
      if (placement.parentId) setExpanded(placement.parentId, true);
      setMoving({ ...m, placement });
      focusSoon(key);
      const preview = applyBinderDraft(model, moveDraftFor(m.ref, placement));
      if (preview.ok) announce(describeLocation(preview.model, m.ref));
      return;
    }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      setMoving(null);
      const title = quoted(titleOf(model, m.ref));
      const res = moveNode(model, m.ref, m.placement);
      if (res.ok) {
        const after = applyBinderDraft(model, res.draft);
        emit(res, `Moved ${title}${after.ok ? `, ${describeLocation(after.model, m.ref)}` : ''}.`);
      } else if (res.error.code === 'no-op') {
        announce(`${title} stays where it was.`);
      } else {
        emit(res);
      }
      focusSoon(key);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setMoving(null);
      announce('Move cancelled.');
      focusSoon(key);
      return;
    }
    if (e.key === 'Tab') setMoving(null);
  };

  // ---- keyboard navigation -------------------------------------------------

  const onTreeKeyDown = (area: BinderArea) => (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.target instanceof HTMLInputElement) return;
    if (moving) {
      handleMoveKey(e, moving);
      return;
    }
    const rows = rowsByArea[area];
    const current = tabKeyFor(area);
    const at = rows.findIndex((r) => refKey(r.ref) === current);
    const row = rows[at];
    if (!row) return;
    const ref = row.ref;
    const mod = e.ctrlKey || e.metaKey || e.altKey;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown': {
        const next = rows[at + 1];
        if (next) focusRow(refKey(next.ref));
        break;
      }
      case 'ArrowUp': {
        const prev = rows[at - 1];
        if (prev) focusRow(refKey(prev.ref));
        break;
      }
      case 'Home': {
        const first = rows[0];
        if (first) focusRow(refKey(first.ref));
        break;
      }
      case 'End': {
        const last = rows[rows.length - 1];
        if (last) focusRow(refKey(last.ref));
        break;
      }
      case 'ArrowRight':
        if (ref.kind === 'folder') {
          if (!isExpanded(ref.id)) setExpanded(ref.id, true);
          else if (row.childCount > 0 && rows[at + 1]) focusRow(refKey(rows[at + 1]!.ref));
        }
        break;
      case 'ArrowLeft':
        if (ref.kind === 'folder' && isExpanded(ref.id) && row.childCount > 0) {
          setExpanded(ref.id, false);
        } else if (row.parentId) {
          focusRow(refKey({ kind: 'folder', id: row.parentId }));
        }
        break;
      case 'Enter':
      case ' ':
        onSelect?.(ref);
        break;
      case 'F2':
        startRename(ref);
        break;
      case 'Delete':
      case 'Backspace':
        if (mod) handled = false;
        else archive(ref);
        break;
      case 'm':
      case 'M':
        if (mod) handled = false;
        else startMove(ref, area);
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };

  const onTreeBlur = (e: FocusEvent<HTMLUListElement>) => {
    const next = e.relatedTarget as Node | null;
    if (moving && next && !e.currentTarget.contains(next)) {
      setMoving(null);
      announce('Move cancelled.');
    }
  };

  /** The one row in an area that is in the tab order. */
  const tabKeyFor = (area: BinderArea): string | null => {
    const rows = rowsByArea[area];
    const keys = new Set(rows.map((r) => refKey(r.ref)));
    if (focusKey && keys.has(focusKey)) return focusKey;
    if (selected && keys.has(refKey(selected))) return refKey(selected);
    return rows[0] ? refKey(rows[0].ref) : null;
  };

  // ---- pointer drag and drop -------------------------------------------------

  const clearDrag = () => {
    setDrag(null);
    setDrop(null);
  };

  const dropAllowed = (placement: Placement | undefined): placement is Placement =>
    !!drag && !!placement && moveNode(model, drag.ref, placement).ok;

  const onRowDragOver = (ref: BinderRef, area: BinderArea, key: string) => (e: DragEvent) => {
    if (!drag || drag.area !== area) return;
    e.stopPropagation();
    const f = pointerFraction(e, 'y');
    let position: DropPosition =
      ref.kind === 'folder'
        ? f < 0.25
          ? 'before'
          : f > 0.75
            ? 'after'
            : 'inside'
        : f < 0.5
          ? 'before'
          : 'after';
    let placement: Placement | undefined;
    // Just below an open folder's row means "first inside it".
    if (
      position === 'after' &&
      ref.kind === 'folder' &&
      isExpanded(ref.id) &&
      visibleChildren(model, area, ref.id).length > 0
    ) {
      position = 'inside';
      placement = { parentId: ref.id, index: 0 };
    } else {
      placement = placementForDrop(model, drag.ref, ref, position);
    }
    if (!dropAllowed(placement)) {
      if (drop?.key === key) setDrop(null);
      return;
    }
    allowDrop(e);
    if (drop?.key !== key || drop.position !== position) setDrop({ key, position, placement });
  };

  const onEndDragOver = (area: BinderArea) => (e: DragEvent) => {
    if (!drag || drag.area !== area) return;
    const placement = placementAtEnd(model, area, null, drag.ref);
    if (!dropAllowed(placement)) return;
    allowDrop(e);
    const key = `end:${area}`;
    if (drop?.key !== key) setDrop({ key, position: 'after', placement });
  };

  const onDragLeave = (key: string) => (e: DragEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    if (drop?.key === key) setDrop(null);
  };

  const onDrop = (key: string) => (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (drag && drop && drop.key === key) {
      const title = quoted(titleOf(model, drag.ref));
      const res = moveNode(model, drag.ref, drop.placement);
      if (res.ok) {
        const after = applyBinderDraft(model, res.draft);
        emit(
          res,
          `Moved ${title}${after.ok ? `, ${describeLocation(after.model, drag.ref)}` : ''}.`,
        );
        if (drop.placement.parentId) setExpanded(drop.placement.parentId, true);
      } else emit(res);
    }
    clearDrag();
  };

  // ---- rendering -------------------------------------------------------------

  const renderItems = (area: BinderArea, parentId: string | null, level: number): ReactNode => {
    const kids = visibleChildren(view, area, parentId);
    const tabKey = tabKeyFor(area);
    return kids.map((ref, i) => {
      const node = getNode(view, ref);
      if (!node) return null;
      const key = refKey(ref);
      const isFolder = ref.kind === 'folder';
      const open = isFolder && isExpanded(ref.id);
      const kidCount = isFolder ? visibleChildren(view, area, ref.id).length : 0;
      const isRenaming = !!renaming && sameRef(renaming.ref, ref);
      const isMoving = !!moving && sameRef(moving.ref, ref);
      const isSelected = sameRef(selected, ref);
      const titleId = domId(`title-${key}`);
      const countId = domId(`count-${key}`);
      const dropHere = drop?.key === key ? drop.position : null;
      return (
        <li
          key={key}
          ref={register(key)}
          role="treeitem"
          aria-level={level}
          aria-setsize={kids.length}
          aria-posinset={i + 1}
          aria-expanded={isFolder ? open : undefined}
          aria-selected={isSelected}
          aria-labelledby={isRenaming ? undefined : titleId}
          aria-label={isRenaming ? node.title : undefined}
          aria-describedby={showWordCounts ? countId : undefined}
          tabIndex={tabKey === key ? 0 : -1}
          data-key={key}
          className={cx(
            'lh-binder-item',
            isFolder ? 'lh-binder-item--folder' : 'lh-binder-item--document',
            isSelected && 'is-selected',
            isMoving && 'is-moving',
            drag && sameRef(drag.ref, ref) && 'is-dragging',
          )}
          onFocus={(e) => {
            if (e.target === e.currentTarget) setFocusKey(key);
          }}
        >
          <div
            className={cx('lh-binder-row', dropHere && `is-drop-${dropHere}`)}
            style={{ '--lh-binder-level': level } as CSSProperties}
            draggable={!isRenaming && !moving}
            onDragStart={(e) => {
              e.stopPropagation();
              startDrag(e, key);
              setDrag({ ref, area });
            }}
            onDragOver={onRowDragOver(ref, area, key)}
            onDragLeave={onDragLeave(key)}
            onDrop={onDrop(key)}
            onDragEnd={clearDrag}
            onClick={() => {
              if (moving || isRenaming) return;
              focusRow(key);
              onSelect?.(ref);
            }}
            onDoubleClick={() => startRename(ref)}
          >
            <span
              className={cx('lh-binder-twisty', isFolder && (open ? 'is-open' : 'is-closed'))}
              aria-hidden="true"
              onClick={(e) => {
                if (!isFolder) return;
                e.stopPropagation();
                setExpanded(ref.id, !open);
                focusRow(key);
              }}
            />
            <span
              className={cx('lh-binder-icon', isFolder ? 'is-folder' : 'is-document')}
              aria-hidden="true"
            />
            {isRenaming ? (
              <input
                ref={renameInput}
                className="lh-binder-rename"
                aria-label={`Rename ${quoted(node.title)}`}
                value={renaming.value}
                maxLength={TEXT_LIMITS.titleMaxChars}
                onChange={(e) => setRenaming({ ref, value: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={commitRename}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span id={titleId} className="lh-binder-title">
                {node.title}
              </span>
            )}
            {showWordCounts && (
              <span id={countId} className="lh-binder-count">
                {formatCount(nodeWordCount(view, ref, wordCounts))}
                <span className="lh-visually-hidden"> words</span>
              </span>
            )}
          </div>
          {open && kidCount > 0 && (
            <ul role="group" className="lh-binder-group">
              {renderItems(area, ref.id, level + 1)}
            </ul>
          )}
        </li>
      );
    });
  };

  const archived = archivedNodes(model);
  const instructionsId = domId('instructions');
  const archiveListId = domId('archive');

  return (
    <nav className={cx('lh-binder', className)} aria-label={label}>
      <p id={instructionsId} className="lh-visually-hidden">
        Arrow keys move between items. Enter opens. F2 renames. Delete archives. M starts moving the
        item: arrow keys move it, Enter drops it, Escape cancels.
      </p>
      {areas.map((area) => {
        const headingId = domId(`area-${area}`);
        const rows = rowsByArea[area];
        const current = currentIn(area);
        const endKey = `end:${area}`;
        return (
          <section key={area} className="lh-binder-area" aria-labelledby={headingId}>
            <div className="lh-binder-area-head">
              <h2 id={headingId} className="lh-binder-area-title">
                {AREA_LABELS[area]}
              </h2>
              <div className="lh-binder-tools">
                <button
                  type="button"
                  className="lh-binder-tool"
                  onClick={() => create(area, 'document')}
                >
                  {area === 'notes' ? 'New note' : 'New document'}
                </button>
                <button
                  type="button"
                  className="lh-binder-tool"
                  aria-label={`New folder in ${AREA_LABELS[area]}`}
                  onClick={() => create(area, 'folder')}
                >
                  New folder
                </button>
                <button
                  type="button"
                  className="lh-binder-tool"
                  disabled={!current}
                  aria-label={
                    current
                      ? `Archive ${quoted(titleOf(model, current))}`
                      : 'Archive (nothing selected)'
                  }
                  onClick={() => current && archive(current)}
                >
                  Archive
                </button>
              </div>
            </div>
            <ul
              role="tree"
              className="lh-binder-tree"
              aria-labelledby={headingId}
              aria-describedby={instructionsId}
              onKeyDown={onTreeKeyDown(area)}
              onBlur={onTreeBlur}
            >
              {renderItems(area, null, 1)}
            </ul>
            {rows.length === 0 && (
              <p className="lh-binder-empty">
                {area === 'notes' ? 'No notes yet.' : 'No documents yet.'}
              </p>
            )}
            <div
              className={cx(
                'lh-binder-dropend',
                drag?.area === area && 'is-armed',
                drop?.key === endKey && 'is-drop-after',
              )}
              aria-hidden="true"
              onDragOver={onEndDragOver(area)}
              onDragLeave={onDragLeave(endKey)}
              onDrop={onDrop(endKey)}
            />
          </section>
        );
      })}
      {(archived.length > 0 || showArchive) && (
        <section className="lh-binder-archive">
          <button
            type="button"
            className="lh-binder-archive-toggle"
            aria-expanded={showArchive}
            aria-controls={archiveListId}
            onClick={() => setShowArchive((s) => !s)}
          >
            Archive <span className="lh-binder-archive-count">{archived.length}</span>
          </button>
          {showArchive && (
            <ul id={archiveListId} className="lh-binder-archive-list" aria-label="Archived items">
              {archived.length === 0 && <li className="lh-binder-empty">Nothing is archived.</li>}
              {archived.map(({ ref, area }) => {
                const hiddenBy = archivedAncestorTitle(model, ref);
                const title = titleOf(model, ref);
                return (
                  <li key={refKey(ref)} className="lh-binder-archive-item">
                    <span className="lh-binder-archive-title">{title}</span>
                    <span className="lh-binder-archive-where">
                      {AREA_LABELS[area]}
                      {ref.kind === 'folder' ? ' · folder' : ''}
                      {hiddenBy ? ` · inside ${quoted(hiddenBy)}` : ''}
                    </span>
                    <button
                      type="button"
                      className="lh-binder-tool"
                      aria-label={`Restore ${quoted(title)}`}
                      onClick={() => restore(ref)}
                    >
                      Restore
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      <LiveRegion message={message} />
    </nav>
  );
}

/** Title of the nearest archived folder above `ref`, or null. */
function archivedAncestorTitle(model: BinderModel, ref: BinderRef): string | null {
  let parentId = getNode(model, ref)?.parentId ?? null;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const folder = model.folders[parentId];
    if (!folder) return null;
    if (folder.archived) return folder.title;
    parentId = folder.parentId;
  }
  return null;
}
