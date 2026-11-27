import { describe, expect, it } from 'vitest';
import { binderModel } from '../test/binderModel';
import { workspaceTitles } from './titles';

describe('workspaceTitles', () => {
  it('single: the sole document goes by the project name', () => {
    const m = binderModel('Essay', { manuscript: [{ id: 'd', title: 'Essay' }] });
    expect(workspaceTitles(m, 'd')).toEqual({
      mode: 'single',
      soleId: 'd',
      docTitle: 'Essay',
      projectTitle: 'Essay',
      crumb: null,
    });
  });

  it('single: an old project whose document title differs still shows the project name', () => {
    const m = binderModel('Essay', { manuscript: [{ id: 'd', title: 'Untitled' }] });
    expect(workspaceTitles(m, 'd').docTitle).toBe('Essay');
  });

  it('single with a note open: the note title, and a crumb to the manuscript', () => {
    const m = binderModel('Essay', {
      manuscript: [{ id: 'd', title: 'Old' }],
      notes: [{ id: 'n', title: 'Characters' }],
    });
    expect(workspaceTitles(m, 'n')).toEqual({
      mode: 'single',
      soleId: 'd',
      docTitle: 'Characters',
      projectTitle: 'Essay',
      crumb: { title: 'Essay', documentId: 'd' },
    });
  });

  it('single ignores archived documents', () => {
    const m = binderModel('Essay', {
      manuscript: [{ id: 'd' }, { id: 'x', archived: true }],
    });
    expect(workspaceTitles(m, 'd').mode).toBe('single');
  });

  it('multi: each document keeps its own name', () => {
    const m = binderModel('Novel', {
      manuscript: [
        { id: 'a', title: 'One' },
        { id: 'b', title: 'Two' },
      ],
      notes: [{ id: 'n', title: 'Places' }],
    });
    expect(workspaceTitles(m, 'b')).toEqual({
      mode: 'multi',
      soleId: null,
      docTitle: 'Two',
      projectTitle: 'Novel',
      crumb: null,
    });
    expect(workspaceTitles(m, 'n').crumb).toBeNull();
  });

  it('multi: a manuscript folder', () => {
    const m = binderModel('Novel', {
      manuscript: [{ id: 'f', title: 'Part One', children: [{ id: 'a', title: 'One' }] }],
    });
    expect(workspaceTitles(m, 'a')).toMatchObject({ mode: 'multi', docTitle: 'One' });
  });

  it('empty: no manuscript, nothing open', () => {
    const m = binderModel('Notes only', { notes: [{ id: 'n', title: 'Ideas' }] });
    expect(workspaceTitles(m, null)).toEqual({
      mode: 'empty',
      soleId: null,
      docTitle: null,
      projectTitle: 'Notes only',
      crumb: null,
    });
    expect(workspaceTitles(m, 'n')).toMatchObject({ mode: 'empty', docTitle: 'Ideas' });
  });
});
