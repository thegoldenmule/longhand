import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BinderRef } from '@longhand/schema';
import { BinderTree, type BinderTreeProps } from './BinderTree';
import { binderReducer } from '../reducer';
import type { BinderDraft } from '../drafts';
import type { BinderModel } from '../model';
import { makeModel, novel, shape } from '../test/fixtures';

afterEach(cleanup);

function Harness(
  props: Partial<BinderTreeProps> & { initial: BinderModel; spy: (d: BinderDraft) => void },
) {
  const { initial, spy, ...rest } = props;
  const [model, setModel] = useState(initial);
  const [selected, setSelected] = useState<BinderRef | null>(null);
  return (
    <>
      <BinderTree
        model={model}
        selected={selected}
        onSelect={setSelected}
        onDraft={(d) => {
          spy(d);
          setModel((m) => binderReducer(m, d));
        }}
        {...rest}
      />
      <output data-testid="shape">{JSON.stringify(shape(model, 'manuscript'))}</output>
      <output data-testid="selected">{selected ? `${selected.kind}:${selected.id}` : ''}</output>
    </>
  );
}

function setup(initial = novel(), props: Partial<BinderTreeProps> = {}) {
  const spy = vi.fn<(d: BinderDraft) => void>();
  let n = 0;
  const user = userEvent.setup();
  render(<Harness initial={initial} spy={spy} newId={() => `new${++n}`} {...props} />);
  const shapeNow = () => JSON.parse(screen.getByTestId('shape').textContent ?? '[]') as unknown;
  return { spy, user, shapeNow };
}

const item = (name: string) => screen.getByRole('treeitem', { name });
const row = (name: string) => item(name).querySelector('.lh-binder-row') as HTMLElement;

describe('BinderTree rendering', () => {
  it('renders both areas as ARIA trees with nested levels', () => {
    setup();
    const manuscript = screen.getByRole('tree', { name: 'Manuscript' });
    const notes = screen.getByRole('tree', { name: 'Notes' });
    expect(
      within(manuscript)
        .getAllByRole('treeitem')
        .map((el) => el.getAttribute('aria-level')),
    ).toEqual(['1', '2', '3', '3', '2', '3', '1', '1']);
    expect(item('Part One').getAttribute('aria-expanded')).toBe('true');
    expect(item('Rain').getAttribute('aria-expanded')).toBeNull();
    expect(item('Chapter 2').getAttribute('aria-posinset')).toBe('2');
    expect(item('Chapter 2').getAttribute('aria-setsize')).toBe('2');
    expect(within(notes).getByRole('treeitem', { name: 'Mara' })).toBeTruthy();
    // Exactly one row is tabbable.
    expect(screen.getAllByRole('treeitem').filter((el) => el.tabIndex === 0)).toHaveLength(2);
  });

  it('respects defaultExpanded and hides archived nodes', () => {
    const m = makeModel({
      manuscript: [
        { id: 'p', title: 'Part', children: [{ id: 'a', title: 'Alpha' }] },
        { id: 'x', title: 'Gone', archived: true },
      ],
    });
    setup(m, { defaultExpanded: [] });
    expect(item('Part').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: 'Alpha' })).toBeNull();
    expect(screen.queryByRole('treeitem', { name: 'Gone' })).toBeNull();
  });

  it('shows word counts per row, folders summing their subtree', () => {
    setup(novel(), { showWordCounts: true, wordCounts: { s3: 1200 } });
    expect(within(item('The Inn')).getByText('5')).toBeTruthy();
    expect(within(row('Chapter 1')).getByText('9')).toBeTruthy();
    expect(within(row('Part One')).getByText('1,209')).toBeTruthy();
    expect(item('The Inn').getAttribute('aria-describedby')).toBeTruthy();
  });
});

