/**
 * Word attribution, shared by the report, provenance-ui and export.
 *
 * Words are the `tokenizeWords` tokens of each block's inline text (textblocks and
 * footnotes, by the anchor rules). A word whose characters carry more than one
 * class takes the **least trusted** one, in the order
 * `pasted-external` < `imported` < `quoted` < `typed-from-suggestion` < `typed`
 * (BUILD.md, coordinator decisions). A character with no run (never produced by
 * the fold) counts as `pasted-external`: never overclaim.
 */
import {
  PROVENANCE_CLASSES,
  docFromJSON,
  runAt,
  segmentDoc,
  tokenizeWords,
  type PMNode,
  type PMNodeJSON,
  type ProjectState,
  type ProvenanceClass,
  type ProvenanceRun,
} from '@longhand/schema';
import { TRUST_ORDER, type RunClass } from './prov';

/** One attributed word. */
export interface WordAttribution {
  /** Position of the first character. */
  from: number;
  /** Position after the last character. */
  to: number;
  text: string;
  class: RunClass;
  /** Block id (`p3`, `fn1`) in the attributed version. */
  blockId: string;
  /** Distinct `originSeq`s of its characters, ascending. */
  originSeqs: number[];
  /** Suggestion ids of its `typed-from-suggestion` characters, if any. */
  suggestionIds?: string[];
}

/** Counts per class (all six classes present; `pasted-internal` is always 0). */
export interface ClassCounts {
  total: number;
  byClass: Record<ProvenanceClass, number>;
}

function toNode(doc: PMNode | PMNodeJSON): PMNode {
  return 'nodeSize' in doc ? (doc as PMNode) : docFromJSON(doc);
}

function emptyCounts(): ClassCounts {
  const byClass = Object.fromEntries(PROVENANCE_CLASSES.map((c) => [c, 0])) as Record<
    ProvenanceClass,
    number
  >;
  return { total: 0, byClass };
}

/** Run lookup by position (binary search). */
function runCursor(runs: readonly ProvenanceRun[]) {
  return (pos: number): ProvenanceRun | undefined => runAt(runs, pos);
}

/** Attributes every word of `doc` to one class (see module docs). */
export function attributeWords(
  doc: PMNode | PMNodeJSON,
  runs: readonly ProvenanceRun[],
): WordAttribution[] {
  const seg = segmentDoc(toNode(doc));
  const at = runCursor(runs);
  const out: WordAttribution[] = [];
  for (const block of [...seg.blocks, ...seg.footnotes]) {
    for (const tok of tokenizeWords(block.text)) {
      let cls: RunClass = 'typed';
      const seqs = new Set<number>();
      const sugs = new Set<string>();
      for (let i = tok.start; i < tok.end; i++) {
        const r = at(block.charPos[i] as number);
        const c: RunClass = r
          ? r.class === 'pasted-internal'
            ? 'pasted-external'
            : r.class
          : 'pasted-external';
        if (TRUST_ORDER[c] < TRUST_ORDER[cls]) cls = c;
        if (r) seqs.add(r.originSeq);
        if (r?.suggestionId) sugs.add(r.suggestionId);
      }
      const w: WordAttribution = {
        from: block.charPos[tok.start] as number,
        to: (block.charPos[tok.end - 1] as number) + 1,
        text: tok.text,
        class: cls,
        blockId: block.id,
        originSeqs: [...seqs].sort((a, b) => a - b),
      };
      if (sugs.size > 0) w.suggestionIds = [...sugs].sort();
      out.push(w);
    }
  }
  return out;
}

/** Words per class of one document. */
export function wordsByClass(
  doc: PMNode | PMNodeJSON,
  runs: readonly ProvenanceRun[],
): ClassCounts {
  const counts = emptyCounts();
  for (const w of attributeWords(doc, runs)) {
    counts.byClass[w.class] += 1;
    counts.total += 1;
  }
  return counts;
}

/**
 * Characters per class of one document: every character of the inline text
 * (text characters and hard breaks, UTF-16 code units; citations and block
 * boundaries excluded).
 */
export function charactersByClass(
  doc: PMNode | PMNodeJSON,
  runs: readonly ProvenanceRun[],
): ClassCounts {
  const seg = segmentDoc(toNode(doc));
  const at = runCursor(runs);
  const counts = emptyCounts();
  for (const block of [...seg.blocks, ...seg.footnotes]) {
    for (const p of block.charPos) {
      const r = at(p);
      const c: RunClass = r && r.class !== 'pasted-internal' ? r.class : 'pasted-external';
      counts.byClass[c] += 1;
      counts.total += 1;
    }
  }
  return counts;
}

/** Sums class counts. */
export function addCounts(a: ClassCounts, b: ClassCounts): ClassCounts {
  const out = emptyCounts();
  for (const c of PROVENANCE_CLASSES) out.byClass[c] = a.byClass[c] + b.byClass[c];
  out.total = a.total + b.total;
  return out;
}

/** Which documents a project-level count covers. */
export interface CountScope {
  /** Explicit documents (overrides the filters below). */
  documentIds?: readonly string[];
  /** Include notes (default false). */
  includeNotes?: boolean;
  /** Include archived documents (default false). */
  includeArchived?: boolean;
}

function scopedDocs(state: ProjectState, scope: CountScope) {
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

/** Words per class across a project's documents (default: non-archived manuscript documents). */
export function projectWordsByClass(state: ProjectState, scope: CountScope = {}): ClassCounts {
  return scopedDocs(state, scope).reduce(
    (acc, d) => addCounts(acc, wordsByClass(d.content, d.provenance)),
    emptyCounts(),
  );
}

/** Characters per class across a project's documents (same scope rules). */
export function projectCharactersByClass(state: ProjectState, scope: CountScope = {}): ClassCounts {
  return scopedDocs(state, scope).reduce(
    (acc, d) => addCounts(acc, charactersByClass(d.content, d.provenance)),
    emptyCounts(),
  );
}
