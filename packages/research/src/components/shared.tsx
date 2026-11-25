import type { CslItem, SourceState } from '@longhand/schema';
import { sourceLabel } from '../csl';
import type { DraftContext, ResearchDraft } from '../drafts';
import { doiKey, normalizeIsbn, normalizeUrl } from '../identifiers';
import { sourceTypeLabel } from '../manual';

/** Props every component that emits drafts takes. */
export interface DraftProps {
  /** Envelope fields for the drafts this component builds. */
  draftContext: DraftContext;
  /** Receives each commit draft; the host queues it for the ledger service. */
  onDraft: (draft: ResearchDraft) => void;
}

/** A record keyed by id, or a list. */
export type Collection<T> = readonly T[] | Readonly<Record<string, T>>;

/** Normalizes a {@link Collection} to a list. */
export function toList<T>(c: Collection<T> | undefined): T[] {
  if (!c) return [];
  return Array.isArray(c) ? [...(c as readonly T[])] : Object.values(c as Record<string, T>);
}

/** Library sources sorted by first author (or title), then year. Archived ones last. */
export function sortSources(sources: SourceState[]): SourceState[] {
  const key = (s: SourceState): string => {
    const n = s.csl.author?.[0] ?? s.csl.editor?.[0];
    return `${s.archived ? 1 : 0}|${(n?.family ?? n?.literal ?? s.csl.title ?? '').toLowerCase()}|${s.csl.title ?? ''}`;
  };
  return [...sources].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** The library source that is the same work as `csl` (by DOI, ISBN or URL), if any. */
export function findDuplicate(sources: SourceState[], csl: CslItem): SourceState | null {
  const doi = csl.DOI ? doiKey(csl.DOI) : null;
  const isbn = csl.ISBN ? normalizeIsbn(csl.ISBN) : null;
  const url = csl.URL ? normalizeUrl(csl.URL) : null;
  return (
    sources.find(
      (s) =>
        !s.archived &&
        ((doi !== null && s.csl.DOI !== undefined && doiKey(s.csl.DOI) === doi) ||
          (isbn !== null && s.csl.ISBN !== undefined && normalizeIsbn(s.csl.ISBN) === isbn) ||
          (url !== null && s.csl.URL !== undefined && normalizeUrl(s.csl.URL) === url)),
    ) ?? null
  );
}

/** Title, byline and type of a CSL item. */
export function SourceSummary({ csl }: { csl: CslItem }) {
  const { title, byline } = sourceLabel(csl);
  return (
    <span className="lh-research-summary">
      <span className="lh-research-summary-title">{title}</span>
      {byline ? <span className="lh-research-summary-byline">{byline}</span> : null}
      <span className="lh-research-summary-type">{sourceTypeLabel(csl.type)}</span>
    </span>
  );
}

/** The label every AI-surfaced, not-yet-verified source carries. */
export const AI_SURFACED_LABEL = 'AI-surfaced — unverified';

/** Badge marking AI-surfaced, unverified material. */
export function AiSurfacedBadge() {
  return (
    <span className="lh-research-ai-badge" data-ai-surfaced="">
      {AI_SURFACED_LABEL}
    </span>
  );
}
