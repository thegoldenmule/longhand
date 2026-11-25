import { describe, expect, it } from 'vitest';
import {
  classifyIdentifier,
  doiKey,
  isbn10to13,
  normalizeDoi,
  normalizeIsbn,
  normalizeUrl,
} from './identifiers';

describe('normalizeDoi', () => {
  it('accepts bare DOIs, doi: prefixes and doi.org URLs', () => {
    expect(normalizeDoi('10.1038/nature14539')).toBe('10.1038/nature14539');
    expect(normalizeDoi(' doi:10.1038/nature14539 ')).toBe('10.1038/nature14539');
    expect(normalizeDoi('https://doi.org/10.1038/nature14539')).toBe('10.1038/nature14539');
    expect(normalizeDoi('http://dx.doi.org/10.1145/3442188.3445922')).toBe(
      '10.1145/3442188.3445922',
    );
    expect(normalizeDoi('https://doi.org/10.1007%2F978-3-030-58452-8_13')).toBe(
      '10.1007/978-3-030-58452-8_13',
    );
    expect(normalizeDoi('10.1038/nature14539.')).toBe('10.1038/nature14539');
  });

  it('rejects non-DOIs', () => {
    expect(normalizeDoi('nature14539')).toBeNull();
    expect(normalizeDoi('10.12/x')).toBeNull();
    expect(normalizeDoi('https://example.com/10.1038/x')).toBeNull();
  });

  it('compares case-insensitively', () => {
    expect(doiKey('10.1038/NATURE14539')).toBe(doiKey('https://doi.org/10.1038/nature14539'));
  });
});

describe('normalizeIsbn', () => {
  it('validates ISBN-13 and ISBN-10 check digits and returns ISBN-13', () => {
    expect(normalizeIsbn('978-0-262-03384-8')).toBe('9780262033848');
    expect(normalizeIsbn('ISBN 0-262-03384-4')).toBe('9780262033848');
    expect(normalizeIsbn('080442957X')).toBe('9780804429573');
    expect(normalizeIsbn('9780262033849')).toBeNull();
    expect(normalizeIsbn('0262033845')).toBeNull();
    expect(normalizeIsbn('12345')).toBeNull();
  });

  it('converts ISBN-10 to ISBN-13', () => {
    expect(isbn10to13('0141439513')).toBe('9780141439518');
  });
});

describe('normalizeUrl', () => {
  it('accepts http(s) URLs and adds https to bare hosts', () => {
    expect(normalizeUrl('https://arxiv.org/abs/1706.03762')).toBe(
      'https://arxiv.org/abs/1706.03762',
    );
    expect(normalizeUrl('example.com/page')).toBe('https://example.com/page');
  });

  it('rejects other schemes and junk', () => {
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('ftp://example.com/x')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('word')).toBeNull();
  });
});

describe('classifyIdentifier', () => {
  it('prefers DOI, then ISBN, then URL', () => {
    expect(classifyIdentifier('https://doi.org/10.1038/nature14539')).toEqual({
      kind: 'doi',
      value: '10.1038/nature14539',
    });
    expect(classifyIdentifier('978-0-14-143951-8')).toEqual({
      kind: 'isbn',
      value: '9780141439518',
    });
    expect(classifyIdentifier('arxiv.org/abs/1706.03762')).toEqual({
      kind: 'url',
      value: 'https://arxiv.org/abs/1706.03762',
    });
    expect(classifyIdentifier('a book I read once')).toBeNull();
  });
});
