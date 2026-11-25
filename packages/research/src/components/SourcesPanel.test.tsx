// @vitest-environment jsdom
import { CommitDraftSchema } from '@longhand/schema';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResearchDraft } from '../drafts';
import { createMetadataClient } from '../metadata';
import { fixtureFetch } from '../test-support/fixture-fetch';
import { AUSTEN, LECUN, draftContext, source, sources, surfaced } from '../test-support/state';
import { SourcesPanel } from './SourcesPanel';
import { AI_SURFACED_LABEL } from './shared';

afterEach(cleanup);

function setup(props: Partial<Parameters<typeof SourcesPanel>[0]> = {}) {
  const drafts: ResearchDraft[] = [];
  const fetch = fixtureFetch();
  const metadata = createMetadataClient({ fetch, now: () => new Date('2026-11-24T12:00:00.000Z') });
  const user = userEvent.setup();
  render(
    <SourcesPanel
      sources={{}}
      metadata={metadata}
      draftContext={draftContext()}
      onDraft={(d) => drafts.push(d)}
      {...props}
    />,
  );
  return { drafts, fetch, user };
}

describe('<SourcesPanel>', () => {
  it('adds a source by DOI after a fetched preview', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const { drafts, fetch, user } = setup();
    await user.type(
      screen.getByLabelText('Add by DOI, ISBN or web address'),
      'doi:10.1038/nature14539',
    );
    await user.click(screen.getByRole('button', { name: 'Fetch details' }));
    const preview = await screen.findByRole('region', { name: 'Fetched details' });
    expect(within(preview).getByText('Deep learning')).toBeTruthy();
    expect(within(preview).getByText('10.1038/nature14539')).toBeTruthy();
    expect(drafts).toHaveLength(0);

    await user.click(within(preview).getByRole('button', { name: 'Add to library' }));
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    expect(d.type).toBe('SourceAdded');
    if (d.type !== 'SourceAdded') return;
    expect(d.payload.origin).toEqual({ kind: 'doi', value: '10.1038/nature14539' });
    expect(d.payload.csl.title).toBe('Deep learning');
    expect(d.payload.csl.id).toBe(d.payload.sourceId);
    expect(d.payload.fromSurfacedId).toBeNull();
    expect(CommitDraftSchema.safeParse(d).success).toBe(true);
    // Only the injected fetcher touched the network.
    expect(fetch.log).toHaveLength(1);
    expect(globalFetch).not.toHaveBeenCalled();
    globalFetch.mockRestore();
  });

  it('lets the writer edit fetched details before adding (ISBN)', async () => {
    const { drafts, user } = setup();
    await user.type(screen.getByLabelText('Add by DOI, ISBN or web address'), '978-0-262-03384-8');
    await user.click(screen.getByRole('button', { name: 'Fetch details' }));
    await user.click(await screen.findByRole('button', { name: 'Edit details first' }));
    const title = screen.getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Introduction to Algorithms, Third Edition');
    await user.click(screen.getByRole('button', { name: 'Add to library' }));
    const d = drafts[0]!;
    expect(d.type === 'SourceAdded' && d.payload.csl.title).toBe(
      'Introduction to Algorithms, Third Edition',
    );
    expect(d.type === 'SourceAdded' && d.payload.origin).toEqual({
      kind: 'isbn',
      value: '9780262033848',
    });
  });

  it('shows fetch errors and emits nothing', async () => {
    const { drafts, user } = setup();
    await user.type(
      screen.getByLabelText('Add by DOI, ISBN or web address'),
      'doi:10.5555/longhand-does-not-exist',
    );
    await user.click(screen.getByRole('button', { name: 'Fetch details' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Crossref has no record/);
    expect(drafts).toHaveLength(0);
  });

  it('adds a source by hand, validating the form', async () => {
    const { drafts, user } = setup();
    await user.click(screen.getByRole('button', { name: 'Enter a source by hand' }));
    await user.click(screen.getByRole('button', { name: 'Add to library' }));
    expect(screen.getByRole('alert').textContent).toBe('A title is required.');
    expect(drafts).toHaveLength(0);

    await user.type(screen.getByLabelText('Title'), 'Letters from the Field');
    await user.type(screen.getByLabelText('Authors'), 'Doe, Jane');
    await user.type(screen.getByLabelText('Date'), '1999');
    await user.click(screen.getByRole('button', { name: 'Add to library' }));
    expect(drafts).toHaveLength(1);
    const d = drafts[0]!;
    if (d.type !== 'SourceAdded') throw new Error(d.type);
    expect(d.payload.origin).toEqual({ kind: 'manual', value: null });
    expect(d.payload.csl).toEqual({
      id: d.payload.sourceId,
      type: 'book',
      title: 'Letters from the Field',
      author: [{ family: 'Doe', given: 'Jane' }],
      issued: { 'date-parts': [[1999]] },
    });
  });

  it('edits metadata and notes, and archives', async () => {
    const { drafts, user } = setup({ sources: sources(source(LECUN), source(AUSTEN)) });
    const items = screen.getAllByRole('listitem');
    expect(items.map((li) => within(li).getAllByText(/./)[0]!.textContent)).toEqual([
      'Pride and Prejudice',
      'Deep learning',
    ]);
    await user.click(within(items[1]!).getByRole('button', { name: 'Edit' }));
    const vol = screen.getByLabelText('Volume');
    await user.clear(vol);
    await user.type(vol, '522');
    await user.type(screen.getByLabelText('Your note'), 'Use for the history section');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const d = drafts[0]!;
    if (d.type !== 'SourceUpdated') throw new Error(d.type);
    expect(d.payload.sourceId).toBe('src-lecun');
    expect(d.payload.note).toBe('Use for the history section');
    expect(d.payload.csl).toEqual({ ...LECUN, volume: '522' });

    await user.click(
      within(screen.getAllByRole('listitem')[0]!).getByRole('button', { name: 'Archive' }),
    );
    expect(drafts[1]!.payload).toEqual({ sourceId: 'src-austen', archived: true });
  });

  it('labels AI-surfaced candidates as unverified until the writer verifies and adds one', async () => {
    const { drafts, user } = setup({ sources: sources(source(AUSTEN)), surfaced: [surfaced()] });
    const card = screen.getByRole('article', { name: 'AI search: transformer attention' });
    // Header badge plus one per unverified candidate.
    expect(within(card).getAllByText(AI_SURFACED_LABEL)).toHaveLength(3);
    expect(within(card).getByText('For: “attention is enough”')).toBeTruthy();
    // Candidates are not in the library.
    const library = screen.getByRole('region', { name: 'Library' });
    expect(within(library).queryByText('Attention Is All You Need')).toBeNull();

    await user.click(within(card).getAllByRole('button', { name: 'Verify and add…' })[0]!);
    const form = screen.getByRole('form', { name: 'Verify before adding' });
    expect(within(form).getByText(AI_SURFACED_LABEL)).toBeTruthy();
    expect(within(form).getByRole('link', { name: 'open it' }).getAttribute('href')).toBe(
      'https://doi.org/10.48550/arXiv.1706.03762',
    );
    expect(drafts).toHaveLength(0);
    await user.click(within(form).getByRole('button', { name: 'I checked it — add to library' }));
    const d = drafts[0]!;
    if (d.type !== 'SourceAdded') throw new Error(d.type);
    expect(d.payload).toMatchObject({
      origin: { kind: 'surfaced', value: 'https://doi.org/10.48550/arXiv.1706.03762' },
      fromSurfacedId: 'surf-1',
      candidateIndex: 0,
    });
    expect(d.payload.csl.title).toBe('Attention Is All You Need');
    expect(CommitDraftSchema.safeParse(d).success).toBe(true);
  });

  it('shows verified candidates as added, and dismisses the card', async () => {
    const added = source(
      { id: 'src-v', type: 'article', title: 'Attention Is All You Need' },
      { fromSurfacedId: 'surf-1', candidateIndex: 0, origin: { kind: 'surfaced', value: null } },
    );
    const { drafts, user } = setup({
      sources: sources(added),
      surfaced: [surfaced({ accepted: [{ candidateIndex: 0, sourceId: 'src-v' }] })],
    });
    const card = screen.getByRole('article', { name: /AI search/ });
    expect(within(card).getByText('Verified and added')).toBeTruthy();
    expect(within(card).getAllByText(AI_SURFACED_LABEL)).toHaveLength(2);
    expect(within(card).getAllByRole('button', { name: 'Verify and add…' })).toHaveLength(1);
    const library = screen.getByRole('region', { name: 'Library' });
    expect(within(library).getByText('Found by the AI, verified by you')).toBeTruthy();

    await user.click(within(card).getByRole('button', { name: 'Dismiss' }));
    expect(drafts[0]).toMatchObject({
      type: 'SuggestionDismissed',
      payload: { targetId: 'surf-1', reason: null, note: null },
    });
  });

  it('hides dismissed surfaced cards and wires Cite', async () => {
    const onCite = vi.fn();
    const { user } = setup({
      sources: sources(source(LECUN)),
      surfaced: [surfaced({ status: 'dismissed' })],
      onCite,
    });
    expect(screen.queryByText(AI_SURFACED_LABEL)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cite…' }));
    expect(onCite).toHaveBeenCalledWith('src-lecun');
  });
});
