import type { CslItem, SourceState } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import {
  STYLES,
  formatBibliography,
  formatCitation,
  formatCitations,
  parseLocator,
  referencedSourceIds,
  resolveStyle,
} from './format';

const lecun: CslItem = {
  id: 'lecun',
  type: 'article-journal',
  title: 'Deep learning',
  'container-title': 'Nature',
  author: [
    { family: 'LeCun', given: 'Yann' },
    { family: 'Bengio', given: 'Yoshua' },
    { family: 'Hinton', given: 'Geoffrey' },
  ],
  issued: { 'date-parts': [[2015, 5, 27]] },
  volume: '521',
  issue: '7553',
  page: '436-444',
  DOI: '10.1038/nature14539',
};

const austen: CslItem = {
  id: 'austen',
  type: 'book',
  title: 'Pride and Prejudice',
  author: [{ family: 'Austen', given: 'Jane' }],
  issued: { 'date-parts': [[2003]] },
  publisher: 'Penguin Books',
  'publisher-place': 'London',
};

const items = [lecun, austen];

describe('parseLocator', () => {
  it('maps common abbreviations to CSL labels', () => {
    expect(parseLocator('p. 12')).toEqual({ label: 'page', locator: '12' });
    expect(parseLocator('pp. 12–14')).toEqual({ label: 'page', locator: '12–14' });
    expect(parseLocator('ch. 3')).toEqual({ label: 'chapter', locator: '3' });
    expect(parseLocator('§ 4')).toEqual({ label: 'section', locator: '4' });
    expect(parseLocator('para. 2')).toEqual({ label: 'paragraph', locator: '2' });
    expect(parseLocator('fig. 1')).toEqual({ label: 'figure', locator: '1' });
    expect(parseLocator('00:14:05')).toEqual({ label: 'timestamp', locator: '00:14:05' });
    expect(parseLocator('xii')).toEqual({ label: 'page', locator: 'xii' });
    expect(parseLocator('12')).toEqual({ label: 'page', locator: '12' });
    expect(parseLocator('preface')).toEqual({ locator: 'preface' });
    expect(parseLocator('volume 2')).toEqual({ label: 'volume', locator: '2' });
    expect(parseLocator('page 5')).toEqual({ label: 'page', locator: '5' });
    expect(parseLocator('chapter 3')).toEqual({ label: 'chapter', locator: '3' });
    expect(parseLocator('Book 4')).toEqual({ label: 'book', locator: '4' });
    expect(parseLocator('')).toBeNull();
    expect(parseLocator(null)).toBeNull();
  });
});

describe('resolveStyle', () => {
  it('accepts bundled ids and short aliases, falling back to APA', () => {
    expect(resolveStyle('modern-language-association')).toBe('modern-language-association');
    expect(resolveStyle('MLA')).toBe('modern-language-association');
    expect(resolveStyle('chicago')).toBe('chicago-author-date');
    expect(resolveStyle('ieee')).toBe('apa');
    expect(STYLES.map((s) => s.id)).toEqual([
      'apa',
      'modern-language-association',
      'chicago-author-date',
    ]);
  });
});

describe('formatCitation', () => {
  it('APA', () => {
    expect(formatCitation(items, 'lecun', 'p. 437', 'apa').text).toBe(
      '(LeCun et al., 2015, p. 437)',
    );
    expect(formatCitation(items, 'austen', 'pp. 12-14', 'apa').text).toBe(
      '(Austen, 2003, pp. 12–14)',
    );
    expect(formatCitation(items, 'austen', 'ch. 3', 'apa').text).toBe('(Austen, 2003, Chapter 3)');
    expect(formatCitation(items, 'austen', null, 'apa').text).toBe('(Austen, 2003)');
  });

  it('MLA', () => {
    expect(formatCitation(items, 'lecun', 'p. 437', 'modern-language-association').text).toBe(
      '(LeCun et al. 437)',
    );
    expect(formatCitation(items, 'austen', 'ch. 3', 'modern-language-association').text).toBe(
      '(Austen, ch. 3)',
    );
  });

  it('Chicago author-date', () => {
    expect(formatCitation(items, 'lecun', 'p. 437', 'chicago-author-date').text).toBe(
      '(LeCun et al. 2015, 437)',
    );
    expect(formatCitation(items, 'austen', 'ch. 3', 'chicago-author-date').text).toBe(
      '(Austen 2003, chap. 3)',
    );
  });

  it('formats a multi-source cluster and reports missing sources', () => {
    const out = formatCitations(
      items,
      [{ sourceId: 'lecun' }, { sourceId: 'austen' }, { sourceId: 'gone' }],
      'apa',
    );
    expect(out.text).toBe('(Austen, 2003; LeCun et al., 2015)');
    expect(out.missing).toEqual(['gone']);
    expect(formatCitation(items, 'gone', null).text).toBe('(missing source)');
  });

  it('accepts library sources and keys them by source id', () => {
    const source: SourceState = {
      id: 'src-9',
      csl: { ...austen, id: 'stale-id' },
      origin: { kind: 'isbn', value: '9780141439518' },
      fromSurfacedId: null,
      candidateIndex: null,
      note: '',
      archived: false,
      addedSeq: 3,
      updatedSeq: 3,
    };
    expect(formatCitation({ 'src-9': source }, 'src-9', '7').text).toBe('(Austen, 2003, p. 7)');
  });

  it('picks up edited metadata between calls', () => {
    expect(formatCitation([lecun], 'lecun', null).text).toBe('(LeCun et al., 2015)');
    expect(
      formatCitation([{ ...lecun, issued: { 'date-parts': [[2016]] } }], 'lecun', null).text,
    ).toBe('(LeCun et al., 2016)');
  });
});