describe('BinderTree keyboard', () => {
  it('navigates with arrows, collapses and expands, and selects with Enter', async () => {
    const { user } = setup();
    // New document, New folder (Archive is disabled until something is focused), then the tree.
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(item('Part One'));
    // The tree is a single tab stop.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New note' }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(item('Part One'));
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(item('Rain'));
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement).toBe(item('Chapter 1'));
    await user.keyboard('{ArrowLeft}');
    expect(item('Chapter 1').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: 'Rain' })).toBeNull();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(document.activeElement).toBe(item('Rain'));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(item('Epilogue'));
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('selected').textContent).toBe('document:epilogue');
    expect(item('Epilogue').getAttribute('aria-selected')).toBe('true');
  });

  it('renames inline with F2 and Enter', async () => {
    const { user, spy } = setup();
    await user.click(row('Rain'));
    await user.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Rename ‘Rain’' });
    expect(document.activeElement).toBe(input);
    await user.keyboard('Downpour{Enter}');
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentRenamed',
      payload: { documentId: 's1', title: 'Downpour' },
    });
    expect(document.activeElement).toBe(item('Downpour'));
  });

  it('cancels a rename with Escape and emits nothing for an unchanged title', async () => {
    const { user, spy } = setup();
    await user.click(row('Part Two'));
    await user.keyboard('{F2}Something{Escape}');
    expect(spy).not.toHaveBeenCalled();
    expect(item('Part Two')).toBeTruthy();
    await user.dblClick(row('Part Two'));
    await user.keyboard('{Enter}');
    expect(spy).not.toHaveBeenCalled();
  });

  it('creates a document inside the focused folder and opens it for naming', async () => {
    const { user, spy } = setup();
    await user.click(row('Chapter 2'));
    await user.click(screen.getAllByRole('button', { name: 'New document' })[0]!);
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentCreated',
      payload: {
        documentId: 'new1',
        kind: 'manuscript',
        title: 'Untitled',
        parentId: 'ch2',
        index: 1,
      },
    });
    const input = screen.getByRole('textbox', { name: 'Rename ‘Untitled’' });
    expect(document.activeElement).toBe(input);
    await user.keyboard('Evening{Enter}');
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentRenamed',
      payload: { documentId: 'new1', title: 'Evening' },
    });
    expect(within(item('Chapter 2')).getByRole('treeitem', { name: 'Evening' })).toBeTruthy();
  });

  it('creates folders after a focused document and notes in Notes', async () => {
    const { user, spy } = setup();
    await user.click(row('Epilogue'));
    await user.click(screen.getByRole('button', { name: 'New folder in Manuscript' }));
    expect(spy).toHaveBeenLastCalledWith({
      type: 'FolderCreated',
      payload: {
        folderId: 'new1',
        area: 'manuscript',
        title: 'New folder',
        parentId: null,
        index: 3,
      },
    });
    await user.keyboard('{Enter}');
    await user.click(screen.getByRole('button', { name: 'New note' }));
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentCreated',
      payload: {
        documentId: 'new2',
        kind: 'note',
        title: 'Untitled note',
        parentId: null,
        index: 2,
      },
    });
  });

  it('moves with M, arrow keys and Enter', async () => {
    const { user, spy, shapeNow } = setup();
    await user.click(row('Rain'));
    await user.keyboard('m{ArrowDown}');
    // The preview shows the move before it is committed.
    expect(
      within(item('Chapter 1'))
        .getAllByRole('treeitem')
        .map((el) => el.textContent),
    ).toEqual(['The Inn', 'Rain']);
    expect(spy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(item('Rain'));
    await user.keyboard('{Enter}');
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentMoved',
      payload: { documentId: 's1', parentId: 'ch1', index: 1 },
    });
    expect(shapeNow()).toEqual([
      { part1: [{ ch1: ['s2', 's1'] }, { ch2: ['s3'] }] },
      { part2: [] },
      'epilogue',
    ]);
  });

  it('nests with ArrowRight and moves out with ArrowLeft in move mode', async () => {
    const { user, spy } = setup();
    await user.click(row('Epilogue'));
    await user.keyboard('m{ArrowRight}{Enter}');
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentMoved',
      payload: { documentId: 'epilogue', parentId: 'part2', index: 0 },
    });
    expect(document.activeElement).toBe(item('Epilogue'));
    await user.keyboard('m{ArrowLeft}{Enter}');
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentMoved',
      payload: { documentId: 'epilogue', parentId: null, index: 2 },
    });
  });

  it('moves a folder with its subtree, stepping out past the first sibling', async () => {
    const { user, spy, shapeNow } = setup();
    await user.click(row('Chapter 1'));
    await user.keyboard('m{ArrowUp}{Enter}');
    expect(spy).toHaveBeenLastCalledWith({
      type: 'FolderMoved',
      payload: { folderId: 'ch1', parentId: null, index: 0 },
    });
    expect(shapeNow()).toEqual([
      { ch1: ['s1', 's2'] },
      { part1: [{ ch2: ['s3'] }] },
      { part2: [] },
      'epilogue',
    ]);
  });

  it('Escape cancels a move and nothing is emitted', async () => {
    const { user, spy, shapeNow } = setup();
    const before = shapeNow();
    await user.click(row('Part One'));
    await user.keyboard('m{ArrowDown}{ArrowDown}{Escape}');
    expect(spy).not.toHaveBeenCalled();
    expect(shapeNow()).toEqual(before);
    expect(
      within(screen.getByRole('tree', { name: 'Manuscript' })).getAllByRole('treeitem')[0],
    ).toBe(item('Part One'));
  });

  it('announces when a step goes nowhere', async () => {
    const { user, spy } = setup();
    await user.click(row('Part One'));
    await user.keyboard('m{ArrowUp}');
    expect(screen.getAllByRole('status')[0]?.textContent).toContain('Already at the top');
    await user.keyboard('{Enter}');
    expect(spy).not.toHaveBeenCalled();
  });

  it('archives with Delete and restores from the archive view', async () => {
    const { user, spy } = setup();
    await user.click(row('The Inn'));
    await user.keyboard('{Delete}');
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentArchived',
      payload: { documentId: 's2', archived: true },
    });
    expect(screen.queryByRole('treeitem', { name: 'The Inn' })).toBeNull();
    expect(document.activeElement).toBe(item('Chapter 2'));
    await user.click(screen.getByRole('button', { name: /Archive 1/ }));
    const list = screen.getByRole('list', { name: 'Archived items' });
    expect(within(list).getByText('The Inn')).toBeTruthy();
    await user.click(within(list).getByRole('button', { name: 'Restore ‘The Inn’' }));
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentArchived',
      payload: { documentId: 's2', archived: false },
    });
    expect(item('The Inn')).toBeTruthy();
  });

  it('archives a folder from the toolbar, hiding its subtree', async () => {
    const { user, spy } = setup();
    await user.click(row('Chapter 1'));
    await user.click(screen.getByRole('button', { name: 'Archive ‘Chapter 1’' }));
    expect(spy).toHaveBeenLastCalledWith({
      type: 'FolderArchived',
      payload: { folderId: 'ch1', archived: true },
    });
    expect(screen.queryByRole('treeitem', { name: 'Rain' })).toBeNull();
  });
});

