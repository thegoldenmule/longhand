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

/** Creates a project from the home page and opens it; returns its id. */
export async function newProject(
  page: Page,
  title = 'Harbour',
  opts: { genre?: string; audience?: string } = {},
): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.getByLabel('Title').fill(title);
  if (opts.genre) await page.getByLabel('Genre').fill(opts.genre);
  if (opts.audience) await page.getByLabel('Audience').fill(opts.audience);
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.waitForURL(/\/p\/[^/?]+/);
  await expect(page.getByTestId('manuscript')).toBeVisible();
  return projectIdOf(page);
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

/**
 * Opens the feedback form, chooses an editor (default: the seeded test editor),
 * optionally taps one of its questions and types one, and asks.
 */
export async function askForFeedback(
  page: Page,
  editor: string = TEST_EDITOR.name,
  opts: { question?: string; ask?: string } = {},
): Promise<void> {
  await page.getByTestId('ask-feedback').click();
  const form = page.getByRole('form', { name: 'Ask for feedback' });
  await expect(form).toBeVisible();
  await form
    .locator('.lh-editor-option', {
      has: page.locator('.lh-editor-name', { hasText: new RegExp(`^${editor}$`) }),
    })
    .click();
  if (opts.question) await form.getByRole('button', { name: opts.question }).click();
  if (opts.ask) await form.getByRole('textbox').fill(opts.ask);
  await form.getByRole('button', { name: `Ask ${editor}` }).click();
}

export async function waitForReview(page: Page): Promise<void> {
  await expect(page.getByTestId('review-summary').first()).toBeVisible({ timeout: 30_000 });
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
