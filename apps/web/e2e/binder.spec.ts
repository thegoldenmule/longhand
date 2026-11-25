/** The binder (F2): nested folders, keyboard and drag moves, the corkboard and notes. */
import type { Page } from '@playwright/test';
import type { ProjectState } from '@longhand/schema';
import { expect, getState, ledgerText, manuscript, newProject, test, waitSaved } from './helpers';

const tree = (page: Page, area: 'Manuscript' | 'Notes') => page.getByRole('tree', { name: area });
const item = (page: Page, title: string) => page.getByRole('treeitem', { name: title }).first();

async function renameNew(page: Page, from: string, to: string): Promise<void> {
  const input = page.getByRole('textbox', { name: `Rename ‘${from}’` });
  await expect(input).toBeVisible();
  await input.fill(to);
  await input.press('Enter');
  await expect(item(page, to)).toBeVisible();
}

const folderNamed = (s: ProjectState, title: string) =>
  Object.values(s.folders).find((f) => f.title === title);
const docNamed = (s: ProjectState, title: string) =>
  Object.values(s.documents).find((d) => d.title === title);

test('9 · binder: nested folders, keyboard and drag moves, corkboard synopsis, notes', async ({
  page,
}) => {
  const pid = await newProject(page, 'Novel');
  await expect(tree(page, 'Manuscript').getByRole('treeitem')).toHaveCount(1);

  // Part One › Chapter 1 › Scene 1
  await page.getByRole('button', { name: 'New folder in Manuscript' }).click();
  await renameNew(page, 'New folder', 'Part One');
  await item(page, 'Part One').click();
  await page.getByRole('button', { name: 'New folder in Manuscript' }).click();
  await renameNew(page, 'New folder', 'Chapter 1');
  await item(page, 'Chapter 1').click();
  await page.getByRole('button', { name: 'New document' }).click();
  await renameNew(page, 'Untitled', 'Scene 1');
  await expect
    .poll(async () => {
      const s = await getState(pid);
      const part = folderNamed(s, 'Part One');
      const chapter = folderNamed(s, 'Chapter 1');
      const scene = docNamed(s, 'Scene 1');
      return [chapter?.parentId === part?.id, scene?.parentId === chapter?.id];
    })
    .toEqual([true, true]);
  await expect(item(page, 'Chapter 1')).toHaveAttribute('aria-level', '2');
  await expect(item(page, 'Scene 1')).toHaveAttribute('aria-level', '3');

  // Keyboard: move "Untitled" below Part One (M, Down, Enter).
  await item(page, 'Untitled').focus();
  await page.keyboard.press('m');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => {
      const s = await getState(pid);
      return s.binder.manuscript.map((r) =>
        r.kind === 'folder' ? s.folders[r.id]!.title : s.documents[r.id]!.title,
      );
    })
    .toEqual(['Part One', 'Untitled']);

  // Drag: drop "Untitled" into the middle of the Chapter 1 row (inside the folder).
  const target = item(page, 'Chapter 1').locator('.lh-binder-row').first();
  await item(page, 'Untitled').locator('.lh-binder-row').first().dragTo(target);
  await expect
    .poll(async () => {
      const s = await getState(pid);
      return docNamed(s, 'Untitled')?.parentId === folderNamed(s, 'Chapter 1')?.id;
    })
    .toBe(true);

  // Corkboard: Chapter 1's cards, with a synopsis edited in place.
  await page.getByTestId('corkboard-toggle').click();
  await item(page, 'Chapter 1').click();
  const board = page.getByRole('list', { name: 'Corkboard: Chapter 1' });
  await expect(board).toBeVisible();
  await board.getByRole('button', { name: 'Edit synopsis of ‘Scene 1’' }).click();
  await board
    .getByRole('textbox', { name: 'Synopsis of ‘Scene 1’' })
    .fill('Mara waits for the signal.');
  await board.getByRole('textbox', { name: 'Synopsis of ‘Scene 1’' }).press('ControlOrMeta+Enter');
  await expect(board).toContainText('Mara waits for the signal.');
  await expect
    .poll(async () => docNamed(await getState(pid), 'Scene 1')?.synopsis)
    .toBe('Mara waits for the signal.');

  // Notes: a character note, written like any document.
  await page.getByRole('button', { name: 'New note' }).click();
  await renameNew(page, 'Untitled note', 'Characters');
  await page
    .getByTestId('corkboard-toggle')
    .locator('..')
    .getByRole('button', { name: 'Write' })
    .click();
  await item(page, 'Characters').click();
  await expect(page.getByTestId('document-title')).toHaveText('Characters');
  await manuscript(page).click();
  await page.keyboard.type('Mara: harbour pilot, counts everything twice.', { delay: 4 });
  const note = docNamed(await getState(pid), 'Characters')!;
  expect(note.kind).toBe('note');
  await expect
    .poll(() => ledgerText(pid, note.id), { timeout: 20_000 })
    .toBe('Mara: harbour pilot, counts everything twice.');
  await waitSaved(page, pid, '');
  await expect(tree(page, 'Notes').getByRole('treeitem')).toHaveCount(1);
});