describe('BinderTree hide', () => {
  const sole = () =>
    makeModel({ manuscript: [{ id: 'd', title: 'Essay' }], notes: [{ id: 'n', title: 'Ideas' }] });
  const hidden = { kind: 'document' as const, id: 'd' };

  it('leaves hidden rows out, with no empty message', () => {
    setup(sole(), { hide: [hidden], selected: hidden });
    const manuscript = screen.getByRole('tree', { name: 'Manuscript' });
    expect(within(manuscript).queryAllByRole('treeitem')).toHaveLength(0);
    expect(screen.queryByText('No documents yet.')).toBeNull();
    expect(screen.queryByText('Essay')).toBeNull();
    expect(item('Ideas')).toBeTruthy();
  });

  it('never archives a hidden node', async () => {
    const { user, spy } = setup(sole(), { hide: [hidden], selected: hidden });
    const area = screen.getByRole('region', { name: 'Manuscript' });
    const archive = within(area).getByRole('button', { name: 'Archive (nothing selected)' });
    expect((archive as HTMLButtonElement).disabled).toBe(true);
    await user.click(archive);
    expect(spy).not.toHaveBeenCalled();
  });

  it('places a new document after the hidden selection and opens it for naming', async () => {
    const { user, spy } = setup(sole(), { hide: [hidden], selected: hidden });
    const area = screen.getByRole('region', { name: 'Manuscript' });
    await user.click(within(area).getByRole('button', { name: 'New document' }));
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentCreated',
      payload: {
        documentId: 'new1',
        kind: 'manuscript',
        title: 'Untitled',
        parentId: null,
        index: 1,
      },
    });
    const input = screen.getByRole('textbox', { name: 'Rename ‘Untitled’' });
    expect(document.activeElement).toBe(input);
    await user.keyboard('Second{Enter}');
    expect(item('Second')).toBeTruthy();
    expect(screen.queryByRole('treeitem', { name: 'Essay' })).toBeNull();
  });

  it('shows the empty message when the area really is empty', () => {
    setup(makeModel({ notes: [{ id: 'n', title: 'Ideas' }] }), { hide: [hidden] });
    expect(screen.getByText('No documents yet.')).toBeTruthy();
  });
});

