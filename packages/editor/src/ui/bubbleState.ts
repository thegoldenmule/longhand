/**
 * Shared state for the bubble toolbar, kept apart from `bubble.ts` so commands
 * and the footnote node view can reach it without an import cycle.
 *
 * - `bubbleKey`'s plugin state holds the range the link field edits in the main
 *   document, mapped through every transaction while the field is open.
 * - A registry maps each main view to its bubble controller and to the nested
 *   footnote editor that is open in it, if any.
 */
import { PluginKey, type Command } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

/** Plugin state: the main-document range the link field is editing, if open. */
export interface BubbleState {
  link: { from: number; to: number } | null;
}

/** Meta for {@link bubbleKey}: open the link field over a range, or close it. */
export type BubbleMeta = { openLink: { from: number; to: number } } | { closeLink: true };

export const bubbleKey = new PluginKey<BubbleState>('longhand-bubble');

/** What the toolbar exposes to commands and the footnote editor. */
export interface BubbleController {
  /** Opens the link field for the selection (or the link at the caret) in `view`. */
  openLink(view: EditorView): boolean;
  /** Moves focus into the toolbar, if it is showing for `view`. */
  focus(view: EditorView): boolean;
  /** Recomputes visibility and placement. */
  refresh(): void;
}

const controllers = new WeakMap<EditorView, BubbleController>();
const footnoteEditors = new WeakMap<EditorView, EditorView>();

export function registerBubble(view: EditorView, controller: BubbleController | null): void {
  if (controller) controllers.set(view, controller);
  else controllers.delete(view);
}

/** The bubble controller of a main view, if it has one. */
export function bubbleOf(view: EditorView): BubbleController | undefined {
  return controllers.get(view);
}

/** Records (or clears) the footnote editor open inside `outer`. */
export function setFootnoteEditor(outer: EditorView, inner: EditorView | null): void {
  if (inner) footnoteEditors.set(outer, inner);
  else if (footnoteEditors.has(outer)) footnoteEditors.delete(outer);
  controllers.get(outer)?.refresh();
}

/** The footnote editor open inside `outer`, if any. */
export function footnoteEditorOf(outer: EditorView): EditorView | undefined {
  return footnoteEditors.get(outer);
}

/** Mod-K: opens the bubble's link field on the selection or the link at the caret. */
export const openLinkEditor: Command = (_state, dispatch, view) => {
  const bubble = view ? bubbleOf(view) : undefined;
  if (!bubble || !view) return false;
  return dispatch ? bubble.openLink(view) : true;
};

/** Alt-F10: moves focus into the bubble toolbar when it is showing. */
export const focusToolbar: Command = (_state, dispatch, view) => {
  const bubble = view ? bubbleOf(view) : undefined;
  if (!bubble || !view) return false;
  return dispatch ? bubble.focus(view) : true;
};
