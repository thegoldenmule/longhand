/**
 * The step engine: applies one ProseMirror step to a document and carries
 * provenance runs, tombstones (deleted content, for undo/redo and drops) and the
 * step-map history through it.
 *
 * Every step is described by its `StepMap` changes `(oldStart, oldEnd) →
 * (newStart, newEnd)`. Units outside every change survive and are mapped; units
 * inside a change's old range are deleted (and buried as tombstones); units inside
 * its new range are inserted, and the caller decides their provenance.
 */
import type { PMNode } from '@longhand/schema';
import type { Step, StepMap } from 'prosemirror-transform';
import { canonicalRuns, mergeRunLists, provAt, runsFromUnits, type IRun, type Prov } from './prov';
import { unitsBetween, type UnitRef } from './units';

/** A deleted unit with its provenance. */
export interface DeletedUnit extends UnitRef {
  p: Prov;
}

/** One replaced range of a step. */
export interface Change {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  /** Units removed from `[oldStart, oldEnd)` of the old document. */
  deleted: DeletedUnit[];
  /** Units now in `[newStart, newEnd)` of the new document. */
  inserted: UnitRef[];
}

/** A step applied to a document. */
export interface AppliedStep {
  doc: PMNode;
  map: StepMap;
  changes: Change[];
}

/** Applies `step` to `doc`. Returns null if the step does not apply. */
export function applyStep(doc: PMNode, runs: readonly IRun[], step: Step): AppliedStep | null {
  let result;
  try {
    result = step.apply(doc);
  } catch {
    return null;
  }
  if (result.failed !== null || result.doc === null) return null;
  const next = result.doc;
  const map = step.getMap();
  const changes: Change[] = [];
  map.forEach((oldStart, oldEnd, newStart, newEnd) => {
    const deleted = unitsBetween(doc, oldStart, oldEnd).map((u) => ({
      ...u,
      p: provAt(runs, u.pos) as Prov,
    }));
    changes.push({
      oldStart,
      oldEnd,
      newStart,
      newEnd,
      deleted,
      inserted: unitsBetween(next, newStart, newEnd),
    });
  });
  return { doc: next, map, changes };
}

/**
 * Carries runs through a step: surviving pieces are mapped, deleted units dropped,
 * and inserted units get `assigned[i][j]` (change i, inserted unit j).
 */
export function carryRuns(
  runs: readonly IRun[],
  map: StepMap,
  changes: readonly Change[],
  assigned: ReadonlyArray<readonly Prov[]>,
): IRun[] {
  if (changes.length === 0) return runs as IRun[];
  const cuts: number[] = [];
  for (const c of changes) cuts.push(c.oldStart, c.oldEnd);
  const inside = (x: number, y: number): boolean =>
    changes.some((c) => c.oldStart < c.oldEnd && x >= c.oldStart && y <= c.oldEnd);
  const first = changes[0] as Change;
  const survivors: IRun[] = [];
  for (const r of runs) {
    if (r.to <= first.oldStart) {
      survivors.push(r);
      continue;
    }
    let x = r.from;
    const points = cuts.filter((c) => c > r.from && c < r.to).sort((a, b) => a - b);
    points.push(r.to);
    for (const y of points) {
      if (y <= x) continue;
      if (!inside(x, y)) {
        const from = map.map(x, 1);
        const to = map.map(y, -1);
        if (to > from) survivors.push({ from, to, p: r.p });
      }
      x = y;
    }
  }
  const inserted: Array<{ pos: number; p: Prov }> = [];
  changes.forEach((c, i) => {
    const ps = assigned[i] ?? [];
    c.inserted.forEach((u, j) => inserted.push({ pos: u.pos, p: ps[j] as Prov }));
  });
  inserted.sort((a, b) => a.pos - b.pos);
  return mergeRunLists(canonicalRuns(survivors), runsFromUnits(inserted));
}

// ---------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------

/** A deleted unit kept for undo/redo and drop verification. */
export interface DeadUnit {
  readonly key: string;
  readonly p: Prov;
  /** Seq of the commit that deleted it. */
  readonly seq: number;
  /** Identity of the input-method run that deleted it (for drop verification). */
  readonly tag?: object;
}

/**
 * Deleted content sitting in the gap before position `pos` of the current
 * document, in original document order.
 */
export interface Tomb {
  readonly pos: number;
  readonly units: readonly DeadUnit[];
}

/**
 * Carries tombstones through a step. Tombs inside or at the edges of a change are
 * merged with that change's newly deleted units (`buried[i]`, by old position) into
 * one tomb at `newStart`; other tombs are mapped. `extra` adds tombs at given new
 * positions (remainders split off by an undo/redo match).
 */
