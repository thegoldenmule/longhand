/**
 * Formatting commands, keyboard shortcuts and Markdown-style input rules.
 *
 * Every command that inserts content (hard break, scene break, footnote) or
 * re-inserts typed text (undoing an input rule) carries a guard grant, so the
 * input guard accepts it while still requiring a real key event.
 *
 * Shortcuts (Mod = Cmd on macOS, Ctrl elsewhere):
 *
 * | Keys | Action |
 * | --- | --- |
 * | Mod-B / Mod-I | strong / emphasis |
 * | Mod-Alt-1/2/3, Mod-Alt-0 | heading 1–3, paragraph |
 * | Mod-Shift-8 / Mod-Shift-7 | bullet / ordered list |
 * | Mod-Shift-. (also Ctrl->) | block quote |
 * | Mod-Shift-Enter | scene break |
 * | Mod-Alt-F | footnote |
 * | Shift-Enter | line break |
 * | Tab / Shift-Tab | indent / outdent list item |
 * | Mod-Z, Mod-Shift-Z, Mod-Y | undo, redo |
 *
 * Input rules: `# `, `## `, `### ` headings; `> ` quote; `- `/`* `/`+ ` bullets;
 * `1. ` ordered list; `***` or `---` on an empty line → scene break; `*em*`,
 * `_em_`, `**strong**`, `__strong__`; `^[` → footnote (Pandoc's inline note syntax).
 * Backspace right after a rule undoes it.
 */
import {
  baseKeymap,
  chainCommands,
  createParagraphNear,
  liftEmptyBlock,
  newlineInCode,
  setBlockType,
  splitBlock,
  toggleMark,
  wrapIn,
} from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  undoInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import type { MarkType } from 'prosemirror-model';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import {
  NodeSelection,
  TextSelection,
  type Command,
  type EditorState,
  type Plugin,
  type Transaction,
} from 'prosemirror-state';
import type { InputGrant } from './input/classify';
import type { InputGuard } from './input/guard';
import { marks, nodes } from './nodes';


/** Wraps a command so its transactions carry a guard grant. */
export function granted(guard: InputGuard, cmd: Command, grant: InputGrant): Command {
  return (state, dispatch, view) =>
    cmd(state, dispatch ? (tr: Transaction) => dispatch(guard.grant(tr, grant)) : undefined, view);
}

/** Inserts a hard line break. */
export const insertHardBreak: Command = (state, dispatch) => {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(nodes.hard_break.create()).scrollIntoView());
  return true;
};

/** Inserts a scene break after the current block and moves the caret below it. */
export const insertSceneBreak: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if ($from.depth < 1) return false;
  const after = $from.after(1);
  if (dispatch) {
    const tr = state.tr.insert(after, [nodes.scene_break.create(), nodes.paragraph.create()]);
    tr.setSelection(TextSelection.create(tr.doc, after + 2)).scrollIntoView();
    dispatch(tr);
  }
  return true;
};

/** Inserts an empty footnote at the caret and selects it (opening its editor). */
export const insertFootnote: Command = (state, dispatch) => {
  const { $from } = state.selection;
  if (!$from.parent.inlineContent || $from.parent.type === nodes.footnote) return false;
  if (dispatch) {
    const node = nodes.footnote.create();
    const tr = state.tr.replaceSelectionWith(node, false);
    const pos = tr.selection.from - node.nodeSize;
    tr.setSelection(NodeSelection.create(tr.doc, pos)).scrollIntoView();
    dispatch(tr);
  }
  return true;
};

