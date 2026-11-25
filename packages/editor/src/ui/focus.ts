/**
 * Focus mode: dims everything except the current sentence or paragraph.
 *
 * The editor root gets `data-focus="sentence|paragraph"`; CSS dims the text color
 * of the whole document and the plugin marks the current block (node decoration)
 * or sentence (inline decoration) with `lh-focus-current`. Sentences come from the
 * schema's rule-based `splitSentences`, over the same inline text the segmenter uses.
 */
import { splitSentences } from '@longhand/schema';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

/** Focus granularity, or off. */
export type FocusMode = 'off' | 'sentence' | 'paragraph';

/** Plugin key; dispatch `tr.setMeta(focusKey, mode)` to change the mode. */
export const focusKey = new PluginKey<FocusMode>('longhand-focus');

/** Inline text of a textblock with the document position of each character. */
export function textblockText(
  block: PMNode,
  contentStart: number,
): { text: string; pos: number[] } {
  let text = '';
  const pos: number[] = [];
  block.forEach((child, offset) => {
    const at = contentStart + offset;
    if (child.isText) {
      const t = child.text as string;
      for (let i = 0; i < t.length; i++) pos.push(at + i);
      text += t;
    } else if (child.type.name === 'hard_break') {
      pos.push(at);
      text += '\n';
    }
  });
  return { text, pos };
}

/** The `[from, to)` range of the sentence containing the selection head, or null. */
export function currentSentence(state: EditorState): { from: number; to: number } | null {
  const $head = state.selection.$head;
  const block = $head.parent;
  if (!block.isTextblock) return null;
  const start = $head.start();
  const { text, pos } = textblockText(block, start);
  if (text.length === 0) return null;
  const ranges = splitSentences(text);
  if (ranges.length === 0) return null;
  // Offset of the head within `text`: number of characters before it.
  let offset = 0;
  while (offset < pos.length && (pos[offset] as number) < $head.pos) offset++;
  let chosen = ranges[0] as { start: number; end: number };
  for (const r of ranges) {
    if (r.start <= offset) chosen = r;
    else break;
  }
  return { from: pos[chosen.start] as number, to: (pos[chosen.end - 1] as number) + 1 };
}

function decorations(state: EditorState, mode: FocusMode): DecorationSet {
  if (mode === 'off') return DecorationSet.empty;
  const $head = state.selection.$head;
  let depth = $head.depth;
  while (depth > 0 && !$head.node(depth).isTextblock) depth--;
  if (depth === 0) return DecorationSet.empty;
  const decos: Decoration[] = [];
  const from = $head.before(depth);
  const to = $head.after(depth);
  if (mode === 'paragraph') {
    decos.push(Decoration.node(from, to, { class: 'lh-focus-current' }));
  } else {
    const s = currentSentence(state);
    if (s) decos.push(Decoration.inline(s.from, s.to, { class: 'lh-focus-current' }));
  }
  return DecorationSet.create(state.doc, decos);
}

/** Creates the focus-mode plugin. */
export function focusPlugin(initial: FocusMode): Plugin<FocusMode> {
  return new Plugin<FocusMode>({
    key: focusKey,
    state: {
      init: () => initial,
      apply: (tr, value) => (tr.getMeta(focusKey) as FocusMode | undefined) ?? value,
    },
    props: {
      decorations(state) {
        return decorations(state, focusKey.getState(state) ?? 'off');
      },
      attributes(state): Record<string, string> {
        const mode = focusKey.getState(state) ?? 'off';
        return mode === 'off' ? {} : { 'data-focus': mode };
      },
    },
  });
}
