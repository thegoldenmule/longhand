import type { PMNodeJSON } from '@longhand/schema';
import { NodeSelection, TextSelection } from 'prosemirror-state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEditorView, type CreateEditorOptions, type EditorHandle } from './core';
import type { GuardViolation } from './input/guard';
import { MockTransport } from './sync/mockTransport';
import { MemoryQueue } from './sync/queue';
import {
  beforeInput,
  clipboardEvent,
  docJSON,
  expectValidDraft,
  FakeDataTransfer,
  settle,
} from './test/helpers';
import { footnoteEditorOf } from './ui/bubbleState';

const handles: EditorHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.destroy();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const WORDY = 'https://example.com/these-are-many-words-in-an-href';

function linked(text: string, href: string, before = '', after = ''): PMNodeJSON {
  const content: PMNodeJSON[] = [];
  if (before) content.push({ type: 'text', text: before });
  content.push({ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] });
  if (after) content.push({ type: 'text', text: after });
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

function make(over: Partial<CreateEditorOptions> = {}, doc: PMNodeJSON | string = 'Hello world.') {
  const json = typeof doc === 'string' ? docJSON(doc) : doc;
  const transport = new MockTransport({ documents: { doc1: { doc: json } } });
  const violations: GuardViolation[] = [];
  const mount = document.body.appendChild(document.createElement('div'));
  const handle = createEditorView({
    mount,
    projectId: 'proj',
    documentId: 'doc1',
    actorId: 'user1',
    deviceId: 'dev1',
    sessionId: 'sess1',
    doc: json,
    version: 0,
    transport,
    queue: new MemoryQueue('proj'),
    batch: { idleMs: 20 },
    trustSyntheticEvents: true,
    inputPolicy: 'refuse',
    // jsdom cannot focus a bare contenteditable; a tabindex makes it focusable.
    attributes: { tabindex: '0' },
    onViolation: (v) => violations.push(v),
    ...over,
  });
  handles.push(handle);
  const view = handle.view;
  const text = (): string => view.state.doc.textBetween(0, view.state.doc.content.size, '\n');
  const select = (from: number, to = from): void =>
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  const typeText = (t: string): void => {
    for (const ch of t) {
      view.dom.dispatchEvent(beforeInput('insertText', ch));
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (f) =>
        f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  };
  const key = (k: string, mods: KeyboardEventInit = {}, target: EventTarget = view.dom): void => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }),
    );
  };
  const bubble = (): HTMLElement =>
    view.dom.parentElement!.querySelector('[data-testid="bubble-toolbar"]') as HTMLElement;
  const button = (label: string): HTMLButtonElement =>
    bubble().querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;
  const press = (el: HTMLElement): void => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const marksOf = (word: string): string[] => {
    let found: string[] = [];
    view.state.doc.descendants((n) => {
      if (n.isText && n.text === word)
        found = n.marks.map((m) =>
          m.type.name === 'link' ? `link:${m.attrs.href as string}` : m.type.name,
        );
    });
    return found;
  };
  const committed = async (): Promise<void> => {
    handle.flush();
    await settle(10);
  };
  return {
    handle,
    view,
    transport,
    violations,
    text,
    select,
    typeText,
    key,
    bubble,
    button,
    press,
    marksOf,
    committed,
  };
}

const CTRL = { ctrlKey: true };

