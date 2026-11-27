/**
 * Helpers for the full-stack suite. Assertions about the record go to the ledger
 * service's API (the outside view), never to app internals.
 */
import { expect, test as base, type Locator, type Page } from '@playwright/test';
import { applyCommit, emptyState, projectState, type LedgerState } from '@longhand/ledger';
import {
  MANUSCRIPT_EVENT_TYPES,
  STARTER_EDITORS,
  docFromJSON,
  type Commit,
  type PMNodeJSON,
  type ProjectState,
} from '@longhand/schema';
import { E2E } from './ports';
import { TEST_EDITOR } from './seed';

export { TEST_EDITOR };
/** Names of the starter editors the service seeds. */
export const STARTER_NAMES = STARTER_EDITORS.map((e) => e.name);

// ------------------------------------------------------------------- the API

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${E2E.ledgerUrl}${path}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status}: ${text}`);
  return JSON.parse(text) as T;
}

export async function listProjects(): Promise<string[]> {
  const r = await api<{ projects: Array<{ projectId: string }> }>('/v1/projects');
  return r.projects.map((p) => p.projectId);
}

export async function getCommits(projectId: string): Promise<Commit[]> {
  const out: Commit[] = [];
  for (;;) {
    const r = await api<{ headSeq: number; commits: Commit[] }>(
      `/v1/projects/${encodeURIComponent(projectId)}/commits?after=${out.length}&limit=5000`,
    );
    out.push(...r.commits);
    if (r.commits.length === 0 || out.length >= r.headSeq) return out;
  }
}

export async function getState(projectId: string): Promise<ProjectState> {
  return (await api<{ state: ProjectState }>(`/v1/projects/${encodeURIComponent(projectId)}/state`))
    .state;
}

/** A document's text (blocks joined by newlines) from the ledger. */
export function textOf(content: PMNodeJSON): string {
  const doc = docFromJSON(content);
  return doc.textBetween(0, doc.content.size, '\n');
}

export async function ledgerText(projectId: string, documentId?: string): Promise<string> {
  const s = await getState(projectId);
  const doc = documentId
    ? s.documents[documentId]
    : Object.values(s.documents).find((d) => d.kind === 'manuscript');
  return doc ? textOf(doc.content) : '';
}

// -------------------------------------------------------------- the invariant

const MANUSCRIPT = new Set<string>(MANUSCRIPT_EVENT_TYPES);

/**
 * The invariant, checked from the outside: replay every project's ledger as the
 * service hands it out, and require that every commit that changed any
 * document's text has a human actor (and is one of the human manuscript event
 * types), and that every manuscript-type commit is human.
 */
export async function assertHumanManuscript(projectIds?: string[]): Promise<number> {
  let checked = 0;
  for (const pid of projectIds ?? (await listProjects())) {
    const commits = await getCommits(pid);
    let state: LedgerState = emptyState();
    let before = projectState(state);
    for (const c of commits) {
      state = applyCommit(state, c);
      const after = projectState(state);
      if (MANUSCRIPT.has(c.type)) {
        expect(c.actor.kind, `${pid} seq ${c.seq} ${c.type}`).toBe('human');
      }
      for (const [id, doc] of Object.entries(after.documents)) {
        const prev = before.documents[id];
        const changed = prev
          ? prev.content !== doc.content &&
            JSON.stringify(prev.content) !== JSON.stringify(doc.content)
          : textOf(doc.content) !== '';
        if (changed) {
          expect(c.actor.kind, `${pid} seq ${c.seq} ${c.type} changed ${id}`).toBe('human');
          expect(MANUSCRIPT.has(c.type), `${c.type} changed ${id}`).toBe(true);
        }
      }
      before = after;
      checked++;
    }
  }
  return checked;
}

/** `test` with the invariant checked over every project after each test. */
export const test = base.extend<{ invariant: void }>({
  invariant: [
    // Playwright reads fixture dependencies from the destructuring pattern.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use();
      await assertHumanManuscript();
    },
    { auto: true },
  ],
});
export { expect };

// ------------------------------------------------------------------- the UI

/**
 * Starts a project from the home page (one click: it is Untitled) and opens it;
 * returns its id. A `title` is typed into the title at the top of the page, which
 * names the project and its one document. Genre and audience go in through the
 * Settings tab.
 */
export async function newProject(
  page: Page,
  title?: string,
  opts: { genre?: string; audience?: string } = {},
): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.waitForURL(/\/p\/[^/?]+/);
  await expect(page.getByTestId('manuscript')).toBeVisible();
  const pid = projectIdOf(page);
  if (title !== undefined) {
    const field = page.getByTestId('document-title');
    await field.fill(title);
    await field.press('Enter');
    await expect.poll(async () => (await getState(pid)).settings.title).toBe(title);
  }
  if (opts.genre || opts.audience) {
    if ((await page.getByTestId('side-panel').count()) === 0) {
      await page.getByTestId('toggle-panel').click();
    }
    await page.getByTestId('tab-settings').click();
    const pane = page.getByTestId('settings-pane');
    if (opts.genre) await pane.getByLabel('Genre').fill(opts.genre);
    if (opts.audience) await pane.getByLabel('Audience').fill(opts.audience);
    await pane.getByLabel(opts.audience ? 'Audience' : 'Genre').blur();
    await expect
      .poll(async () => {
        const s = (await getState(pid)).settings;
        return [s.genre, s.audience];
      })
      .toEqual([opts.genre ?? '', opts.audience ?? '']);
    await page.getByRole('button', { name: 'Close side panel' }).click();
  }
  return pid;
}

export function projectIdOf(page: Page): string {
  return decodeURIComponent(new URL(page.url()).pathname.split('/')[2] as string);
}

export function manuscript(page: Page): Locator {
  return page.getByTestId('manuscript');
}

/** Clicks at the end of the manuscript and types paragraphs (Enter between them). */
export async function typeParagraphs(page: Page, paragraphs: readonly string[]): Promise<void> {
  await manuscript(page).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  for (const [i, p] of paragraphs.entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(p, { delay: 4 });
  }
}

/** Waits until the ledger holds `text` and the status line says Saved. */
export async function waitSaved(page: Page, projectId: string, text: string): Promise<void> {
  await expect.poll(() => ledgerText(projectId), { timeout: 20_000 }).toContain(text);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
}

export const STORY = [
  'The rain fell sideways over the harbour, and nobody came to the door.',
  'Mara counted the boats twice. She waited for the signal from the lighthouse.',
  'At dawn the bells began to ring across the water.',
] as const;

/** A project with the three-paragraph story, saved. */
export async function storyProject(page: Page, title = 'Harbour'): Promise<string> {
  const pid = await newProject(page, title, { genre: 'Literary fiction', audience: 'Adults' });
  await typeParagraphs(page, STORY);
  await waitSaved(page, pid, STORY[2]);
  return pid;
}

/** The feedback chat in the side panel. */
export function chatPanel(page: Page): Locator {
  return page.getByTestId('feedback-chat');
}

/** The chat's messages, in order (`data-role` writer or editor). */
export function chatMessages(page: Page): Locator {
  return chatPanel(page).getByTestId('chat-message');
}

/** Chooses an editor in the chat's dropdown by name. */
export async function chooseEditor(page: Page, editor: string): Promise<void> {
  const select = chatPanel(page).getByRole('combobox', { name: 'Editor' });
  const option = select.locator('option', { hasText: new RegExp(`^${editor}( ·|$)`) });
  await select.selectOption((await option.getAttribute('value'))!);
}

/**
 * Opens the chat (Ask for feedback), chooses an editor (default: the seeded test
 * editor) and sends a message. "review" in it makes the mock leave notes; a
 * `question` taps one of the editor's canned questions in an empty chat.
 */
export async function askForFeedback(
  page: Page,
  editor: string = TEST_EDITOR.name,
  opts: { message?: string; question?: string } = {},
): Promise<void> {
  await page.getByTestId('ask-feedback').click();
  await expect(chatPanel(page)).toBeVisible();
  await chooseEditor(page, editor);
  const box = chatPanel(page).getByRole('textbox', { name: `Message ${editor}` });
  if (opts.question)
    await chatPanel(page)
      .getByTestId('chat-starters')
      .getByRole('button', { name: opts.question })
      .click();
  else await box.fill(opts.message ?? 'Please review this.');
  await box.press('Enter');
}

/** Waits until the newest message is an editor's reply. */
export async function waitForReply(page: Page): Promise<void> {
  await expect(chatMessages(page).last()).toHaveAttribute('data-role', 'editor', {
    timeout: 30_000,
  });
}

export function marginCards(page: Page): Locator {
  return page.getByTestId('annotation-margin').locator('[data-card-id]');
}

export function marginCard(page: Page, kind: string, nth = 0): Locator {
  return page.getByTestId('annotation-margin').locator(`[data-kind="${kind}"]`).nth(nth);
}

/** Provenance classes of the tint spans covering `text` in the editor. */
export async function tintClassesOf(page: Page, text: string): Promise<string[]> {
  return page.evaluate((t) => {
    const root = document.querySelector('[data-testid="manuscript"]') as HTMLElement;
    const out = new Set<string>();
    for (const span of root.querySelectorAll<HTMLElement>('[data-prov]')) {
      if (t.includes(span.textContent ?? '\u0000') || (span.textContent ?? '').includes(t))
        out.add(span.dataset.prov as string);
    }
    return [...out];
  }, text);
}

/** Saves a download and returns its bytes. */
export async function downloadBytes(page: Page, trigger: () => Promise<void>) {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const path = await download.path();
  const { readFileSync } = await import('node:fs');
  return { name: download.suggestedFilename(), bytes: new Uint8Array(readFileSync(path)), path };
}

/** Opens the side panel on its Provenance tab (tint, replay, report, export). */
export async function openProvenance(page: Page): Promise<void> {
  if ((await page.getByTestId('side-panel').count()) === 0) {
    await page.getByTestId('toggle-panel').click();
  }
  await page.getByTestId('tab-provenance').click();
}

/** The tint switch on the Provenance tab's legend (open the tab first). */
export function tintSwitch(page: Page): Locator {
  return page.getByTestId('provenance-pane').getByRole('switch', { name: 'Tint' });
}