/** Keymaps for the main editor. */
export function editorKeymaps(guard: InputGuard): Plugin[] {
  const fmt = (cmd: Command): Command => granted(guard, cmd, { units: 0, kind: 'format' });
  const brk = (cmd: Command): Command => granted(guard, cmd, { units: 0, kind: 'break' });
  const ins = (cmd: Command, units: number): Command => granted(guard, cmd, { units, kind: 'insert' });
  const enter = chainCommands(
    splitListItem(nodes.list_item),
    newlineInCode,
    createParagraphNear,
    liftEmptyBlock,
    splitBlock,
  );
  const blockquote = fmt(wrapIn(nodes.blockquote));
  return [
    keymap({
      'Mod-z': undo,
      'Shift-Mod-z': redo,
      'Mod-y': redo,
      Backspace: granted(guard, undoInputRule, { units: 'all', kind: 'delete' }),
      Enter: brk(enter),
      'Shift-Enter': ins(insertHardBreak, 1),
      'Mod-Shift-Enter': ins(insertSceneBreak, 1),
      'Mod-b': fmt(toggleMark(marks.strong)),
      'Mod-B': fmt(toggleMark(marks.strong)),
      'Mod-i': fmt(toggleMark(marks.em)),
      'Mod-I': fmt(toggleMark(marks.em)),
      'Mod-Alt-0': fmt(setBlockType(nodes.paragraph)),
      'Mod-Alt-1': fmt(setBlockType(nodes.heading, { level: 1 })),
      'Mod-Alt-2': fmt(setBlockType(nodes.heading, { level: 2 })),
      'Mod-Alt-3': fmt(setBlockType(nodes.heading, { level: 3 })),
      'Mod-Shift-8': fmt(wrapInList(nodes.bullet_list)),
      'Mod-Shift-7': fmt(wrapInList(nodes.ordered_list)),
      'Mod-Shift-.': blockquote,
      'Ctrl->': blockquote,
      'Mod-Alt-f': ins(insertFootnote, 1),
      Tab: fmt(sinkListItem(nodes.list_item)),
      'Shift-Tab': fmt(liftListItem(nodes.list_item)),
    }),
    keymap(baseKeymap),
  ];
}

type RuleHandler = (
  state: EditorState,
  match: RegExpMatchArray,
  start: number,
  end: number,
  text: string,
) => Transaction | null;

function markRule(guard: InputGuard, re: RegExp, delim: number, type: MarkType): InputRule {
  return new InputRule(re, (state, match, start, end) => {
    const full = match[0];
    const inner = match[1] as string;
    const openStart = start + (full.length - inner.length - 2 * delim);
    const tr = state.tr;
    if (delim > 1) tr.delete(end - (delim - 1), end);
    tr.delete(openStart, openStart + delim);
    tr.addMark(openStart, openStart + inner.length, type.create());
    tr.removeStoredMark(type);
    return guard.grant(tr, { units: 0, kind: 'format' });
  });
}

/** Markdown-style input rules. */
export function editorInputRules(guard: InputGuard): Plugin {
  const wrap = (rule: InputRule): InputRule => {
    const { handler, match: re } = rule as unknown as { handler: RuleHandler; match: RegExp };
    return new InputRule(re, (state, match, start, end, text) => {
      const tr = handler(state, match, start, end, text);
      return tr ? guard.grant(tr, { units: 0, kind: 'format' }) : null;
    });
  };
  const sceneBreak = new InputRule(/^(?:\*\*|--)[*-]$/, (state, match, start, end) => {
    const typed = match[0];
    if (typed !== '***' && typed !== '---') return null;
    const $start = state.doc.resolve(start);
    if ($start.parent.type !== nodes.paragraph || $start.depth !== 1) return null;
    if ($start.parent.content.size !== end - start) return null;
    const before = $start.before(1);
    const after = $start.after(1);
    const tr = state.tr.replaceWith(before, after, [nodes.scene_break.create(), nodes.paragraph.create()]);
    tr.setSelection(TextSelection.create(tr.doc, before + 2));
    return guard.grant(tr, { units: 1, kind: 'format' });
  });
  const footnote = new InputRule(/\^\[$/, (state, _match, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type === nodes.footnote) return null;
    const tr = state.tr.replaceWith(start, end, nodes.footnote.create());
    tr.setSelection(NodeSelection.create(tr.doc, start));
    return guard.grant(tr, { units: 1, kind: 'insert' });
  });
  return inputRules({
    rules: [
      wrap(textblockTypeInputRule(/^(#{1,3})\s$/, nodes.heading, (m) => ({ level: (m[1] as string).length }))),
      wrap(wrappingInputRule(/^\s*>\s$/, nodes.blockquote)),
      wrap(wrappingInputRule(/^\s*([-+*])\s$/, nodes.bullet_list)),
      wrap(
        wrappingInputRule(
          /^(\d+)\.\s$/,
          nodes.ordered_list,
          (m) => ({ order: Number(m[1]) }),
          (m, node) => node.childCount + (node.attrs.order as number) === Number(m[1]),
        ),
      ),
      sceneBreak,
      markRule(guard, /\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, 2, marks.strong),
      markRule(guard, /__([^_\s](?:[^_]*[^_\s])?)__$/, 2, marks.strong),
      markRule(guard, /(?:^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/, 1, marks.em),
      markRule(guard, /(?:^|[^_A-Za-z0-9])_([^_\s](?:[^_]*[^_\s])?)_$/, 1, marks.em),
      footnote,
    ],
  });
}
