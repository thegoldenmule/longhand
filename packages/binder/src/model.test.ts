import { describe, expect, it } from 'vitest';
import {
  ancestorIds,
  archivedNodes,
  describeLocation,
  descendants,
  flattenVisible,
  isEffectivelyArchived,
  locate,
  placementForDrop,
  stepPlacement,
  type MoveStep,
} from './model';
import { applyBinderDraft } from './reducer';
import type { BinderRef } from '@longhand/schema';
import { documentText, documentWordCount, nodeWordCount } from './wordCount';
import { makeModel, novel, shape } from './test/fixtures';

const F = (id: string) => ({ kind: 'folder' as const, id });
const D = (id: string) => ({ kind: 'document' as const, id });

describe('queries', () => {
  it('locates nodes and walks ancestors and descendants', () => {
    const m = novel();
    expect(locate(m, D('s2'))).toEqual({ area: 'manuscript', parentId: 'ch1', index: 1 });
    expect(locate(m, F('part2'))).toEqual({ area: 'manuscript', parentId: null, index: 1 });
    expect(locate(m, D('nope'))).toBeUndefined();
    expect(ancestorIds(m, D('s1'))).toEqual(['ch1', 'part1']);
    expect(descendants(m, 'part1').map((r) => r.id)).toEqual(['ch1', 's1', 's2', 'ch2', 's3']);
  });

  it('flattens only expanded folders and skips archived nodes', () => {
    const m = makeModel({
      manuscript: [
        { id: 'p', children: [{ id: 'a' }, { id: 'x', archived: true }, { id: 'b' }] },
        { id: 'q', children: [{ id: 'c' }] },
      ],
    });
    const rows = flattenVisible(m, 'manuscript', new Set(['p']));
    expect(rows.map((r) => [r.ref.id, r.level, r.posInSet, r.setSize])).toEqual([
      ['p', 1, 1, 2],
      ['a', 2, 1, 2],
      ['b', 2, 2, 2],
      ['q', 1, 2, 2],
    ]);
    expect(rows[0]?.childCount).toBe(2);
  });

  it('knows what is effectively archived and lists archived nodes', () => {
    const m = makeModel({
      manuscript: [
        { id: 'p', archived: true, children: [{ id: 'a' }, { id: 'b', archived: true }] },
      ],
      notes: [{ id: 'n', archived: true }],
    });
    expect(isEffectivelyArchived(m, D('a'))).toBe(true);
    expect(archivedNodes(m).map((x) => x.ref.id)).toEqual(['p', 'b', 'n']);
  });
});

describe('placementForDrop', () => {
  it('accounts for removing the moved node first', () => {
    const m = novel(); // root: part1, part2, epilogue
    expect(placementForDrop(m, F('part1'), D('epilogue'), 'after')).toEqual({
      parentId: null,
      index: 2,
    });
    expect(placementForDrop(m, F('part1'), D('epilogue'), 'before')).toEqual({
      parentId: null,
      index: 1,
    });
    expect(placementForDrop(m, D('epilogue'), F('part1'), 'before')).toEqual({
      parentId: null,
      index: 0,
    });
    expect(placementForDrop(m, D('epilogue'), F('ch1'), 'inside')).toEqual({
      parentId: 'ch1',
      index: 2,
    });
    expect(placementForDrop(m, D('s1'), F('ch1'), 'inside')).toEqual({ parentId: 'ch1', index: 1 });
    expect(placementForDrop(m, D('s1'), D('s2'), 'inside')).toBeUndefined();
  });

  it('drops land exactly where the reducer puts them', () => {
    const m = novel();
    const res = applyBinderDraft(m, {
      type: 'FolderMoved',
      payload: { folderId: 'part1', ...placementForDrop(m, F('part1'), D('epilogue'), 'after')! },
    });
    expect(res.ok && res.model.binder.manuscript.map((r) => r.id)).toEqual([
      'part2',
      'epilogue',
      'part1',
    ]);
  });
});

describe('stepPlacement (keyboard move steps)', () => {
  function walk(ref: BinderRef, steps: MoveStep[]) {
    let m = novel();
    for (const s of steps) {
      const p = stepPlacement(m, ref, s);
      if (!p) return { m, stuck: s };
      const draft =
        ref.kind === 'folder'
          ? ({ type: 'FolderMoved', payload: { folderId: ref.id, ...p } } as const)
          : ({ type: 'DocumentMoved', payload: { documentId: ref.id, ...p } } as const);
      const res = applyBinderDraft(m, draft);
      if (!res.ok) throw new Error(res.error.code);
      m = res.model;
    }
    return { m, stuck: null };
  }

  it('swaps down and up among siblings', () => {
    expect(shape(walk(D('s1'), ['down']).m, 'manuscript')[0]).toEqual({
      part1: [{ ch1: ['s2', 's1'] }, { ch2: ['s3'] }],
    });
    const { m } = walk(D('s2'), ['up']);
    expect(m.folders.ch1?.children.map((r) => r.id)).toEqual(['s2', 's1']);
  });

  it('leaves the parent past the last child, and re-enters with in', () => {
    const out = walk(D('s2'), ['down']).m;
    expect(out.folders.part1?.children.map((r) => r.id)).toEqual(['ch1', 's2', 'ch2']);
    const back = walk(D('s2'), ['down', 'in']).m;
    expect(back.folders.ch1?.children.map((r) => r.id)).toEqual(['s1', 's2']);
  });

  it('moves out to just after the parent', () => {
    const { m } = walk(D('s1'), ['out', 'out']);
    expect(m.binder.manuscript.map((r) => r.id)).toEqual(['part1', 's1', 'part2', 'epilogue']);
    expect(walk(D('s1'), ['out', 'out', 'out']).stuck).toBe('out');
  });

  it('cannot go above the top or into a document', () => {
    expect(walk(F('part1'), ['up']).stuck).toBe('up');
    expect(walk(D('epilogue'), ['down']).stuck).toBe('down');
    expect(walk(F('part1'), ['in']).stuck).toBe('in');
    expect(stepPlacement(novel(), D('epilogue'), 'in')).toEqual({ parentId: 'part2', index: 0 });
  });

  it('skips archived siblings', () => {
    const m = makeModel({ manuscript: [{ id: 'a' }, { id: 'gone', archived: true }, { id: 'b' }] });
    expect(stepPlacement(m, D('a'), 'down')).toEqual({ parentId: null, index: 2 });
  });

  it('describes a location', () => {
    expect(describeLocation(novel(), D('s2'))).toBe('position 2 of 2 in ‘Chapter 1’');
    expect(describeLocation(novel(), D('n2'))).toBe('position 2 of 2 at the top of Notes');
  });
});

describe('word counts', () => {
  it('counts document text across blocks, marks and breaks', () => {
    expect(
      documentText({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'wo' },
              { type: 'text', text: 'rd', marks: [{ type: 'em' }] },
            ],
          },
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'two' },
              { type: 'hard_break' },
              { type: 'text', text: 'three' },
            ],
          },
        ],
      }),
    ).toBe('\nword\n\ntwo\nthree\n');
    expect(documentWordCount(novel(), 's2')).toBe(5);
  });

  it('sums folders over their non-archived subtree, with overrides', () => {
    const m = novel();
    expect(nodeWordCount(m, F('ch1'))).toBe(9);
    expect(nodeWordCount(m, F('ch1'), { s1: 100 })).toBe(105);
    const archived = applyBinderDraft(m, {
      type: 'DocumentArchived',
      payload: { documentId: 's2', archived: true },
    });
    expect(archived.ok && nodeWordCount(archived.model, F('part1'))).toBe(4);
  });
});
