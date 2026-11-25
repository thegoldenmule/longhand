/**
 * Decoration layers: the extension point the provenance tint, annotations (ghost
 * text, underlines, margin anchors) and replay use to draw on the manuscript
 * without touching it.
 *
 * A layer is a plugin holding a `DecorationSet`. Positions handed to it may be in
 * any recent ledger version: pass the mapping from `handle.mappingFrom(version)`
 * and the layer moves them onto the current local document (which may contain
 * unacknowledged steps). After that the set follows every transaction.
 */
import type { Mappable } from 'prosemirror-transform';
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type DecorationAttrs, type EditorView } from 'prosemirror-view';

/** A decoration described by plain positions. */
export type LayerDecoration =
  | { kind: 'inline'; from: number; to: number; attrs: DecorationAttrs; spec?: Record<string, unknown> }
  | { kind: 'node'; from: number; to: number; attrs: DecorationAttrs; spec?: Record<string, unknown> }
  | {
      kind: 'widget';
      pos: number;
      toDOM: (view: EditorView, getPos: () => number | undefined) => Node;
      side?: number;
      spec?: Record<string, unknown>;
    };

/** A named decoration layer. */
export interface DecorationLayer {
  readonly key: PluginKey<DecorationSet>;
  /** Add this to the editor (`extraPlugins` or `handle.setExtraPlugins`). */
  readonly plugin: Plugin<DecorationSet>;
  /**
   * Replaces the layer's decorations. With `mapping`, positions are first mapped
   * from the version they were computed at. Returns the number of decorations kept.
   */
  set(view: EditorView, decorations: readonly LayerDecoration[], mapping?: Mappable | null): number;
  clear(view: EditorView): void;
  get(state: EditorState): DecorationSet;
}

/** Converts plain decorations to ProseMirror decorations on `doc`, mapping first. Drops ones that no longer fit. */
export function buildDecorations(
  state: EditorState,
  decorations: readonly LayerDecoration[],
  mapping?: Mappable | null,
): Decoration[] {
  const doc = state.doc;
  const size = doc.content.size;
  const m = (pos: number, assoc: number): number => (mapping ? mapping.map(pos, assoc) : pos);
  const out: Decoration[] = [];
  for (const d of decorations) {
    if (d.kind === 'widget') {
      const pos = m(d.pos, d.side ?? 0);
      if (pos < 0 || pos > size) continue;
      out.push(Decoration.widget(pos, d.toDOM, { side: d.side ?? 0, ...(d.spec ?? {}) }));
      continue;
    }
    const from = m(d.from, d.kind === 'inline' ? 1 : -1);
    const to = m(d.to, d.kind === 'inline' ? -1 : 1);
    if (from < 0 || to > size || to <= from) continue;
    if (d.kind === 'inline') out.push(Decoration.inline(from, to, d.attrs, d.spec));
    else {
      const node = doc.nodeAt(from);
      if (!node || from + node.nodeSize !== to) continue;
      out.push(Decoration.node(from, to, d.attrs, d.spec));
    }
  }
  return out;
}

/** Creates a decoration layer. */
export function createDecorationLayer(name: string): DecorationLayer {
  const key = new PluginKey<DecorationSet>(`longhand-layer-${name}`);
  const plugin = new Plugin<DecorationSet>({
    key,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const meta = tr.getMeta(key) as DecorationSet | undefined;
        if (meta) return meta;
        return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
      },
    },
    props: {
      decorations: (state) => key.getState(state),
    },
  });
  return {
    key,
    plugin,
    set(view, decorations, mapping) {
      const decos = buildDecorations(view.state, decorations, mapping);
      view.dispatch(view.state.tr.setMeta(key, DecorationSet.create(view.state.doc, decos)));
      return decos.length;
    },
    clear(view) {
      view.dispatch(view.state.tr.setMeta(key, DecorationSet.empty));
    },
    get(state) {
      return key.getState(state) ?? DecorationSet.empty;
    },
  };
}
