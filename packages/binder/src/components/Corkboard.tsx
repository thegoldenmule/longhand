import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { TEXT_LIMITS, type BinderArea, type BinderRef } from '@longhand/schema';
import {
  editSynopsis,
  moveNode,
  type BinderDraft,
  type BinderError,
  type DraftResult,
} from '../drafts';
import {
  describeLocation,
  getNode,
  locate,
  placementForDrop,
  refKey,
  sameRef,
  titleOf,
  visibleChildren,
  type BinderModel,
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

/** Props of {@link Corkboard}. */
export interface CorkboardProps {
  model: BinderModel;
  /** The area whose root is shown when `folderId` is null. */
  area: BinderArea;
  /** The folder whose children become cards; null for the area root. */
  folderId: string | null;
  /** Called with every binder event the writer makes (reorders, synopsis edits). */
  onDraft: (draft: BinderDraft) => void;
  /** Called when the writer opens a card (its title). */
  onOpen?: (ref: BinderRef) => void;
  /** Highlights a card. */
  selected?: BinderRef | null;
  /** Show word counts on cards. */
  showWordCounts?: boolean;
  /** Per-document word counts to show instead of counting `content`. */
  wordCounts?: Readonly<Record<string, number>>;
  /** Called when an action is refused (the message is also announced). */
  onError?: (error: BinderError) => void;
  /** Accessible label of the board; defaults to `Corkboard: <folder or area>`. */
  label?: string;
  className?: string;
}

function moveDraftFor(ref: BinderRef, placement: Placement): BinderDraft {
  return ref.kind === 'folder'
    ? { type: 'FolderMoved', payload: { folderId: ref.id, ...placement } }
    : { type: 'DocumentMoved', payload: { documentId: ref.id, ...placement } };
}

const EARLIER = new Set(['ArrowLeft', 'ArrowUp']);
const LATER = new Set(['ArrowRight', 'ArrowDown']);

/**
 * Index cards for a folder's (or an area root's) non-archived children: title,
 * synopsis (documents and folders) and optional word count. Synopses are edited in place. Cards reorder by
 * dragging, or from the keyboard with each card's Move button: arrows move the card,
 * Enter or Space drops it, Escape cancels.
 */
export function Corkboard(props: CorkboardProps) {
  const {
    model,
    area,
    folderId,
    onDraft,
    onOpen,
    selected = null,
    showWordCounts = false,
    wordCounts,
    onError,
    label,
    className,
  } = props;

  const baseId = useId();
  const domId = (part: string) => `${baseId}-${part.replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const [editing, setEditingState] = useState<{ ref: BinderRef; value: string } | null>(null);
  const editingRef = useRef(editing);
  const setEditing = (next: { ref: BinderRef; value: string } | null) => {
    editingRef.current = next;
    setEditingState(next);
  };
  const [moving, setMoving] = useState<{ ref: BinderRef; placement: Placement } | null>(null);
  const [drag, setDrag] = useState<BinderRef | null>(null);
  const [drop, setDrop] = useState<{
    key: string;
    position: 'before' | 'after';
    placement: Placement;
  } | null>(null);
  const [message, announce] = useAnnouncer();
  const { register, focusSoon } = useDeferredFocus();
  const textarea = useRef<HTMLTextAreaElement>(null);

  const view = useMemo(() => {
    if (!moving) return model;
    const res = applyBinderDraft(model, moveDraftFor(moving.ref, moving.placement));
    return res.ok ? res.model : model;
  }, [model, moving]);

  const cards = visibleChildren(view, area, folderId);
  const folderTitle = folderId ? (model.folders[folderId]?.title ?? '') : AREA_LABELS[area];

  const editingKey = editing ? refKey(editing.ref) : null;
  useEffect(() => {
    if (editingKey && textarea.current) {
      const el = textarea.current;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editingKey]);

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

  // ---- synopsis ---------------------------------------------------------------

  const startEdit = (ref: BinderRef) => {
    if (moving) return;
    setEditing({ ref, value: getNode(model, ref)?.synopsis ?? '' });
  };

  const finishEdit = (save: boolean) => {
    const e = editingRef.current;
    if (!e) return;
    setEditing(null);
    if (save) {
      emit(
        editSynopsis(model, e.ref, e.value),
        `Saved the synopsis of ${quoted(titleOf(model, e.ref))}.`,
      );
    }
    focusSoon(`edit:${refKey(e.ref)}`);
  };

  // ---- keyboard move ------------------------------------------------------------

  const toggleMove = (ref: BinderRef) => {
    const key = refKey(ref);
    if (!moving) {
      const loc = locate(model, ref);
      if (!loc) return;
      setMoving({ ref, placement: { parentId: loc.parentId, index: loc.index } });
      announce(
        `Moving card ${quoted(titleOf(model, ref))}, ${describeLocation(model, ref)}. ` +
          'Arrow keys move it, Enter drops it, Escape cancels.',
      );
      return;
    }
    const m = moving;
    setMoving(null);
    const res = moveNode(model, m.ref, m.placement);
    const title = quoted(titleOf(model, m.ref));
    if (res.ok) {
      const after = applyBinderDraft(model, res.draft);
      emit(res, `Moved ${title}${after.ok ? `, ${describeLocation(after.model, m.ref)}` : ''}.`);
    } else if (res.error.code === 'no-op') announce(`${title} stays where it was.`);
    else emit(res);
    focusSoon(`move:${key}`);
  };

  const onHandleKeyDown = (ref: BinderRef) => (e: KeyboardEvent) => {
    if (!moving || !sameRef(moving.ref, ref)) return;
    const at = cards.findIndex((c) => sameRef(c, ref));
    if (EARLIER.has(e.key) || LATER.has(e.key)) {
      e.preventDefault();
      const earlier = EARLIER.has(e.key);
      const neighbour = cards[earlier ? at - 1 : at + 1];
      if (!neighbour) {
        announce(earlier ? 'Already first.' : 'Already last.');
        return;
      }
      const placement = placementForDrop(view, ref, neighbour, earlier ? 'before' : 'after');
      if (!placement) return;
      setMoving({ ref, placement });
      focusSoon(`move:${refKey(ref)}`);
      const preview = applyBinderDraft(model, moveDraftFor(ref, placement));
      if (preview.ok) announce(describeLocation(preview.model, ref));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setMoving(null);
      announce('Move cancelled.');
      focusSoon(`move:${refKey(ref)}`);
    } else if (e.key === 'Tab') {
      setMoving(null);
    }
  };

  // ---- pointer drag -------------------------------------------------------------

  const clearDrag = () => {
    setDrag(null);
    setDrop(null);
  };

  const onCardDragOver = (ref: BinderRef, key: string) => (e: DragEvent) => {
    if (!drag || sameRef(drag, ref)) return;
    const position = pointerFraction(e, 'x') < 0.5 ? 'before' : 'after';
    const placement = placementForDrop(model, drag, ref, position);
    if (!placement || !moveNode(model, drag, placement).ok) {
      if (drop?.key === key) setDrop(null);
      return;
    }
    allowDrop(e);
    if (drop?.key !== key || drop.position !== position) setDrop({ key, position, placement });
  };

  const onCardDrop = (key: string) => (e: DragEvent) => {
    e.preventDefault();
    if (drag && drop && drop.key === key) {
      const res = moveNode(model, drag, drop.placement);
      const after = res.ok ? applyBinderDraft(model, res.draft) : null;
      emit(
        res,
        `Moved ${quoted(titleOf(model, drag))}${after?.ok ? `, ${describeLocation(after.model, drag)}` : ''}.`,
      );
    }
    clearDrag();
  };

  // ---- render -------------------------------------------------------------------

  const instructionsId = domId('instructions');

  return (
    <div className={cx('lh-cork', className)}>
      <p id={instructionsId} className="lh-visually-hidden">
        Press Move, then use the arrow keys to move the card. Enter drops it, Escape cancels.
      </p>
      {cards.length === 0 ? (
        <p className="lh-cork-empty">
          {folderId ? 'This folder is empty.' : `Nothing in ${AREA_LABELS[area]} yet.`}
        </p>
      ) : (
        <ol className="lh-cork-grid" aria-label={label ?? `Corkboard: ${folderTitle}`}>
          {cards.map((ref) => {
            const node = getNode(view, ref);
            if (!node) return null;
            const key = refKey(ref);
            const titleId = domId(`title-${key}`);
            const isMoving = !!moving && sameRef(moving.ref, ref);
            const isEditing = !!editing && sameRef(editing.ref, ref);
            const dropHere = drop?.key === key ? drop.position : null;
            const folderCount =
              ref.kind === 'folder' ? visibleChildren(view, area, ref.id).length : 0;
            return (
              <li
                key={key}
                data-key={key}
                className={cx(
                  'lh-card',
                  ref.kind === 'folder' && 'lh-card--folder',
                  sameRef(selected, ref) && 'is-selected',
                  isMoving && 'is-moving',
                  drag && sameRef(drag, ref) && 'is-dragging',
                  dropHere && `is-drop-${dropHere}`,
                )}
                draggable={!isEditing && !moving}
                onDragStart={(e) => {
                  startDrag(e, key);
                  setDrag(ref);
                }}
                onDragOver={onCardDragOver(ref, key)}
                onDragLeave={(e) => {
                  const next = e.relatedTarget as Node | null;
                  if (next && e.currentTarget.contains(next)) return;
                  if (drop?.key === key) setDrop(null);
                }}
                onDrop={onCardDrop(key)}
                onDragEnd={clearDrag}
              >
                <article className="lh-card-inner" aria-labelledby={titleId}>
                  <header className="lh-card-head">
                    <h3 id={titleId} className="lh-card-title">
                      {onOpen ? (
                        <button type="button" className="lh-card-open" onClick={() => onOpen(ref)}>
                          {node.title}
                        </button>
                      ) : (
                        node.title
                      )}
                    </h3>
                    <button
                      type="button"
                      ref={register(`move:${key}`)}
                      className="lh-card-handle"
                      aria-label={`Move ${quoted(node.title)}`}
                      aria-pressed={isMoving}
                      aria-describedby={instructionsId}
                      onClick={() => toggleMove(ref)}
                      onKeyDown={onHandleKeyDown(ref)}
                      onBlur={(e) => {
                        if (isMoving && e.relatedTarget) {
                          setMoving(null);
                          announce('Move cancelled.');
                        }
                      }}
                    >
                      <span aria-hidden="true" className="lh-card-grip" />
                    </button>
                  </header>
                  {isEditing ? (
                    <div className="lh-card-edit">
                      <textarea
                        ref={textarea}
                        className="lh-card-textarea"
                        aria-label={`Synopsis of ${quoted(node.title)}`}
                        aria-describedby={domId(`hint-${key}`)}
                        value={editing.value}
                        maxLength={TEXT_LIMITS.synopsisMaxChars}
                        rows={4}
                        onChange={(e) => setEditing({ ref, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault();
                            finishEdit(false);
                          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                            e.preventDefault();
                            finishEdit(true);
                          }
                        }}
                        onBlur={() => finishEdit(true)}
                      />
                      <p id={domId(`hint-${key}`)} className="lh-card-hint">
                        Saved when you leave the card. Escape discards.
                      </p>
                    </div>
                  ) : (
                    <>
                      <p
                        className={cx('lh-card-synopsis', !node.synopsis && 'is-empty')}
                        onClick={() => startEdit(ref)}
                      >
                        {node.synopsis || 'No synopsis yet.'}
                      </p>
                      <button
                        type="button"
                        ref={register(`edit:${key}`)}
                        className="lh-card-action"
                        aria-label={`Edit synopsis of ${quoted(node.title)}`}
                        onClick={() => startEdit(ref)}
                      >
                        Edit synopsis
                      </button>
                    </>
                  )}
                  {ref.kind === 'folder' && (
                    <p className="lh-card-meta">
                      Folder · {folderCount} {folderCount === 1 ? 'item' : 'items'}
                    </p>
                  )}
                  {showWordCounts && (
                    <p className="lh-card-count">
                      {formatCount(nodeWordCount(view, ref, wordCounts))} words
                    </p>
                  )}
                </article>
              </li>
            );
          })}
        </ol>
      )}
      <LiveRegion message={message} />
    </div>
  );
}
