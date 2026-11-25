import { schema } from '@longhand/schema';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { applyStep, carryRuns, carryTombs, findInTombs, touchedBetween, type Tomb } from './engine';
import { editDistance, normalize, normalizedEditDistance, ngramsOf, wordBoundedIndexes } from './matcher';
import { canonicalRuns, prov, remapUnits, toPublicRuns, withMove, type IRun } from './prov';
import { pvecFrom, pvecGet, pvecPush, pvecToArray, pvecEmpty } from './pvec';
import { unitsBetween } from './units';

const doc = schema.nodes.doc!.create(null, [schema.nodes.paragraph!.create(null, schema.text('abcdef'))]);
const A = prov('typed', 1);
const B = prov('pasted-external', 2);

describe('runs', () => {
  it('canonicalizes, remaps and serializes', () => {
    const runs = canonicalRuns([
      { from: 1, to: 3, p: A },
      { from: 3, to: 5, p: prov('typed', 1) },
      { from: 5, to: 7, p: B },
    ]);
    expect(runs.map((r) => [r.from, r.to])).toEqual([
      [1, 5],
      [5, 7],
    ]);
    const re = remapUnits(runs, [2, 3], (p) => withMove(p, 9));
    expect(toPublicRuns(re)).toEqual([
      { from: 1, to: 2, class: 'typed', originSeq: 1 },
      { from: 2, to: 4, class: 'typed', originSeq: 1, moves: [9] },
      { from: 4, to: 5, class: 'typed', originSeq: 1 },
      { from: 5, to: 7, class: 'pasted-external', originSeq: 2 },
    ]);
  });

  it('carries runs through a replace step', () => {
    const runs: IRun[] = [
      { from: 1, to: 4, p: A },
      { from: 4, to: 7, p: B },
    ];
    const step = new Transform(doc).replaceWith(3, 5, schema.text('XYZ')).steps[0]!;
    const a = applyStep(doc, runs, step)!;
    expect(a.changes).toHaveLength(1);
    expect(a.changes[0]!.deleted.map((u) => u.key).join('')).toBe('cd');
    const C = prov('typed', 3);
    const out = carryRuns(runs, a.map, a.changes, [a.changes[0]!.inserted.map(() => C)]);
    expect(out.map((r) => [r.from, r.to, r.p.originSeq])).toEqual([
      [1, 3, 1],
      [3, 6, 3],
      [6, 8, 2],
    ]);
    expect(unitsBetween(a.doc, 1, 8).map((u) => u.key).join('')).toBe('abXYZef');
  });

  it('buries deleted units in order and finds them again', () => {
    let d = doc;
    let runs: IRun[] = [{ from: 1, to: 7, p: A }];
    let tombs: Tomb[] = [];
    // Backspace "f", then "e": the tomb holds "ef" in document order.
    for (const [from, to] of [
      [6, 7],
      [5, 6],
    ] as const) {
      const step = new Transform(d).delete(from, to).steps[0]!;
      const a = applyStep(d, runs, step)!;
      const buried = a.changes.map((c) => c.deleted.map((u) => ({ pos: u.pos, unit: { key: u.key, p: u.p, seq: 5 } })));
      tombs = carryTombs(tombs, a.map, a.changes, buried);
      runs = carryRuns(runs, a.map, a.changes, []);
      d = a.doc;
    }
    expect(tombs).toHaveLength(1);
    expect(tombs[0]!.units.map((u) => u.key).join('')).toBe('ef');
    expect(findInTombs(tombs, ['e', 'f'], 5, 5)).toEqual({ tombIndex: 0, start: 0, length: 2 });
    expect(findInTombs(tombs, ['f', 'e'], 5, 5)).toBeNull();
  });

  it('detects edits between versions', () => {
    const tr = new Transform(doc).insert(2, schema.text('Q'));
    const maps = tr.mapping.maps;
    expect(touchedBetween(maps, 1, 4)).toBe(true);
    expect(touchedBetween(maps, 4, 7)).toBe(false);
  });
});

describe('matcher', () => {
  it('measures distance and n-grams deterministically', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(normalizedEditDistance('lingered', 'lingerd')).toBeCloseTo(1 / 8);
    expect(normalize('  The   Storm’s  ')).toBe("the storm's");
    expect([...ngramsOf('One two three four five')]).toEqual(['one two three four', 'two three four five']);
    expect(wordBoundedIndexes('drizzle drizzled', 'drizzle')).toEqual([0]);
  });
});

describe('pvec', () => {
  it('is persistent', () => {
    let v = pvecEmpty<number>();
    for (let i = 0; i < 600; i++) v = pvecPush(v, i);
    const w = pvecPush(v, 600);
    expect(v.length).toBe(600);
    expect(pvecGet(w, 600)).toBe(600);
    expect(pvecGet(v, 600)).toBeUndefined();
    expect(pvecToArray(pvecFrom([1, 2, 3]))).toEqual([1, 2, 3]);
  });
});
