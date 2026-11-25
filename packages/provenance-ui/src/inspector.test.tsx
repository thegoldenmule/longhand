import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectSpan } from './inspector';
import { ProvenanceInspector, SpanInspector } from './react/SpanInspector';
import { fixture, mountEditor } from './test/helpers';
import { createProvenanceTint } from './tint';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

function at(name: string, documentId: string, pos: number) {
  const m = inspectSpan(fixture(name).state, documentId, pos);
  if (!m) throw new Error(`no history at ${name}/${documentId}@${pos}`);
  return m;
}

describe('inspectSpan: suggestions', () => {
  it('typed text before any suggestion', () => {
    const m = at('suggestions', 'doc-s', 2);
    expect(m).toMatchObject({
      class: 'typed',
      action: 'Typed',
      origin: { seq: 3, type: 'TextEdited', clientTime: '2026-11-02T09:00:00.800Z' },
      methods: ['typed'],
      methodText: 'typed on the keyboard',
      matched: null,
      visibleSuggestions: [],
      moves: [],
      pastes: [],
    });
    expect(m.session).toMatchObject({ number: 1, total: 1, startSeq: 3, endSeq: 33 });
  });

  it('a word-choice suggestion retyped (adopted)', () => {
    const m = at('suggestions', 'doc-s', 23);
    expect(m.class).toBe('typed-from-suggestion');
    expect(m.origin.seq).toBe(22);
    expect(m.matched).toMatchObject({
      id: 'sug-adopt',
      kind: 'suggestion',
      kindLabel: 'a wording suggestion',
      group: 'suggestions',
      status: 'adopted',
    });
    expect(m.spanText).toBe(
      fixture('suggestions').fixture.expected.documents['doc-s']!.text.slice(21, 30),
    );
    // Every suggestion open in the document when seq 22 was typed.
    const visible = m.visibleSuggestions.map((s) => s.id);
    expect(visible).toContain('sug-adopt');
    expect(visible).not.toContain('sug-stale-never');
    expect(m.visibleSuggestions.every((s) => s.seq < 22)).toBe(true);
  });

  it('an insertion suggestion and a four-word match from a comment', () => {
    expect(at('suggestions', 'doc-s', 66).matched).toMatchObject({
      id: 'sug-insert',
      kind: 'insertion',
      group: 'suggestions',
    });
    const c = at('suggestions', 'doc-s', 205);
    expect(c.matched).toMatchObject({ id: 'com-s', kind: 'comment', group: 'comments' });
    const body = fixture('suggestions').fixture.expected.state.annotations.comments['com-s']!.body;
    expect(body.startsWith(c.matched!.text!.replace(/…$/, ''))).toBe(true);
  });
});

describe('inspectSpan: internal-paste', () => {
  it('an external paste, with its size', () => {
    const m = at('internal-paste', 'doc-a', 25);
    expect(m.class).toBe('pasted-external');
    expect(m.action).toBe('Pasted');
    expect(m.pastes).toEqual([
      expect.objectContaining({ id: 'paste-0005', origin: 'external', characters: 24, words: 4 }),
    ]);
    expect(m.note).toBeNull();
  });

  it('typed text copied and pasted keeps its class and records the paste', () => {
    const m = at('internal-paste', 'doc-a', 50);
    expect(m.class).toBe('typed');
    expect(m.origin.seq).toBe(4);
    expect(m.moves).toEqual([
      expect.objectContaining({
        seq: 19,
        kind: 'paste',
        label: 'Copied and pasted within the project',
        paste: expect.objectContaining({ id: 'paste-0024', characters: 14, words: 2 }),
      }),
    ]);
  });

  it('pasted text pasted again keeps its paste size from the original paste', () => {
    const m = at('internal-paste', 'doc-b', 58);
    expect(m.class).toBe('pasted-external');
    expect(m.pastes[0]).toMatchObject({ id: 'paste-0005', characters: 24 });
    expect(m.moves[0]).toMatchObject({ seq: 14, kind: 'paste' });
  });

  it('a drag and drop', () => {
    expect(at('internal-paste', 'doc-b', 84).moves).toEqual([
      expect.objectContaining({
        seq: 28,
        kind: 'drop',
        label: 'Dragged and dropped within the document',
      }),
    ]);
  });

  it('an internal paste that could not be verified is explained', () => {
    const m = at('internal-paste', 'doc-b', 79);
    expect(m.class).toBe('pasted-external');
    expect(m.methods).toEqual(['pasted-internal']);
    expect(m.note).toMatch(/could not be verified/);
    expect(m.pastes).toEqual([
      expect.objectContaining({ id: 'paste-0036', origin: 'internal', verifiedInternal: false }),
    ]);
  });
});

describe('inspectSpan: proposals', () => {
  it('a sentence moved by an accepted proposal', () => {
    const m = at('proposals', 'doc-p', 12);
    expect(m.moves).toEqual([
      expect.objectContaining({
        seq: 18,
        kind: 'move',
        proposal: { id: 'mv-sentence', kind: 'move', unit: 'sentence' },
        label: 'Moved by accepting a proposal (move sentence)',
      }),
    ]);
  });

  it('a paragraph move', () => {
    expect(at('proposals', 'doc-p', 100).moves[0]).toMatchObject({
      seq: 23,
      proposal: { id: 'mv-paragraph', unit: 'paragraph' },
    });
  });

  it('the joining space of an accepted proposal', () => {
    const m = at('proposals', 'doc-p', 38);
    expect(m.origin.type).toBe('ProposalAccepted');
    expect(m.action).toBe('Added when a proposal was accepted');
    expect(m.note).toMatch(/joining space/);
  });
});

