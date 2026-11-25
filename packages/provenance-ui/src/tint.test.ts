import { schema, type ProvenanceRun } from '@longhand/schema';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, describe, expect, it } from 'vitest';
import { docFromJSON } from '@longhand/schema';
import { fixture, fixtureDocuments, mountEditor, type MountedEditor } from './test/helpers';
import { createProvenanceTint, provenanceDecorations, staticTintHost } from './tint';

const mounted: MountedEditor[] = [];
afterEach(() => {
  for (const m of mounted.splice(0)) m.destroy();
  document.body.innerHTML = '';
});

const tintClassOf = (r: ProvenanceRun) =>
  r.class === 'pasted-internal' ? 'pasted-external' : r.class;

function decoRanges(tint: ReturnType<typeof createProvenanceTint>, state: EditorState) {
  return tint.layer
    .get(state)
    .find()
    .map((d) => {
      const spec = d.spec as { provenance: ProvenanceRun; runs: ProvenanceRun[] };
      return {
        from: d.from,
        to: d.to,
        class: tintClassOf(spec.provenance),
        originSeqs: spec.runs.map((r) => r.originSeq),
      };
    })
    .sort((a, b) => a.from - b.from);
}

/**
 * Checks merged decorations against the runs: every run position is covered by
 * one decoration of the run's class whose seqs include the run's, and no two
 * touching decorations look the same (they would have been merged).
 */
function expectMergedCover(
  decos: ReturnType<typeof decoRanges>,
  runs: readonly ProvenanceRun[],
): void {
  for (const r of runs) {
    for (let pos = r.from; pos < r.to; pos++) {
      const covering = decos.filter((d) => d.from <= pos && pos < d.to);
      expect(covering).toHaveLength(1);
      expect(covering[0]!.class).toBe(tintClassOf(r));
      expect(covering[0]!.originSeqs).toContain(r.originSeq);
    }
  }
  const covered = decos.reduce((n, d) => n + d.to - d.from, 0);
  expect(covered).toBe(runs.reduce((n, r) => n + r.to - r.from, 0));
  expect(decos.length).toBeLessThanOrEqual(runs.length);
}

