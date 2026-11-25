import { describe, expect, it } from 'vitest';
import { CommitDraftSchema, EVENTS } from '@longhand/schema';
import {
  archiveNode,
  changeProjectSettings,
  createCommitDrafter,
  createDocument,
  createFolder,
  editSynopsis,
  moveNode,
  renameNode,
  restoreNode,
  toCommitDraft,
  type BinderDraft,
  type DraftResult,
} from './drafts';
import { novel, makeModel } from './test/fixtures';

const F = (id: string) => ({ kind: 'folder' as const, id });
const D = (id: string) => ({ kind: 'document' as const, id });

function draftOf<D>(r: DraftResult<D>): D {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}: ${r.error.message}`);
  return r.draft;
}
function errorOf(r: DraftResult<unknown>) {
  if (r.ok) throw new Error('expected a refusal');
  return r.error.code;
}
function expectValid(d: BinderDraft) {
  expect(EVENTS[d.type].payload.safeParse(d.payload).success).toBe(true);
}

describe('createDocument / createFolder', () => {
  it('creates a manuscript document at the end of the area root by default', () => {
    const d = draftOf(
      createDocument(novel(), { area: 'manuscript', title: ' Prologue ', id: 'pro' }),
    );
    expect(d).toEqual({
      type: 'DocumentCreated',
      payload: {
        documentId: 'pro',
        kind: 'manuscript',
        title: 'Prologue',
        parentId: null,
        index: 3,
      },
    });
    expectValid(d);
  });

  it('creates notes as kind note', () => {
    const d = draftOf(
      createDocument(novel(), {
        area: 'notes',
        title: 'Places',
        id: 'n9',
        parentId: 'chars',
        index: 0,
      }),
    );
    expect(d.payload).toMatchObject({ kind: 'note', parentId: 'chars', index: 0 });
  });

  it('clamps the index to the child count', () => {
    const d = draftOf(
      createFolder(novel(), {
        area: 'manuscript',
        title: 'Ch 3',
        id: 'ch3',
        parentId: 'part1',
        index: 99,
      }),
    );
    expect(d).toEqual({
      type: 'FolderCreated',
      payload: { folderId: 'ch3', area: 'manuscript', title: 'Ch 3', parentId: 'part1', index: 2 },
    });
  });

  it('generates a UUID id when none is given', () => {
    const d = draftOf(createFolder(novel(), { area: 'notes', title: 'World' }));
    expect(d.payload.folderId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses bad titles, ids, parents and areas', () => {
    const m = novel();
    expect(errorOf(createDocument(m, { area: 'manuscript', title: '   ' }))).toBe('invalid-title');
    expect(errorOf(createDocument(m, { area: 'manuscript', title: 'x'.repeat(201) }))).toBe(
      'invalid-title',
    );
    expect(errorOf(createDocument(m, { area: 'manuscript', title: 'A', id: 's1' }))).toBe(
      'duplicate-id',
    );
    expect(errorOf(createDocument(m, { area: 'manuscript', title: 'A', id: 'part1' }))).toBe(
      'duplicate-id',
    );
    expect(errorOf(createDocument(m, { area: 'manuscript', title: 'A', id: 'bad id' }))).toBe(
      'invalid-id',
    );
    expect(errorOf(createDocument(m, { area: 'manuscript', title: 'A', parentId: 'nope' }))).toBe(
      'not-found',
    );
    expect(errorOf(createDocument(m, { area: 'manuscript', title: 'A', parentId: 's1' }))).toBe(
      'invalid-parent',
    );
    expect(errorOf(createDocument(m, { area: 'manuscript', title: 'A', parentId: 'chars' }))).toBe(
      'cross-area',
    );
    expect(errorOf(createFolder(m, { area: 'notes', title: 'A', parentId: 'part1' }))).toBe(
      'cross-area',
    );
    expect(errorOf(createFolder(m, { area: 'notes', title: 'A', index: -1 }))).toBe(
      'invalid-index',
    );
  });

  it('refuses creating inside an archived folder or its subtree', () => {
    const m = makeModel({
      manuscript: [{ id: 'old', archived: true, children: [{ id: 'inner', children: [] }] }],
    });
    expect(errorOf(createDocument(m, { area: 'manuscript', title: 'A', parentId: 'old' }))).toBe(
      'archived',
    );
    expect(errorOf(createDocument(m, { area: 'manuscript', title: 'A', parentId: 'inner' }))).toBe(
      'archived',
    );
  });
});

describe('renameNode', () => {
  it('renames documents and folders, trimming the title', () => {
    expect(draftOf(renameNode(novel(), D('s1'), '  Downpour '))).toEqual({
      type: 'DocumentRenamed',
      payload: { documentId: 's1', title: 'Downpour' },
    });
    expect(draftOf(renameNode(novel(), F('part1'), 'Book One'))).toEqual({
      type: 'FolderRenamed',
      payload: { folderId: 'part1', title: 'Book One' },
    });
  });

  it('refuses unchanged, blank and missing', () => {
    expect(errorOf(renameNode(novel(), D('s1'), ' Rain '))).toBe('no-op');
    expect(errorOf(renameNode(novel(), D('s1'), ''))).toBe('invalid-title');
    expect(errorOf(renameNode(novel(), D('zzz'), 'A'))).toBe('not-found');
    expect(errorOf(renameNode(novel(), F('s1'), 'A'))).toBe('not-found');
  });
});

describe('moveNode', () => {
  it('reorders within a parent using the after-removal index', () => {
    // part1: [ch1, ch2]; moving ch1 after ch2 is index 1 once ch1 is removed.
    expect(draftOf(moveNode(novel(), F('ch1'), { parentId: 'part1', index: 1 }))).toEqual({
      type: 'FolderMoved',
      payload: { folderId: 'ch1', parentId: 'part1', index: 1 },
    });
  });

  it('nests a document in another folder, clamping the index', () => {
    expect(draftOf(moveNode(novel(), D('epilogue'), { parentId: 'part2', index: 7 }))).toEqual({
      type: 'DocumentMoved',
      payload: { documentId: 'epilogue', parentId: 'part2', index: 0 },
    });
  });

  it('refuses moving a folder into itself or its own descendant', () => {
    expect(errorOf(moveNode(novel(), F('part1'), { parentId: 'part1', index: 0 }))).toBe('cycle');
    expect(errorOf(moveNode(novel(), F('part1'), { parentId: 'ch1', index: 0 }))).toBe('cycle');
    expect(errorOf(moveNode(novel(), F('part1'), { parentId: 'ch2', index: 0 }))).toBe('cycle');
  });

  it('refuses moves across areas, into documents, into missing or archived folders', () => {
    const m = makeModel({
      manuscript: [
        { id: 'a' },
        { id: 'f', children: [] },
        { id: 'gone', archived: true, children: [] },
      ],
      notes: [{ id: 'nf', children: [] }],
    });
    expect(errorOf(moveNode(m, D('a'), { parentId: 'nf', index: 0 }))).toBe('cross-area');
    expect(errorOf(moveNode(m, F('nf'), { parentId: 'f', index: 0 }))).toBe('cross-area');
    expect(errorOf(moveNode(m, D('a'), { parentId: 'a', index: 0 }))).toBe('invalid-parent');
    expect(errorOf(moveNode(m, D('a'), { parentId: 'x', index: 0 }))).toBe('not-found');
    expect(errorOf(moveNode(m, D('a'), { parentId: 'gone', index: 0 }))).toBe('archived');
    expect(errorOf(moveNode(m, D('zz'), { parentId: null, index: 0 }))).toBe('not-found');
    expect(errorOf(moveNode(m, D('a'), { parentId: null, index: 1.5 }))).toBe('invalid-index');
  });

  it('refuses moves that change nothing, including clamped ones', () => {
    expect(errorOf(moveNode(novel(), D('epilogue'), { parentId: null, index: 2 }))).toBe('no-op');
    expect(errorOf(moveNode(novel(), D('epilogue'), { parentId: null, index: 50 }))).toBe('no-op');
    expect(errorOf(moveNode(novel(), F('part1'), { parentId: null, index: 0 }))).toBe('no-op');
  });
});

describe('archive / restore', () => {
  it('archives and restores', () => {
    expect(draftOf(archiveNode(novel(), F('ch1')))).toEqual({
      type: 'FolderArchived',
      payload: { folderId: 'ch1', archived: true },
    });
    const m = makeModel({ manuscript: [{ id: 'a', archived: true }] });
    expect(draftOf(restoreNode(m, D('a')))).toEqual({
      type: 'DocumentArchived',
      payload: { documentId: 'a', archived: false },
    });
  });

  it('refuses no-ops and missing nodes', () => {
    expect(errorOf(restoreNode(novel(), D('s1')))).toBe('no-op');
    expect(errorOf(archiveNode(novel(), F('nope')))).toBe('not-found');
  });
});

describe('editSynopsis', () => {
  it('replaces a document synopsis', () => {
    expect(draftOf(editSynopsis(novel(), D('s2'), 'She waits.'))).toEqual({
      type: 'SynopsisEdited',
      payload: { documentId: 's2', synopsis: 'She waits.' },
    });
    expect(draftOf(editSynopsis(novel(), D('s1'), '')).payload.synopsis).toBe('');
  });

  it('replaces a folder synopsis', () => {
    expect(draftOf(editSynopsis(novel(), F('ch2'), 'Morning after.'))).toEqual({
      type: 'SynopsisEdited',
      payload: { folderId: 'ch2', synopsis: 'Morning after.' },
    });
    expect(errorOf(editSynopsis(novel(), F('ch1'), 'Arrival.'))).toBe('no-op');
  });

  it('refuses unchanged, too long and missing', () => {
    expect(errorOf(editSynopsis(novel(), D('s1'), 'A stranger arrives.'))).toBe('no-op');
    expect(errorOf(editSynopsis(novel(), D('s1'), 'x'.repeat(2001)))).toBe('invalid-synopsis');
    expect(errorOf(editSynopsis(novel(), D('part1'), 'x'))).toBe('not-found');
    expect(errorOf(editSynopsis(novel(), F('s1'), 'x'))).toBe('not-found');
  });
});

describe('changeProjectSettings', () => {
  it('patches only the fields that changed', () => {
    const d = draftOf(
      changeProjectSettings(novel(), {
        genre: 'literary fiction',
        audience: '',
        dailyWordGoal: 500,
        title: ' Test Project ',
      }),
    );
    expect(d).toEqual({
      type: 'ProjectSettingsChanged',
      payload: { patch: { genre: 'literary fiction', dailyWordGoal: 500 } },
    });
    expectValid(d);
  });

  it('can clear the daily goal and change style notes and goals', () => {
    const m = { settings: { ...novel().settings, dailyWordGoal: 300 } };
    expect(
      draftOf(
        changeProjectSettings(m, { dailyWordGoal: null, goals: 'Finish', styleNotes: 'Short.' }),
      ).payload.patch,
    ).toEqual({
      dailyWordGoal: null,
      goals: 'Finish',
      styleNotes: 'Short.',
    });
  });

  it('refuses empty patches and invalid values', () => {
    expect(errorOf(changeProjectSettings(novel(), {}))).toBe('no-op');
    expect(errorOf(changeProjectSettings(novel(), { genre: '' }))).toBe('no-op');
    expect(errorOf(changeProjectSettings(novel(), { title: '  ' }))).toBe('invalid-title');
    expect(errorOf(changeProjectSettings(novel(), { dailyWordGoal: 0 }))).toBe('invalid-settings');
    expect(errorOf(changeProjectSettings(novel(), { dailyWordGoal: 2.5 }))).toBe(
      'invalid-settings',
    );
    expect(errorOf(changeProjectSettings(novel(), { genre: 'g'.repeat(101) }))).toBe(
      'invalid-settings',
    );
  });
});

describe('commit envelopes', () => {
  it('toCommitDraft produces a valid human CommitDraft', () => {
    const draft = draftOf(renameNode(novel(), D('s1'), 'Downpour'));
    const commit = toCommitDraft(draft, {
      commitId: '2f1c6a8e-3b2a-4f7e-9d1c-0a9b8c7d6e5f',
      projectId: 'proj1',
      clientTime: '2026-11-24T18:12:00.000Z',
      actorId: 'user1',
      deviceId: 'dev1',
      sessionId: 'sess1',
    });
    expect(commit).toMatchObject({
      type: 'DocumentRenamed',
      actor: { kind: 'human', id: 'user1' },
    });
    expect(CommitDraftSchema.safeParse(commit).success).toBe(true);
  });

  it('createCommitDrafter stamps ids and times', () => {
    let n = 0;
    const drafter = createCommitDrafter({
      projectId: 'proj1',
      actorId: 'user1',
      deviceId: 'dev1',
      sessionId: 'sess1',
      now: () => new Date(Date.UTC(2026, 10, 24, 18, 0, 0)),
      newId: () => `c${++n}`,
    });
    const commit = drafter(draftOf(archiveNode(novel(), D('s2'))));
    expect(commit).toMatchObject({ commitId: 'c1', clientTime: '2026-11-24T18:00:00.000Z' });
    expect(CommitDraftSchema.safeParse(commit).success).toBe(true);
  });
});
