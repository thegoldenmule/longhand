import { schema } from '@longhand/schema';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { Transform } from 'prosemirror-transform';
import { afterEach, describe, expect, it } from 'vitest';
import { createEditorView, type CreateEditorOptions, type EditorHandle } from './core';
import { createDecorationLayer } from './decorations';
import type { GuardViolation } from './input/guard';
import { MockTransport } from './sync/mockTransport';
import { MemoryQueue } from './sync/queue';
import { beforeInput, clipboardEvent, docJSON, expectValidDraft, FakeDataTransfer, settle } from './test/helpers';

const handles: EditorHandle[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.destroy();
  document.body.innerHTML = '';
});

function make(over: Partial<CreateEditorOptions> = {}, text = 'Hello world. Second sentence.') {
  const transport = new MockTransport({ documents: { doc1: { doc: docJSON(text) } } });
  const violations: GuardViolation[] = [];
  const mount = document.body.appendChild(document.createElement('div'));
  const handle = createEditorView({
    mount,
    projectId: 'proj',
    documentId: 'doc1',
    actorId: 'user1',
    deviceId: 'dev1',
    sessionId: 'sess1',
    doc: docJSON(text),
    version: 0,
    transport,
    queue: new MemoryQueue('proj'),
    batch: { idleMs: 20 },
    trustSyntheticEvents: true,
    inputPolicy: 'refuse',
    onViolation: (v) => violations.push(v),
    ...over,
  });
  handles.push(handle);
  const view = handle.view;
  const text_ = (): string => view.state.doc.textBetween(0, view.state.doc.content.size, '\n');
  const at = (pos: number): void => view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
  /** Simulates the browser delivering typed text: beforeinput, then ProseMirror's text input path. */
  const typeText = (t: string): void => {
    for (const ch of t) {
      view.dom.dispatchEvent(beforeInput('insertText', ch));
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
      if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
    }
  };
  return { handle, view, transport, violations, text: text_, at, typeText };
}

async function committed(handle: EditorHandle): Promise<void> {
  handle.flush();
  await settle(10);
}

describe('createEditorView: input guard', () => {
  it('refuses doc changes no input event explains', async () => {
    const { view, text, violations, transport, handle } = make();
    view.dispatch(view.state.tr.insertText('AI words ', 1));
    expect(text()).toBe('Hello world. Second sentence.');
    expect(violations).toHaveLength(1);
    await committed(handle);
    expect(transport.log).toHaveLength(0);
  });

  it('accepts typed input and commits it as typed', async () => {
    const { handle, text, typeText, at, transport } = make();
    at(1);
    typeText('Oh ');
    expect(text()).toBe('Oh Hello world. Second sentence.');
    await committed(handle);
    const te = transport.commits('TextEdited')[0]!;
    expectValidDraft(te);
    expect(te.payload.runs).toEqual([{ steps: 3, method: 'typed' }]);
    expect(te.payload.timeline.map((k) => [k.kind, k.len])).toEqual([
      ['insert', 1],
      ['insert', 1],
      ['insert', 1],
    ]);
  });

  it('refuses text appended by another plugin on a keystroke', () => {
    const sneaky = new Plugin({
      appendTransaction: (trs, _old, state) =>
        trs.some((t) => t.docChanged) && !state.doc.textContent.includes('[ai]') ? state.tr.insertText('[ai]', 1) : null,
    });
    const { typeText, at, text, violations } = make({ extraPlugins: [sneaky] });
    at(1);
    typeText('x');
    expect(text()).toBe('xHello world. Second sentence.');
    expect(violations.some((v) => !v.flagged)).toBe(true);
  });

  it('reverts a document swapped in with updateState', async () => {
    const { view, text, violations } = make();
    const forged = new Transform(view.state.doc).insert(1, schema.text('forged ')).doc;
    view.updateState(EditorState.create({ doc: forged, plugins: view.state.plugins }));
    await settle();
    expect(text()).toBe('Hello world. Second sentence.');
    expect(violations.map((v) => v.reason)).toContain('document replaced outside the transaction pipeline');
  });
});