export function carryTombs(
  tombs: readonly Tomb[],
  map: StepMap,
  changes: readonly Change[],
  buried: ReadonlyArray<ReadonlyArray<{ pos: number; unit: DeadUnit }>>,
  extra: readonly Tomb[] = [],
): Tomb[] {
  if (changes.length === 0 && extra.length === 0) return tombs as Tomb[];
  const groups: Array<Array<{ pos: number; tomb?: Tomb; unit?: DeadUnit }>> = changes.map(() => []);
  const out: Tomb[] = [];
  for (const t of tombs) {
    const i = changes.findIndex((c) => t.pos >= c.oldStart && t.pos <= c.oldEnd);
    if (i >= 0) (groups[i] as Array<{ pos: number; tomb?: Tomb }>).push({ pos: t.pos, tomb: t });
    else out.push({ pos: map.map(t.pos, -1), units: t.units });
  }
  changes.forEach((c, i) => {
    const g = groups[i] as Array<{ pos: number; tomb?: Tomb; unit?: DeadUnit }>;
    for (const b of buried[i] ?? []) g.push({ pos: b.pos, unit: b.unit });
    // Tombs at position x sit before the unit at x; stable sort keeps tomb order.
    g.sort((a, b) => a.pos - b.pos || (a.tomb ? 0 : 1) - (b.tomb ? 0 : 1));
    const units: DeadUnit[] = [];
    for (const e of g) {
      if (e.tomb) units.push(...e.tomb.units);
      else if (e.unit) units.push(e.unit);
    }
    if (units.length > 0) out.push({ pos: c.newStart, units });
  });
  out.push(...extra.filter((t) => t.units.length > 0));
  out.sort((a, b) => a.pos - b.pos);
  // Coalesce tombs that landed on the same position (order preserved).
  const merged: Tomb[] = [];
  for (const t of out) {
    const last = merged[merged.length - 1];
    if (last && last.pos === t.pos) merged[merged.length - 1] = { pos: t.pos, units: [...last.units, ...t.units] };
    else merged.push(t);
  }
  return merged;
}

/** A match of a key sequence inside a tomb. */
export interface TombMatch {
  tombIndex: number;
  start: number;
  length: number;
}

function bestMatchIn(
  tombs: readonly Tomb[],
  indexes: readonly number[],
  keys: readonly string[],
): TombMatch | null {
  let best: TombMatch | null = null;
  let bestScore = -1;
  for (const ti of indexes) {
    const units = (tombs[ti] as Tomb).units;
    for (let s = 0; s + keys.length <= units.length; s++) {
      let ok = true;
      let minSeq = Infinity;
      for (let k = 0; k < keys.length; k++) {
        const u = units[s + k] as DeadUnit;
        if (u.key !== keys[k]) {
          ok = false;
          break;
        }
        if (u.seq < minSeq) minSeq = u.seq;
      }
      if (ok && minSeq > bestScore) {
        bestScore = minSeq;
        best = { tombIndex: ti, start: s, length: keys.length };
      }
    }
  }
  return best;
}

/**
 * Finds deleted content equal to `keys`: first in tombs at positions within
 * `[from, to]` (where an undo re-inserts it), then anywhere in the document. Among
 * several matches, the most recently deleted wins.
 */
export function findInTombs(
  tombs: readonly Tomb[],
  keys: readonly string[],
  from: number,
  to: number,
): TombMatch | null {
  if (keys.length === 0) return null;
  const near: number[] = [];
  const all: number[] = [];
  tombs.forEach((t, i) => {
    all.push(i);
    if (t.pos >= from && t.pos <= to) near.push(i);
  });
  return bestMatchIn(tombs, near, keys) ?? bestMatchIn(tombs, all, keys);
}

// ---------------------------------------------------------------------------
// Step-map history
// ---------------------------------------------------------------------------

/** Persistent list of step maps: `map` takes version `version - 1` to `version`. */
export interface MapNode {
  readonly map: StepMap;
  readonly version: number;
  readonly prev: MapNode | null;
}

/** Maps between `from` and `to` (ascending), or null if the history does not reach. */
export function mapsBetween(head: MapNode | null, fromVersion: number, toVersion: number): StepMap[] | null {
  const out: StepMap[] = [];
  let n = head;
  while (n && n.version > toVersion) n = n.prev;
  while (n && n.version > fromVersion) {
    out.push(n.map);
    n = n.prev;
  }
  if (out.length !== toVersion - fromVersion) return null;
  return out.reverse();
}

/**
 * True if any step between `readVersion` and `version` touched `[from, to)` (given
 * in version `version`): replaced content overlapping it, inserted strictly inside
 * it, or (for a point, `from === to`) replaced content at it. Walks backwards,
 * mapping the range into each earlier version.
 */
export function touchedBetween(
  maps: readonly StepMap[],
  from: number,
  to: number,
): boolean {
  let f = from;
  let t = to;
  for (let k = maps.length - 1; k >= 0; k--) {
    const m = maps[k] as StepMap;
    let touched = false;
    m.forEach((_os, _oe, ns, ne) => {
      if (touched) return;
      if (f === t) {
        if (ns <= f && f <= ne && (ne > ns || _oe > _os)) touched = true;
      } else if (ne > ns && ns < t && ne > f) touched = true;
      else if (ns > f && ns < t) touched = true;
    });
    if (touched) return true;
    const inv = m.invert();
    if (f === t) {
      f = inv.map(f, 1);
      t = f;
    } else {
      f = inv.map(f, 1);
      t = inv.map(t, -1);
      if (t < f) t = f;
    }
  }
  return false;
}
