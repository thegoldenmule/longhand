/**
 * Provenance: who wrote what, as runs over document positions.
 *
 * Provenance is derived only by the fold (`packages/ledger`), never stored as
 * editable marks. UI lanes consume {@link ProvenanceRun} arrays.
 *
 * ## Canonical form (what the fold must produce, byte for byte)
 * A *unit* is one position `p` whose content `[p, p+1)` is a text character or an
 * inline leaf node (`citation`, `hard_break`). Block boundaries, `scene_break` and
 * the open/close tokens of `footnote` nodes are not units.
 * - Runs are sorted by `from`, non-empty and non-overlapping.
 * - Every unit is covered by exactly one run; a run covers only units, so runs
 *   never span a block boundary or a footnote token.
 * - Two runs with `a.to === b.from` and equal `class`, `originSeq`, `suggestionId`
 *   and `moves` are merged.
 * - Optional fields are omitted when empty (`suggestionId` absent unless
 *   `typed-from-suggestion`; `moves` absent unless non-empty).
 * {@link checkProvenanceRuns} checks all of this.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { z } from 'zod';
import { IdSchema, PosSchema, SeqSchema } from './ids';

/**
 * Authorship classes (spec "Authorship classes"):
 * - `typed` — keyboard input in the editor. The writer's own.
 * - `typed-from-suggestion` — typed while a matching suggestion was open (normalized
 *   edit distance ≤ 0.15, or ≥ 4 consecutive matching words). Own, disclosed as AI-assisted.
 * - `pasted-external` — clipboard content not from this project. Not own; flagged with size.
 * - `pasted-internal` — copied from elsewhere in the project. **Never emitted as a run
 *   class:** internally pasted text inherits its source span's class (and keeps its
 *   original `originSeq`, adding the paste to `moves`). The value labels paste events
 *   in reports. Unverifiable internal pastes fold as `pasted-external`.
 * - `imported` — an existing draft brought in at creation. Unverified.
 * - `quoted` — clipping/quote block text and citation nodes. Quoted, not authored.
 */
export const ProvenanceClassSchema = z.enum([
  'typed',
  'typed-from-suggestion',
  'pasted-external',
  'pasted-internal',
  'imported',
  'quoted',
]);
/** Authorship class. */
export type ProvenanceClass = z.infer<typeof ProvenanceClassSchema>;
/** All classes, in legend order. */
export const PROVENANCE_CLASSES = ProvenanceClassSchema.options;

/** How each class counts, for legends and reports. */
export const PROVENANCE_CLASS_INFO: Readonly<
  Record<
    ProvenanceClass,
    {
      label: string;
      countsAsOwn: 'yes' | 'yes-ai-assisted' | 'no' | 'inherits' | 'unverified' | 'quoted';
    }
  >
> = {
  typed: { label: 'Typed', countsAsOwn: 'yes' },
  'typed-from-suggestion': { label: 'Typed from a suggestion', countsAsOwn: 'yes-ai-assisted' },
  'pasted-external': { label: 'Pasted (external)', countsAsOwn: 'no' },
  'pasted-internal': { label: 'Pasted (internal)', countsAsOwn: 'inherits' },
  imported: { label: 'Imported (unverified)', countsAsOwn: 'unverified' },
  quoted: { label: 'Quoted from a source', countsAsOwn: 'quoted' },
};

/** Zod schema for a {@link ProvenanceRun}. */
export const ProvenanceRunSchema = z.object({
  /** First position covered (inclusive). */
  from: PosSchema,
  /** Position after the last unit covered (exclusive). */
  to: PosSchema,
  class: ProvenanceClassSchema,
  /** Seq of the commit whose input put this text in the ledger (the TextEdited, DocumentImported…). */
  originSeq: SeqSchema,
  /** For `typed-from-suggestion`: the matched suggestion. */
  suggestionId: IdSchema.optional(),
  /** Seqs of commits that relocated or duplicated this text (accepted moves, internal pastes, drops), ascending. */
  moves: z.array(SeqSchema).min(1).optional(),
});
/** A run of text with one provenance. */
export type ProvenanceRun = z.infer<typeof ProvenanceRunSchema>;

/** Positions of every provenance unit in `doc`, ascending (see module docs). */
export function provenanceUnits(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isText) {
      for (let i = 0; i < (node.text as string).length; i++) out.push(pos + i);
    } else if (node.isInline && node.isLeaf) {
      out.push(pos);
    }
    return true;
  });
  return out;
}

function sameAttrs(a: ProvenanceRun, b: ProvenanceRun): boolean {
  return (
    a.class === b.class &&
    a.originSeq === b.originSeq &&
    a.suggestionId === b.suggestionId &&
    JSON.stringify(a.moves ?? []) === JSON.stringify(b.moves ?? [])
  );
}

/** Checks that `runs` is the canonical provenance of `doc`'s units. Returns an error message, or null if valid. */
export function checkProvenanceRuns(doc: PMNode, runs: readonly ProvenanceRun[]): string | null {
  const units = provenanceUnits(doc);
  let u = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i] as ProvenanceRun;
    if (r.to <= r.from) return `run ${i} is empty`;
    if ((r.class === 'typed-from-suggestion') !== (r.suggestionId !== undefined)) {
      return `run ${i}: suggestionId is required for, and only for, typed-from-suggestion`;
    }
    if (r.class === 'pasted-internal') return `run ${i}: pasted-internal is never a run class`;
    if (r.moves) {
      for (let k = 1; k < r.moves.length; k++) {
        if ((r.moves[k] as number) <= (r.moves[k - 1] as number))
          return `run ${i}: moves must be ascending`;
      }
    }
    if (i > 0) {
      const prev = runs[i - 1] as ProvenanceRun;
      if (r.from < prev.to) return `run ${i} overlaps or is out of order`;
      if (r.from === prev.to && sameAttrs(prev, r))
        return `runs ${i - 1} and ${i} should be merged`;
    }
    if (units[u] !== r.from)
      return `run ${i} starts at ${r.from}, expected the next unit at ${units[u] ?? 'none'}`;
    for (let p = r.from; p < r.to; p++, u++) {
      if (units[u] !== p) return `run ${i} covers ${p}, which is not a text unit`;
    }
  }
  if (u !== units.length)
    return `${units.length - u} unit(s) from position ${units[u]} are not covered`;
  return null;
}

/** The run covering position `pos` (binary search), or undefined. */
export function runAt(runs: readonly ProvenanceRun[], pos: number): ProvenanceRun | undefined {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid] as ProvenanceRun;
    if (pos < r.from) hi = mid - 1;
    else if (pos >= r.to) lo = mid + 1;
    else return r;
  }
  return undefined;
}
