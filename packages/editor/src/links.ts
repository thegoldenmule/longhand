/**
 * Links in the manuscript: finding a link's extent, setting and removing links,
 * pasting a URL over a selection, and clicks that never navigate.
 *
 * A link is formatting. Its `href` is a mark attribute, never document text, so
 * every command here changes marks only: zero input units, kind `format`. The
 * href always passes the schema's policy (`normalizeHref`), which the mark's
 * validator enforces anyway.
 */
import { normalizeHref, pastedLinkHref } from '@longhand/schema';
import type { Mark, Node as PMNode, ResolvedPos } from 'prosemirror-model';
import { Plugin, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { InputGuard } from './input/guard';
import { marks } from './nodes';

/** A link's mark and its extent in the document. */
export interface LinkRange {
  from: number;
  to: number;
  href: string;
  mark: Mark;
}

/**
 * The link around a position: the caret's link (strictly inside, as the
 * non-inclusive mark reports it) or, with `side`, the link touching that side.
 */
export function linkAt($pos: ResolvedPos, side: -1 | 0 | 1 = 0): LinkRange | null {
  const parent = $pos.parent;
  if (!parent.inlineContent) return null;
  let mark: Mark | undefined;
  if (side === 0) mark = marks.link.isInSet($pos.marks()) ?? undefined;
  else {
    const node = side < 0 ? $pos.nodeBefore : $pos.nodeAfter;
    mark = node ? (marks.link.isInSet(node.marks) ?? undefined) : undefined;
  }
  if (!mark) return null;
  const start = $pos.start();
  // Walk the parent's children to find the contiguous run carrying this exact mark.
  let from = -1;
  let to = -1;
  let pos = start;
  let found = false;
  for (let i = 0; i < parent.childCount; i++) {
    const child = parent.child(i);
    const end = pos + child.nodeSize;
    if (mark.isInSet(child.marks)) {
      if (from < 0) from = pos;
      to = end;
      if (pos <= $pos.pos && $pos.pos <= end) found = true;
    } else if (found) break;
    else from = -1;
    pos = end;
  }
  if (!found || from < 0) return null;
  return { from, to, href: mark.attrs.href as string, mark };
}

/** The first link mark inside `[from, to)`, with its extent, if any. */
export function firstLinkIn(doc: PMNode, from: number, to: number): LinkRange | null {
  let hit: LinkRange | null = null;
  doc.nodesBetween(from, to, (node, pos) => {
    if (hit) return false;
    if (node.isInline && marks.link.isInSet(node.marks)) {
      hit = linkAt(doc.resolve(Math.max(from, pos)), 1);
      return false;
    }
    return true;
  });
  return hit;
}

/** Sets `href` as the link over `[from, to)`, replacing any link there. Null for a refused href. */
export function setLinkTr(
  state: EditorState,
  from: number,
  to: number,
  href: string,
): Transaction | null {
  const clean = normalizeHref(href);
  if (!clean || to <= from) return null;
  return state.tr
    .removeMark(from, to, marks.link)
    .addMark(from, to, marks.link.create({ href: clean }));
}

/** Removes every link over `[from, to)`. */
export function removeLinkTr(state: EditorState, from: number, to: number): Transaction {
  return state.tr.removeMark(from, to, marks.link);
}

/**
 * Paste handler: plain-text clipboard content that is plainly a URL, pasted over a
 * non-empty text selection, links the selection instead of replacing it (as
 * Medium does). The URL becomes the mark's attribute, so no words are inserted.
 * Returns the transaction to dispatch, or null to let the paste go through.
 */
export function linkPasteTr(state: EditorState, event: ClipboardEvent): Transaction | null {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || sel.empty) return null;
  const text = event.clipboardData?.getData('text/plain') ?? '';
  if (!text || /\n/.test(text.trim())) return null;
  const href = pastedLinkHref(text);
  if (!href) return null;
  let applies = false;
  state.doc.nodesBetween(sel.from, sel.to, (node, _pos, parent) => {
    if (node.isText && parent?.type.allowsMarkType(marks.link)) applies = true;
    return !applies;
  });
  if (!applies) return null;
  return setLinkTr(state, sel.from, sel.to, href);
}

/** Opens a link in a new tab, never in this one. */
export function openLink(href: string, win: Window | null = globalThis.window ?? null): void {
  const clean = normalizeHref(href);
  if (!clean || !win) return;
  win.open(clean, '_blank', 'noopener,noreferrer');
}

function anchorOf(view: EditorView, target: EventTarget | null): HTMLAnchorElement | null {
  const el = target instanceof Element ? target : (target as Node | null)?.parentElement;
  const a = el?.closest('a[href]') ?? null;
  return a && view.dom.contains(a) ? (a as HTMLAnchorElement) : null;
}

/**
 * Links in an editable view never navigate on a click. ⌘-click (Ctrl-click
 * elsewhere) opens the link in a new tab. Middle clicks are left to the browser,
 * which opens a new tab too.
 */
export function linkClickPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        click: (view, event) => {
          const a = anchorOf(view, event.target);
          if (!a) return false;
          event.preventDefault();
          if (event.metaKey || event.ctrlKey) {
            openLink(a.getAttribute('href') ?? '', view.dom.ownerDocument.defaultView);
            return true;
          }
          return false;
        },
      },
    },
  });
}

/** Pasting a URL over a selection links it (guard grant: format, zero units). */
export function linkPastePlugin(guard: InputGuard): Plugin {
  return new Plugin({
    props: {
      handlePaste: (view, event) => {
        if (!guard.tracker.trusted(event)) return false;
        const tr = linkPasteTr(view.state, event);
        if (!tr) return false;
        guard.tracker.consumePaste();
        view.dispatch(guard.grant(tr, { units: 0, kind: 'format' }));
        return true;
      },
    },
  });
}
