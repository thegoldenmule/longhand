import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommitDraft } from '@longhand/schema';
import { markdownToDoc } from '../lib/importDraft';

const fake = vi.hoisted(() => ({
  me: vi.fn(async () => ({ actorId: 'writer-1' })),
  createProject: vi.fn(async (_input: { title: string }) => ({ projectId: 'p1' })),
  json: vi.fn(async (_method: string, _path: string, _body: unknown) => ({
    status: 'ack',
    seq: 2,
  })),
  listProjects: vi.fn(async () => [
    { projectId: 'a', title: 'Untitled', updatedAt: '2026-11-01T10:00:00.000Z' },
  ]),
}));
vi.mock('../lib/client', () => ({ getClient: () => fake }));

import { ProjectsHome } from './ProjectsHome';

const assign = vi.fn<(url: string) => void>();
beforeEach(() => {
  vi.stubGlobal('location', { assign, search: '', pathname: '/' });
  // jsdom has no matchMedia (the theme toggle reads it).
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const posted = () => fake.json.mock.calls.map((c) => c[2] as CommitDraft);

describe('ProjectsHome', () => {
  it('starts an Untitled project in one click, with no form', async () => {
    render(<ProjectsHome />);
    const button = screen.getByRole('button', { name: 'New project' });
    expect(button.getAttribute('aria-expanded')).toBeNull();
    await act(async () => fireEvent.click(button));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/p/p1'));
    expect(fake.createProject).toHaveBeenCalledExactlyOnceWith({ title: 'Untitled' });
    expect(fake.json).toHaveBeenCalledOnce();
    expect(fake.json.mock.calls[0]?.slice(0, 2)).toEqual(['POST', '/v1/projects/p1/commits']);
    const [draft] = posted();
    expect(draft).toMatchObject({
      projectId: 'p1',
      type: 'DocumentCreated',
      actor: { kind: 'human', id: 'writer-1' },
      payload: { kind: 'manuscript', title: 'Untitled', parentId: null, index: 0 },
    });
    expect(screen.queryByRole('form', { name: 'New project' })).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('imports a draft named by its heading, without the heading in the body', async () => {
    render(<ProjectsHome />);
    fireEvent.click(screen.getByRole('button', { name: 'Import a draft' }));
    expect(screen.queryByLabelText('Genre')).toBeNull();
    expect(screen.queryByLabelText('Audience')).toBeNull();
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    expect(title.placeholder).toBe('Untitled');
    const importButton = screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement;
    expect(importButton.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Draft'), {
      target: { value: '# The Storm\n\nIt rained.' },
    });
    expect(importButton.disabled).toBe(false);
    await act(async () => fireEvent.click(importButton));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/p/p1'));
    expect(fake.createProject).toHaveBeenCalledExactlyOnceWith({ title: 'The Storm' });
    const [draft] = posted();
    expect(draft).toMatchObject({
      type: 'DocumentImported',
      payload: { title: 'The Storm', content: markdownToDoc('It rained.') },
    });
  });
});
