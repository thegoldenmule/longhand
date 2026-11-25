/**
 * Mapping annotation positions through steps.
 *
 * - Ranges map with `from` associating right and `to` associating left, so text
 *   inserted at either edge stays outside; a range whose text is all deleted
 *   becomes null (and stays null).
 * - Points (insertion suggestions, a move's insertion point, split and join
 *   positions) map with their own association and become null when the content
 *   around them is deleted.
 * - Open suggestions track a *region*: once the writer edits inside it, text typed
 *   at its edges is absorbed (so retyping "drizzle" over "rain" keystroke by
 *   keystroke stays inside), and a run's `traceSuggestionId` hint absorbs edge
 *   insertions from the start.
 * - Open proposals record whether any step touched them (they go stale).
 */
import type { StepMap } from 'prosemirror-transform';
import type { Change } from './engine';
import type { Span, Tracker } from './state';

/** Facts about the step being mapped. */
export interface StepFacts {
  map: StepMap;
  changes: readonly Change[];
  /** The step came from a typed / ime / autocorrect run. */
  typed: boolean;
  /** `traceSuggestionId` of the step's run, if any. */
  hint: string | null;
  /** Positions relocated by an accepted move: tracker id → new range/point (skips normal mapping). */
  relocated?: ReadonlyMap<string, { range: Span | null; point: number | null }>;
}

/** Per-commit notes about trackers, filled while mapping. */
export interface Scratch {
  /** Open suggestions whose region was edited in this commit. */
  regionTouched: Set<string>;
  /** …by a typed step. */
  typedTouch: Set<string>;
  /** …by any other step. */
  otherTouch: Set<string>;
  /** Insertion suggestions whose reference sentence was deleted. */
  refTouched: Set<string>;
  /** Open proposals edited in this commit. */
  proposalTouched: Set<string>;
  /** Suggestions named by a trace-over hint in this commit. */
  hinted: Set<string>;
}

/** A fresh scratch. */
export function newScratch(): Scratch {
  return {
    regionTouched: new Set(),
    typedTouch: new Set(),
    otherTouch: new Set(),
    refTouched: new Set(),
    proposalTouched: new Set(),
    hinted: new Set(),
  };
}

/** True if a change touches the text range `[from, to)` (old coordinates). */
export function touchesRange(
  changes: readonly Change[],
  from: number,
  to: number,
  inclusive = false,
): boolean {
  for (const c of changes) {
    if (inclusive) {
      if (c.oldStart <= to && c.oldEnd >= from) return true;
      continue;
    }
    if (c.oldEnd > c.oldStart) {
      if (c.oldStart < to && c.oldEnd > from) return true;
    } else if (c.oldStart > from && c.oldStart < to) {
      return true;
    }
  }
  return false;
}

/** True if a change removes content on both sides of `pos`, or replaces content at it. */
export function touchesPoint(changes: readonly Change[], pos: number): boolean {
  for (const c of changes)
    if (c.oldEnd > c.oldStart && c.oldStart < pos && c.oldEnd > pos) return true;
  return false;
}

function mapRange(map: StepMap, r: Span): Span | null {
  const from = map.map(r.from, 1);
  const to = map.map(r.to, -1);
  return to > from ? { from, to } : null;
}

function mapPoint(map: StepMap, pos: number, assoc: 1 | -1): number | null {
  const res = map.mapResult(pos, assoc);
  return res.deletedAcross ? null : res.pos;
}

function regionOverlaps(changes: readonly Change[], r: Span, absorbEdges: boolean): boolean {
  for (const c of changes) {
    const pure = c.oldEnd === c.oldStart;
    if (r.from === r.to) {
      if (c.oldStart <= r.from && r.from <= c.oldEnd) return true;
      continue;
    }
    if (!pure && c.oldStart < r.to && c.oldEnd > r.from) return true;
    if (pure && c.oldStart > r.from && c.oldStart < r.to) return true;
    if (pure && absorbEdges && (c.oldStart === r.from || c.oldStart === r.to)) return true;
  }
  return false;
}

/** Maps one tracker (a mutable copy) through a step, noting touches in `scratch`. */
export function mapTracker(t: Tracker, step: StepFacts, scratch: Scratch): void {
  const { map, changes } = step;
  const reloc = step.relocated?.get(t.id);
  if (t.watch && t.group === 'proposals' && !reloc) {
    let touched = false;
    if (t.range) touched = touchesRange(changes, t.range.from, t.range.to, t.nodeRange);
    if (!touched && t.point !== null && touchesPoint(changes, t.point)) touched = true;
    if (touched) scratch.proposalTouched.add(t.id);
  }
  if (t.ref && !reloc) {
    // An insertion goes stale only when the sentence it is relative to is deleted.
    t.ref = mapRange(map, t.ref);
    if (!t.ref) scratch.refTouched.add(t.id);
  }
  if (reloc) {
    t.range = reloc.range;
    t.point = reloc.point;
    return;
  }
  if (t.region && t.range) {
    const absorb = t.region.touched || step.hint === t.id;
    if (step.hint === t.id) scratch.hinted.add(t.id);
    if (regionOverlaps(changes, t.range, absorb)) {
      t.region = { ...t.region, touched: true };
      scratch.regionTouched.add(t.id);
      (step.typed ? scratch.typedTouch : scratch.otherTouch).add(t.id);
      const from = map.map(t.range.from, -1);
      const to = map.map(t.range.to, 1);
      t.range = { from, to: Math.max(from, to) };
    } else if (t.range.from === t.range.to) {
      const pos = map.map(t.range.from, t.rangeAssoc);
      t.range = { from: pos, to: pos };
    } else {
      const from = map.map(t.range.from, 1);
      const to = map.map(t.range.to, -1);
      t.range = { from, to: Math.max(from, to) };
    }
  } else if (t.range && (t.group === 'feedbackRequests' || t.group === 'chatMessages')) {
    // A selection scope never becomes null: it collapses to a point instead.
    const from = map.map(t.range.from, 1);
    t.range = { from, to: Math.max(from, map.map(t.range.to, -1)) };
  } else if (t.range) {
    if (t.isPoint) {
      const pos = mapPoint(map, t.range.from, t.rangeAssoc);
      t.range = pos === null ? null : { from: pos, to: pos };
    } else {
      t.range = mapRange(map, t.range);
    }
  }
  if (t.point !== null) t.point = mapPoint(map, t.point, t.pointAssoc);
}

/** A deep-enough copy of a tracker for mutation within one commit. */
export function cloneTracker(t: Tracker): Tracker {
  return {
    ...t,
    range: t.range ? { ...t.range } : null,
    ref: t.ref ? { ...t.ref } : null,
    region: t.region ? { ...t.region } : null,
  };
}
