// @vitest-environment jsdom
import { CommitDraftSchema, docFromJSON } from '@longhand/schema';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getResearchInput, insertCitation, placeClipping } from '../commands';
import type { ResearchDraft } from '../drafts';
import { AUSTEN, LECUN, clipping, draftContext, source, sources } from '../test-support/state';
import { Bibliography } from './Bibliography';
import { CitationPicker } from './CitationPicker';
import { ClippingsList } from './ClippingsList';

afterEach(cleanup);

const LIB = sources(source(LECUN), source(AUSTEN));

function editorState(): EditorState {
  const doc = docFromJSON({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Deep nets learn.' }] }],
  });
  return EditorState.create({ doc, selection: TextSelection.create(doc, 17) });
}

describe('<ClippingsList>', () => {
  it('saves a quote with its location', async () => {
    const drafts: ResearchDraft[] = [];
    const user = userEvent.setup();
    render(
      <ClippingsList
        clippings={[]}
        sources={LIB}
        draftContext={draftContext()}
        onDraft={(d) => drafts.push(d)}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save a quote…' }));
    await user.selectOptions(screen.getByLabelText('Source'), 'src-lecun');
    await user.click(screen.getByRole('button', { name: 'Save quote' }));
    expect(screen.getByRole('alert').textContent).toBe('Paste or type the quote.');
    await user.type(
      screen.getByLabelText('Quote'),
      'Deep learning allows computational models{Enter}to learn',
    );
    await user.type(screen.getByLabelText('Location'), 'p. 436');
    await user.click(screen.getByRole('button', { name: 'Save quote' }));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      type: 'ClippingSaved',
      payload: {
        sourceId: 'src-lecun',
        text: 'Deep learning allows computational models\nto learn',
        locator: 'p. 436',
        note: null,
      },
    });
    expect(CommitDraftSchema.safeParse(drafts[0]).success).toBe(true);
  });

  it('places a clipping in the manuscript as a quoted quote block, and removes clippings', async () => {
    const drafts: ResearchDraft[] = [];
    const user = userEvent.setup();
    let tr: Transaction | null = null;
    const state = editorState();
    const onPlace = vi.fn((c) => placeClipping(c)(state, (t) => (tr = t)));
    render(
      <ClippingsList
        clippings={{
          'clip-1': clipping(),
          'clip-2': clipping({ id: 'clip-2', removed: true, text: 'gone' }),
        }}
        sources={LIB}
        draftContext={draftContext()}
        onDraft={(d) => drafts.push(d)}
        onPlace={onPlace}
      />,
    );
    expect(screen.queryByText('gone')).toBeNull();
    const item = screen.getByRole('listitem');
    expect(within(item).getByText('Pride and Prejudice, p. 1')).toBeTruthy();
    await user.click(within(item).getByRole('button', { name: 'Place in manuscript' }));
    expect(onPlace).toHaveBeenCalledWith(clipping());
    const placed = tr as Transaction | null;
    expect(placed).not.toBeNull();
    expect(getResearchInput(placed!)!.run).toEqual({
      steps: 1,
      method: 'clipping',
      clippingId: 'clip-1',
    });
    expect(placed!.doc.child(1).type.name).toBe('quote_block');

    await user.click(within(item).getByRole('button', { name: 'Remove' }));
    expect(drafts[0]).toMatchObject({ type: 'ClippingRemoved', payload: { clippingId: 'clip-1' } });
  });

  it('filters to one source', () => {
    render(
      <ClippingsList
        clippings={[
          clipping(),
          clipping({ id: 'clip-3', sourceId: 'src-lecun', text: 'Other quote' }),
        ]}
        sources={LIB}
        sourceId="src-lecun"
        draftContext={draftContext()}
        onDraft={() => {}}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Other quote')).toBeTruthy();
  });
});

describe('<CitationPicker>', () => {
  it('previews and inserts a citation with a locator', async () => {
    const user = userEvent.setup();
    let state = editorState();
    const onInsert = vi.fn((sourceId: string, locator: string | null) =>
      insertCitation(sourceId, locator, { documentId: 'doc1', citationId: 'cite-1' })(
        state,
        (t) => {
          state = state.apply(t);
        },
      ),
    );
    render(<CitationPicker sources={LIB} onInsert={onInsert} style="apa" />);
    expect(
      (screen.getByRole('button', { name: 'Insert citation' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.type(screen.getByLabelText('Find a source'), 'deep');
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    await user.click(screen.getByRole('radio'));
    await user.type(screen.getByLabelText('Page or location'), 'p. 437');
    expect(screen.getByRole('status').textContent).toBe('(LeCun et al., 2015, p. 437)');
    await user.click(screen.getByRole('button', { name: 'Insert citation' }));
    expect(onInsert).toHaveBeenCalledWith('src-lecun', 'p. 437');
    const cite = state.doc.firstChild!.lastChild!;
    expect(cite.type.name).toBe('citation');
    expect(cite.attrs).toEqual({ sourceId: 'src-lecun', locator: 'p. 437' });
  });

  it('previews in the chosen style and omits empty locators', async () => {
    const user = userEvent.setup();
    const onInsert = vi.fn();
    render(
      <CitationPicker
        sources={LIB}
        initialSourceId="src-austen"
        style="modern-language-association"
        onInsert={onInsert}
      />,
    );
    expect(screen.getByRole('status').textContent).toBe('(Austen)');
    await user.click(screen.getByRole('button', { name: 'Insert citation' }));
    expect(onInsert).toHaveBeenCalledWith('src-austen', null);
  });
});

describe('<Bibliography>', () => {
  it('renders the bibliography and switches style', async () => {
    const user = userEvent.setup();
    const onStyleChange = vi.fn();
    render(<Bibliography sources={LIB} onStyleChange={onStyleChange} />);
    const list = screen.getByRole('list');
    expect(list.getAttribute('data-style')).toBe('apa');
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'Austen, J. (2003). Pride and Prejudice. Penguin Books.',
      'LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539',
    ]);
    expect(within(list).getAllByRole('listitem')[0]!.querySelector('i')!.textContent).toBe(
      'Pride and Prejudice',
    );

    await user.selectOptions(screen.getByLabelText('Style'), 'modern-language-association');
    expect(onStyleChange).toHaveBeenCalledWith('modern-language-association');
    expect(screen.getByRole('list').getAttribute('data-style')).toBe('modern-language-association');
    expect(screen.getAllByRole('listitem')[0]!.textContent).toBe(
      'Austen, Jane. Pride and Prejudice. Penguin Books, 2003.',
    );

    await user.selectOptions(screen.getByLabelText('Style'), 'chicago-author-date');
    expect(screen.getAllByRole('listitem')[0]!.textContent).toBe(
      'Austen, Jane. 2003. Pride and Prejudice. Penguin Books.',
    );
  });

  it('is controlled by the style prop and limits to cited sources', () => {
    render(
      <Bibliography sources={LIB} style="chicago" sourceIds={['src-lecun']} title="Works cited" />,
    );
    expect(screen.getByRole('heading', { name: 'Works cited' })).toBeTruthy();
    expect((screen.getByLabelText('Style') as HTMLSelectElement).value).toBe('chicago-author-date');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('shows an empty state', () => {
    render(<Bibliography sources={{}} />);
    expect(screen.getByText('Nothing to list yet.')).toBeTruthy();
  });
});
