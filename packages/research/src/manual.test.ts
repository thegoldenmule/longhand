import { describe, expect, it } from 'vitest';
import { formatName, parseDate, parseName, parseNames } from './csl';
import { cslToManualEntry, emptyManualEntry, validateManualEntry } from './manual';

describe('names and dates', () => {
  it('parses personal names, particles, suffixes and organizations', () => {
    expect(parseName('LeCun, Yann')).toEqual({ family: 'LeCun', given: 'Yann' });
    expect(parseName('Yann LeCun')).toEqual({ family: 'LeCun', given: 'Yann' });
    expect(parseName('Ludwig van Beethoven')).toEqual({ family: 'van Beethoven', given: 'Ludwig' });
    expect(parseName('Martin Luther King Jr.')).toEqual({
      family: 'King',
      given: 'Martin Luther',
      suffix: 'Jr.',
    });
    expect(parseName('World Health Organization')).toEqual({
      literal: 'World Health Organization',
    });
    expect(parseName('Plato')).toEqual({ literal: 'Plato' });
    expect(parseName('  ')).toBeNull();
    expect(parseNames('Doe, Jane; Roe, Richard\nAda Lovelace')).toEqual([
      { family: 'Doe', given: 'Jane' },
      { family: 'Roe', given: 'Richard' },
      { family: 'Lovelace', given: 'Ada' },
    ]);
    expect(formatName({ family: 'Doe', given: 'Jane' })).toBe('Doe, Jane');
  });

  it('parses dates', () => {
    expect(parseDate('2015-05-27')).toEqual({ 'date-parts': [[2015, 5, 27]] });
    expect(parseDate('2015-05')).toEqual({ 'date-parts': [[2015, 5]] });
    expect(parseDate('2015')).toEqual({ 'date-parts': [[2015]] });
    expect(parseDate('2017-03-26T10:00:00.000Z')).toEqual({ 'date-parts': [[2017, 3, 26]] });
    expect(parseDate('May 27, 2015')).toEqual({ 'date-parts': [[2015, 5, 27]] });
    expect(parseDate('27 May 2015')).toEqual({ 'date-parts': [[2015, 5, 27]] });
    expect(parseDate('September 2009')).toEqual({ 'date-parts': [[2009, 9]] });
    expect(parseDate('c. 1850')).toEqual({ 'date-parts': [[1850]] });
    expect(parseDate('someday')).toBeNull();
  });
});

describe('validateManualEntry', () => {
  it('builds CSL-JSON from a filled form', () => {
    const form = {
      ...emptyManualEntry('chapter'),
      title: '  On Quotation  ',
      authors: 'Doe, Jane; Richard Roe',
      editors: 'Smith, A.',
      issued: '2019-04',
      containerTitle: 'Essays on Citing',
      publisher: 'Example Press',
      publisherPlace: 'Boston',
      page: '12-30',
      doi: 'https://doi.org/10.1234/abcd',
      isbn: '0-262-03384-4',
      url: 'example.org/essays',
    };
    const result = validateManualEntry(form, 'src-1');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.csl).toEqual({
      id: 'src-1',
      type: 'chapter',
      title: 'On Quotation',
      author: [
        { family: 'Doe', given: 'Jane' },
        { family: 'Roe', given: 'Richard' },
      ],
      editor: [{ family: 'Smith', given: 'A.' }],
      issued: { 'date-parts': [[2019, 4]] },
      'container-title': 'Essays on Citing',
      publisher: 'Example Press',
      'publisher-place': 'Boston',
      page: '12-30',
      DOI: '10.1234/abcd',
      ISBN: '9780262033848',
      URL: 'https://example.org/essays',
    });
  });

  it('reports field errors', () => {
    const result = validateManualEntry(
      {
        ...emptyManualEntry(),
        type: 'spaceship',
        issued: 'soon',
        doi: 'nope',
        isbn: '123',
        url: 'not a url',
      },
      'src-1',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual([
      'doi',
      'isbn',
      'issued',
      'title',
      'type',
      'url',
    ]);
  });

  it('warns about missing author and date but accepts them', () => {
    const result = validateManualEntry({ ...emptyManualEntry(), title: 'Anonymous pamphlet' }, 's');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.authors).toBeTruthy();
    expect(result.warnings.issued).toBeTruthy();
    expect(result.csl).toEqual({ id: 's', type: 'book', title: 'Anonymous pamphlet' });
  });

  it('round-trips through cslToManualEntry and keeps unknown variables', () => {
    const csl = {
      id: 's',
      type: 'article-journal',
      title: 'Deep learning',
      'container-title': 'Nature',
      author: [{ family: 'LeCun', given: 'Yann' }],
      issued: { 'date-parts': [[2015, 5, 27]] },
      volume: '521',
      DOI: '10.1038/nature14539',
      source: 'Crossref',
      abstract: 'Deep learning allows…',
    };
    const form = cslToManualEntry(csl);
    expect(form.authors).toBe('LeCun, Yann');
    expect(form.issued).toBe('2015-05-27');
    const result = validateManualEntry({ ...form, volume: '522' }, 's', csl);
    expect(result.ok && result.csl).toEqual({ ...csl, volume: '522' });
  });
});