describe('createEditorView: clipboard', () => {
  it('classifies an internal copy/paste as pasted-internal with a SliceCopied → PasteOccurred chain', async () => {
    const { handle, view, transport, text } = make();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    const data = new FakeDataTransfer();
    view.dom.dispatchEvent(clipboardEvent('copy', data));
    expect(data.types).toContain('application/x-longhand-slice');
    expect(data.getData('text/html')).toContain('data-longhand-slice');
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 30)));
    view.dom.dispatchEvent(clipboardEvent('paste', data));
    expect(text()).toBe('Hello world. Second sentence.Hello');
    await committed(handle);
    const types = transport.commits().map((c) => c.type);
    expect(types).toEqual(['SliceCopied', 'PasteOccurred', 'TextEdited']);
    const copy = transport.commits('SliceCopied')[0]!;
    const paste = transport.commits('PasteOccurred')[0]!;
    const te = transport.commits('TextEdited')[0]!;
    for (const d of [copy, paste, te]) expectValidDraft(d);
    expect(paste.payload).toMatchObject({ origin: 'internal', via: 'clipboard', copyId: copy.payload.copyId, characters: 5, words: 1 });
    expect(paste.payload.textHash).toBe(copy.payload.textHash);
    expect(te.payload.runs).toEqual([{ steps: 1, method: 'pasted-internal', pasteId: paste.payload.pasteId }]);
  });

  it('classifies a foreign paste as pasted-external', async () => {
    const { handle, view, transport } = make();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1)));
    const data = new FakeDataTransfer();
    data.setData('text/plain', 'Borrowed words ');
    view.dom.dispatchEvent(clipboardEvent('paste', data));
    await committed(handle);
    const paste = transport.commits('PasteOccurred')[0]!;
    expect(paste.payload).toMatchObject({ origin: 'external', copyId: null, characters: 15, words: 2, mimeTypes: ['text/plain'] });
    expect(transport.commits('TextEdited')[0]!.payload.runs[0]).toMatchObject({ method: 'pasted-external' });
  });

  it('refuses programmatic pastes', () => {
    const { view, text } = make();
    view.pasteText('injected', new Event('paste') as ClipboardEvent);
    expect(text()).toBe('Hello world. Second sentence.');
  });

  it('records a cut as SliceCopied (cut) then a typed cut deletion', async () => {
    const { handle, view, transport, text } = make();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 6, 12)));
    view.dom.dispatchEvent(clipboardEvent('cut', new FakeDataTransfer()));
    expect(text()).toBe('Hello. Second sentence.');
    await committed(handle);
    expect(transport.commits().map((c) => c.type)).toEqual(['SliceCopied', 'TextEdited']);
    expect(transport.commits('SliceCopied')[0]!.payload).toMatchObject({ cut: true, from: 6, to: 12, version: 0 });
    expect(transport.commits('TextEdited')[0]!.payload.timeline[0]).toMatchObject({ kind: 'cut', len: 6 });
  });
});

describe('createEditorView: formatting input rules', () => {
  it('turns "# " into a heading and "> " into a quote', () => {
    const { view, typeText, at } = make({}, '');
    at(1);
    typeText('## Title');
    expect(view.state.doc.firstChild?.type.name).toBe('heading');
    expect(view.state.doc.firstChild?.attrs.level).toBe(2);
    expect(view.state.doc.firstChild?.textContent).toBe('Title');
  });

  it('applies **strong** and *em* marks without inserting text', () => {
    const { view, typeText, at, violations } = make({}, '');
    at(1);
    typeText('a **bold** and *soft*');
    const para = view.state.doc.firstChild!;
    expect(para.textContent).toBe('a bold and soft');
    const marksOf = (word: string): string[] => {
      let found: string[] = [];
      para.forEach((n) => {
        if (n.text === word) found = n.marks.map((m) => m.type.name);
      });
      return found;
    };
    expect(marksOf('bold')).toEqual(['strong']);
    expect(marksOf('soft')).toEqual(['em']);
    expect(violations).toHaveLength(0);
  });

  it('turns *** into a scene break, "- " into a list and ^[ into a footnote', () => {
    const { view, typeText, at } = make({}, '');
    at(1);
    typeText('***');
    expect(view.state.doc.child(0).type.name).toBe('scene_break');
    typeText('- item');
    expect(view.state.doc.child(1).type.name).toBe('bullet_list');
    typeText(' note^[');
    let footnotes = 0;
    view.state.doc.descendants((n) => {
      if (n.type.name === 'footnote') footnotes++;
    });
    expect(footnotes).toBe(1);
  });

  it('formats with keyboard shortcuts', () => {
    const { view, at } = make();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 1, 6)));
    const key = (k: string, mods: KeyboardEventInit = {}): void => {
      view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods }));
    };
    key('b', /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true });
    const first = view.state.doc.firstChild!.firstChild!;
    expect(first.text).toBe('Hello');
    expect(first.marks.map((m) => m.type.name)).toEqual(['strong']);
    at(3);
    key('Enter');
    expect(view.state.doc.childCount).toBe(2);
  });
});

