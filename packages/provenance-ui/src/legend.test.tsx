import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TINT_CLASSES } from './classes';
import { formatShare } from './format';
import { documentLegend, projectLegend } from './legendData';
import { ProvenanceLegend } from './react/ProvenanceLegend';
import { fixture, FIXTURE_NAMES, fixtureDocuments, mountEditor } from './test/helpers';
import { createProvenanceTint } from './tint';

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('legend data', () => {
  for (const { name, doc } of fixtureDocuments()) {
    it(`${name}/${doc.id}: matches the fixture's wordsByClass`, () => {
      const expected = fixture(name).fixture.expected.documents[doc.id]!.wordsByClass;
      const data = documentLegend(doc);
      expect(data.counts).toEqual(expected);
      expect(data.total).toBe(expected.total);
      for (const row of data.rows) expect(row.count).toBe(expected.byClass[row.cls]);
      // The matched-kind breakdown accounts for every typed-from-suggestion word.
      expect(data.matched.reduce((n, m) => n + m.count, 0)).toBe(
        expected.byClass['typed-from-suggestion'],
      );
    });
  }

  for (const name of FIXTURE_NAMES) {
    it(`${name}: project counts match projectWords`, () => {
      const f = fixture(name).fixture;
      expect(projectLegend(f.expected.state).counts).toEqual(f.expected.projectWords);
    });
  }

  it('splits typed-from-suggestion words by the AI text they matched', () => {
    const doc = fixture('suggestions').fixture.expected.state.documents['doc-s']!;
    const kinds = Object.fromEntries(documentLegend(doc).matched.map((m) => [m.kind, m.count]));
    expect(Object.keys(kinds).sort()).toEqual(['comment', 'insertion', 'suggestion']);
  });

  it('never rounds a partial share to 0% or 100%', () => {
    expect(formatShare(1, 5000)).toBe('0.1%');
    expect(formatShare(4999, 5000)).toBe('99.9%');
    expect(formatShare(5000, 5000)).toBe('100%');
    expect(formatShare(0, 5000)).toBe('0%');
    expect(formatShare(1, 3)).toBe('33.3%');
  });
});

describe('<ProvenanceLegend>', () => {
  for (const { name, doc } of fixtureDocuments()) {
    it(`${name}/${doc.id}: renders each class count`, () => {
      const expected = fixture(name).fixture.expected.documents[doc.id]!.wordsByClass;
      render(<ProvenanceLegend document={doc} />);
      expect(screen.getByTestId('legend-total').textContent).toBe(
        `${expected.total} word${expected.total === 1 ? '' : 's'}`,
      );
      for (const cls of TINT_CLASSES) {
        expect(screen.getByTestId(`legend-count-${cls}`).textContent).toBe(
          String(expected.byClass[cls]),
        );
      }
    });
  }

  it('renders project-wide counts', () => {
    const f = fixture('novel').fixture;
    render(<ProvenanceLegend project={{ state: f.expected.state }} />);
    expect(screen.getByTestId('legend-total').textContent).toBe(
      `${f.expected.projectWords.total} words`,
    );
  });

  it('toggles the tint and highlights a class on the editor', () => {
    const doc = fixture('research').fixture.expected.state.documents['doc-r']!;
    const tint = createProvenanceTint();
    const ed = mountEditor(doc, tint.plugins);
    tint.attach(ed.handle);
    tint.setRuns(doc.provenance, doc.version);
    render(<ProvenanceLegend document={doc} tint={tint} />);

    const toggle = screen.getByRole('switch', { name: 'Tint' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(ed.handle.view.dom.classList.contains('lh-prov-on')).toBe(true);

    // Clicking a class highlights its spans; clicking again clears it.
    const quoted = screen.getByTestId('legend-quoted');
    fireEvent.click(quoted);
    expect(quoted.getAttribute('aria-pressed')).toBe('true');
    expect(ed.handle.view.dom.getAttribute('data-prov-highlight')).toBe('quoted');
    fireEvent.click(quoted);
    expect(quoted.getAttribute('aria-pressed')).toBe('false');
    expect(ed.handle.view.dom.hasAttribute('data-prov-highlight')).toBe(false);

    // A class with no words cannot be chosen.
    expect((screen.getByTestId('legend-imported') as HTMLButtonElement).disabled).toBe(true);

    // Choosing a class while the tint is off turns it on.
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId('legend-pasted-external'));
    expect(tint.getSnapshot()).toMatchObject({ enabled: true, highlight: 'pasted-external' });
    ed.destroy();
  });

  it('lists the matched kinds under typed from a suggestion', () => {
    const doc = fixture('suggestions').fixture.expected.state.documents['doc-s']!;
    render(<ProvenanceLegend document={doc} />);
    const list = screen.getByRole('list', { name: 'Matched AI text' });
    expect(within(list).getByTestId('legend-matched-comment').textContent).toMatch(/Comments\d+/);
  });

  it('works uncontrolled without a tint', () => {
    const doc = fixture('plain-typing').fixture.expected.state.documents['doc-pages']!;
    const changes: unknown[] = [];
    render(
      <ProvenanceLegend
        document={doc}
        enabled={false}
        onEnabledChange={(e) => changes.push(e)}
        onHighlightChange={(c) => changes.push(c)}
      />,
    );
    fireEvent.click(screen.getByTestId('legend-typed'));
    expect(changes).toEqual([true, 'typed']);
  });
});
