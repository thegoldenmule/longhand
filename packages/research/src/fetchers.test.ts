import { CslItemSchema } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { crossrefWorkUrl, fetchDoi } from './crossref';
import { MetadataError, USER_AGENT } from './http';
import { createMetadataClient } from './metadata';
import { fetchIsbn, openLibraryIsbnUrl } from './openlibrary';
import { fetchUrl, pageMetadataToCsl, scanHtml } from './page';
import { fixtureFetch, response } from './test-support/fixture-fetch';

const NOW = () => new Date('2026-11-24T12:00:00.000Z');

describe('Crossref DOI lookup (recorded responses)', () => {
  it('maps a journal article', async () => {
    const csl = await fetchDoi('https://doi.org/10.1038/nature14539', { fetch: fixtureFetch() });
    expect(csl).toMatchObject({
      id: 'doi:10.1038/nature14539',
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
      URL: 'https://doi.org/10.1038/nature14539',
    });
    expect(CslItemSchema.safeParse(csl).success).toBe(true);
  });

  it('maps a conference paper with a publisher place', async () => {
    const csl = await fetchDoi('10.1145/3442188.3445922', { fetch: fixtureFetch() });
    expect(csl.type).toBe('paper-conference');
    expect(csl.title).toMatch(/^On the Dangers of Stochastic Parrots/);
    expect(csl['container-title']).toMatch(/^Proceedings of the 2021 ACM Conference/);
    expect(csl['publisher-place']).toBe('New York, NY, USA');
    expect(csl.author).toHaveLength(4);
  });

  it('maps a book chapter with its ISBN', async () => {
    const csl = await fetchDoi('10.1007/978-3-030-58452-8_13', { fetch: fixtureFetch() });
    expect(csl.type).toBe('chapter');
    expect(csl.ISBN).toMatch(/^978/);
    expect(csl['container-title']).toBe('Lecture Notes in Computer Science');
  });

  it('reports a missing DOI as not-found', async () => {
    await expect(
      fetchDoi('10.5555/longhand-does-not-exist', { fetch: fixtureFetch() }),
    ).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('rejects input that is not a DOI without a request', async () => {
    const fetch = fixtureFetch();
    await expect(fetchDoi('nature', { fetch })).rejects.toBeInstanceOf(MetadataError);
    expect(fetch.log).toHaveLength(0);
  });

  it('identifies itself with a generic User-Agent and no contact details', async () => {
    const fetch = fixtureFetch();
    await fetchDoi('10.1038/nature14539', { fetch });
    expect(fetch.log[0]!.headers['User-Agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toBe('Longhand/0.1');
    expect(fetch.log[0]!.url).toBe(crossrefWorkUrl('10.1038/nature14539'));
    expect(fetch.log[0]!.url).not.toMatch(/mailto|@/);
  });

  it('can omit the User-Agent (browsers)', async () => {
    const fetch = fixtureFetch();
    await fetchDoi('10.1038/nature14539', { fetch, userAgent: null });
    expect(fetch.log[0]!.headers['User-Agent']).toBeUndefined();
  });

  it('turns network failures and server errors into MetadataErrors', async () => {
    const failing = async () => {
      throw new TypeError('fetch failed');
    };
    await expect(fetchDoi('10.1038/nature14539', { fetch: failing })).rejects.toMatchObject({
      code: 'network-error',
    });
    const url = crossrefWorkUrl('10.1038/nature14539');
    await expect(
      fetchDoi('10.1038/nature14539', { fetch: fixtureFetch({ [url]: response(503, 'busy') }) }),
    ).rejects.toMatchObject({ code: 'http-error', status: 503 });
    await expect(
      fetchDoi('10.1038/nature14539', { fetch: fixtureFetch({ [url]: response(200, '<html>') }) }),
    ).rejects.toMatchObject({ code: 'bad-response' });
  });
});

describe('Open Library ISBN lookup (recorded responses)', () => {
  it('maps a book', async () => {
    const csl = await fetchIsbn('978-0-262-03384-8', { fetch: fixtureFetch() });
    expect(csl).toMatchObject({
      id: 'isbn:9780262033848',
      type: 'book',
      title: 'Introduction to Algorithms',
      author: [
        { family: 'Cormen', given: 'Thomas H.' },
        { family: 'Leiserson', given: 'Charles E.' },
        { family: 'Rivest', given: 'Ronald L.' },
        { family: 'Stein', given: 'Clifford' },
      ],
      issued: { 'date-parts': [[2009]] },
      publisher: 'The MIT Press',
      ISBN: '9780262033848',
    });
    expect(CslItemSchema.safeParse(csl).success).toBe(true);
  });

  it('accepts ISBN-10 input', async () => {
    const csl = await fetchIsbn('0141439513', { fetch: fixtureFetch() });
    expect(csl.title).toBe('Pride and Prejudice');
    expect(csl.author).toEqual([{ family: 'Austen', given: 'Jane' }]);
    expect(csl.publisher).toBe('Penguin Books');
  });

  it('reports an unknown ISBN (Open Library answers {}) as not-found', async () => {
    const isbn = '9780306406157';
    const fetch = fixtureFetch({ [openLibraryIsbnUrl(isbn)]: response(200, '{}') });
    await expect(fetchIsbn(isbn, { fetch })).rejects.toMatchObject({ code: 'not-found' });
  });

  it('rejects an invalid check digit', async () => {
    await expect(fetchIsbn('9780262033849', { fetch: fixtureFetch() })).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });
});

describe('page metadata (recorded pages)', () => {
  it('reads Highwire citation_* tags (arXiv)', async () => {
    const csl = await fetchUrl('https://arxiv.org/abs/1706.03762', {
      fetch: fixtureFetch(),
      now: NOW,
    });
    expect(csl).toMatchObject({
      type: 'article',
      title: 'Attention Is All You Need',
      issued: { 'date-parts': [[2017, 6, 12]] },
      number: '1706.03762',
      accessed: { 'date-parts': [[2026, 11, 24]] },
      URL: 'https://arxiv.org/abs/1706.03762',
    });
    expect(csl.author?.[0]).toEqual({ family: 'Vaswani', given: 'Ashish' });
    expect(csl.author).toHaveLength(8);
  });

  it('reads JSON-LD and prefers the visible title (Wikipedia)', async () => {
    const csl = await fetchUrl('https://en.wikipedia.org/wiki/Typewriter', {
      fetch: fixtureFetch(),
      now: NOW,
    });
    expect(csl.title).toBe('Typewriter');
    expect(csl['container-title']).toBe('Wikipedia');
    expect(csl.issued?.['date-parts']?.[0]?.[0]).toBe(2002);
  });

  it('reads a JSON-LD NewsArticle (The New Yorker)', async () => {
    const csl = await fetchUrl('https://www.newyorker.com/magazine/2017/04/03/ai-versus-md', {
      fetch: fixtureFetch(),
      now: NOW,
    });
    expect(csl).toMatchObject({
      type: 'article-newspaper',
      title: 'A.I. Versus M.D.',
      'container-title': 'The New Yorker',
      author: [{ family: 'Mukherjee', given: 'Siddhartha' }],
    });
    expect(csl.issued?.['date-parts']?.[0]?.slice(0, 2)).toEqual([2017, 3]);
  });

  it('falls back to <title> (example.com)', async () => {
    const csl = await fetchUrl('https://example.com/', { fetch: fixtureFetch(), now: NOW });
    expect(csl).toMatchObject({
      type: 'webpage',
      title: 'Example Domain',
      URL: 'https://example.com/',
    });
    expect(csl.author).toBeUndefined();
  });

  it('refuses non-HTML responses', async () => {
    const url = 'https://example.org/paper.pdf';
    const fetch = fixtureFetch({ [url]: response(200, '%PDF', 'application/pdf') });
    await expect(fetchUrl(url, { fetch })).rejects.toMatchObject({ code: 'bad-response' });
  });

  it('reads Open Graph, Dublin Core and author meta, ignoring comments', () => {
    const html = `<!doctype html><html lang="en-GB"><head>
      <!-- <meta name="citation_title" content="Commented out"> -->
      <title>Ignored | Field Notes</title>
      <meta property="og:title" content="On Longhand &amp; Memory">
      <meta property="og:site_name" content="Field Notes">
      <meta property="og:type" content="article">
      <meta name="author" content="Ada Lovelace">
      <meta property="article:published_time" content="2024-02-03T10:00:00Z">
      <link rel="canonical" href="/posts/longhand">
    </head><body></body></html>`;
    const csl = pageMetadataToCsl(scanHtml(html), 'https://notes.example.org/p?id=1');
    expect(csl).toMatchObject({
      type: 'article',
      title: 'On Longhand & Memory',
      'container-title': 'Field Notes',
      author: [{ family: 'Lovelace', given: 'Ada' }],
      issued: { 'date-parts': [[2024, 2, 3]] },
      URL: 'https://notes.example.org/posts/longhand',
      language: 'en-GB',
    });
  });
});

describe('createMetadataClient', () => {
  it('classifies input and returns the SourceAdded origin', async () => {
    const client = createMetadataClient({ fetch: fixtureFetch(), now: NOW });
    expect((await client.lookup('doi:10.1038/nature14539')).origin).toEqual({
      kind: 'doi',
      value: '10.1038/nature14539',
    });
    const isbn = await client.lookup('0-262-03384-4');
    expect(isbn.origin).toEqual({ kind: 'isbn', value: '9780262033848' });
    expect(isbn.provider).toBe('openlibrary');
    const page = await client.lookup('example.com');
    expect(page.origin).toEqual({ kind: 'url', value: 'https://example.com/' });
    expect(page.provider).toBe('web');
    await expect(client.lookup('my notes')).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('routes page fetches through pageFetch when given', async () => {
    const api = fixtureFetch();
    const proxy = fixtureFetch();
    const client = createMetadataClient({ fetch: api, pageFetch: proxy, now: NOW });
    await client.fetchUrl('https://example.com/');
    await client.fetchDoi('10.1038/nature14539');
    expect(proxy.log.map((l) => l.url)).toEqual(['https://example.com/']);
    expect(api.log.map((l) => l.url)).toEqual([crossrefWorkUrl('10.1038/nature14539')]);
  });
});
