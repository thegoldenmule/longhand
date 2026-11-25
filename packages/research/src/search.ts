/**
 * Candidate-source search for the AI `search_sources` tool and the Sources panel:
 * Crossref works search and Open Library search, run in parallel, interleaved and
 * de-duplicated.
 */
import { BOUNDS, type CslItem, type SourceSearch, type SurfacedCandidate } from '@longhand/schema';
import { searchCrossref } from './crossref';
import { yearOf } from './csl';
import type { HttpOptions } from './http';
import { doiKey, normalizeIsbn } from './identifiers';
import type { MetadataProvider } from './metadata';
import { searchOpenLibrary } from './openlibrary';

/** Options for {@link createSourceSearch}. */
export interface SourceSearchOptions extends HttpOptions {
  /** Which providers to query. Defaults to both. */
  providers?: Array<'crossref' | 'openlibrary'>;
  /**
   * How many results to request from each provider. Defaults to `limit` (so each
   * provider alone could fill the result), capped at 20.
   */
  perProvider?: number;
  /** Called when a provider fails; the search continues with the others. */
  onProviderError?: (provider: 'crossref' | 'openlibrary', error: unknown) => void;
}

/**
 * The schema's `SourceSearch` (what the agent lane's `search_sources` handler
 * consumes): `search` returns `SurfacedCandidate`s with their provider, ready for
 * `SourceSurfaced.candidates` (`limit` is clamped to `BOUNDS.searchMaxCandidates`).
 * `searchItems` returns the bare CSL items, unclamped, for the Sources panel.
 */
export interface LonghandSourceSearch extends SourceSearch {
  searchItems(query: string, limit: number): Promise<CslItem[]>;
}

/** Normalized title for duplicate detection: ASCII-lowercased, punctuation and articles dropped. */
function titleKey(title: string | undefined): string {
  return (title ?? '')
    .toLowerCase()
    .split(':')[0]!
    .replace(/[^a-z0-9À-￿]+/g, ' ')
    .replace(/\b(?:the|a|an)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstFamily(item: CslItem): string {
  const n = item.author?.[0] ?? item.editor?.[0];
  return (n?.family ?? n?.literal ?? '').toLowerCase();
}

/** Keys under which two items count as the same work. */
function dedupeKeys(item: CslItem): string[] {
  const keys: string[] = [];
  if (item.DOI) keys.push(`doi:${doiKey(item.DOI)}`);
  const isbn = item.ISBN ? normalizeIsbn(item.ISBN) : null;
  if (isbn) keys.push(`isbn:${isbn}`);
  const t = titleKey(item.title);
  if (t) keys.push(`t:${t}|${firstFamily(item)}|${yearOf(item.issued) ?? ''}`);
  return keys;
}

/** Interleaves result lists (first of each, then second of each…) and drops duplicates. */
export function mergeResults(lists: CslItem[][], limit: number): CslItem[] {
  const seen = new Set<string>();
  const out: CslItem[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const list of lists) {
      const item = list[i];
      if (!item || out.length >= limit) continue;
      const keys = dedupeKeys(item);
      if (keys.some((k) => seen.has(k))) continue;
      keys.forEach((k) => seen.add(k));
      out.push(item);
    }
  }
  return out;
}

/** Which provider an item came from (set by this package's fetchers in CSL `source`). */
export function providerOf(item: CslItem): MetadataProvider {
  const src = typeof item.source === 'string' ? item.source : '';
  if (src === 'Crossref') return 'crossref';
  if (src === 'Open Library') return 'openlibrary';
  return 'web';
}

/** Shapes a search result as a `SurfacedCandidate`. */
export function toSurfacedCandidate(item: CslItem): SurfacedCandidate {
  const url = item.URL ?? (item.DOI ? `https://doi.org/${item.DOI}` : null);
  return { csl: item, provider: providerOf(item), url: url && url.length <= 2000 ? url : null };
}

/** Creates the Crossref + Open Library `SourceSearch`. */
export function createSourceSearch(opts: SourceSearchOptions = {}): LonghandSourceSearch {
  const providers = opts.providers ?? ['crossref', 'openlibrary'];
  const run = async (query: string, limit: number): Promise<CslItem[]> => {
    const q = query.trim();
    const n = Math.max(0, Math.floor(limit));
    if (q === '' || n === 0) return [];
    const per = Math.min(20, Math.max(1, opts.perProvider ?? n));
    const lists = await Promise.all(
      providers.map(async (p) => {
        try {
          return p === 'crossref'
            ? await searchCrossref(q, per, opts)
            : await searchOpenLibrary(q, per, opts);
        } catch (err) {
          opts.onProviderError?.(p, err);
          return [];
        }
      }),
    );
    return mergeResults(lists, n);
  };
  return {
    searchItems: run,
    async search(query, limit) {
      const items = await run(query, Math.min(limit, BOUNDS.searchMaxCandidates));
      return items.map(toSurfacedCandidate);
    },
  };
}