describe('formatBibliography', () => {
  it('APA: text and HTML, sorted by author', () => {
    const bib = formatBibliography(items, 'apa');
    expect(bib.entries.map((e) => e.id)).toEqual(['austen', 'lecun']);
    expect(bib.text).toBe(
      [
        'Austen, J. (2003). Pride and Prejudice. Penguin Books.',
        'LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539',
      ].join('\n'),
    );
    expect(bib.entries[0]!.html).toBe(
      '<div class="csl-entry">Austen, J. (2003). <i>Pride and Prejudice</i>. Penguin Books.</div>',
    );
    expect(bib.html).toMatch(/^<div class="csl-bib-body">/);
    expect(bib.layout.hangingIndent).toBe(true);
  });

  it('MLA', () => {
    const bib = formatBibliography(items, 'modern-language-association');
    expect(bib.text).toBe(
      [
        'Austen, Jane. Pride and Prejudice. Penguin Books, 2003.',
        'LeCun, Yann, et al. “Deep Learning.” Nature, vol. 521, no. 7553, May 2015, pp. 436–44, https://doi.org/10.1038/nature14539.',
      ].join('\n'),
    );
    expect(bib.entries[1]!.html).toContain('<i>Nature</i>');
  });

  it('Chicago author-date', () => {
    const bib = formatBibliography(items, 'chicago-author-date');
    expect(bib.text).toBe(
      [
        'Austen, Jane. 2003. Pride and Prejudice. Penguin Books.',
        'LeCun, Yann, Yoshua Bengio, and Geoffrey Hinton. 2015. “Deep Learning.” Nature 521 (7553): 436–44. https://doi.org/10.1038/nature14539.',
      ].join('\n'),
    );
  });

  it('limits to the given ids and handles an empty list', () => {
    expect(formatBibliography(items, 'apa', ['lecun', 'nope']).entries.map((e) => e.id)).toEqual([
      'lecun',
    ]);
    expect(formatBibliography([], 'apa')).toMatchObject({ text: '', entries: [] });
  });

  it('escapes markup in metadata', () => {
    const evil: CslItem = {
      id: 'x',
      type: 'webpage',
      title: '<script>alert(1)</script>',
      URL: 'https://e.com',
    };
    expect(formatBibliography([evil], 'apa').html).not.toContain('<script>');
  });
});

describe('numeric CSL fields', () => {
  // CSL-JSON allows numbers (`volume: 12`); citeproc-js used to throw on them.
  const numeric = {
    ...lecun,
    id: 'numeric',
    volume: 521,
    issue: 7553,
    edition: 2,
  } as unknown as CslItem;

  it('formats citations and bibliographies with numeric fields like their string forms', () => {
    const asStrings = { ...lecun, id: 'numeric', volume: '521', issue: '7553', edition: '2' };
    for (const style of STYLES) {
      expect(formatCitation([numeric], 'numeric', 'p. 437', style.id).text).toBe(
        formatCitation([asStrings], 'numeric', 'p. 437', style.id).text,
      );
      expect(formatBibliography([numeric], style.id).text).toBe(
        formatBibliography([asStrings], style.id).text,
      );
    }
    expect(formatBibliography([numeric], 'apa').text).toContain('521(7553)');
  });

  it('leaves the caller’s item untouched', () => {
    formatBibliography([numeric], 'apa');
    expect((numeric as unknown as { volume: unknown }).volume).toBe(521);
  });
});

describe('referencedSourceIds', () => {
  it('collects citation and quote_block sources in order, once each', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'A claim' },
            { type: 'citation', attrs: { sourceId: 'b', locator: null } },
            { type: 'footnote', content: [{ type: 'citation', attrs: { sourceId: 'a' } }] },
          ],
        },
        {
          type: 'quote_block',
          attrs: { sourceId: 'c', clippingId: 'k', locator: null },
          content: [{ type: 'paragraph' }],
        },
        { type: 'paragraph', content: [{ type: 'citation', attrs: { sourceId: 'b' } }] },
      ],
    };
    expect(referencedSourceIds(doc)).toEqual(['b', 'a', 'c']);
  });
});
