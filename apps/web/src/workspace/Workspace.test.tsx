/**
 * The workspace's titles, rendered in jsdom with the network, the store and the
 * editor stubbed: in a one-document project the title appears exactly once.
 */
import { LedgerBuilder, Replay } from '@longhand/ledger';
import type { CommitDraft } from '@longhand/schema';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  builder: null as unknown as LedgerBuilder,
  posted: [] as CommitDraft[],
}));

vi.mock('../lib/client', () => {
  const client = {
    me: async () => ({ actorId: 'writer-1', accountId: 'acct-1' }),
    raw: async (_method: string, _path: string, draft: CommitDraft) => {
      h.posted.push(draft);
      return new Response(JSON.stringify({ status: 'ack', seq: 100 + h.posted.length }), {
        status: 200,
      });
    },
    cancelSession: async () => undefined,
  };
  return { getClient: () => client };
});

vi.mock('../store/projectStore', () => {
  class ProjectStore {
    private readonly snap;
    constructor() {
      const b = h.builder;
      this.snap = {
        status: 'ready' as const,
        error: null,
        headSeq: b.commits.length,
        commits: b.commits.slice(),
        replay: new Replay(b.commits),
        ledger: b.state,
        state: b.project,
        live: true,
      };
    }
    start = async () => undefined;
    dispose = () => undefined;
    getSnapshot = () => this.snap;
    subscribe = () => () => undefined;
    onProgress = () => () => undefined;
    has = () => false;
  }
  return { ProjectStore };
});

vi.mock('../lib/editors', () => ({
  editorsHref: () => '/editors',
  useEditors: () => ({ editors: [], error: null, reload: () => undefined }),
}));

vi.mock('./EditorSurface', () => ({
  EditorSurface: () => <div data-testid="editor-stub" />,
}));

import { Workspace } from './Workspace';

