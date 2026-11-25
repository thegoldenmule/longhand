/**
 * Source search for the `search_sources` tool. The research lane implements the
 * schema's `SourceSearch`, which returns `SurfacedCandidate`s with their provider;
 * the agent only calls it and records the candidates as AI-surfaced.
 */
import {
  BOUNDS,
  SurfacedCandidateSchema,
  type SourceSearch,
  type SurfacedCandidate,
} from '@longhand/schema';

/** Re-exported from `@longhand/schema` (import it from there). */
export type { SourceSearch } from '@longhand/schema';

/**
 * Checks search results before they become `SourceSurfaced.candidates`: drops any
 * that is not a valid `SurfacedCandidate` (results may have crossed the relay as
 * JSON) and keeps at most `BOUNDS.searchMaxCandidates`.
 */
export function toCandidates(items: readonly unknown[]): SurfacedCandidate[] {
  const out: SurfacedCandidate[] = [];
  for (const raw of items) {
    if (out.length >= BOUNDS.searchMaxCandidates) break;
    const parsed = SurfacedCandidateSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** A fixed-result search, for tests and demos. */
export class StaticSourceSearch implements SourceSearch {
  readonly queries: string[] = [];
  constructor(
    private readonly results: SurfacedCandidate[] | ((query: string) => SurfacedCandidate[]),
  ) {}
  async search(query: string, limit: number): Promise<SurfacedCandidate[]> {
    this.queries.push(query);
    const r = typeof this.results === 'function' ? this.results(query) : this.results;
    return r.slice(0, limit);
  }
}
