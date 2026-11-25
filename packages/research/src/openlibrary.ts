/**
 * Open Library: ISBN lookup (Books API, `jscmd=data`) and search
 * (`openlibrary.org/search.json`), normalized to CSL-JSON.
 */
import type { CslItem } from '@longhand/schema';
import { cleanText, compact, parseDate, parseName, type CslName } from './csl';
import { getJson, MetadataError, type HttpOptions } from './http';
import { normalizeIsbn } from './identifiers';

/** Open Library base URL. */
export const OPEN_LIBRARY = 'https://openlibrary.org';

/** Fields requested from Open Library search (keeps responses small). */
export const OPEN_LIBRARY_SEARCH_FIELDS = [
  'key',
  'title',
  'subtitle',
  'author_name',
  'first_publish_year',
  'publisher',
  'publish_place',
  'isbn',
  'number_of_pages_median',
  'language',
] as const;

/** URL of the Books API record for an ISBN. */
export function openLibraryIsbnUrl(isbn: string): string {
  const q = new URLSearchParams({ bibkeys: `ISBN:${isbn}`, format: 'json', jscmd: 'data' });
  return `${OPEN_LIBRARY}/api/books?${q.toString()}`;
}

/** URL of an Open Library search. */
export function openLibrarySearchUrl(query: string, limit: number): string {
  const q = new URLSearchParams({
    q: query,
    limit: String(limit),
    fields: OPEN_LIBRARY_SEARCH_FIELDS.join(','),
  });
  return `${OPEN_LIBRARY}/search.json?${q.toString()}`;
}

/** The Books API (`jscmd=data`) fields this package reads. */
export interface OpenLibraryBook {
  url?: string;
  key?: string;
  title?: string;
  subtitle?: string;
  authors?: Array<{ name?: string; url?: string }>;
  publishers?: Array<{ name?: string }>;
  publish_places?: Array<{ name?: string }>;
  publish_date?: string;
  number_of_pages?: number;
  identifiers?: { isbn_13?: string[]; isbn_10?: string[] };
}

/** An Open Library search document (the requested fields). */
export interface OpenLibraryDoc {
  key?: string;
  title?: string;
  subtitle?: string;
  author_name?: string[];
  first_publish_year?: number;
  publisher?: string[];
  publish_place?: string[];
  isbn?: string[];
  number_of_pages_median?: number;
  language?: string[];
}

function authorNames(raw: Array<string | undefined>): CslName[] {
  return raw
    .map((n) => (n === undefined ? null : parseName(n)))
    .filter((n): n is CslName => n !== null);
}

function fullTitle(title: string | undefined, subtitle: string | undefined): string | undefined {
  if (!title) return undefined;
  const t = cleanText(title);
  return subtitle ? `${t}: ${cleanText(subtitle)}` : t;
}

function bestIsbn(isbns: string[] | undefined): string | undefined {
  if (!isbns) return undefined;
  const normalized = isbns.map((i) => normalizeIsbn(i)).filter((i): i is string => i !== null);
  return normalized[0];
}

/** Converts a Books API record to CSL-JSON. */
export function openLibraryBookToCsl(book: OpenLibraryBook, isbn: string, id?: string): CslItem {
  return compact({
    id: id ?? `isbn:${isbn}`,
    type: 'book',
    title: fullTitle(book.title, book.subtitle),
    author: authorNames((book.authors ?? []).map((a) => a.name)),
    issued: parseDate(book.publish_date) ?? undefined,
    publisher: book.publishers?.[0]?.name,
    'publisher-place': book.publish_places?.[0]?.name,
    'number-of-pages': book.number_of_pages,
    ISBN: isbn,
    URL: book.url,
    source: 'Open Library',
  } as CslItem);
}

/** Converts an Open Library search document (a work) to CSL-JSON. */
export function openLibraryDocToCsl(doc: OpenLibraryDoc, id?: string): CslItem {
  const isbn = bestIsbn(doc.isbn);
  return compact({
    id: id ?? (doc.key ? `openlibrary:${doc.key}` : 'openlibrary'),
    type: 'book',
    title: fullTitle(doc.title, doc.subtitle),
    author: authorNames(doc.author_name ?? []),
    issued: doc.first_publish_year ? { 'date-parts': [[doc.first_publish_year]] } : undefined,
    publisher: doc.publisher?.[0],
    'publisher-place': doc.publish_place?.[0],
    'number-of-pages': doc.number_of_pages_median,
    ISBN: isbn,
    URL: doc.key ? `${OPEN_LIBRARY}${doc.key}` : undefined,
    source: 'Open Library',
  } as CslItem);
}

/** Looks up an ISBN-10 or ISBN-13 on Open Library. Throws {@link MetadataError}. */
export async function fetchIsbn(input: string, opts: HttpOptions = {}): Promise<CslItem> {
  const isbn = normalizeIsbn(input);
  if (!isbn) throw new MetadataError('invalid-input', `"${input}" is not a valid ISBN.`);
  const json = await getJson(openLibraryIsbnUrl(isbn), opts);
  if (!json || typeof json !== 'object') {
    throw new MetadataError('bad-response', 'Open Library returned an unexpected response.');
  }
  const book = (json as Record<string, OpenLibraryBook | undefined>)[`ISBN:${isbn}`];
  if (!book) throw new MetadataError('not-found', `Open Library has no record of ISBN ${isbn}.`);
  return openLibraryBookToCsl(book, isbn);
}

/** Searches Open Library. Returns CSL items in Open Library's relevance order. */
export async function searchOpenLibrary(
  query: string,
  limit: number,
  opts: HttpOptions = {},
): Promise<CslItem[]> {
  const json = await getJson(openLibrarySearchUrl(query, limit), opts);
  const docs = (json as { docs?: OpenLibraryDoc[] } | null)?.docs;
  if (!Array.isArray(docs)) {
    throw new MetadataError('bad-response', 'Open Library returned an unexpected search response.');
  }
  return docs.filter((d) => d.title).map((d) => openLibraryDocToCsl(d));
}