describe('provenance tint decorations', () => {
  it('builds inline decorations with class, seq and matched kind', () => {
    const { fixture: f } = fixture('suggestions');
    const runs = f.expected.state.documents['doc-s']!.provenance;
    const decos = provenanceDecorations(runs);
    const comment = decos.find(
      (d) => d.kind === 'inline' && d.attrs['data-prov-matched'] === 'comment',
    );
    expect(comment).toMatchObject({
      kind: 'inline',
      from: 204,
      to: 229,
      attrs: {
        class: 'lh-prov lh-prov--typed-from-suggestion',
        'data-prov': 'typed-from-suggestion',
        'data-prov-seq': '33',
        title: 'Typed from a suggestion: matched a margin comment',
      },
    });
  });

  it('merges touching runs that look the same, so a run boundary never shows', () => {
    const run = (from: number, to: number, cls: ProvenanceRun['class'], seq: number) =>
      ({ from, to, class: cls, originSeq: seq }) as ProvenanceRun;
    const decos = provenanceDecorations([
      run(1, 5, 'typed', 3),
      run(5, 9, 'typed', 4), // a batch ended mid-word
      run(9, 14, 'pasted-external', 5),
      run(14, 20, 'pasted-internal', 6), // folds as pasted-external, a second paste
      run(20, 24, 'pasted-external', 7),
      run(26, 30, 'pasted-external', 8), // not touching
      { ...run(30, 34, 'typed-from-suggestion', 9), matchedKind: 'comment' },
      { ...run(34, 38, 'typed-from-suggestion', 10), matchedKind: 'suggestion' },
    ]);
    expect(
      decos.map((d) => (d.kind === 'inline' ? [d.from, d.to, d.attrs['data-prov-seq']] : [])),
    ).toEqual([
      [1, 9, '3 4'],
      [9, 24, '5 6 7'],
      [26, 30, '8'],
      [30, 34, '9'],
      [34, 38, '10'],
    ]);
    expect((decos[1]!.spec as { runs: ProvenanceRun[] }).runs).toHaveLength(3);
  });

  for (const { name, doc } of fixtureDocuments()) {
    it(`${name}/${doc.id}: decoration ranges match the fixture provenance`, () => {
      const tint = createProvenanceTint({ enabled: true });
      const ed = mountEditor(doc, tint.plugins);
      mounted.push(ed);
      tint.attach(ed.handle);
      expect(tint.setRuns(doc.provenance, doc.version)).toBe(true);
      const view = ed.handle.view;
      expectMergedCover(decoRanges(tint, view.state), doc.provenance);
      // The DOM carries the class on exactly the run's text.
      const pmDoc = view.state.doc;
      for (const cls of new Set(doc.provenance.map((r) => r.class))) {
        const expected = doc.provenance
          .filter((r) => r.class === cls)
          .map((r) => pmDoc.textBetween(r.from, r.to, '', ''))
          .join('');
        const actual = [...view.dom.querySelectorAll(`[data-prov="${cls}"]`)]
          .map((el) => el.textContent)
          .join('');
        expect(actual).toBe(expected);
      }
      expect(view.dom.classList.contains('lh-prov-on')).toBe(true);
    });
  }

  it('maps the runs onto unsynced local edits and leaves new text untinted', () => {
    const doc = fixture('suggestions').fixture.expected.state.documents['doc-s']!;
    const tint = createProvenanceTint({ enabled: true });
    const ed = mountEditor(doc, tint.plugins);
    mounted.push(ed);
    tint.attach(ed.handle);
    ed.at(1);
    ed.typeText('Oh, ');
    // The version is behind the local document now; the editor maps it.
    expect(tint.setRuns(doc.provenance, doc.version)).toBe(true);
    const ranges = decoRanges(tint, ed.handle.view.state);
    expect(ranges[0]).toMatchObject({ from: 5, to: 26, class: 'typed' });
    const first = ed.handle.view.dom.querySelector('[data-prov]');
    expect(first?.textContent?.startsWith('The rain fell')).toBe(true);
    // New text is not in the ledger version: no ledger position.
    expect(tint.toLedgerPos(2)).toBeNull();
    expect(tint.toLedgerPos(5)).toBe(1);
    expect(tint.inspectAt(2)?.ledgerPos).toBeNull();
  });

  it('reports a version the editor cannot map as stale', () => {
    const doc = fixture('plain-typing').fixture.expected.state.documents['doc-pages']!;
    const tint = createProvenanceTint({ enabled: true });
    const ed = mountEditor(doc, tint.plugins);
    mounted.push(ed);
    tint.attach(ed.handle);
    expect(tint.setRuns(doc.provenance, doc.version + 50)).toBe(false);
    expect(tint.getSnapshot().stale).toBe(true);
    expect(tint.setRuns(doc.provenance, doc.version)).toBe(true);
    expect(tint.getSnapshot().stale).toBe(false);
  });

  it('toggles and highlights through the plugin attributes', () => {
    const doc = fixture('research').fixture.expected.state.documents['doc-r']!;
    const tint = createProvenanceTint();
    const ed = mountEditor(doc, tint.plugins);
    mounted.push(ed);
    tint.attach(ed.handle);
    tint.setRuns(doc.provenance, doc.version);
    const dom = ed.handle.view.dom;
    expect(dom.querySelector('[data-prov]')).toBeNull();
    expect(dom.classList.contains('lh-prov-on')).toBe(false);
    tint.toggle();
    expect(dom.classList.contains('lh-prov-on')).toBe(true);
    expect(dom.classList.contains('lh-manuscript')).toBe(true);
    expect(dom.querySelectorAll('[data-prov="quoted"]').length).toBeGreaterThan(0);
    tint.setHighlight('quoted');
    expect(dom.getAttribute('data-prov-highlight')).toBe('quoted');
    tint.setEnabled(false);
    expect(dom.querySelector('[data-prov]')).toBeNull();
    expect(dom.hasAttribute('data-prov-highlight')).toBe(false);
    expect(tint.getSnapshot().highlight).toBeNull();
  });

  it('turns Alt-Enter at the caret and clicks into inspection requests', () => {
    const doc = fixture('suggestions').fixture.expected.state.documents['doc-s']!;
    const tint = createProvenanceTint({ enabled: true });
    const ed = mountEditor(doc, tint.plugins);
    mounted.push(ed);
    tint.attach(ed.handle);
    tint.setRuns(doc.provenance, doc.version);
    const seen: Array<{ pos: number | null; via: string }> = [];
    tint.onInspect((r) => seen.push({ pos: r.ledgerPos, via: r.via }));
    ed.at(23);
    ed.handle.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }),
    );
    expect(seen).toEqual([{ pos: 23, via: 'keyboard' }]);
    // A click goes through ProseMirror's handleClick prop.
    const view = ed.handle.view;
    view.someProp('handleClick', (f) =>
      f(view, 66, new MouseEvent('click', { button: 0, clientX: 0, clientY: 0 })),
    );
    expect(seen.at(-1)).toEqual({ pos: 66, via: 'pointer' });
    // Off: no requests.
    tint.setEnabled(false);
    ed.handle.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true }),
    );
    expect(seen).toHaveLength(2);
  });

  it('works on a read-only view through staticTintHost', () => {
    const doc = fixture('import').fixture.expected.state.documents;
    const d = Object.values(doc)[0]!;
    const tint = createProvenanceTint({ enabled: true });
    const view = new EditorView(document.body.appendChild(document.createElement('div')), {
      state: EditorState.create({
        doc: docFromJSON(d.content),
        schema,
        plugins: [...tint.plugins],
      }),
      editable: () => false,
    });
    tint.attach(staticTintHost(view));
    tint.setRuns(d.provenance);
    expect(view.dom.querySelectorAll('[data-prov="imported"]').length).toBeGreaterThan(0);
    expect(tint.toLedgerPos(3)).toBe(3);
    view.destroy();
  });
});
