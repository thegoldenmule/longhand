import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { EMPTY_DOC_JSON, type BinderArea, type BinderRef } from '@longhand/schema';
import { applyBinderDraft, applyBinderDrafts, binderReducer } from './reducer';
import { archiveNode, createDocument, createFolder, moveNode, type BinderDraft } from './drafts';
import type { BinderModel } from './model';
import { checkInvariants, makeModel, novel, shape } from './test/fixtures';

function apply(model: BinderModel, draft: BinderDraft, seq = 50): BinderModel {
  const res = applyBinderDraft(model, draft, { seq });
  if (!res.ok) throw new Error(`refused: ${res.error.code}`);
  expect(checkInvariants(res.model)).toEqual([]);
  return res.model;
}
function refusal(model: BinderModel, draft: BinderDraft) {
  const res = applyBinderDraft(model, draft);
  if (res.ok) throw new Error('expected refusal');
  return res.error.code;
}

describe('applyBinderDraft: creation', () => {
  it('creates a document with the fold defaults', () => {
    const m = apply(novel(), {
      type: 'DocumentCreated',
      payload: {
        documentId: 'pro',
        kind: 'manuscript',
        title: 'Prologue',
        parentId: null,
        index: 0,
      },
    });
    expect(m.binder.manuscript[0]).toEqual({ kind: 'document', id: 'pro' });
    expect(m.documents.pro).toEqual({
      id: 'pro',
      kind: 'manuscript',
      area: 'manuscript',
      title: 'Prologue',
      parentId: null,
      synopsis: '',
      content: EMPTY_DOC_JSON,
      version: 0,
      provenance: [],
      archived: false,
      imported: null,
      createdSeq: 50,
      contentSeq: 50,
      updatedSeq: 50,
    });
  });

  it('puts notes in the notes area and folders in their own area', () => {
    let m = apply(novel(), {
      type: 'DocumentCreated',
      payload: { documentId: 'n3', kind: 'note', title: 'Places', parentId: 'chars', index: 0 },
    });
    expect(m.documents.n3?.area).toBe('notes');
    expect(m.folders.chars?.children.map((r) => r.id)).toEqual(['n3', 'n1']);
    m = apply(m, {
      type: 'FolderCreated',
      payload: { folderId: 'world', area: 'notes', title: 'World', parentId: null, index: 1 },
    });
    expect(shape(m, 'notes')).toEqual([{ chars: ['n3', 'n1'] }, { world: [] }, 'n2']);
  });

  it('clamps creation indexes', () => {
    const m = apply(novel(), {
      type: 'FolderCreated',
      payload: { folderId: 'ch9', area: 'manuscript', title: 'Ch', parentId: 'part2', index: 40 },
    });
    expect(m.folders.part2?.children).toEqual([{ kind: 'folder', id: 'ch9' }]);
  });

  it('refuses duplicates, bad parents and cross-area placement', () => {
    const m = novel();
    expect(
      refusal(m, {
        type: 'DocumentCreated',
        payload: { documentId: 's1', kind: 'manuscript', title: 'X', parentId: null, index: 0 },
      }),
    ).toBe('duplicate-id');
    expect(
      refusal(m, {
        type: 'DocumentCreated',
        payload: { documentId: 'x', kind: 'note', title: 'X', parentId: 'part1', index: 0 },
      }),
    ).toBe('cross-area');
    expect(
      refusal(m, {
        type: 'FolderCreated',
        payload: { folderId: 'x', area: 'manuscript', title: 'X', parentId: 's1', index: 0 },
      }),
    ).toBe('invalid-parent');
    expect(
      refusal(m, {
        type: 'FolderCreated',
        payload: { folderId: 'x', area: 'manuscript', title: 'X', parentId: 'missing', index: 0 },
      }),
    ).toBe('not-found');
  });
});

