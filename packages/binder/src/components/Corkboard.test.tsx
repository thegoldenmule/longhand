import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BinderArea, BinderRef } from '@longhand/schema';
import { Corkboard } from './Corkboard';
import { binderReducer } from '../reducer';
import type { BinderDraft } from '../drafts';
import type { BinderModel } from '../model';
import { makeModel, novel } from '../test/fixtures';

afterEach(cleanup);

function setup(
  initial: BinderModel = novel(),
  folderId: string | null = 'ch1',
  area: BinderArea = 'manuscript',
  extra: { onOpen?: (ref: BinderRef) => void; showWordCounts?: boolean } = {},
) {
  const spy = vi.fn<(d: BinderDraft) => void>();
  function Harness() {
    const [model, setModel] = useState(initial);
    return (
      <Corkboard
        model={model}
        area={area}
        folderId={folderId}
        onDraft={(d) => {
          spy(d);
          setModel((m) => binderReducer(m, d));
        }}
        {...extra}
      />
    );
  }
  render(<Harness />);
  const titles = () =>
    within(screen.getByRole('list'))
      .getAllByRole('heading', { level: 3 })
      .map((h) => h.textContent);
  return { spy, user: userEvent.setup(), titles };
}

describe('Corkboard', () => {
  it('shows a card per visible child with title and synopsis', () => {
    const m = makeModel({
      manuscript: [
        {
          id: 'ch',
          title: 'Chapter',
          children: [
            { id: 'a', title: 'Alpha', synopsis: 'First things.' },
            { id: 'gone', title: 'Gone', archived: true },
            { id: 'sub', title: 'Subplot', children: [{ id: 'b' }, { id: 'c' }] },
          ],
        },
      ],
    });
    const { titles } = setup(m, 'ch', 'manuscript', { showWordCounts: true });
    expect(screen.getByRole('list', { name: 'Corkboard: Chapter' })).toBeTruthy();
    expect(titles()).toEqual(['Alpha', 'Subplot']);
    expect(screen.getByText('First things.')).toBeTruthy();
    expect(screen.getByText('Folder · 2 items')).toBeTruthy();
    expect(screen.getAllByText('0 words')).toHaveLength(2);
  });

  it('shows the area root when folderId is null, and an empty state', () => {
    setup(novel(), null, 'notes');
    expect(screen.getByRole('list', { name: 'Corkboard: Notes' })).toBeTruthy();
    cleanup();
    setup(novel(), 'part2');
    expect(screen.getByText('This folder is empty.')).toBeTruthy();
  });

  it('edits a synopsis in place and emits SynopsisEdited on blur', async () => {
    const { spy, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Edit synopsis of ‘The Inn’' }));
    const box = screen.getByRole('textbox', { name: 'Synopsis of ‘The Inn’' });
    expect(document.activeElement).toBe(box);
    await user.type(box, 'She waits at the door.');
    await user.tab();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith({
      type: 'SynopsisEdited',
      payload: { documentId: 's2', synopsis: 'She waits at the door.' },
    });
    expect(screen.getByText('She waits at the door.')).toBeTruthy();
  });

  it('saves with Ctrl+Enter, discards with Escape, and skips unchanged synopses', async () => {
    const { spy, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Edit synopsis of ‘Rain’' }));
    await user.keyboard(' Wet.{Control>}{Enter}{/Control}');
    expect(spy).toHaveBeenLastCalledWith({
      type: 'SynopsisEdited',
      payload: { documentId: 's1', synopsis: 'A stranger arrives. Wet.' },
    });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Edit synopsis of ‘Rain’' }),
    );
    await user.keyboard('{Enter}');
    await user.keyboard('xyz{Escape}');
    expect(spy).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Edit synopsis of ‘Rain’' }));
    await user.tab();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reorders cards from the keyboard with the Move button', async () => {
    const { spy, user, titles } = setup();
    const handle = screen.getByRole('button', { name: 'Move ‘Rain’' });
    handle.focus();
    await user.keyboard('{Enter}');
    expect(handle.getAttribute('aria-pressed')).toBe('true');
    await user.keyboard('{ArrowRight}');
    expect(titles()).toEqual(['The Inn', 'Rain']);
    expect(spy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Move ‘Rain’' }));
    await user.keyboard('{Enter}');
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentMoved',
      payload: { documentId: 's1', parentId: 'ch1', index: 1 },
    });
    expect(titles()).toEqual(['The Inn', 'Rain']);
  });

  it('cancels a keyboard move with Escape', async () => {
    const { spy, user, titles } = setup();
    screen.getByRole('button', { name: 'Move ‘The Inn’' }).focus();
    await user.keyboard('{Enter}{ArrowLeft}{Escape}');
    expect(titles()).toEqual(['Rain', 'The Inn']);
    expect(spy).not.toHaveBeenCalled();
  });

  it('reorders cards by dragging', () => {
    const { spy, titles } = setup(novel(), null);
    const cards = screen.getAllByRole('listitem');
    const [part1, , epilogue] = cards as [HTMLElement, HTMLElement, HTMLElement];
    vi.spyOn(part1, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      bottom: 100,
      right: 200,
      width: 200,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const dt = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    fireEvent.dragStart(epilogue, { dataTransfer: dt });
    fireEvent.dragOver(part1, { dataTransfer: dt, clientX: 20 });
    expect(part1.className).toContain('is-drop-before');
    fireEvent.drop(part1, { dataTransfer: dt, clientX: 20 });
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentMoved',
      payload: { documentId: 'epilogue', parentId: null, index: 0 },
    });
    expect(titles()).toEqual(['Epilogue', 'Part One', 'Part Two']);
  });

  it('opens a card from its title', async () => {
    const onOpen = vi.fn();
    const { user } = setup(novel(), 'ch1', 'manuscript', { onOpen });
    await user.click(screen.getByRole('button', { name: 'The Inn' }));
    expect(onOpen).toHaveBeenCalledWith({ kind: 'document', id: 's2' });
  });
});