beforeEach(() => {
  h.posted = [];
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function open(builder: LedgerBuilder) {
  h.builder = builder;
  render(<Workspace projectId={builder.projectId} />);
  await screen.findByTestId('editor-stub');
}

/** Every visible place a title can show: text nodes and input values. */
function occurrences(title: string): number {
  const inputs = Array.from(document.querySelectorAll('input')).filter((i) => i.value === title);
  return inputs.length + screen.queryAllByText(title).length;
}

const single = (docTitle = 'Essay') =>
  new LedgerBuilder({ title: 'Essay' }).createDocument('d', docTitle);

describe('Workspace titles', () => {
  it('single: the title shows once, in the header, with the binder closed', async () => {
    await open(single());
    expect(screen.queryByTestId('binder-pane')).toBeNull();
    const title = screen.getByTestId('document-title') as HTMLInputElement;
    expect(title.value).toBe('Essay');
    expect(title.getAttribute('aria-label')).toBe('Title');
    expect(screen.queryByTestId('project-title')).toBeNull();
    expect(occurrences('Essay')).toBe(1);
    expect(screen.getByRole('link', { name: 'All projects' })).toBeTruthy();
    expect(document.title).toBe('Essay · Longhand');
  });

  it('single: an old project whose document title differs shows the project name once', async () => {
    await open(single('Untitled'));
    expect((screen.getByTestId('document-title') as HTMLInputElement).value).toBe('Essay');
    expect(occurrences('Essay')).toBe(1);
    expect(occurrences('Untitled')).toBe(0);
  });

  it('single: opening the binder adds no title, no row and no corkboard switch', async () => {
    await open(single());
    fireEvent.click(screen.getByTestId('toggle-binder'));
    const pane = screen.getByTestId('binder-pane');
    expect(within(pane).getByRole('link', { name: 'All projects' })).toBeTruthy();
    expect(screen.queryByTestId('corkboard-toggle')).toBeNull();
    const manuscript = within(pane).getByRole('tree', { name: 'Manuscript' });
    expect(within(manuscript).queryAllByRole('treeitem')).toHaveLength(0);
    expect(occurrences('Essay')).toBe(1);
    // The header's back link is the binder's now.
    expect(screen.getAllByRole('link', { name: 'All projects' })).toHaveLength(1);
  });

  it('single: renaming at the top renames the project, then the document', async () => {
    await open(single());
    const title = screen.getByTestId('document-title') as HTMLInputElement;
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'The Storm' } });
    await act(async () => fireEvent.keyDown(title, { key: 'Enter' }));
    await waitFor(() => expect(h.posted).toHaveLength(2));
    expect(h.posted.map((d) => [d.type, d.payload])).toEqual([
      ['ProjectSettingsChanged', { patch: { title: 'The Storm' } }],
      ['DocumentRenamed', { documentId: 'd', title: 'The Storm' }],
    ]);
    expect(title.value).toBe('The Storm');
    expect(occurrences('The Storm')).toBe(1);
    expect(document.title).toBe('The Storm · Longhand');
  });

  it('single to multi: the sole document takes the project name first', async () => {
    await open(single('Untitled'));
    fireEvent.click(screen.getByTestId('toggle-binder'));
    const manuscript = screen.getByRole('region', { name: 'Manuscript' });
    await act(async () =>
      fireEvent.click(within(manuscript).getByRole('button', { name: 'New document' })),
    );
    await waitFor(() => expect(h.posted).toHaveLength(2));
    expect(h.posted.map((d) => d.type)).toEqual(['DocumentRenamed', 'DocumentCreated']);
    expect(h.posted[0]?.payload).toEqual({ documentId: 'd', title: 'Essay' });
    // Multi now: the project is named in the binder head, the binder stays open.
    expect((screen.getByTestId('project-title') as HTMLInputElement).value).toBe('Essay');
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
  });

  it('multi: the project in the binder head, the open document in the header', async () => {
    await open(
      new LedgerBuilder({ title: 'Novel' }).createDocument('a', 'One').createDocument('b', 'Two'),
    );
    const pane = screen.getByTestId('binder-pane');
    expect((within(pane).getByTestId('project-title') as HTMLInputElement).value).toBe('Novel');
    expect(screen.getByTestId('corkboard-toggle')).toBeTruthy();
    const header = screen.getByRole('banner', { name: 'Workspace' });
    expect((within(header).getByTestId('document-title') as HTMLInputElement).value).toBe('One');
    expect(within(header).queryByText('Novel')).toBeNull();
    expect(occurrences('Novel')).toBe(1);
    // The open document: the header and its highlighted row.
    expect(occurrences('One')).toBe(2);
    // Binder closed: the project becomes a muted crumb in the header.
    fireEvent.click(screen.getByTestId('toggle-binder'));
    expect(within(header).getByText('Novel').tagName).toBe('SPAN');
    expect(occurrences('Novel')).toBe(1);
    expect(occurrences('One')).toBe(1);
  });

  it('multi: renaming in the header renames only the document', async () => {
    await open(
      new LedgerBuilder({ title: 'Novel' }).createDocument('a', 'One').createDocument('b', 'Two'),
    );
    const title = screen.getByTestId('document-title') as HTMLInputElement;
    expect(title.getAttribute('aria-label')).toBe('Document title');
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: 'Chapter One' } });
    await act(async () => fireEvent.blur(title));
    await waitFor(() => expect(h.posted).toHaveLength(1));
    expect(h.posted[0]).toMatchObject({
      type: 'DocumentRenamed',
      payload: { documentId: 'a', title: 'Chapter One' },
    });
  });

  it('multi to single: the last document goes by the project name, with a note saying so', async () => {
    await open(
      new LedgerBuilder({ title: 'Novel' }).createDocument('a', 'One').createDocument('b', 'Two'),
    );
    fireEvent.focus(screen.getByRole('treeitem', { name: 'Two' }));
    const manuscript = screen.getByRole('region', { name: 'Manuscript' });
    await act(async () =>
      fireEvent.click(within(manuscript).getByRole('button', { name: 'Archive ‘Two’' })),
    );
    await waitFor(() => expect(h.posted).toHaveLength(1));
    expect(h.posted[0]?.type).toBe('DocumentArchived');
    expect((screen.getByTestId('document-title') as HTMLInputElement).value).toBe('Novel');
    expect(
      screen.getByText('One document left. It goes by the project’s name now.').className,
    ).toBe('ws-toast');
    expect(screen.queryByTestId('project-title')).toBeNull();
    expect(screen.queryByTestId('corkboard-toggle')).toBeNull();
  });
});
