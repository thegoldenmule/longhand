/**
 * Crossref: DOI lookup (`api.crossref.org/works/{doi}`) and bibliographic search
 * (`api.crossref.org/works?query.bibliographic=…`), normalized to CSL-JSON.
 */
import type { CslItem } from '@longhand/schema';
import { cleanText, compact, type CslDate, type CslName } from './csl';
import { getJson, MetadataError, type HttpOptions } from './http';
import { normalizeDoi } from './identifiers';

/** Crossref REST API base. */
export const CROSSREF_API = 'https://api.crossref.org';

/** Fields requested from Crossref search (keeps responses small). */
export const CROSSREF_SEARCH_FIELDS = [
  'DOI',
  'type',
  'title',
  'subtitle',
  'author',
  'editor',
  'issued',
  'published-print',
  'published-online',
  'container-title',
  'publisher',
  'publisher-location',
  'volume',
  'issue',
  'page',
  'ISBN',
  'ISSN',
  'URL',
] as const;

/** URL of the Crossref record for a DOI. */
export function crossrefWorkUrl(doi: string): string {
  return `${CROSSREF_API}/works/${encodeURIComponent(doi)}`;
}

/** URL of a Crossref bibliographic search. */
export function crossrefSearchUrl(query: string, rows: number): string {
  const q = new URLSearchParams({
    'query.bibliographic': query,
    rows: String(rows),
    select: CROSSREF_SEARCH_FIELDS.join(','),
  });
  return `${CROSSREF_API}/works?${q.toString()}`;
}

const TYPE_MAP: Record<string, string> = {
  'journal-article': 'article-journal',
  'book-chapter': 'chapter',
  'book-section': 'chapter',
  'book-part': 'chapter',
  'proceedings-article': 'paper-conference',
  book: 'book',
  monograph: 'book',
  'edited-book': 'book',
  'reference-book': 'book',
  'book-set': 'book',
  'posted-content': 'article',
  dissertation: 'thesis',
  report: 'report',
  'report-component': 'report',
  dataset: 'dataset',
  'reference-entry': 'entry-encyclopedia',
  standard: 'standard',
  'peer-review': 'review',
};

interface CrossrefPerson {
  given?: string;
  family?: string;
  name?: string;
  suffix?: string;
}

type CrossrefDate = { 'date-parts'?: Array<Array<number | null>> };

/** The Crossref `message` fields this package reads. */
export interface CrossrefWork {
  DOI?: string;
  type?: string;
  title?: string[];
  subtitle?: string[];
  author?: CrossrefPerson[];
  editor?: CrossrefPerson[];
  issued?: CrossrefDate;
  'published-print'?: CrossrefDate;
  'published-online'?: CrossrefDate;
  'container-title'?: string[];
  publisher?: string;
  'publisher-location'?: string;
  volume?: string;
  issue?: string;
  page?: string;
  ISBN?: string[];
  ISSN?: string[];
  URL?: string;
  abstract?: string;
  language?: string;
}

function names(people: CrossrefPerson[] | undefined): CslName[] | undefined {
  if (!people) return undefined;
  const out: CslName[] = [];
  for (const p of people) {
    if (p.family) {
      const n: CslName = { family: cleanText(p.family) };
      if (p.given) n.given = cleanText(p.given);
      if (p.suffix) n.suffix = p.suffix;
      out.push(n);
    } else if (p.name) {
      out.push({ literal: cleanText(p.name) });
    }
  }
  return out;
}

function date(...candidates: Array<CrossrefDate | undefined>): CslDate | undefined {
  for (const c of candidates) {
    const parts = c?.['date-parts']?.[0]?.filter((x): x is number => typeof x === 'number');
    if (parts && parts.length > 0) return { 'date-parts': [parts.slice(0, 3)] };
  }
  return undefined;
}

function first(xs: string[] | undefined): string | undefined {
  const x = xs?.find((s) => s.trim() !== '');
  return x === undefined ? undefined : cleanText(x);
}

/** Converts a Crossref work to CSL-JSON. `id` defaults to `doi:<DOI>`. */
export function crossrefWorkToCsl(work: CrossrefWork, id?: string): CslItem {
  const title = first(work.title);
  const subtitle = first(work.subtitle);
  const fullTitle =
    title && subtitle && !title.toLowerCase().includes(subtitle.toLowerCase())
      ? `${title}: ${subtitle}`
      : title;
  const csl = compact({
    id: id ?? (work.DOI ? `doi:${work.DOI}` : 'crossref'),
    type: TYPE_MAP[work.type ?? ''] ?? 'article',
    title: fullTitle,
    'container-title': first(work['container-title']),
    author: names(work.author),
    editor: names(work.editor),
    issued: date(work.issued, work['published-print'], work['published-online']),
    publisher: work.publisher ? cleanText(work.publisher) : undefined,
    'publisher-place': work['publisher-location'],
    volume: work.volume,
    issue: work.issue,
    page: work.page,
    DOI: work.DOI,
    ISBN: work.ISBN?.[0],
    ISSN: work.ISSN?.[0],
    URL: work.DOI ? `https://doi.org/${work.DOI}` : work.URL,
    abstract: work.abstract ? cleanText(work.abstract) : undefined,
    language: work.language,
    source: 'Crossref',
  } as CslItem);
  return csl;
}

/** Looks up a DOI on Crossref and returns its CSL-JSON. Throws {@link MetadataError}. */
export async function fetchDoi(input: string, opts: HttpOptions = {}): Promise<CslItem> {
  const doi = normalizeDoi(input);
  if (!doi) throw new MetadataError('invalid-input', `"${input}" is not a DOI.`);
  let json: unknown;
  try {
    json = await getJson(crossrefWorkUrl(doi), opts);
  } catch (err) {
    if (err instanceof MetadataError && err.code === 'not-found') {
      throw new MetadataError('not-found', `Crossref has no record of DOI ${doi}.`, 404);
    }
    throw err;
  }
  const message = (json as { message?: CrossrefWork } | null)?.message;
  if (!message || typeof message !== 'object') {
    throw new MetadataError('bad-response', 'Crossref returned an unexpected response.');
  }
  return crossrefWorkToCsl(message);
}

/** Searches Crossref works. Returns CSL items in Crossref's relevance order. */
export async function searchCrossref(
  query: string,
  limit: number,
  opts: HttpOptions = {},
): Promise<CslItem[]> {
  const json = await getJson(crossrefSearchUrl(query, limit), opts);
  const items = (json as { message?: { items?: CrossrefWork[] } } | null)?.message?.items;
  if (!Array.isArray(items)) {
    throw new MetadataError('bad-response', 'Crossref returned an unexpected search response.');
  }
  return items.filter((w) => (w.title?.length ?? 0) > 0).map((w) => crossrefWorkToCsl(w));
}
