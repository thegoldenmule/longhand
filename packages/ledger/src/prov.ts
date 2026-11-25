/**
 * Internal provenance attributes and runs.
 *
 * The fold keeps provenance as sorted runs `{from, to, p}` over document positions.
 * `p` is an immutable {@link Prov} shared between runs. Public output
 * ({@link toPublicRuns}) is the canonical `ProvenanceRun[]` form from
 * `@longhand/schema`.
 */
import type { ProvenanceClass, ProvenanceRun } from '@longhand/schema';

/** Classes that can appear on a run (`pasted-internal` never does: internal pastes inherit). */
export type RunClass = Exclude<ProvenanceClass, 'pasted-internal'>;

/** Provenance of one unit. Immutable; shared between runs. */
export interface Prov {
  readonly class: RunClass;
  readonly originSeq: number;
  readonly suggestionId?: string;
  readonly moves?: readonly number[];
  /**
   * Internal only: marks units awaiting verification at the end of an input-method
   * run (internal paste, drop, citation, clipping). Never survives a commit.
   */
  readonly pend?: object;
}

/** A run of units sharing one provenance. `from < to`. */
export interface IRun {
  readonly from: number;
  readonly to: number;
  readonly p: Prov;
}

/** Trust order used by word attribution: lower is less trusted. */
export const TRUST_ORDER: Readonly<Record<RunClass, number>> = {
  'pasted-external': 0,
  imported: 1,
  quoted: 2,
  'typed-from-suggestion': 3,
  typed: 4,
};

/** Builds a Prov, omitting empty optional fields. */
export function prov(
  cls: RunClass,
  originSeq: number,
  suggestionId?: string,
  moves?: readonly number[],
): Prov {
  const p: { -readonly [K in keyof Prov]: Prov[K] } = { class: cls, originSeq };
  if (suggestionId !== undefined && cls === 'typed-from-suggestion') p.suggestionId = suggestionId;
  if (moves !== undefined && moves.length > 0) p.moves = moves;
  return p;
}

/** True if two provenances are equal (pending tokens compare by identity). */
export function sameProv(a: Prov, b: Prov): boolean {
  if (a === b) return true;
  if (a.class !== b.class || a.originSeq !== b.originSeq || a.suggestionId !== b.suggestionId) {
    return false;
  }
  if (a.pend !== b.pend) return false;
  const am = a.moves ?? [];
  const bm = b.moves ?? [];
  if (am.length !== bm.length) return false;
  for (let i = 0; i < am.length; i++) if (am[i] !== bm[i]) return false;
  return true;
}

/** The same provenance with `seq` added to `moves` (kept ascending, no duplicates). */
export function withMove(p: Prov, seq: number): Prov {
  const moves = p.moves ?? [];
  if (moves.includes(seq)) return p;
  const next = [...moves, seq].sort((x, y) => x - y);
  return prov(p.class, p.originSeq, p.suggestionId, next);
}

/** The same provenance upgraded to `typed-from-suggestion` (only from `typed`). */
export function asFromSuggestion(p: Prov, suggestionId: string): Prov {
  if (p.class !== 'typed') return p;
  return prov('typed-from-suggestion', p.originSeq, suggestionId, p.moves);
}

/** Merges adjacent runs with equal provenance. Input must be sorted and non-overlapping. */
export function canonicalRuns(runs: readonly IRun[]): IRun[] {
  const out: IRun[] = [];
  for (const r of runs) {
    if (r.to <= r.from) continue;
    const last = out[out.length - 1];
    if (last && last.to === r.from && sameProv(last.p, r.p)) {
      out[out.length - 1] = { from: last.from, to: r.to, p: last.p };
    } else {
      out.push(r);
    }
  }
  return out;
}

/** Index of the run covering `pos`, or -1. */
export function runIndexAt(runs: readonly IRun[], pos: number): number {
  let lo = 0;
  let hi = runs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid] as IRun;
    if (pos < r.from) hi = mid - 1;
    else if (pos >= r.to) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Provenance of the unit at `pos`, or undefined. */
export function provAt(runs: readonly IRun[], pos: number): Prov | undefined {
  const i = runIndexAt(runs, pos);
  return i < 0 ? undefined : (runs[i] as IRun).p;
}

/** Groups `(pos, prov)` pairs (ascending positions) into canonical runs. */
export function runsFromUnits(units: ReadonlyArray<{ pos: number; p: Prov }>): IRun[] {
  const out: IRun[] = [];
  for (const u of units) {
    const last = out[out.length - 1];
    if (last && last.to === u.pos && sameProv(last.p, u.p)) {
      out[out.length - 1] = { from: last.from, to: u.pos + 1, p: last.p };
    } else {
      out.push({ from: u.pos, to: u.pos + 1, p: u.p });
    }
  }
  return out;
}

/** Merges two sorted, disjoint run lists. */
export function mergeRunLists(a: readonly IRun[], b: readonly IRun[]): IRun[] {
  const out: IRun[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (y === undefined || (x !== undefined && x.from <= y.from)) {
      out.push(x as IRun);
      i++;
    } else {
      out.push(y);
      j++;
    }
  }
  return canonicalRuns(out);
}

/**
 * Replaces the provenance of the units at `positions` (ascending) using `f`.
 * Runs are split as needed; the result is canonical.
 */
export function remapUnits(
  runs: readonly IRun[],
  positions: readonly number[],
  f: (p: Prov, pos: number) => Prov,
): IRun[] {
  if (positions.length === 0) return runs as IRun[];
  const out: IRun[] = [];
  let k = 0;
  for (const r of runs) {
    if (k >= positions.length || (positions[k] as number) >= r.to) {
      out.push(r);
      continue;
    }
    let cursor = r.from;
    while (k < positions.length && (positions[k] as number) < r.to) {
      const pos = positions[k] as number;
      if (pos < r.from) {
        k++;
        continue;
      }
      if (pos > cursor) out.push({ from: cursor, to: pos, p: r.p });
      out.push({ from: pos, to: pos + 1, p: f(r.p, pos) });
      cursor = pos + 1;
      k++;
    }
    if (cursor < r.to) out.push({ from: cursor, to: r.to, p: r.p });
  }
  return canonicalRuns(out);
}

/** Public canonical runs. */
export function toPublicRuns(runs: readonly IRun[]): ProvenanceRun[] {
  return runs.map((r) => {
    const out: ProvenanceRun = { from: r.from, to: r.to, class: r.p.class, originSeq: r.p.originSeq };
    if (r.p.suggestionId !== undefined) out.suggestionId = r.p.suggestionId;
    if (r.p.moves !== undefined && r.p.moves.length > 0) out.moves = [...r.p.moves];
    return out;
  });
}
