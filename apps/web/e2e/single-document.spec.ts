/**
 * One document, one name (F2): a new project is Untitled in one click and lands in
 * the body; while the manuscript is one document its name is the project's, shown
 * once at the top of the page and edited there.
 */
import type { Page } from '@playwright/test';
import {
  expect,
  getCommits,
  getState,
  manuscript,
  newProject,
  projectIdOf,
  test,
  waitSaved,
} from './helpers';

const tree = (page: Page) => page.getByRole('tree', { name: 'Manuscript' });
const item = (page: Page, title: string) => page.getByRole('treeitem', { name: title }).first();

test('19 · one click starts an Untitled project with the caret in the body, and the title shows once', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New project' }).click();
  await page.waitForURL(/\/p\/[^/?]+/);
  const pid = projectIdOf(page);
  await expect(manuscript(page)).toBeFocused();
  await page.keyboard.type('The tide came in twice that day.', { delay: 4 });
  await waitSaved(page, pid, 'The tide came in twice that day.');

  const s = await getState(pid);
  expect(s.settings.title).toBe('Untitled');
  expect(Object.values(s.documents).map((d) => [d.kind, d.title])).toEqual([
    ['manuscript', 'Untitled'],
  ]);

  // Exactly one visible title: the field at the top. No binder, no project title,
  // no tree row, nothing in the status line.
  await expect(page.getByTestId('binder-pane')).toHaveCount(0);
  await expect(page.getByTestId('document-title')).toHaveValue('Untitled');
  await expect(page.getByTestId('document-title')).toHaveAttribute('aria-label', 'Title');
  await expect(page.getByTestId('project-title')).toHaveCount(0);
  await expect(page.getByRole('treeitem')).toHaveCount(0);
  await expect(page.getByRole('contentinfo', { name: 'Status' })).not.toContainText('Untitled');
  await expect(page.getByText('Untitled', { exact: true })).toHaveCount(0);
  await expect(page).toHaveTitle('Untitled · Longhand');
});

test('20 · renaming at the top renames the project and its document, and the home page lists it', async ({
  page,
}) => {
  const pid = await newProject(page);
  const before = (await getCommits(pid)).length;
  const title = page.getByTestId('document-title');
  await title.fill('Tide Tables');
  await title.press('Enter');
  await expect(manuscript(page)).toBeFocused();
  await expect
    .poll(async () => (await getCommits(pid)).slice(before).map((c) => c.type))
    .toEqual(['ProjectSettingsChanged', 'DocumentRenamed']);
  const s = await getState(pid);
  expect(s.settings.title).toBe('Tide Tables');
  expect(Object.values(s.documents).map((d) => d.title)).toEqual(['Tide Tables']);
  await expect(page).toHaveTitle('Tide Tables · Longhand');

  // A blank title is Untitled again.
  await title.fill('   ');
  await title.press('Enter');
  await expect.poll(async () => (await getState(pid)).settings.title).toBe('Untitled');

  await title.fill('Tide Tables');
  await title.press('Enter');
  await expect.poll(async () => (await getState(pid)).settings.title).toBe('Tide Tables');
  await page.goto('/');
  await expect(page.locator(`a[href="/p/${encodeURIComponent(pid)}"]`)).toContainText(
    'Tide Tables',
  );
});

test('21 · two Untitled projects coexist', async ({ page }) => {
  const a = await newProject(page);
  const b = await newProject(page);
  expect(a).not.toBe(b);
  await page.goto('/');
  for (const pid of [a, b]) {
    await expect(page.locator(`a[href="/p/${encodeURIComponent(pid)}"]`)).toContainText('Untitled');
  }
});

test('22 · a second document gives each its own name, and archiving back to one goes by the project’s', async ({
  page,
}) => {
  const pid = await newProject(page, 'Essay');
  await page.getByTestId('toggle-binder').click();
  const pane = page.getByTestId('binder-pane');
  await expect(pane.getByRole('link', { name: 'All projects' })).toBeVisible();
  await expect(page.getByTestId('project-title')).toHaveCount(0);
  await expect(page.getByTestId('corkboard-toggle')).toHaveCount(0);
  await expect(tree(page).getByRole('treeitem')).toHaveCount(0);

  // A second document: both rows show, and the project is named in the binder head.
  await page.getByRole('button', { name: 'New document' }).click();
  const rename = page.getByRole('textbox', { name: 'Rename ‘Untitled’' });
  await rename.fill('Second thoughts');
  await rename.press('Enter');
  await expect(tree(page).getByRole('treeitem')).toHaveCount(2);
  await expect(item(page, 'Essay')).toBeVisible();
  await expect(item(page, 'Second thoughts')).toBeVisible();
  await expect(page.getByTestId('project-title')).toHaveValue('Essay');
  await expect(page.getByTestId('corkboard-toggle')).toBeVisible();

  // Now the header renames only the open document.
  const title = page.getByTestId('document-title');
  await expect(title).toHaveAttribute('aria-label', 'Document title');
  await title.fill('First thoughts');
  await title.press('Enter');
  await expect
    .poll(async () => Object.values((await getState(pid)).documents).map((d) => d.title))
    .toEqual(['First thoughts', 'Second thoughts']);
  expect((await getState(pid)).settings.title).toBe('Essay');

  // Archive the second: one document left, shown by the project's name, nothing renamed.
  const before = (await getCommits(pid)).length;
  await item(page, 'Second thoughts').focus();
  await page.keyboard.press('Delete');
  await expect(
    page.getByText('One document left. It goes by the project’s name now.'),
  ).toBeVisible();
  await expect(title).toHaveValue('Essay');
  await expect(tree(page).getByRole('treeitem')).toHaveCount(0);
  await expect(page.getByTestId('project-title')).toHaveCount(0);
  await expect
    .poll(async () => (await getCommits(pid)).slice(before).map((c) => c.type))
    .toEqual(['DocumentArchived']);
});
