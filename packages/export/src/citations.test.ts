import type { CslItem } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import {
  MISSING_SOURCE_TEXT,
  authorDateCitation,
  defaultBibliographyEntry,
  defaultQuoteAttribution,
  formatLocator,
  issuedYear,
  numberedCitation,
  shortAuthors,
} from './citations';
import { SOURCES } from './fixtures.test-helpers';
import { spansText, toSpans } from './model';
import type { CitationContext } from './types';

const byId = (id: string): CslItem => SOURCES.find((s) => s.id === id) as CslItem;
const ctx = (source: CslItem | undefined, number = 1): CitationContext => ({
  source,
  number,
  inFootnote: false,
  documentIndex: 0,
});

describe('citation fallbacks', () => {
  it('formats locators', () => {
    expect(formatLocator(null)).toBeNull();
    expect(formatLocator('  ')).toBeNull();
    expect(formatLocator('12')).toBe('p. 12');
    expect(formatLocator('12-14')).toBe('pp. 12–14');
    expect(formatLocator('12 – 14')).toBe('pp. 12–14');
    expect(formatLocator('ch. 3')).toBe('ch. 3');
    expect(formatLocator('p. 3')).toBe('p. 3');
  });

  it('short authors and years', () => {
    expect(shortAuthors(byId('woolf'))).toBe('Woolf');
    expect(shortAuthors(byId('smith-jones'))).toBe('Smith and Jones');
    expect(shortAuthors(byId('collected'))).toBe('Okafor et al.');
    expect(shortAuthors(byId('web'))).toBeNull();
    expect(shortAuthors(byId('uncited'))).toBe('Anonymous Collective');
    expect(issuedYear(byId('collected'))).toBe('2001');
    expect(issuedYear(byId('web'))).toBeNull();
    expect(
      shortAuthors({
        id: 'x',
        type: 'book',
        author: [{ family: 'Beethoven', 'non-dropping-particle': 'van' }],
      }),
    ).toBe('van Beethoven');
  });

  it('author-date', () => {
    expect(authorDateCitation('woolf', '12', ctx(byId('woolf')))).toBe('(Woolf 1929, p. 12)');
    expect(authorDateCitation('smith-jones', null, ctx(byId('smith-jones')))).toBe(
      '(Smith and Jones 2019)',
    );
    expect(authorDateCitation('web', null, ctx(byId('web')))).toBe(
      '(“Salt Roads of the North” n.d.)',
    );
    expect(authorDateCitation('x', null, ctx({ id: 'x', type: 'book' }))).toBe('(x n.d.)');
    expect(authorDateCitation('ghost', '1', ctx(undefined))).toBe(MISSING_SOURCE_TEXT);
  });

  it('numbered', () => {
    expect(numberedCitation('woolf', null, ctx(byId('woolf'), 3))).toBe('[3]');
    expect(numberedCitation('woolf', '7', ctx(byId('woolf'), 3))).toBe('[3, p. 7]');
    expect(numberedCitation('ghost', null, ctx(undefined, 9))).toBe(MISSING_SOURCE_TEXT);
  });

  it('bibliography entries', () => {
    const entry = (id: string): string =>
      spansText(toSpans(defaultBibliographyEntry(byId(id), { number: null })));
    expect(entry('woolf')).toBe(
      "Woolf, Virginia. 1929. A Room of One's Own. London: Hogarth Press.",
    );
    expect(entry('smith-jones')).toBe(
      'Smith, Ada, and Ben Jones. 2019. “Salt and Memory.” Journal of Coastal History 12(3): 45–67. https://doi.org/10.1000/xyz123.',
    );
    expect(entry('collected')).toBe(
      'Okafor, Chidi, Maja Lind, and Soo Park, eds. 2001. Tides: Collected Essays. Harbour Books.',
    );
    expect(entry('web')).toBe('Salt Roads of the North. n.d. https://example.org/salt.');
    expect(entry('uncited')).toBe('Anonymous Collective. 1880. An Uncited Book.');
    // Titles of standalone works are italic.
    const spans = defaultBibliographyEntry(byId('woolf'), { number: null }) as {
      text: string;
      italic?: boolean;
    }[];
    expect(spans.find((s) => s.italic)?.text).toBe("A Room of One's Own");
  });

  it('quote attribution', () => {
    const attr = (id: string, locator: string | null) =>
      spansText(
        toSpans(
          defaultQuoteAttribution(id, {
            source: SOURCES.find((s) => s.id === id),
            locator,
            clippingId: null,
          }) ?? '',
        ),
      );
    expect(attr('woolf', '4')).toBe("Virginia Woolf, A Room of One's Own, p. 4");
    expect(attr('smith-jones', null)).toBe('Ada Smith and Ben Jones, “Salt and Memory”');
    expect(attr('ghost', '2')).toBe(`${MISSING_SOURCE_TEXT}, p. 2`);
  });
});
