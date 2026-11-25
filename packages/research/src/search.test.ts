import { BOUNDS, SurfacedCandidateSchema, type CslItem } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { crossrefSearchUrl } from './crossref';
import { openLibrarySearchUrl } from './openlibrary';
import { createSourceSearch, mergeResults, providerOf, type SourceSearch } from './search';
import { fixtureFetch, response } from './test-support/fixture-fetch';

describe('createSourceSearch (recorded responses)', () => {
  it('satisfies SourceSearch and interleaves Crossref and Open Library', async () => {
    const search: SourceSearch = createSourceSearch({ fetch: fixtureFetch() });
    const items = await search.search('deep learning', 5);
    expect(items).toHaveLength(5);
    expect(items.map(providerOf)).toEqual([
      'crossref',
      'openlibrary',
      'openlibrary',
      'openlibrary',
      'openlibrary',
    ]);
    expect(items[0]!.DOI).toBeTruthy();
    expect(items[1]!.title).toBe('Deep Learning');
    for (const item of items) expect(item.title).toBeTruthy();
  });

  it('de-duplicates across and within providers', async () => {
    const items = await createSourceSearch({ fetch: fixtureFetch() }).search(
      'the structure of scientific revolutions',
      5,
    );
    const keys = items.map((i) => `${i.title?.toLowerCase()}|${i.DOI ?? i.ISBN}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(items.some((i) => providerOf(i) === 'crossref')).toBe(true);
    expect(items.some((i) => providerOf(i) === 'openlibrary')).toBe(true);
  });

  it('returns SourceSurfaced-shaped candidates, clamped to the schema bound', async () => {
    const search = createSourceSearch({ fetch: fixtureFetch() });
    const candidates = await search.searchCandidates('deep learning', 50);
    expect(candidates.length).toBeLessThanOrEqual(BOUNDS.searchMaxCandidates);
    for (const c of candidates) expect(SurfacedCandidateSchema.safeParse(c).success).toBe(true);
    expect(candidates[0]!.provider).toBe('crossref');
    expect(candidates[0]!.url).toMatch(/^https:\/\/doi\.org\//);
  });

  it('keeps going when one provider fails', async () => {
    const errors: string[] = [];
    const fetch = fixtureFetch({ [crossrefSearchUrl('deep learning', 5)]: response(500, 'oops') });
    const items = await createSourceSearch({
      fetch,
      onProviderError: (p) => errors.push(p),
    }).search('deep learning', 5);
    expect(errors).toEqual(['crossref']);
    expect(items.every((i) => providerOf(i) === 'openlibrary')).toBe(true);
    expect(items.length).toBeGreaterThan(0);
  });

  it('makes no request for an empty query or limit', async () => {
    const fetch = fixtureFetch();
    const search = createSourceSearch({ fetch });
    expect(await search.search('   ', 5)).toEqual([]);
    expect(await search.search('x', 0)).toEqual([]);
    expect(fetch.log).toHaveLength(0);
  });

  it('requests both providers with the limit', async () => {
    const fetch = fixtureFetch();
    await createSourceSearch({ fetch }).search('deep learning', 5);
    expect(fetch.log.map((l) => l.url).sort()).toEqual(
      [crossrefSearchUrl('deep learning', 5), openLibrarySearchUrl('deep learning', 5)].sort(),
    );
  });
});

describe('mergeResults', () => {
  const item = (id: string, extra: Partial<CslItem>): CslItem => ({ id, type: 'book', ...extra });

  it('dedupes by DOI (case-insensitive), ISBN-10/13, and title+author+year', () => {
    const merged = mergeResults(
      [
        [
          item('a', { title: 'X', DOI: '10.1/ABC' }),
          item('b', {
            title: 'The Book',
            author: [{ family: 'Doe' }],
            issued: { 'date-parts': [[2001]] },
          }),
        ],
        [
          item('c', { title: 'Y', DOI: '10.1/abc' }),
          item('d', {
            title: 'Book: A Subtitle',
            author: [{ family: 'Doe' }],
            issued: { 'date-parts': [[2001]] },
          }),
          item('e', { title: 'Z', ISBN: '0141439513' }),
          item('f', { title: 'Z again', ISBN: '9780141439518' }),
        ],
      ],
      10,
    );
    expect(merged.map((i) => i.id)).toEqual(['a', 'b', 'e']);
  });
});
