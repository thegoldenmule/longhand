/**
 * Legend numbers: words per provenance class, computed with the ledger's
 * `wordsByClass` / `projectWordsByClass` (a word whose characters span classes
 * takes the least trusted one), plus how the "typed from a suggestion" words
 * split by the kind of AI text they matched.
 */
import {
  attributeWords,
  projectWordsByClass,
  wordsByClass,
  type ClassCounts,
  type CountScope,
} from '@longhand/ledger';
import {
  runAt,
  type MatchedKind,
  type PMNode,
  type PMNodeJSON,
  type ProjectState,
  type ProvenanceRun,
} from '@longhand/schema';
import { CLASS_META, MATCHED_KIND_SHORT, TINT_CLASSES, type TintClass } from './classes';
import { formatShare } from './format';

/** One legend row. */
export interface LegendRow {
  cls: TintClass;
  label: string;
  count: number;
  /** count / total (0 when there are no words). */
  fraction: number;
  /** Display share ("12.5%"); never rounds a partial class to 0% or 100%. */
  share: string;
}

/** Typed-from-suggestion words by the kind of AI text they matched. */
export interface MatchedBreakdown {
  kind: MatchedKind;
  label: string;
  count: number;
}

/** What the legend shows. */
export interface LegendData {
  total: number;
  rows: LegendRow[];
  /** Typed-from-suggestion words by matched kind, largest first (empty when none). */
  matched: MatchedBreakdown[];
  /** The raw counts (all six classes). */
  counts: ClassCounts;
}

/** A document's content and runs, as `DocumentState` has them. */
export interface LegendDocument {
  content: PMNode | PMNodeJSON;
  provenance: readonly ProvenanceRun[];
}

/** Typed-from-suggestion word counts by matched kind for one document. */
export function matchedKindCounts(
  doc: PMNode | PMNodeJSON,
  runs: readonly ProvenanceRun[],
): Map<MatchedKind, number> {
  const out = new Map<MatchedKind, number>();
  for (const w of attributeWords(doc, runs)) {
    if (w.class !== 'typed-from-suggestion') continue;
    let kind: MatchedKind | undefined;
    for (let p = w.from; p < w.to && !kind; p++) {
      const r = runAt(runs, p);
      if (r?.class === 'typed-from-suggestion') kind = r.matchedKind;
    }
    if (kind) out.set(kind, (out.get(kind) ?? 0) + 1);
  }
  return out;
}

/** Legend data from counts (and an optional matched-kind breakdown). */
export function legendFromCounts(
  counts: ClassCounts,
  matched: ReadonlyMap<MatchedKind, number> = new Map(),
): LegendData {
  const total = counts.total;
  const rows = TINT_CLASSES.map((cls) => {
    const count = counts.byClass[cls] + (cls === 'pasted-external' ? counts.byClass['pasted-internal'] : 0);
    return {
      cls,
      label: CLASS_META[cls].label,
      count,
      fraction: total > 0 ? count / total : 0,
      share: formatShare(count, total),
    };
  });
  const breakdown = [...matched.entries()]
    .filter(([, n]) => n > 0)
    .map(([kind, count]) => ({ kind, label: MATCHED_KIND_SHORT[kind], count }))
    .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
  return { total, rows, matched: breakdown, counts };
}

/** Legend data for one document. */
export function documentLegend(doc: LegendDocument): LegendData {
  return legendFromCounts(
    wordsByClass(doc.content, doc.provenance),
    matchedKindCounts(doc.content, doc.provenance),
  );
}

/** The documents `projectWordsByClass` counts for a scope (same rules). */
function scopedDocuments(state: ProjectState, scope: CountScope) {
  if (scope.documentIds)
    return scope.documentIds.map((id) => state.documents[id]).filter((d) => d !== undefined);
  return Object.keys(state.documents)
    .sort()
    .map((id) => state.documents[id]!)
    .filter(
      (d) =>
        (scope.includeNotes || d.kind === 'manuscript') && (scope.includeArchived || !d.archived),
    );
}

/** Legend data across a project (default: non-archived manuscript documents). */
export function projectLegend(state: ProjectState, scope: CountScope = {}): LegendData {
  const matched = new Map<MatchedKind, number>();
  for (const d of scopedDocuments(state, scope)) {
    for (const [k, n] of matchedKindCounts(d.content, d.provenance))
      matched.set(k, (matched.get(k) ?? 0) + n);
  }
  return legendFromCounts(projectWordsByClass(state, scope), matched);
}