describe('applyBinderDraft: moves', () => {
  const move = (
    kind: BinderRef['kind'],
    id: string,
    parentId: string | null,
    index: number,
  ): BinderDraft =>
    kind === 'folder'
      ? { type: 'FolderMoved', payload: { folderId: id, parentId, index } }
      : { type: 'DocumentMoved', payload: { documentId: id, parentId, index } };

  it('counts the index after removal (moving down within the same parent)', () => {
    // root: [part1, part2, epilogue] -> part1 to index 2 -> [part2, epilogue, part1]
    const m = apply(novel(), move('folder', 'part1', null, 2));
    expect(m.binder.manuscript.map((r) => r.id)).toEqual(['part2', 'epilogue', 'part1']);
  });

  it('moves up within the same parent', () => {
    const m = apply(novel(), move('document', 'epilogue', null, 0));
    expect(m.binder.manuscript.map((r) => r.id)).toEqual(['epilogue', 'part1', 'part2']);
  });

  it('clamps an index past the end', () => {
    const m = apply(novel(), move('document', 's1', 'ch1', 99));
    expect(m.folders.ch1?.children.map((r) => r.id)).toEqual(['s2', 's1']);
  });

  it('a same-place move leaves the order unchanged', () => {
    const before = novel();
    const m = apply(before, move('document', 's2', 'ch1', 1));
    expect(shape(m, 'manuscript')).toEqual(shape(before, 'manuscript'));
  });

  it('reparents across folders and updates parentId and seqs', () => {
    const m = apply(novel(), move('document', 's1', 'ch2', 0), 77);
    expect(m.folders.ch1?.children.map((r) => r.id)).toEqual(['s2']);
    expect(m.folders.ch2?.children.map((r) => r.id)).toEqual(['s1', 's3']);
    expect(m.documents.s1).toMatchObject({ parentId: 'ch2', updatedSeq: 77 });
    expect(m.folders.ch1?.updatedSeq).toBe(77);
    expect(m.folders.ch2?.updatedSeq).toBe(77);
  });

  it('moves a folder with its subtree to the root', () => {
    const m = apply(novel(), move('folder', 'ch1', null, 1));
    expect(shape(m, 'manuscript')).toEqual([
      { part1: [{ ch2: ['s3'] }] },
      { ch1: ['s1', 's2'] },
      { part2: [] },
      'epilogue',
    ]);
    expect(m.folders.ch1?.parentId).toBeNull();
    expect(m.documents.s1?.parentId).toBe('ch1');
  });

  it('refuses moving a folder into itself or a descendant', () => {
    expect(refusal(novel(), move('folder', 'part1', 'part1', 0))).toBe('cycle');
    expect(refusal(novel(), move('folder', 'part1', 'ch1', 0))).toBe('cycle');
    expect(refusal(novel(), move('folder', 'ch1', 'ch1', 0))).toBe('cycle');
  });

  it('refuses moving between areas, into documents, or missing nodes', () => {
    expect(refusal(novel(), move('document', 's1', 'chars', 0))).toBe('cross-area');
    expect(refusal(novel(), move('folder', 'chars', 'part1', 0))).toBe('cross-area');
    expect(refusal(novel(), move('document', 'n1', 'n2', 0))).toBe('invalid-parent');
    expect(refusal(novel(), move('document', 'ghost', null, 0))).toBe('not-found');
    expect(refusal(novel(), move('folder', 's1', null, 0))).toBe('not-found');
  });

  it('allows moving into an archived folder (the ledger accepts it; the builders do not offer it)', () => {
    const m = makeModel({ manuscript: [{ id: 'a' }, { id: 'old', archived: true, children: [] }] });
    const res = applyBinderDraft(m, move('document', 'a', 'old', 0));
    expect(res.ok).toBe(true);
  });

  it('keeps archived siblings in place when indexing', () => {
    const m0 = makeModel({
      manuscript: [{ id: 'a' }, { id: 'gone', archived: true }, { id: 'b' }],
    });
    const m = apply(m0, move('document', 'a', null, 2));
    expect(m.binder.manuscript.map((r) => r.id)).toEqual(['gone', 'b', 'a']);
  });
});

describe('applyBinderDraft: rename, archive, synopsis, settings', () => {
  it('renames and archives without moving', () => {
    let m = apply(novel(), { type: 'FolderRenamed', payload: { folderId: 'ch1', title: 'One' } });
    m = apply(m, { type: 'FolderArchived', payload: { folderId: 'ch1', archived: true } });
    expect(m.folders.ch1).toMatchObject({ title: 'One', archived: true, updatedSeq: 50 });
    expect(m.folders.part1?.children.map((r) => r.id)).toEqual(['ch1', 'ch2']);
    // Children keep their own flags.
    expect(m.documents.s1?.archived).toBe(false);
    m = apply(m, { type: 'FolderArchived', payload: { folderId: 'ch1', archived: false } });
    expect(m.folders.ch1?.archived).toBe(false);
  });

  it('renames documents, edits synopses and archives documents', () => {
    let m = apply(novel(), {
      type: 'DocumentRenamed',
      payload: { documentId: 's1', title: 'Storm' },
    });
    m = apply(m, { type: 'SynopsisEdited', payload: { documentId: 's1', synopsis: 'Wind.' } });
    m = apply(m, { type: 'DocumentArchived', payload: { documentId: 's1', archived: true } });
    expect(m.documents.s1).toMatchObject({ title: 'Storm', synopsis: 'Wind.', archived: true });
    expect(m.documents.s1?.content).toEqual(novel().documents.s1?.content);
  });

  it('refuses edits to missing nodes', () => {
    expect(
      refusal(novel(), { type: 'DocumentRenamed', payload: { documentId: 'x', title: 'A' } }),
    ).toBe('not-found');
    expect(
      refusal(novel(), { type: 'SynopsisEdited', payload: { documentId: 'ch1', synopsis: '' } }),
    ).toBe('not-found');
    expect(
      refusal(novel(), { type: 'FolderArchived', payload: { folderId: 's1', archived: true } }),
    ).toBe('not-found');
  });

  it('merges settings patches', () => {
    const m = apply(novel(), {
      type: 'ProjectSettingsChanged',
      payload: { patch: { genre: 'mystery', dailyWordGoal: 800 } },
    });
    expect(m.settings).toMatchObject({
      title: 'Test Project',
      genre: 'mystery',
      dailyWordGoal: 800,
    });
  });

  it('never mutates its input and carries other fields over', () => {
    const base = { ...novel(), headSeq: 9 };
    const snapshot = JSON.stringify(base);
    const res = applyBinderDraft(base, {
      type: 'DocumentMoved',
      payload: { documentId: 's1', parentId: null, index: 0 },
    });
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(res.ok && res.model.headSeq).toBe(9);
    // Untouched subtrees are shared.
    expect(res.ok && res.model.folders.ch2).toBe(base.folders.ch2);
  });
});

