/**
 * Footnote node view: an inline marker (numbered by CSS counter) that opens a small
 * nested editor when selected. Edits in the nested editor are forwarded to the
 * main editor as steps offset into the footnote, so they pass through the same
 * input guard and capture pipeline as everything else.
 */
import { keymap } from 'prosemirror-keymap';
import type { Node as PMNode } from 'prosemirror-model';
import { redo, undo } from 'prosemirror-history';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { StepMap } from 'prosemirror-transform';
import { EditorView, type NodeView } from 'prosemirror-view';

/** Clipboard hook for the nested editor (copy/cut positions in the main document). */
export type FootnoteCopyHandler = (view: EditorView, event: ClipboardEvent, cut: boolean, offset: number) => boolean;

const FORWARDED_META = ['uiEvent', 'paste', 'composition', 'pointer'];

export class FootnoteView implements NodeView {
  dom: HTMLElement;
  private inner: EditorView | null = null;
  private popover: HTMLElement | null = null;

  constructor(
    private node: PMNode,
    private outer: EditorView,
    private getPos: () => number | undefined,
    private onCopy: FootnoteCopyHandler,
  ) {
    this.dom = document.createElement('span');
    this.dom.className = 'lh-footnote';
    this.dom.setAttribute('data-footnote', '');
    this.dom.setAttribute('role', 'button');
    this.dom.setAttribute('aria-label', 'Footnote');
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
    if (!this.inner) this.open();
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
    if (this.inner) this.close();
  }

  private open(): void {
    const pop = this.dom.appendChild(document.createElement('span'));
    pop.className = 'lh-footnote-editor';
    this.popover = pop;
    const offset = (): number => (this.getPos() ?? 0) + 1;
    this.inner = new EditorView(pop, {
      state: EditorState.create({
        doc: this.node,
        plugins: [
          keymap({
            'Mod-z': () => undo(this.outer.state, this.outer.dispatch),
            'Mod-y': () => redo(this.outer.state, this.outer.dispatch),
            'Shift-Mod-z': () => redo(this.outer.state, this.outer.dispatch),
            Escape: () => {
              this.exit();
              return true;
            },
          }),
        ],
      }),
      dispatchTransaction: (tr) => this.dispatchInner(tr),
      handleDOMEvents: {
        mousedown: () => {
          if (this.inner && this.outer.hasFocus()) this.inner.focus();
          return false;
        },
        copy: (view, e) => this.onCopy(view, e, false, offset()),
        cut: (view, e) => this.onCopy(view, e, true, offset()),
      },
    });
    this.inner.focus();
  }

  private exit(): void {
    const pos = this.getPos();
    if (pos === undefined) return;
    const tr = this.outer.state.tr.setSelection(TextSelection.create(this.outer.state.doc, pos + this.node.nodeSize));
    this.outer.dispatch(tr);
    this.outer.focus();
  }

  private close(): void {
    this.inner?.destroy();
    this.inner = null;
    this.popover?.remove();
    this.popover = null;
  }

  private dispatchInner(tr: Transaction): void {
    if (!this.inner) return;
    const { state, transactions } = this.inner.state.applyTransaction(tr);
    if (tr.getMeta('fromOutside') || !transactions.some((t) => t.docChanged)) {
      this.inner.updateState(state);
      return;
    }
    const pos = this.getPos();
    if (pos === undefined) return;
    const outerTr = this.outer.state.tr;
    const offsetMap = StepMap.offset(pos + 1);
    for (const t of transactions) for (const step of t.steps) {
      const mapped = step.map(offsetMap);
      if (mapped) outerTr.step(mapped);
    }
    for (const key of FORWARDED_META) {
      const v = tr.getMeta(key);
      if (v !== undefined) outerTr.setMeta(key, v);
    }
    const before = this.outer.state;
    this.outer.dispatch(outerTr);
    // If the outer editor refused the change, keep the nested editor in sync with it.
    if (this.outer.state === before) {
      this.inner.updateState(EditorState.create({ doc: this.node, plugins: this.inner.state.plugins, selection: this.inner.state.selection }));
    } else {
      this.inner.updateState(state);
    }
  }

  update(node: PMNode): boolean {
    if (!node.sameMarkup(this.node)) return false;
    this.node = node;
    if (this.inner) {
      const state = this.inner.state;
      const start = node.content.findDiffStart(state.doc.content);
      if (start !== null && start !== undefined) {
        const end = node.content.findDiffEnd(state.doc.content);
        if (end) {
          let { a: endA, b: endB } = end;
          const overlap = start - Math.min(endA, endB);
          if (overlap > 0) {
            endA += overlap;
            endB += overlap;
          }
          this.inner.dispatch(state.tr.replace(start, endB, node.slice(start, endA)).setMeta('fromOutside', true));
        }
      }
    }
    return true;
  }

  stopEvent(event: Event): boolean {
    return !!this.inner && !!event.target && this.inner.dom.contains(event.target as Node);
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.close();
  }
}

/** Node view constructor for the `footnote` node. */
export function footnoteNodeView(onCopy: FootnoteCopyHandler) {
  return (node: PMNode, view: EditorView, getPos: () => number | undefined): NodeView =>
    new FootnoteView(node, view, getPos, onCopy);
}

