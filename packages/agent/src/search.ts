/**
 * Source search for the `search_sources` tool. The research lane implements
 * {@link SourceSearch}; the agent only calls it and labels results AI-surfaced.
 */
import { BOUNDS, CslItemSchema, type CslItem, type SurfacedCandidate } from '@longhand/schema';

/** Searches Crossref / Open Library / the web for candidate sources. */
export interface SourceSearch {
  search(query: string, limit: number): Promise<CslItem[]>;
}

/**
 * Turns search results into `SourceSurfaced` candidates: drops items that are not
 * valid CSL-JSON, keeps at most `BOUNDS.searchMaxCandidates`, and infers the
 * provider (DOI → crossref, ISBN → openlibrary, else web) since `SourceSearch`
 * returns bare CSL items.
 */
export function toCandidates(items: readonly unknown[]): SurfacedCandidate[] {
  const out: SurfacedCandidate[] = [];
  for (const raw of items) {
    if (out.length >= BOUNDS.searchMaxCandidates) break;
    const parsed = CslItemSchema.safeParse(raw);
    if (!parsed.success) continue;
    const csl = parsed.data;
    const provider: SurfacedCandidate['provider'] = csl.DOI
      ? 'crossref'
      : csl.ISBN
        ? 'openlibrary'
        : 'web';
    const url = csl.URL ?? (csl.DOI ? `https://doi.org/${csl.DOI}` : null);
    out.push({ csl, provider, url: url && url.length <= 2000 ? url : null });
  }
  return out;
}

/** A fixed-result search, for tests and demos. */
export class StaticSourceSearch implements SourceSearch {
  readonly queries: string[] = [];
  constructor(private readonly results: CslItem[] | ((query: string) => CslItem[])) {}
  async search(query: string, limit: number): Promise<CslItem[]> {
    this.queries.push(query);
    const r = typeof this.results === 'function' ? this.results(query) : this.results;
    return r.slice(0, limit);
  }
}