describe('applyBinderDrafts / binderReducer', () => {
  it('applies a pending queue and reports drafts the ledger would reject', () => {
    const m = novel();
    const { model, rejected } = applyBinderDrafts(m, [
      { type: 'FolderMoved', payload: { folderId: 'ch2', parentId: null, index: 0 } },
      { type: 'FolderMoved', payload: { folderId: 'part1', parentId: 'ch1', index: 0 } },
      { type: 'DocumentRenamed', payload: { documentId: 's3', title: 'Dawn' } },
    ]);
    expect(rejected.map((r) => r.error.code)).toEqual(['cycle']);
    expect(model.binder.manuscript[0]).toEqual({ kind: 'folder', id: 'ch2' });
    expect(model.documents.s3?.title).toBe('Dawn');
  });

  it('binderReducer keeps state on refusal', () => {
    const m = novel();
    expect(
      binderReducer(m, {
        type: 'FolderMoved',
        payload: { folderId: 'part1', parentId: 'part1', index: 0 },
      }),
    ).toBe(m);
  });
});

describe('builders + reducer (property)', () => {
  const AREAS: BinderArea[] = ['manuscript', 'notes'];

  type Op =
    | { op: 'doc' | 'folder'; area: number; parent: number; index: number }
    | { op: 'move'; node: number; target: number; index: number }
    | { op: 'archive'; node: number };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      op: fc.constantFrom('doc' as const, 'folder' as const),
      area: fc.nat(1),
      parent: fc.nat(30),
      index: fc.nat(6),
    }),
    fc.record({
      op: fc.constant('move' as const),
      node: fc.nat(40),
      target: fc.nat(40),
      index: fc.nat(6),
    }),
    fc.record({ op: fc.constant('archive' as const), node: fc.nat(40) }),
  );

  it('every accepted draft keeps the tree well formed, and refused moves change nothing', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        let m = novel();
        let n = 0;
        for (const o of ops) {
          const folderIds = Object.keys(m.folders);
          const nodes: BinderRef[] = [
            ...folderIds.map((id) => ({ kind: 'folder' as const, id })),
            ...Object.keys(m.documents).map((id) => ({ kind: 'document' as const, id })),
          ];
          let res;
          if (o.op !== 'move' && o.op !== 'archive') {
            const area = AREAS[o.area] as BinderArea;
            const parentId = o.parent < folderIds.length ? (folderIds[o.parent] as string) : null;
            const opts = { area, title: `T${n}`, id: `new${n++}`, parentId, index: o.index };
            res = o.op === 'doc' ? createDocument(m, opts) : createFolder(m, opts);
          } else if (o.op === 'move') {
            const ref = nodes[o.node % nodes.length] as BinderRef;
            const parentId = o.target < folderIds.length ? (folderIds[o.target] as string) : null;
            res = moveNode(m, ref, { parentId, index: o.index });
          } else {
            res = archiveNode(m, nodes[o.node % nodes.length] as BinderRef);
          }
          const applied = res.ok ? applyBinderDraft(m, res.draft) : null;
          if (res.ok) {
            // Whatever a builder emits, the reducer accepts.
            expect(applied?.ok).toBe(true);
            if (applied?.ok) m = applied.model;
          }
          expect(checkInvariants(m)).toEqual([]);
        }
      }),
      { numRuns: 200 },
    );
  });
});
