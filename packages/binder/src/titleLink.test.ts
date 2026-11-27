import { describe, expect, it } from 'vitest';
import { titleOrUntitled, UNTITLED } from './drafts';
import { renameProjectAndDocument, withTitleLink } from './titleLink';
import type { BinderModel } from './model';
import { makeModel } from './test/fixtures';

/** A one-document project: the project is "Essay", the document's stored title is `docTitle`. */
function single(docTitle = 'Essay'): BinderModel {
  const m = makeModel({ manuscript: [{ id: 'd', title: docTitle }] });
  return { ...m, settings: { ...m.settings, title: 'Essay' } };
}

describe('titleOrUntitled', () => {
  it('trims, turns newlines into spaces and names the blank Untitled', () => {
    expect(UNTITLED).toBe('Untitled');
    expect(titleOrUntitled('  The Storm  ')).toBe('The Storm');
    expect(titleOrUntitled('The\nStorm\r\nat Sea\r')).toBe('The Storm at Sea');
    expect(titleOrUntitled('')).toBe('Untitled');
    expect(titleOrUntitled(' \n\t ')).toBe('Untitled');
  });
});

describe('renameProjectAndDocument', () => {
  it('renames the project first, then the document', () => {
    const r = renameProjectAndDocument(single(), 'd', 'The Storm');
    expect(r).toEqual({
      ok: true,
      drafts: [
        { type: 'ProjectSettingsChanged', payload: { patch: { title: 'The Storm' } } },
        { type: 'DocumentRenamed', payload: { documentId: 'd', title: 'The Storm' } },
      ],
    });
  });

  it('renames only the document when only its stored title differs', () => {
    const r = renameProjectAndDocument(single('Old name'), 'd', 'Essay');
    expect(r).toEqual({
      ok: true,
      drafts: [{ type: 'DocumentRenamed', payload: { documentId: 'd', title: 'Essay' } }],
    });
  });

  it('is a no-op when nothing changes', () => {
    const r = renameProjectAndDocument(single(), 'd', ' Essay ');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.code).toBe('no-op');
  });

  it('names a blank title Untitled', () => {
    const r = renameProjectAndDocument(single(), 'd', '   ');
    expect(r.ok && r.drafts.map((d) => d.payload)).toEqual([
      { patch: { title: 'Untitled' } },
      { documentId: 'd', title: 'Untitled' },
    ]);
  });

  it('refuses a title over 200 characters', () => {
    const r = renameProjectAndDocument(single(), 'd', 'x'.repeat(201));
    expect(!r.ok && r.error.code).toBe('invalid-title');
  });

  it('trims and joins lines', () => {
    const r = renameProjectAndDocument(single(), 'd', '  A\nB  ');
    expect(r.ok && r.drafts.map((d) => d.payload)).toEqual([
      { patch: { title: 'A B' } },
      { documentId: 'd', title: 'A B' },
    ]);
  });
});

const created = (id: string, kind: 'manuscript' | 'note' = 'manuscript') =>
  ({
    type: 'DocumentCreated',
    payload: { documentId: id, kind, title: 'Untitled', parentId: null, index: 1 },
  }) as const;

describe('withTitleLink', () => {
  it('renames the sole document to the project name before a second document arrives', () => {
    const draft = created('d2');
    expect(withTitleLink(single('Old name'), draft)).toEqual([
      { type: 'DocumentRenamed', payload: { documentId: 'd', title: 'Essay' } },
      draft,
    ]);
  });

  it('passes the draft through when the titles already match', () => {
    const draft = created('d2');
    expect(withTitleLink(single(), draft)).toEqual([draft]);
  });

  it('passes a new note through', () => {
    const draft = created('n1', 'note');
    expect(withTitleLink(single('Old name'), draft)).toEqual([draft]);
  });

  it('renames first when restoring an archived manuscript document', () => {
    const m = single('Old name');
    const withArchived = makeModel({
      manuscript: [
        { id: 'd', title: 'Old name' },
        { id: 'a', title: 'Draft two', archived: true },
      ],
    });
    const model: BinderModel = { ...withArchived, settings: m.settings };
    const draft = {
      type: 'DocumentArchived',
      payload: { documentId: 'a', archived: false },
    } as const;
    expect(withTitleLink(model, draft)).toEqual([
      { type: 'DocumentRenamed', payload: { documentId: 'd', title: 'Essay' } },
      draft,
    ]);
  });

  it('renames first when a manuscript folder arrives', () => {
    const draft = {
      type: 'FolderCreated',
      payload: { folderId: 'f', area: 'manuscript', title: 'New folder', parentId: null, index: 1 },
    } as const;
    expect(withTitleLink(single('Old name'), draft)).toEqual([
      { type: 'DocumentRenamed', payload: { documentId: 'd', title: 'Essay' } },
      draft,
    ]);
  });

  it('passes everything through in multi mode', () => {
    const m = makeModel({
      manuscript: [
        { id: 'a', title: 'One' },
        { id: 'b', title: 'Two' },
      ],
    });
    const draft = created('c');
    expect(withTitleLink(m, draft)).toEqual([draft]);
    const archive = {
      type: 'DocumentArchived',
      payload: { documentId: 'b', archived: true },
    } as const;
    expect(withTitleLink(m, archive)).toEqual([archive]);
  });
});