describe('inspectSpan: research', () => {
  const sources = () => fixture('research').fixture.expected.state.sources;

  it('a citation is quoted and names its source', () => {
    const m = at('research', 'doc-r', 53);
    expect(m.class).toBe('quoted');
    expect(m.action).toBe('Cited');
    expect(m.source?.id).toBeTruthy();
    expect(m.source?.title).toBe(sources()[m.source!.id]!.csl.title ?? null);
  });

  it('a placed clipping is quoted from its source', () => {
    const m = at('research', 'doc-r', 102);
    expect(m.class).toBe('quoted');
    expect(m.methods).toEqual(['clipping']);
    expect(m.source).not.toBeNull();
  });

  it('a clipping that did not match is pasted, and says why', () => {
    const m = at('research', 'doc-r', 235);
    expect(m.class).toBe('pasted-external');
    expect(m.note).toMatch(/did not match the saved clipping/);
  });
});

describe('<SpanInspector>', () => {
  it('shows when, session, input, AI text and moves', () => {
    const m = at('suggestions', 'doc-s', 205);
    render(<SpanInspector model={m} rect={null} onClose={() => undefined} inline />);
    expect(screen.getByRole('dialog', { name: 'Typed from a suggestion' })).toBeTruthy();
    expect(screen.getByTestId('inspector-when').textContent).toBe('Typed2 Nov 2026, 09:01:08');
    expect(screen.getByTestId('inspector-session').textContent).toMatch(
      /^SessionWriting session 1 of 1 · 2 Nov 2026, 09:00–09:01 · \d+ s active$/,
    );
    expect(screen.getByTestId('inspector-input').textContent).toBe('InputTyped on the keyboard');
    expect(screen.getByTestId('inspector-suggestion').textContent).toMatch(
      /Matched a margin comment: /,
    );
    expect(screen.getByTestId('inspector-moves').textContent).toBe('MovesNot moved');
    expect(screen.getByTestId('inspector-ledger').textContent).toMatch(/Ledger seq 33/);
  });

  it('shows the paste size for pasted text', () => {
    render(
      <SpanInspector
        model={at('internal-paste', 'doc-a', 25)}
        rect={null}
        onClose={() => undefined}
        inline
      />,
    );
    expect(screen.getByTestId('inspector-paste').textContent).toBe(
      'Paste size24 characters, 4 words from outside the project',
    );
  });

  it('lists the suggestions that were showing', () => {
    render(
      <SpanInspector
        model={at('suggestions', 'doc-s', 23)}
        rect={null}
        onClose={() => undefined}
        inline
      />,
    );
    const visible = screen.getByTestId('inspector-visible');
    expect(visible.textContent).toMatch(/suggestions were open when it was typed/);
    expect(visible.querySelector('[data-matched="true"]')?.textContent).toMatch(/word choice/);
  });

  it('closes on Escape', () => {
    let closed = 0;
    render(
      <SpanInspector
        model={at('proposals', 'doc-p', 12)}
        rect={null}
        onClose={() => closed++}
        inline
      />,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(closed).toBe(1);
  });
});

describe('<ProvenanceInspector>', () => {
  function setup(name: string, documentId: string) {
    const { fixture: f, state } = fixture(name);
    const doc = f.expected.state.documents[documentId]!;
    const tint = createProvenanceTint({ enabled: true });
    const ed = mountEditor(doc, tint.plugins);
    tint.attach(ed.handle);
    tint.setRuns(doc.provenance, doc.version);
    render(<ProvenanceInspector tint={tint} state={state} documentId={documentId} />);
    return { tint, ed, view: ed.handle.view };
  }

  it('opens from the keyboard, takes focus, and gives it back on Escape', () => {
    const { ed, view } = setup('suggestions', 'doc-s');
    ed.at(205);
    view.focus();
    act(() => {
      view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }),
      );
    });
    const dialog = screen.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    expect(dialog.textContent).toMatch(/margin comment/);
    // The inspected span is outlined in the editor.
    expect(view.dom.querySelector('.lh-prov-inspected')?.textContent).toBe(
      view.state.doc.textBetween(204, 229),
    );
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(view.dom.querySelector('.lh-prov-inspected')).toBeNull();
    expect(view.hasFocus() || document.activeElement === view.dom).toBe(true);
    ed.destroy();
  });

  it('opens on click without taking focus from the editor', () => {
    const { ed, view } = setup('proposals', 'doc-p');
    act(() => {
      view.someProp('handleClick', (f) => f(view, 13, new MouseEvent('click', { button: 0 })));
    });
    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toMatch(/Moved by accepting a proposal \(move sentence\)/);
    expect(document.activeElement).not.toBe(dialog);
    // Escape in the editor closes it.
    act(() => {
      view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    ed.destroy();
  });

  it('says when the text is not in the ledger yet', () => {
    const { ed, tint } = setup('suggestions', 'doc-s');
    ed.at(1);
    ed.typeText('New ');
    act(() => {
      tint.inspectAt(2);
    });
    expect(screen.getByRole('dialog', { name: 'Not in the ledger yet' })).toBeTruthy();
    ed.destroy();
  });

  it('closes when the tint is turned off', () => {
    const { ed, tint } = setup('research', 'doc-r');
    act(() => {
      tint.inspectAt(60);
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    act(() => tint.setEnabled(false));
    expect(screen.queryByRole('dialog')).toBeNull();
    ed.destroy();
  });
});