describe('link and code input rules', () => {
  it('turns `code` into inline code without inserting text', async () => {
    const e = make({}, '');
    e.select(1);
    e.typeText('run `make book` now');
    expect(e.text()).toBe('run make book now');
    expect(e.marksOf('make book')).toEqual(['code']);
    expect(e.violations).toEqual([]);
    await e.committed();
    const te = e.transport.commits('TextEdited')[0]!;
    expectValidDraft(te);
    expect(te.payload.runs.every((r) => r.method === 'typed')).toBe(true);
    expect(te.payload.timeline.some((k) => k.kind === 'format')).toBe(true);
  });

  it('turns [text](url) into a link when the url is allowed, normalizing it', () => {
    const e = make({}, '');
    e.select(1);
    e.typeText('see [the site](example.com) today');
    expect(e.text()).toBe('see the site today');
    expect(e.marksOf('the site')).toEqual(['link:https://example.com']);
    expect(e.handle.wordCounts().document).toBe(4);
    expect(e.violations).toEqual([]);
  });

  it('leaves [text](javascript:…) as typed text', () => {
    const e = make({}, '');
    e.select(1);
    e.typeText('[x](javascript:void)');
    expect(e.text()).toBe('[x](javascript:void)');
    let links = 0;
    e.view.state.doc.descendants((n) => {
      if (n.marks.some((m) => m.type.name === 'link')) links++;
    });
    expect(links).toBe(0);
  });

  it('never runs mark rules inside inline code', () => {
    const doc: PMNodeJSON = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'ab', marks: [{ type: 'code' }] }],
        },
      ],
    };
    const e = make({}, doc);
    e.select(2);
    e.typeText('**x**');
    expect(e.text()).toBe('a**x**b');
    expect(e.marksOf('a**x**b')).toEqual(['code']);
  });

  it('does not extend a link when typing at its end', () => {
    const e = make({}, linked('here', 'https://example.com', 'Go '));
    e.select(8);
    e.typeText('!');
    expect(e.text()).toBe('Go here!');
    expect(e.marksOf('here')).toEqual(['link:https://example.com']);
    expect(e.marksOf('!')).toEqual([]);
  });

  it('toggles inline code with Mod-E, and code excludes bold', () => {
    const e = make();
    e.select(1, 6);
    e.key('e', CTRL);
    expect(e.marksOf('Hello')).toEqual(['code']);
    e.key('b', CTRL);
    expect(e.marksOf('Hello')).toEqual(['code']);
  });
});

describe('pasting a URL over a selection', () => {
  it('links the selection: no text added, no PasteOccurred, formatting only', async () => {
    const e = make();
    e.select(1, 6);
    const data = new FakeDataTransfer();
    data.setData('text/plain', ' https://example.com/a ');
    e.view.dom.dispatchEvent(clipboardEvent('paste', data));
    expect(e.text()).toBe('Hello world.');
    expect(e.marksOf('Hello')).toEqual(['link:https://example.com/a']);
    expect(e.handle.wordCounts().document).toBe(2);
    await e.committed();
    expect(e.transport.commits().map((c) => c.type)).toEqual(['TextEdited']);
    const te = e.transport.commits('TextEdited')[0]!;
    expectValidDraft(te);
    expect(te.payload.runs).toEqual([{ steps: 1, method: 'typed' }]);
    expect(te.payload.characters).toBe(0);
    expect(te.payload.timeline.map((k) => [k.kind, k.len])).toEqual([['format', 0]]);
  });

  it('pastes normally when the selection is empty or the text is not plainly a link', async () => {
    const e = make();
    e.select(1, 6);
    const evil = new FakeDataTransfer();
    evil.setData('text/plain', 'javascript:alert(1)');
    e.view.dom.dispatchEvent(clipboardEvent('paste', evil));
    expect(e.text()).toBe('javascript:alert(1) world.');
    expect(e.marksOf('javascript:alert(1)')).toEqual([]);
    e.select(1);
    const url = new FakeDataTransfer();
    url.setData('text/plain', 'https://example.com ');
    e.view.dom.dispatchEvent(clipboardEvent('paste', url));
    expect(e.text()).toBe('https://example.com javascript:alert(1) world.');
    await e.committed();
    expect(e.transport.commits('PasteOccurred')).toHaveLength(2);
  });

  it('keeps allowed links from pasted HTML and drops the rest', () => {
    const e = make({}, '');
    e.select(1);
    const data = new FakeDataTransfer();
    data.setData(
      'text/html',
      '<p><a href="example.com">safe</a> <a href="javascript:alert(1)">evil</a> <code>x</code></p>',
    );
    data.setData('text/plain', 'safe evil x');
    e.view.dom.dispatchEvent(clipboardEvent('paste', data));
    expect(e.text()).toBe('safe evil x');
    expect(e.marksOf('safe')).toEqual(['link:https://example.com']);
    expect(e.marksOf(' evil ')).toEqual([]);
    expect(e.marksOf('x')).toEqual(['code']);
  });

  it('keeps an internal copy and paste of linked text pasted-internal', async () => {
    const e = make({}, linked('here', 'https://example.com', 'Go ', '.'));
    e.select(4, 8);
    const data = new FakeDataTransfer();
    e.view.dom.dispatchEvent(clipboardEvent('copy', data));
    e.select(9);
    e.view.dom.dispatchEvent(clipboardEvent('paste', data));
    expect(e.text()).toBe('Go here.here');
    await e.committed();
    const te = e.transport.commits('TextEdited')[0]!;
    expect(te.payload.runs[0]).toMatchObject({ method: 'pasted-internal' });
  });
});

