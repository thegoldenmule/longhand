/**
 * The bubble toolbar: Medium-style formatting above a text selection.
 *
 * Three faces, one floating element (`.lh-bubble`) placed in the editor root:
 * - **format**: Bold, Italic, Link, Heading, Subheading, Quote and Code buttons
 *   above a non-empty text selection, each with `aria-pressed`. In a footnote
 *   editor only the mark buttons show (blocks make no sense there).
 * - **link field**: an inline URL field (Link button or Mod-K). Enter applies,
 *   Esc cancels, it is pre-filled when the selection is already a link, and it
 *   has Remove then.
 * - **link view**: with the caret inside a link, the URL (opens in a new tab)
 *   with Edit and Remove.
 *
 * Keyboard: the toolbar never takes focus while the writer types. Alt-F10 moves
 * focus into it (and Tab does, outside lists, since it follows the editor in tab
 * order while it shows). Arrow keys, Home and End move between buttons; Esc
 * returns to the text with the selection intact. Mouse presses on the toolbar
 * keep focus and the selection in the editor.
 *
 * Hidden when the selection is collapsed (outside a link), while a selection is
 * being dragged, during IME composition, when the editor is read-only or
 * unfocused, and while a dialog is open (the provenance inspector, an annotation
 * popover: anything with `role="dialog"` or an open `<dialog>`; see `suppress`).
 *
 * Every change is formatting: marks or block types only, dispatched with the
 * guard's `format` grant (zero units). A link's href is an attribute, never text.
 */
import type { MarkType } from 'prosemirror-model';
import {
  AllSelection,
  Plugin,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { normalizeHref } from '@longhand/schema';
import {
  granted,
  inBlockquote,
  isHeading,
  toggleBlockquote,
  toggleHeading,
  toggleMarkAll,
} from '../commands';
import type { InputGuard } from '../input/guard';
import { firstLinkIn, linkAt, removeLinkTr, setLinkTr } from '../links';
import { marks } from '../nodes';
import {
  bubbleKey,
  footnoteEditorOf,
  registerBubble,
  type BubbleController,
  type BubbleMeta,
  type BubbleState,
} from './bubbleState';

/** Options for {@link bubblePlugin}. */
export interface BubbleOptions {
  guard: InputGuard;
  /**
   * True while something else owns the writer's attention and the toolbar must
   * hide. Default: an element with `role="dialog"` or an open `<dialog>` is in
   * the document (the provenance inspector is one).
   */
  suppress?: () => boolean;
}

type Mode = 'format' | 'link' | 'view';

interface ButtonSpec {
  id: string;
  label: string;
  keys: string | null;
  glyph: string;
  block?: boolean;
}

const BUTTONS: readonly ButtonSpec[] = [
  { id: 'strong', label: 'Bold', keys: 'Mod-B', glyph: 'B' },
  { id: 'em', label: 'Italic', keys: 'Mod-I', glyph: 'i' },
  { id: 'link', label: 'Link', keys: 'Mod-K', glyph: '' },
  { id: 'h1', label: 'Heading', keys: 'Mod-Alt-1', glyph: 'T', block: true },
  { id: 'h2', label: 'Subheading', keys: 'Mod-Alt-2', glyph: 'T', block: true },
  { id: 'quote', label: 'Quote', keys: 'Mod-Shift-.', glyph: '“', block: true },
  { id: 'code', label: 'Code', keys: 'Mod-E', glyph: '<>' },
];

const LINK_ICON =
  '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false"><path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1-1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

const LINK_ERROR = 'Use an http, https or mailto link';

function isMac(doc: Document): boolean {
  const nav = doc.defaultView?.navigator;
  return !!nav && /Mac|iPhone|iPad/.test(nav.platform);
}

function keyLabel(keys: string, mac: boolean): string {
  const parts = keys.split('-');
  const key = parts.pop() as string;
  const map: Record<string, string> = mac
    ? { Mod: '⌘', Alt: '⌥', Shift: '⇧' }
    : { Mod: 'Ctrl+', Alt: 'Alt+', Shift: 'Shift+' };
  return parts.map((p) => map[p] ?? p).join('') + key;
}

/** True when every inline text in the selection carries `type`. */
function markEverywhere(state: EditorState, type: MarkType): boolean {
  const { from, to } = state.selection;
  let any = false;
  let all = true;
  state.doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (!node.isText || !parent?.type.allowsMarkType(type)) return true;
    any = true;
    if (!type.isInSet(node.marks)) all = false;
    return true;
  });
  return any && all;
}

