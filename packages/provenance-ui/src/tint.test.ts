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

function decoRanges(tint: ReturnType<typeof createProvenanceTint>, state: EditorState) {
  return tint.layer
    .get(state)
    .find()
    .map((d) => {
      const run = (d.spec as { provenance: ProvenanceRun }).provenance;
      return { from: d.from, to: d.to, class: run.class, originSeq: run.originSeq };
    })
    .sort((a, b) => a.from - b.from);
}

describe('provenance tint decorations', () => {
  it('builds one inline decoration per run with class, seq and matched kind', () => {
    const { fixture: f } = fixture('suggestions');
    const runs = f.expected.state.documents['doc-s']!.provenance;
    const decos = provenanceDecorations(runs);
    expect(decos).toHaveLength(runs.length);
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

  for (const { name, doc } of fixtureDocuments()) {
    it(`${name}/${doc.id}: decoration ranges match the fixture provenance`, () => {
      const tint = createProvenanceTint({ enabled: true });
      const ed = mountEditor(doc, tint.plugins);
      mounted.push(ed);
      tint.attach(ed.handle);
      expect(tint.setRuns(doc.provenance, doc.version)).toBe(true);
      const view = ed.handle.view;
      expect(decoRanges(tint, view.state)).toEqual(
        doc.provenance.map((r) => ({
          from: r.from,
          to: r.to,
          class: r.class,
          originSeq: r.originSeq,
        })),
      );
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