describe('links in the editor', () => {
  it('render with rel="noopener noreferrer" and never navigate on a click', () => {
    const open = vi.fn();
    vi.spyOn(window, 'open').mockImplementation(open);
    const e = make({}, linked('here', 'https://example.com/x', 'Go '));
    const a = e.view.dom.querySelector('a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://example.com/x');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    const plain = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
    const mod = new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true });
    a.dispatchEvent(mod);
    expect(mod.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer');
    const ctrl = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    a.dispatchEvent(ctrl);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('never counts the href as words', () => {
    const e = make({}, linked('here', WORDY, 'Go '));
    expect(e.handle.wordCounts().document).toBe(2);
  });
});

describe('the bubble toolbar', () => {
  it('shows above a non-empty selection while the editor has focus, never for a caret', () => {
    const e = make();
    e.handle.focus();
    e.select(3);
    expect(e.bubble().hidden).toBe(true);
    e.select(1, 6);
    expect(e.bubble().hidden).toBe(false);
    const bar = e.bubble().querySelector('[role="toolbar"]')!;
    expect(bar.getAttribute('aria-label')).toBe('Formatting');
    expect(
      Array.from(bar.querySelectorAll('button')).map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Bold', 'Italic', 'Link', 'Heading', 'Subheading', 'Quote', 'Code']);
    // It never takes focus by itself.
    expect(document.activeElement).toBe(e.view.dom);
    e.select(12);
    expect(e.bubble().hidden).toBe(true);
  });

  it('hides when the editor loses focus, is read-only or a dialog is open', async () => {
    const e = make();
    e.handle.focus();
    e.select(1, 6);
    expect(e.bubble().hidden).toBe(false);
    const dialog = document.body.appendChild(document.createElement('div'));
    dialog.setAttribute('role', 'dialog');
    await settle();
    expect(e.bubble().hidden).toBe(true);
    dialog.remove();
    await settle();
    expect(e.bubble().hidden).toBe(false);
    e.handle.setEditable(false);
    e.select(1, 7);
    expect(e.bubble().hidden).toBe(true);
    e.handle.setEditable(true);
    e.select(1, 6);
    expect(e.bubble().hidden).toBe(false);
    (document.activeElement as HTMLElement).blur();
    await settle();
    expect(e.bubble().hidden).toBe(true);
  });

  it('honours a host suppress callback and can be turned off', () => {
    let suppressed = true;
    const e = make({ bubble: { suppress: () => suppressed } });
    e.handle.focus();
    e.select(1, 6);
    expect(e.bubble().hidden).toBe(true);
    suppressed = false;
    e.select(1, 7);
    expect(e.bubble().hidden).toBe(false);
    const off = make({ bubble: false });
    expect(off.bubble()).toBeNull();
  });

  it('applies marks and blocks as formatting, with pressed states', async () => {
    const e = make({}, 'Hello world.');
    e.handle.focus();
    e.select(1, 6);
    const bold = e.button('Bold');
    expect(bold.getAttribute('aria-pressed')).toBe('false');
    e.press(bold);
    expect(e.marksOf('Hello')).toEqual(['strong']);
    expect(e.button('Bold').getAttribute('aria-pressed')).toBe('true');
    e.press(e.button('Italic'));
    expect(e.marksOf('Hello')).toEqual(['em', 'strong']);
    e.press(e.button('Code'));
    expect(e.marksOf('Hello')).toEqual(['code']);
    expect(e.button('Code').getAttribute('aria-pressed')).toBe('true');
    expect(e.button('Bold').getAttribute('aria-pressed')).toBe('false');
    e.press(e.button('Heading'));
    expect(e.view.state.doc.firstChild!.type.name).toBe('heading');
    expect(e.view.state.doc.firstChild!.attrs.level).toBe(1);
    expect(e.button('Heading').getAttribute('aria-pressed')).toBe('true');
    e.press(e.button('Subheading'));
    expect(e.view.state.doc.firstChild!.attrs.level).toBe(2);
    e.press(e.button('Subheading'));
    expect(e.view.state.doc.firstChild!.type.name).toBe('paragraph');
    e.press(e.button('Quote'));
    expect(e.view.state.doc.firstChild!.type.name).toBe('blockquote');
    expect(e.button('Quote').getAttribute('aria-pressed')).toBe('true');
    e.press(e.button('Quote'));
    expect(e.view.state.doc.firstChild!.type.name).toBe('paragraph');
    expect(e.text()).toBe('Hello world.');
    expect(e.violations).toEqual([]);
    await e.committed();
    const edits = e.transport.commits('TextEdited');
    expect(edits.length).toBeGreaterThan(0);
    for (const te of edits) {
      expectValidDraft(te);
      expect(te.payload.characters).toBe(0);
      expect(te.payload.runs.every((r) => r.method === 'typed')).toBe(true);
      expect(te.payload.timeline.every((k) => k.kind === 'format' && k.len === 0)).toBe(true);
    }
  });

  it('edits links in an inline field: Enter applies, Esc cancels, bad hrefs are refused', () => {
    const e = make();
    e.handle.focus();
    e.select(1, 6);
    e.press(e.button('Link'));
    const input = e.bubble().querySelector('input') as HTMLInputElement;
    expect(e.bubble().dataset.mode).toBe('link');
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute('aria-label')).toBe('Link address');
    expect(e.view.dom.querySelector('.lh-link-pending')?.textContent).toBe('Hello');
    expect(input.value).toBe('');
    expect(e.bubble().querySelector<HTMLElement>('[aria-label="Remove link"]')!.hidden).toBe(true);
    input.value = 'javascript:alert(1)';
    e.key('Enter', {}, input);
    const error = e.bubble().querySelector('[role="alert"]') as HTMLElement;
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('Use an http, https or mailto link');
    expect(error.textContent).not.toContain(';');
    expect(e.marksOf('Hello')).toEqual([]);
    input.value = 'example.com/page';
    e.key('Enter', {}, input);
    expect(e.marksOf('Hello')).toEqual(['link:https://example.com/page']);
    expect(document.activeElement).toBe(e.view.dom);
    expect(e.bubble().dataset.mode).toBe('format');
    expect(e.button('Link').getAttribute('aria-pressed')).toBe('true');
    // Reopening pre-fills the field and offers Remove. Esc cancels.
    e.press(e.button('Link'));
    expect(input.value).toBe('https://example.com/page');
    input.value = 'https://other.example';
    e.key('Escape', {}, input);
    expect(e.marksOf('Hello')).toEqual(['link:https://example.com/page']);
    expect(document.activeElement).toBe(e.view.dom);
    e.press(e.button('Link'));
    const remove = e.bubble().querySelector('[aria-label="Remove link"]') as HTMLElement;
    expect(remove.hidden).toBe(false);
    e.press(remove);
    expect(e.marksOf('Hello')).toEqual([]);
    expect(e.violations).toEqual([]);
  });

  it('opens the link field with Mod-K, also from a caret inside a link', () => {
    const e = make({}, linked('here', 'https://example.com', 'Go ', ' now.'));
    e.handle.focus();
    e.select(2);
    e.key('k', CTRL);
    expect(e.bubble().hidden).toBe(true);
    e.select(5);
    e.key('k', CTRL);
    const input = e.bubble().querySelector('input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('https://example.com');
    input.value = 'mailto:ada@example.com';
    e.key('Enter', {}, input);
    expect(e.marksOf('here')).toEqual(['link:mailto:ada@example.com']);
  });

  it('shows the URL with Edit and Remove when the caret is in a link', () => {
    const e = make({}, linked('here', 'https://example.com/long/path', 'Go ', ' now.'));
    e.handle.focus();
    e.select(5);
    expect(e.bubble().hidden).toBe(false);
    expect(e.bubble().dataset.mode).toBe('view');
    const url = e.bubble().querySelector('.lh-bubble__url') as HTMLAnchorElement;
    expect(url.getAttribute('href')).toBe('https://example.com/long/path');
    expect(url.textContent).toBe('example.com/long/path');
    expect(url.rel).toBe('noopener noreferrer');
    expect(url.target).toBe('_blank');
    e.press(e.bubble().querySelector('[aria-label="Edit link"]') as HTMLElement);
    expect(e.bubble().dataset.mode).toBe('link');
    e.key('Escape', {}, e.bubble().querySelector('input')!);
    e.select(5);
    e.press(e.bubble().querySelector('[aria-label="Remove link"]:not([data-act="remove"])')!);
    expect(e.marksOf('here')).toEqual([]);
    expect(e.text()).toBe('Go here now.');
  });

  it('is keyboard reachable with Alt-F10, arrows move, Esc returns to the text', () => {
    const e = make();
    e.handle.focus();
    e.select(1, 6);
    e.key('F10', { altKey: true });
    expect(document.activeElement).toBe(e.button('Bold'));
    expect(e.button('Bold').tabIndex).toBe(0);
    e.key('ArrowRight', {}, document.activeElement!);
    expect(document.activeElement).toBe(e.button('Italic'));
    expect(e.button('Bold').tabIndex).toBe(-1);
    e.key('End', {}, document.activeElement!);
    expect(document.activeElement).toBe(e.button('Code'));
    e.key('ArrowRight', {}, document.activeElement!);
    expect(document.activeElement).toBe(e.button('Bold'));
    // Activating from the keyboard keeps focus in the toolbar.
    e.button('Bold').click();
    expect(e.marksOf('Hello')).toEqual(['strong']);
    expect(document.activeElement).toBe(e.button('Bold'));
    e.key('Escape', {}, document.activeElement!);
    expect(document.activeElement).toBe(e.view.dom);
    expect(e.view.state.selection.from).toBe(1);
    expect(e.view.state.selection.to).toBe(6);
    // Alt-F10 does nothing without a selection.
    e.select(3);
    e.key('F10', { altKey: true });
    expect(document.activeElement).toBe(e.view.dom);
  });

  it('shows only the mark buttons in a footnote editor, and they work there', async () => {
    const doc: PMNodeJSON = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Body' },
            { type: 'footnote', content: [{ type: 'text', text: 'A note here.' }] },
          ],
        },
      ],
    };
    // jsdom has no layout: give ranges empty rects so the footnote editor can scroll its selection.
    const proto = Range.prototype as unknown as Record<string, unknown>;
    if (!proto.getClientRects) {
      proto.getClientRects = () => [];
      proto.getBoundingClientRect = () => ({
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
        width: 0,
        height: 0,
      });
    }
    const e = make({}, doc);
    e.handle.focus();
    e.view.dispatch(e.view.state.tr.setSelection(NodeSelection.create(e.view.state.doc, 5)));
    const inner = footnoteEditorOf(e.view)!;
    expect(inner).toBeTruthy();
    inner.dom.setAttribute('tabindex', '0');
    inner.focus();
    inner.dispatch(inner.state.tr.setSelection(TextSelection.create(inner.state.doc, 2, 6)));
    expect(e.bubble().hidden).toBe(false);
    const visible = Array.from(e.bubble().querySelectorAll('button'))
      .filter((b) => !b.hidden && b.closest('[role="toolbar"]'))
      .map((b) => b.getAttribute('aria-label'));
    expect(visible).toEqual(['Bold', 'Italic', 'Link', 'Code']);
    document.dispatchEvent(new Event('pointerdown'));
    e.press(e.button('Italic'));
    let marked = '';
    e.view.state.doc.descendants((n) => {
      if (n.isText && n.marks.some((m) => m.type.name === 'em')) marked = n.text!;
    });
    expect(marked).toBe('note');
    expect(e.violations).toEqual([]);
    await e.committed();
    const te = e.transport.commits('TextEdited')[0]!;
    expect(te.payload.characters).toBe(0);
    expect(te.payload.runs.every((r) => r.method === 'typed')).toBe(true);
    delete proto.getClientRects;
    delete proto.getBoundingClientRect;
  });
});
