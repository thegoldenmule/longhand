import type { BinderDraft } from '@longhand/binder';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { binderModel } from '../test/binderModel';
import { BinderPane } from './BinderPane';

afterEach(cleanup);

function setup(single: boolean) {
  const model = single
    ? binderModel('Essay', {
        manuscript: [{ id: 'd', title: 'Essay' }],
        notes: [{ id: 'n', title: 'Characters' }],
      })
    : binderModel('Novel', {
        manuscript: [
          { id: 'a', title: 'One' },
          { id: 'b', title: 'Two' },
        ],
      });
  const onDraft = vi.fn<(d: BinderDraft) => void>();
  const onError = vi.fn<(m: string) => void>();
  render(
    <BinderPane
      model={model}
      single={single}
      {...(single ? { hide: [{ kind: 'document' as const, id: 'd' }] } : {})}
      selected={{ kind: 'document', id: single ? 'd' : 'a' }}
      corkboard={false}
      onCorkboard={() => undefined}
      onSelect={() => undefined}
      onDraft={onDraft}
      onError={onError}
    />,
  );
  return { onDraft, onError };
}

describe('BinderPane', () => {
  it('single: no project title, no corkboard switch, no row for the document', () => {
    setup(true);
    const pane = screen.getByTestId('binder-pane');
    expect(within(pane).getByRole('link', { name: 'All projects' }).textContent).toBe(
      'All projects',
    );
    expect(screen.queryByTestId('project-title')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Binder view' })).toBeNull();
    expect(within(pane).queryByText('Essay')).toBeNull();
    expect(within(pane).queryByDisplayValue('Essay')).toBeNull();
    const manuscript = screen.getByRole('tree', { name: 'Manuscript' });
    expect(within(manuscript).queryAllByRole('treeitem')).toHaveLength(0);
    expect(screen.getByRole('treeitem', { name: 'Characters' })).toBeTruthy();
  });

  it('multi: the project title is edited in the head', () => {
    const { onDraft } = setup(false);
    expect(screen.getByRole('group', { name: 'Binder view' })).toBeTruthy();
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
    const title = screen.getByRole('textbox', { name: 'Project title' }) as HTMLInputElement;
    expect(title.value).toBe('Novel');
    expect(title.dataset.testid).toBe('project-title');
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'The Novel' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(onDraft).toHaveBeenCalledExactlyOnceWith({
      type: 'ProjectSettingsChanged',
      payload: { patch: { title: 'The Novel' } },
    });
  });
});