describe('BinderTree pointer drag and drop', () => {
  const dataTransfer = () => ({
    setData: vi.fn(),
    getData: vi.fn(),
    effectAllowed: '',
    dropEffect: '',
  });

  function rect(el: HTMLElement) {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top: 0,
      left: 0,
      bottom: 20,
      right: 200,
      width: 200,
      height: 20,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  }

  function dragTo(from: HTMLElement, to: HTMLElement, clientY: number) {
    const dt = dataTransfer();
    rect(to);
    fireEvent.dragStart(from, { dataTransfer: dt });
    fireEvent.dragOver(to, { dataTransfer: dt, clientY });
    fireEvent.drop(to, { dataTransfer: dt, clientY });
    fireEvent.dragEnd(from, { dataTransfer: dt });
  }

  it('drops after a document in another folder', () => {
    const { spy, shapeNow } = setup();
    dragTo(row('Morning'), row('Epilogue'), 18);
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentMoved',
      payload: { documentId: 's3', parentId: null, index: 3 },
    });
    expect(shapeNow()).toEqual([
      { part1: [{ ch1: ['s1', 's2'] }, { ch2: [] }] },
      { part2: [] },
      'epilogue',
      's3',
    ]);
  });

  it('nests into a folder when dropped on its middle', () => {
    const { spy } = setup();
    dragTo(row('Epilogue'), row('Part Two'), 10);
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentMoved',
      payload: { documentId: 'epilogue', parentId: 'part2', index: 0 },
    });
  });

  it('reorders before a sibling', () => {
    const { spy } = setup();
    dragTo(row('The Inn'), row('Rain'), 2);
    expect(spy).toHaveBeenLastCalledWith({
      type: 'DocumentMoved',
      payload: { documentId: 's2', parentId: 'ch1', index: 0 },
    });
  });

  it('refuses dropping a folder into its own descendant', () => {
    const { spy, shapeNow } = setup();
    const before = shapeNow();
    dragTo(row('Part One'), row('Chapter 2'), 10);
    dragTo(row('Part One'), row('Rain'), 18);
    expect(spy).not.toHaveBeenCalled();
    expect(shapeNow()).toEqual(before);
  });

  it('refuses dropping into the other area', () => {
    const { spy } = setup();
    dragTo(row('Rain'), row('Characters'), 10);
    expect(spy).not.toHaveBeenCalled();
  });
});
