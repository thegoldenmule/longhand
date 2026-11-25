/**
 * Draws each citation node as its formatted in-text citation, e.g.
 * "(Okafor, 2014, p. 12)", in the project's style. A node decoration only: the
 * document keeps the structured citation (source id + locator), never the text.
 */
import { formatCitation } from '@longhand/research';
import type { SourceState } from '@longhand/schema';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

const key = new PluginKey<DecorationSet>('longhand-citation-labels');

export interface CitationLabels {
  plugin: Plugin;
  /** New sources or style: redraws the labels. */
  refresh(view: EditorView, sources: Readonly<Record<string, SourceState>>, style: string): void;
}

export function createCitationLabels(): CitationLabels {
  let sources: Readonly<Record<string, SourceState>> = {};
  let style = 'apa';

  const label = (node: PMNode): string => {
    const sourceId = node.attrs.sourceId as string;
    if (!sources[sourceId]) return '(missing source)';
    try {
      return formatCitation(sources, sourceId, (node.attrs.locator as string | null) ?? null, style)
        .text;
    } catch {
      return '(citation)';
    }
  };

  const build = (doc: PMNode): DecorationSet => {
    const decos: Decoration[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === 'citation') {
        decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-cite-label': label(node) }));
      }
      return true;
    });
    return DecorationSet.create(doc, decos);
  };

  const plugin = new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state: EditorState) => build(state.doc),
      apply: (tr, old) => (tr.getMeta(key) || tr.docChanged ? build(tr.doc) : old),
    },
    props: { decorations: (state) => key.getState(state) },
  });

  return {
    plugin,
    refresh(view, nextSources, nextStyle) {
      sources = nextSources;
      style = nextStyle;
      if (view.isDestroyed) return;
      // No steps: a decoration refresh never touches the manuscript.
      view.dispatch(view.state.tr.setMeta(key, true));
    },
  };
}