function hasSelection(state: EditorState): boolean {
  const sel = state.selection;
  return !sel.empty && (sel instanceof TextSelection || sel instanceof AllSelection);
}

function defaultSuppress(doc: Document): boolean {
  return !!doc.querySelector('[role="dialog"], dialog[open]');
}

function shortHref(href: string): string {
  const bare = href.replace(/^https?:\/\//, '').replace(/^mailto:/, '');
  return bare.length > 48 ? `${bare.slice(0, 47)}…` : bare;
}

/** Main-document plugin: link-field range state plus the toolbar view. */
export function bubblePlugin(opts: BubbleOptions): Plugin<BubbleState> {
  return new Plugin<BubbleState>({
    key: bubbleKey,
    state: {
      init: () => ({ link: null }),
      apply(tr, value) {
        const meta = tr.getMeta(bubbleKey) as BubbleMeta | undefined;
        if (meta && 'openLink' in meta) return { link: meta.openLink };
        if (meta && 'closeLink' in meta) return { link: null };
        if (!value.link || !tr.docChanged) return value;
        const from = tr.mapping.map(value.link.from, 1);
        const to = tr.mapping.map(value.link.to, -1);
        return { link: to > from ? { from, to } : null };
      },
    },
    props: {
      // While the link field has focus the browser hides the selection: keep it visible.
      decorations(state) {
        const link = bubbleKey.getState(state)?.link;
        if (!link) return null;
        return DecorationSet.create(state.doc, [
          Decoration.inline(link.from, link.to, { class: 'lh-link-pending' }),
        ]);
      },
    },
    view: (view) => new BubbleView(view, opts),
  });
}

class BubbleView {
  readonly dom: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly buttons = new Map<string, HTMLButtonElement>();
  private readonly linkForm: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly removeBtn: HTMLButtonElement;
  private readonly error: HTMLElement;
  private readonly viewBox: HTMLElement;
  private readonly url: HTMLAnchorElement;
  private readonly doc: Document;
  private readonly suppress: () => boolean;
  private readonly cleanups: Array<() => void> = [];
  private mode: Mode | null = null;
  private dragging = false;
  /** The view the toolbar acts on: the main view or an open footnote editor. */
  private target: EditorView;
  /** Footnote link field: range in the footnote editor's document. */
  private innerLink: { view: EditorView; from: number; to: number; doc: unknown } | null = null;
  private restoreTo: 'editor' | 'toolbar' = 'editor';

  constructor(
    private readonly view: EditorView,
    private readonly opts: BubbleOptions,
  ) {
    this.doc = view.dom.ownerDocument;
    this.target = view;
    this.suppress = opts.suppress ?? (() => defaultSuppress(this.doc));
    const doc = this.doc;
    const mac = isMac(doc);

    this.dom = doc.createElement('div');
    this.dom.className = 'lh-bubble';
    this.dom.hidden = true;
    this.dom.setAttribute('data-testid', 'bubble-toolbar');

    this.bar = this.dom.appendChild(doc.createElement('div'));
    this.bar.className = 'lh-bubble__bar';
    this.bar.setAttribute('role', 'toolbar');
    this.bar.setAttribute('aria-label', 'Formatting');
    this.bar.setAttribute('aria-orientation', 'horizontal');
    let prevBlock: boolean | undefined;
    for (const spec of BUTTONS) {
      const block = !!spec.block;
      if (prevBlock !== undefined && prevBlock !== block) {
        const sep = this.bar.appendChild(doc.createElement('span'));
        sep.className = 'lh-bubble__sep';
        sep.setAttribute('aria-hidden', 'true');
        if (block) sep.dataset.block = '';
      }
      prevBlock = block;
      const b = this.bar.appendChild(doc.createElement('button'));
      b.type = 'button';
      b.className = `lh-bubble__btn lh-bubble__btn--${spec.id}`;
      b.dataset.cmd = spec.id;
      b.tabIndex = -1;
      b.setAttribute('aria-label', spec.label);
      b.setAttribute('aria-pressed', 'false');
      b.title = spec.keys ? `${spec.label} (${keyLabel(spec.keys, mac)})` : spec.label;
      if (spec.id === 'link') b.innerHTML = LINK_ICON;
      else {
        const g = b.appendChild(doc.createElement('span'));
        g.setAttribute('aria-hidden', 'true');
        g.textContent = spec.glyph;
      }
      if (block) b.dataset.block = '';
      this.buttons.set(spec.id, b);
    }

    this.linkForm = this.dom.appendChild(doc.createElement('div'));
    this.linkForm.className = 'lh-bubble__link';
    this.linkForm.setAttribute('role', 'group');
    this.linkForm.setAttribute('aria-label', 'Link');
    this.input = this.linkForm.appendChild(doc.createElement('input'));
    this.input.type = 'url';
    this.input.className = 'lh-bubble__input';
    this.input.setAttribute('aria-label', 'Link address');
    this.input.placeholder = 'Paste or type a link';
    this.input.autocomplete = 'off';
    this.input.spellcheck = false;
    this.input.setAttribute('enterkeyhint', 'done');
    this.removeBtn = this.linkForm.appendChild(doc.createElement('button'));
    this.removeBtn.type = 'button';
    this.removeBtn.className = 'lh-bubble__text-btn';
    this.removeBtn.dataset.act = 'remove';
    this.removeBtn.textContent = 'Remove';
    this.removeBtn.setAttribute('aria-label', 'Remove link');
    this.error = this.linkForm.appendChild(doc.createElement('span'));
    this.error.className = 'lh-bubble__error';
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;
    const errId = `lh-bubble-error-${Math.random().toString(36).slice(2, 10)}`;
    this.error.id = errId;
    this.input.setAttribute('aria-describedby', errId);

    this.viewBox = this.dom.appendChild(doc.createElement('div'));
    this.viewBox.className = 'lh-bubble__view';
    this.viewBox.setAttribute('role', 'group');
    this.viewBox.setAttribute('aria-label', 'Link');
    this.url = this.viewBox.appendChild(doc.createElement('a'));
    this.url.className = 'lh-bubble__url';
    this.url.target = '_blank';
    this.url.rel = 'noopener noreferrer';
    for (const [act, text, label] of [
      ['edit', 'Edit', 'Edit link'],
      ['unlink', 'Remove', 'Remove link'],
    ] as const) {
      const b = this.viewBox.appendChild(doc.createElement('button'));
      b.type = 'button';
      b.className = 'lh-bubble__text-btn';
      b.dataset.act = act;
      b.textContent = text;
      b.setAttribute('aria-label', label);
    }

    (view.dom.parentElement ?? view.dom).appendChild(this.dom);
    this.listen();
    registerBubble(view, this.controller());
    this.refresh();
  }

  // -- wiring ----------------------------------------------------------------

  private on(el: EventTarget, type: string, fn: (e: Event) => void, capture = false): void {
    el.addEventListener(type, fn, capture);
    this.cleanups.push(() => el.removeEventListener(type, fn, capture));
  }

  private listen(): void {
    // Presses on the toolbar keep focus (and the selection) in the editor, except in the field.
    this.on(this.dom, 'mousedown', (e) => {
      if (e.target !== this.input) e.preventDefault();
    });
    this.on(this.dom, 'click', (e) => this.onClick(e as MouseEvent));
    this.on(this.dom, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.on(this.dom, 'focusout', (e) => {
      const next = (e as FocusEvent).relatedTarget as Node | null;
      if (next && this.dom.contains(next)) return;
      // Leaving the link field for anywhere else cancels it.
      if (this.linkRange()) this.closeLink(false);
      queueMicrotask(() => this.refresh());
    });
    const host = this.view.dom.parentElement ?? this.view.dom;
    this.on(host, 'focusin', () => this.refresh());
    this.on(host, 'focusout', () => queueMicrotask(() => this.refresh()));
    this.on(this.view.dom, 'mousedown', (e) => {
      if ((e as MouseEvent).button === 0) {
        this.dragging = true;
        this.refresh();
      }
    });
    this.on(
      this.doc,
      'mouseup',
      () => {
        if (!this.dragging) return;
        this.dragging = false;
        // Let ProseMirror read the final selection first.
        setTimeout(() => this.refresh(), 0);
      },
      true,
    );
    const win = this.doc.defaultView;
    if (win) this.on(win, 'resize', () => this.refresh());
    if (typeof MutationObserver !== 'undefined' && this.doc.body) {
      const mo = new MutationObserver(() => this.refresh());
      mo.observe(this.doc.body, { childList: true });
      this.cleanups.push(() => mo.disconnect());
    }
  }

  private controller(): BubbleController {
    return {
      openLink: (v) => this.openLink(v),
      focus: (v) => this.focusToolbar(v),
      refresh: () => this.refresh(),
    };
  }

  update(): void {
    this.refresh();
  }

  destroy(): void {
    for (const c of this.cleanups.splice(0)) c();
    registerBubble(this.view, null);
    this.dom.remove();
  }

  // -- context ---------------------------------------------------------------

  /** The footnote editor, when it has the writer's focus (or had it before the toolbar). */
  private context(): EditorView {
    const inner = footnoteEditorOf(this.view);
    if (inner && !inner.isDestroyed) {
      if (inner.hasFocus()) return inner;
      if (this.target === inner && this.dom.contains(this.doc.activeElement)) return inner;
      if (this.innerLink?.view === inner) return inner;
    }
    return this.view;
  }

  private inFootnote(v: EditorView): boolean {
    return v !== this.view;
  }

  private focused(v: EditorView): boolean {
    return v.hasFocus() || this.dom.contains(this.doc.activeElement);
  }

  /** The range the link field edits, in `this.target`'s document. */
  private linkRange(): { from: number; to: number } | null {
    if (this.inFootnote(this.target)) {
      const l = this.innerLink;
      if (!l || l.view !== this.target || l.doc !== this.target.state.doc) return null;
      return { from: l.from, to: l.to };
    }
    return bubbleKey.getState(this.view.state)?.link ?? null;
  }

  // -- commands --------------------------------------------------------------

  /** Runs a format command on the target view (main view: guard format grant). */
  private run(cmd: Command, v: EditorView = this.target): boolean {
    if (this.inFootnote(v)) return cmd(v.state, v.dispatch, v);
    return granted(this.opts.guard, cmd, { units: 0, kind: 'format' })(v.state, v.dispatch, v);
  }

  private dispatchFormat(v: EditorView, tr: Transaction): void {
    if (this.inFootnote(v)) v.dispatch(tr);
    else v.dispatch(this.opts.guard.grant(tr, { units: 0, kind: 'format' }));
  }

  private commandFor(id: string): Command | null {
    switch (id) {
      case 'strong':
        return toggleMarkAll(marks.strong);
      case 'em':
        return toggleMarkAll(marks.em);
      case 'code':
        return toggleMarkAll(marks.code);
      case 'h1':
        return toggleHeading(1);
      case 'h2':
        return toggleHeading(2);
      case 'quote':
        return toggleBlockquote;
      default:
        return null;
    }
  }

  private pressed(id: string, state: EditorState): boolean {
    switch (id) {
      case 'strong':
        return markEverywhere(state, marks.strong);
      case 'em':
        return markEverywhere(state, marks.em);
      case 'code':
        return markEverywhere(state, marks.code);
      case 'link':
        return state.doc.rangeHasMark(state.selection.from, state.selection.to, marks.link);
      case 'h1':
        return isHeading(state, 1);
      case 'h2':
        return isHeading(state, 2);
      case 'quote':
        return inBlockquote(state);
      default:
        return false;
    }
  }

  private onClick(e: MouseEvent): void {
    const el = (e.target as Element | null)?.closest('button, a');
    if (!el || !this.dom.contains(el)) return;
    if (el === this.url) return; // a plain link outside the editor: opens in a new tab
    const btn = el as HTMLButtonElement;
    const v = this.target;
    const fromKeyboard = this.doc.activeElement === btn;
    if (btn.dataset.cmd === 'link') {
      this.restoreTo = fromKeyboard ? 'toolbar' : 'editor';
      this.openLink(v);
      return;
    }
    if (btn.dataset.cmd) {
      const cmd = this.commandFor(btn.dataset.cmd);
      if (cmd && this.run(cmd, v)) this.refresh();
      if (fromKeyboard) btn.focus();
      return;
    }
    switch (btn.dataset.act) {
      case 'remove':
        this.applyLink('');
        return;
      case 'edit':
        this.restoreTo = 'editor';
        this.openLink(v);
        return;
      case 'unlink': {
        const l = linkAt(v.state.selection.$from);
        if (l) this.dispatchFormat(v, removeLinkTr(v.state, l.from, l.to));
        v.focus();
        return;
      }
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.target === this.input) {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.applyLink(this.input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeLink(true);
      }
      return;
    }
    const items = this.focusables();
    const i = items.indexOf(this.doc.activeElement as HTMLElement);
    const move = (to: number): void => {
      e.preventDefault();
      const n = items.length;
      if (n === 0) return;
      this.rove(items[((to % n) + n) % n] as HTMLElement);
    };
    switch (e.key) {
      case 'ArrowRight':
        move(i + 1);
        break;
      case 'ArrowLeft':
        move(i - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(items.length - 1);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.target.focus();
        break;
    }
  }

  /** The keyboard stops of the face that is showing. */
  private focusables(): HTMLElement[] {
    const box =
      this.mode === 'view' ? this.viewBox : this.mode === 'link' ? this.linkForm : this.bar;
    return Array.from(box.querySelectorAll<HTMLElement>('a, button, input')).filter(
      (el) => !el.hidden && !(el as HTMLButtonElement).disabled,
    );
  }

  /** Roving tabindex: only `el` is a tab stop, and it takes focus. */
  private rove(el: HTMLElement, focus = true): void {
    for (const b of this.dom.querySelectorAll<HTMLElement>('a, button')) b.tabIndex = -1;
    el.tabIndex = 0;
    if (focus) el.focus();
  }

  private focusToolbar(v: EditorView): boolean {
    this.target = v === this.view ? this.context() : v;
    this.refresh();
    if (this.mode === 'link') {
      this.input.focus();
      return true;
    }
    if (this.dom.hidden) return false;
    const first = this.focusables()[0];
    if (!first) return false;
    this.rove(first);
    return true;
  }

  private openLink(v: EditorView): boolean {
    const target = v === this.view ? this.context() : v;
    const state = target.state;
    let range: { from: number; to: number } | null = null;
    let current: string | null = null;
    if (hasSelection(state)) {
      range = { from: state.selection.from, to: state.selection.to };
      current = firstLinkIn(state.doc, range.from, range.to)?.href ?? null;
    } else {
      const l = linkAt(state.selection.$from);
      if (l) {
        range = { from: l.from, to: l.to };
        current = l.href;
      }
    }
    if (!range) return false;
    this.target = target;
    if (this.inFootnote(target)) {
      this.innerLink = { view: target, ...range, doc: target.state.doc };
    } else {
      this.innerLink = null;
      this.view.dispatch(this.view.state.tr.setMeta(bubbleKey, { openLink: range }));
    }
    this.input.value = current ?? '';
    this.removeBtn.hidden = current === null;
    this.error.hidden = true;
    this.error.textContent = '';
    this.input.removeAttribute('aria-invalid');
    this.refresh();
    this.input.focus();
    this.input.select();
    return true;
  }

  /** Applies the field's value: an allowed href links the range, an empty one unlinks it. */
  private applyLink(value: string): void {
    const v = this.target;
    const range = this.linkRange();
    if (!range) {
      this.closeLink(true);
      return;
    }
    let tr: Transaction | null;
    if (value.trim() === '') tr = removeLinkTr(v.state, range.from, range.to);
    else {
      tr = normalizeHref(value) ? setLinkTr(v.state, range.from, range.to, value) : null;
      if (!tr) {
        this.error.textContent = LINK_ERROR;
        this.error.hidden = false;
        this.input.setAttribute('aria-invalid', 'true');
        this.input.focus();
        return;
      }
    }
    this.restoreTo = 'editor';
    this.closeLink(false);
    this.dispatchFormat(v, tr);
    v.focus();
    this.refresh();
  }

  private closeLink(restore: boolean): void {
    const wasOpen = this.mode === 'link' || !!this.linkRange();
    this.innerLink = null;
    if (bubbleKey.getState(this.view.state)?.link)
      this.view.dispatch(this.view.state.tr.setMeta(bubbleKey, { closeLink: true }));
    if (!wasOpen) return;
    this.mode = null;
    if (restore) {
      if (this.restoreTo === 'toolbar') {
        this.refresh();
        const link = this.buttons.get('link');
        if (link && !this.dom.hidden) this.rove(link);
        else this.target.focus();
      } else this.target.focus();
    }
    this.restoreTo = 'editor';
    this.refresh();
  }

  // -- rendering -------------------------------------------------------------

  /** Recomputes which face shows (if any), its button states and its placement. */
  refresh(): void {
    if (this.view.isDestroyed) return;
    const linkOpen = !!this.linkRange();
    if (!linkOpen) {
      const ctx = this.context();
      if (ctx !== this.target && !this.dom.contains(this.doc.activeElement)) this.target = ctx;
    }
    const v = this.target;
    const state = v.state;
    let mode: Mode | null = null;
    let range: { from: number; to: number } | null = null;
    const blocked = !this.view.editable || this.view.composing || v.composing || this.suppress();
    if (!blocked && linkOpen) {
      mode = 'link';
      range = this.linkRange();
    } else if (!blocked && !this.dragging && this.focused(v)) {
      if (hasSelection(state)) {
        mode = 'format';
        range = { from: state.selection.from, to: state.selection.to };
      } else {
        const l = linkAt(state.selection.$from);
        if (l) {
          mode = 'view';
          range = { from: l.from, to: l.to };
          this.url.href = l.href;
          this.url.textContent = shortHref(l.href);
          this.url.title = l.href;
        }
      }
    }
    // Not from inside a view update: closing dispatches.
    if (blocked && linkOpen) queueMicrotask(() => this.closeLink(false));
    const wasHidden = this.dom.hidden;
    this.mode = mode;
    this.dom.hidden = mode === null;
    this.dom.dataset.mode = mode ?? '';
    if (mode === null || !range) return;
    this.bar.hidden = mode !== 'format';
    this.linkForm.hidden = mode !== 'link';
    this.viewBox.hidden = mode !== 'view';
    if (mode === 'format') this.renderButtons(state, v);
    if (wasHidden) {
      const first = this.focusables()[0];
      if (first) this.rove(first, false);
    }
    this.place(v, range);
  }

  private renderButtons(state: EditorState, v: EditorView): void {
    const footnote = this.inFootnote(v);
    for (const el of this.bar.querySelectorAll<HTMLElement>('[data-block]')) el.hidden = footnote;
    for (const [id, b] of this.buttons) {
      const cmd = this.commandFor(id);
      const enabled = id === 'link' ? true : !!cmd && cmd(state);
      b.disabled = !enabled;
      b.setAttribute('aria-pressed', String(enabled && this.pressed(id, state)));
    }
    // Keep one tab stop on an enabled, visible button.
    const items = this.focusables();
    if (!items.some((el) => el.tabIndex === 0) && items[0]) this.rove(items[0], false);
  }

  private place(v: EditorView, range: { from: number; to: number }): void {
    const host = this.dom.offsetParent ?? this.dom.parentElement;
    if (!host) return;
    let rect: { top: number; bottom: number; left: number; right: number };
    try {
      const a = v.coordsAtPos(range.from, 1);
      const b = v.coordsAtPos(range.to, -1);
      if (Math.abs(a.top - b.top) < 4) {
        rect = {
          top: Math.min(a.top, b.top),
          bottom: Math.max(a.bottom, b.bottom),
          left: a.left,
          right: b.right,
        };
      } else {
        const box = v.dom.getBoundingClientRect();
        rect = { top: a.top, bottom: a.bottom, left: a.left, right: Math.max(a.left, box.right) };
      }
    } catch {
      return; // no layout (tests) or a stale position
    }
    const hostRect = host.getBoundingClientRect();
    const width = this.dom.offsetWidth;
    const height = this.dom.offsetHeight;
    const gap = 8;
    const center = (rect.left + rect.right) / 2;
    let left = center - hostRect.left - width / 2;
    left = Math.max(4, Math.min(left, hostRect.width - width - 4));
    let top = rect.top - hostRect.top - height - gap;
    const below = rect.top - height - gap < 0;
    if (below) top = rect.bottom - hostRect.top + gap;
    this.dom.style.left = `${Math.round(left)}px`;
    this.dom.style.top = `${Math.round(top)}px`;
    this.dom.dataset.below = below ? 'true' : 'false';
    this.dom.style.setProperty(
      '--lh-bubble-arrow',
      `${Math.round(Math.max(12, Math.min(width - 12, center - hostRect.left - left)))}px`,
    );
  }
}
