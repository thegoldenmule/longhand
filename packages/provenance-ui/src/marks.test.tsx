import { documentNode, foldCommits, LedgerBuilder } from '@longhand/ledger';
import { schema } from '@longhand/schema';
import { cleanup, render, screen } from '@testing-library/react';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectSpan } from './inspector';
import { ReplayScrubber } from './react/ReplayScrubber';
import { createProvenanceTint, staticTintHost } from './tint';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const HREF = 'https://example.com/words-that-only-live-in-the-href';

/** Typed text, then a pasted phrase; then a link over typed and pasted words, and code. */
function ledger(): LedgerBuilder {
  const b = new LedgerBuilder({ seed: 51 });
  b.createDocument('d', 'Doc');
  b.type('d', 'Read the log ');
  b.pasteExternal('d', 'borrowed words');
  const at = b.pos('d', { before: 'log' });
  b.format('d', (tr) =>
    tr.addMark(at, at + 'log borrowed'.length, schema.marks.link!.create({ href: HREF })),
  );
  const read = b.pos('d', { before: 'Read' });
  b.format('d', (tr) => tr.addMark(read, read + 4, schema.marks.code!.create()));
  return b;
}

describe('provenance over links and inline code', () => {
  it('tints linked and code text by class, inside the link and code elements', () => {
    const b = ledger();
    const d = b.project.documents.d!;
    const tint = createProvenanceTint({ enabled: true });
    const view = new EditorView(document.body.appendChild(document.createElement('div')), {
      state: EditorState.create({ doc: documentNode(b.state, 'd')!, plugins: [...tint.plugins] }),
      editable: () => false,
    });
    tint.attach(staticTintHost(view));
    tint.setRuns(d.provenance);
    const a = view.dom.querySelector('a')!;
    expect(a.getAttribute('href')).toBe(HREF);
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a.textContent).toBe('log borrowed');
    expect(a.querySelector('[data-prov="pasted-external"]')?.textContent).toBe('borrowed');
    expect(view.dom.querySelector('code')?.textContent).toBe('Read');
    view.destroy();
  });

  it('inspects linked text by its words, never its href', () => {
    const b = ledger();
    const state = foldCommits(b.commits);
    const typed = inspectSpan(state, 'd', b.pos('d', { before: 'log' }))!;
    expect(typed.class).toBe('typed');
    expect(typed.spanText).not.toContain('example.com');
    const pasted = inspectSpan(state, 'd', b.pos('d', { before: 'borrowed' }))!;
    expect(pasted.class).toBe('pasted-external');
    expect(pasted.spanText).toBe('borrowed words');
    expect(pasted.pastes[0]).toMatchObject({ words: 2 });
    expect(JSON.stringify([typed, pasted])).not.toContain('words-that-only-live');
  });

  it('replays links and code, and a click on a replayed link never navigates', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const b = ledger();
    render(<ReplayScrubber commits={b.commits} documentId="d" />);
    const doc = screen.getByTestId('replay-doc');
    const a = doc.querySelector('a')!;
    expect(a.getAttribute('href')).toBe(HREF);
    expect(doc.querySelector('code')?.textContent).toBe('Read');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }));
    expect(open).toHaveBeenCalledWith(HREF, '_blank', 'noopener,noreferrer');
  });
});