describe('createEditorView: commands for other lanes', () => {
  it('inserts a citation with its CitationInserted companion, only after a user gesture', async () => {
    const { handle, view, transport } = make();
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 13)));
    expect(handle.insertCitation({ sourceId: 'src1', locator: 'p. 3' })).toBeNull();
    document.dispatchEvent(new Event('pointerdown'));
    const id = handle.insertCitation({ sourceId: 'src1', locator: 'p. 3' });
    expect(id).toBeTruthy();
    await committed(handle);
    expect(transport.commits().map((c) => c.type)).toEqual(['CitationInserted', 'TextEdited']);
    expect(transport.commits('TextEdited')[0]!.payload.runs).toEqual([{ steps: 1, method: 'citation', citationId: id }]);
  });

  it('accepts transactions declared through the research meta alias', async () => {
    const { handle, view, transport } = make();
    document.dispatchEvent(new Event('click'));
    const tr = view.state.tr.insert(13, schema.nodes.citation!.create({ sourceId: 's9', locator: null }));
    tr.setMeta('longhand/research-input', {
      run: { steps: 1, method: 'citation', citationId: 'cit-r' },
      companions: [{ type: 'CitationInserted', payload: { citationId: 'cit-r', documentId: 'doc1', sourceId: 's9', locator: null } }],
      characters: 0,
      keystroke: { kind: 'paste', len: 0 },
    });
    view.dispatch(tr);
    await committed(handle);
    expect(transport.commits().map((c) => c.type)).toEqual(['CitationInserted', 'TextEdited']);
  });

  it('places a clipping as a quote block', async () => {
    const { handle, transport, view } = make();
    document.dispatchEvent(new Event('pointerdown'));
    expect(handle.insertClipping({ clippingId: 'clip1', sourceId: 'src1', text: 'Line one\nLine two' })).toBe(true);
    expect(view.state.doc.child(1).type.name).toBe('quote_block');
    await committed(handle);
    const te = transport.commits('TextEdited')[0]!;
    expect(te.payload.runs).toEqual([{ steps: 1, method: 'clipping', clippingId: 'clip1' }]);
    expect(te.payload.characters).toBe(16);
  });

  it('adds traceSuggestionId to typed runs while tracing', async () => {
    const { handle, typeText, at, transport } = make();
    handle.setTraceSuggestion('sug-1');
    at(1);
    typeText('ab');
    handle.setTraceSuggestion(null);
    typeText('c');
    await committed(handle);
    expect(transport.commits('TextEdited')[0]!.payload.runs).toEqual([
      { steps: 2, method: 'typed', traceSuggestionId: 'sug-1' },
      { steps: 1, method: 'typed' },
    ]);
  });
});

describe('createEditorView: UI state', () => {
  it('marks the current sentence in focus mode', () => {
    const { handle, view, at } = make();
    handle.setSettings({ focusMode: 'sentence' });
    at(16);
    expect(view.dom.getAttribute('data-focus')).toBe('sentence');
    expect(view.dom.querySelector('.lh-focus-current')?.textContent).toBe('Second sentence.');
    handle.setSettings({ focusMode: 'paragraph' });
    expect(view.dom.querySelector('p.lh-focus-current')).not.toBeNull();
    handle.setSettings({ focusMode: 'off' });
    expect(view.dom.hasAttribute('data-focus')).toBe(false);
  });

  it('reports word counts', async () => {
    const counts: number[] = [];
    const { typeText, at } = make({ onWordCount: (c) => counts.push(c.document) });
    at(1);
    typeText('New ');
    await new Promise((r) => setTimeout(r, 100));
    expect(counts.at(-1)).toBe(5);
  });

  it('maps decoration layers from a ledger version onto the local doc', () => {
    const layer = createDecorationLayer('test');
    const { handle, typeText, at, view } = make({ extraPlugins: [layer.plugin] });
    at(1);
    typeText('Oh ');
    expect(handle.setDecorations(layer, [{ kind: 'inline', from: 1, to: 6, attrs: { class: 'tint' } }], 0)).toBe(true);
    expect(view.dom.querySelector('.tint')?.textContent).toBe('Hello');
    expect(handle.setDecorations(layer, [], 99)).toBe(false);
  });

  it('clamps the caret ratio', () => {
    const { handle } = make();
    handle.setSettings({ caretRatio: 0.9 });
    expect(handle.settings().caretRatio).toBe(0.6);
    handle.setSettings({ caretRatio: 0.1 });
    expect(handle.settings().caretRatio).toBe(0.33);
  });
});
