/**
 * Step helpers: counting what a step inserts and deletes, and the range a
 * transaction changed. Character counts follow the anchor rules in
 * `@longhand/schema` (text verbatim, `hard_break` as one `"\n"`, citations as
 * nothing, footnote text included).
 */
import type { Fragment, Node as PMNode } from 'prosemirror-model';
import {
  ReplaceAroundStep,
  ReplaceStep,
  type Step,
  type Transform,
} from 'prosemirror-transform';

/** Inline-text length of a fragment: text characters plus one per `hard_break`. */
export function inlineCharCount(fragment: Fragment): number {
  let n = 0;
  fragment.descendants((node) => {
    if (node.isText) n += (node.text as string).length;
    else if (node.type.name === 'hard_break') n += 1;
    return true;
  });
  return n;
}

/**
 * "Input units" a fragment inserts: text characters plus every inline leaf
 * (`hard_break`, `citation`, `footnote`) and block atom (`scene_break`). The
 * input guard requires a matching budget from real input events for typed text.
 */
export function inputUnitCount(fragment: Fragment): number {
  let n = 0;
  fragment.descendants((node) => {
    if (node.isText) n += (node.text as string).length;
    else if (node.isInline && (node.isLeaf || node.isAtom)) n += 1;
    else if (node.isBlock && node.isAtom) n += 1;
    return true;
  });
  return n;
}

/** Content inserted by a step (empty fragment for mark/attr steps). */
export function insertedContent(step: Step): Fragment | null {
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
    return (step as unknown as { slice: { content: Fragment } }).slice.content;
  }
  return null;
}

/** Inline characters a step inserts. */
export function insertedChars(step: Step): number {
  const c = insertedContent(step);
  return c ? inlineCharCount(c) : 0;
}

/** Input units a step inserts (see {@link inputUnitCount}). */
export function insertedUnits(step: Step): number {
  const c = insertedContent(step);
  return c ? inputUnitCount(c) : 0;
}

/** Inline characters a step removes from `docBefore`. */
export function deletedChars(step: Step, docBefore: PMNode): number {
  const s = step as unknown as {
    from: number;
    to: number;
    gapFrom?: number;
    gapTo?: number;
  };
  const count = (from: number, to: number): number =>
    to > from ? inlineCharCount(docBefore.slice(from, to).content) : 0;
  if (step instanceof ReplaceAroundStep) {
    return count(s.from, s.gapFrom as number) + count(s.gapTo as number, s.to);
  }
  if (step instanceof ReplaceStep) return count(s.from, s.to);
  return 0;
}

/** Totals over every step of a transform. */
export interface StepTotals {
  insertedChars: number;
  insertedUnits: number;
  deletedChars: number;
  /** True if any step is a mark, attr or structure-only change. */
  structural: boolean;
}

/** Sums inserted and deleted characters over a transform's steps. */
export function transformTotals(tr: Transform): StepTotals {
  const totals: StepTotals = { insertedChars: 0, insertedUnits: 0, deletedChars: 0, structural: false };
  tr.steps.forEach((step, i) => {
    totals.insertedChars += insertedChars(step);
    totals.insertedUnits += insertedUnits(step);
    const d = deletedChars(step, tr.docs[i] as PMNode);
    totals.deletedChars += d;
    if (!(step instanceof ReplaceStep) || (d === 0 && insertedChars(step) === 0)) totals.structural = true;
  });
  return totals;
}

/**
 * The range of the final document touched by a transform's steps, or null if
 * nothing changed.
 */
export function changedRange(tr: Transform): { from: number; to: number } | null {
  let from = Infinity;
  let to = -Infinity;
  const maps = tr.mapping.maps;
  maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_os, _oe, ns, ne) => {
      from = Math.min(from, rest.map(ns, -1));
      to = Math.max(to, rest.map(ne, 1));
    });
  });
  if (from === Infinity) return null;
  return { from, to: Math.max(from, to) };
}

/** True if the step splits a textblock (what Enter does). */
export function isSplitStep(step: Step): boolean {
  if (!(step instanceof ReplaceStep)) return false;
  const slice = (step as unknown as { slice: { openStart: number; openEnd: number; content: Fragment } })
    .slice;
  return slice.openStart > 0 && slice.openEnd > 0 && slice.content.childCount >= 2 && inlineCharCount(slice.content) === 0;
}
