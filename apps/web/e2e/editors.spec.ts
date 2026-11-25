/**
 * Named editors: the account-wide Editors page (reached from the projects home
 * and from the request form), adding, editing and deleting an editor, and asking
 * it for feedback from a project. Tests run in parallel on one account, so this
 * one works on its own editor and never resets the roster (the service and client
 * tests cover reset).
 */
import type { EditorProfile } from '@longhand/schema';
import {
  STARTER_NAMES,
  TEST_EDITOR,
  api,
  askForFeedback,
  expect,
  getCommits,
  getState,
  newProject,
  test,
  typeParagraphs,
  waitForReview,
  waitSaved,
} from './helpers';

async function editorsFromApi(): Promise<EditorProfile[]> {
  return (await api<{ editors: EditorProfile[] }>('/v1/editors')).editors;
}

test('17 · editors: add, edit, ask from a project, delete; the record keeps the editor', async ({
  page,
}) => {
  // The projects home links to the Editors page.
  await page.goto('/');
  await page.getByRole('link', { name: 'Editors', exact: true }).click();
  await page.waitForURL(/\/editors$/);
  await expect(page.getByRole('heading', { name: 'Your editors' })).toBeVisible();
  const rows = page.getByTestId('editor-row');
  for (const name of [...STARTER_NAMES, TEST_EDITOR.name])
    await expect(rows.filter({ hasText: name }).first()).toBeVisible();
  await expect(rows.filter({ hasText: 'Theo' })).toContainText('Word choice');
  await expect(rows.filter({ hasText: 'Theo' })).toContainText('Standard');

  // Add an editor.
  await page.getByRole('button', { name: 'New editor' }).click();
  const form = page.getByRole('form', { name: 'New editor' });
  await form.getByLabel('Name').fill('Quinn');
  await form.getByLabel(/^Brief/).fill('A patient structural editor. Asks before it tells.');
  await form.locator('label', { hasText: 'Pacing' }).click();
  await form.getByLabel('Thorough').check();
  await form.getByRole('button', { name: '+ Add a question' }).click();
  await form.getByRole('textbox', { name: 'Question 1' }).fill('Is the ending earned?');
  await form.getByRole('button', { name: '+ Add a question' }).click();
  await form.getByRole('textbox', { name: 'Question 2' }).fill('Where would you cut?');
  await form.getByRole('button', { name: 'Add editor' }).click();
  await expect(rows.filter({ hasText: 'Quinn' })).toBeVisible();
  let quinn = (await editorsFromApi()).find((e) => e.name === 'Quinn')!;
  expect(quinn).toMatchObject({
    brief: 'A patient structural editor. Asks before it tells.',
    lenses: ['clarity', 'pacing'],
    intensity: 'thorough',
    questions: ['Is the ending earned?', 'Where would you cut?'],
  });

  // Edit it: rename, drop a question.
  await rows.filter({ hasText: 'Quinn' }).getByRole('button', { name: 'Edit Quinn' }).click();
  const edit = page.getByRole('form', { name: 'Edit Quinn' });
  await edit.getByLabel('Name').fill('Quincy');
  await edit.getByRole('button', { name: 'Remove question 2' }).click();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(rows.filter({ hasText: 'Quincy' })).toBeVisible();
  quinn = (await editorsFromApi()).find((e) => e.id === quinn.id)!;
  expect(quinn).toMatchObject({ name: 'Quincy', questions: ['Is the ending earned?'] });

  // Reset asks first; keeping your editors changes nothing.
  await page.getByRole('button', { name: 'Reset to starters' }).click();
  await page.getByRole('button', { name: 'Keep mine' }).click();
  expect((await editorsFromApi()).some((e) => e.id === quinn.id)).toBe(true);

  // Ask Quincy from a project.
  const pid = await newProject(page, 'Editors');
  await typeParagraphs(page, ['The tide came in slowly. Nobody noticed the boat.']);
  await waitSaved(page, pid, 'Nobody noticed the boat.');
  await askForFeedback(page, 'Quincy', { question: 'Is the ending earned?', ask: 'Be gentle.' });
  await waitForReview(page);
  await expect(page.getByTestId('review-editor')).toHaveText('Quincy');
  const request = (await getCommits(pid)).find((c) => c.type === 'FeedbackRequested')!;
  expect(request.payload).toMatchObject({
    lenses: ['clarity', 'pacing'],
    intensity: 'thorough',
    ask: 'Is the ending earned?\nBe gentle.',
    editor: { id: quinn.id, name: 'Quincy', brief: quinn.brief },
  });

  // The request form links to the Editors page, with a way back.
  await page.getByTestId('ask-feedback').click();
  const ask = page.getByRole('form', { name: 'Ask for feedback' });
  await ask.getByRole('link', { name: 'Manage editors' }).click();
  await page.waitForURL(/\/editors\?back=/);

  // Delete it.
  await rows.filter({ hasText: 'Quincy' }).getByRole('button', { name: 'Edit Quincy' }).click();
  await page.getByRole('button', { name: 'Delete…' }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(rows.filter({ hasText: 'Quincy' })).toHaveCount(0);
  expect((await editorsFromApi()).some((e) => e.id === quinn.id)).toBe(false);

  // Back in the project, the past review still names the editor it asked.
  await page.getByRole('link', { name: '← Back to your project' }).click();
  await page.waitForURL(new RegExp(`/p/${pid}`));
  const req = Object.values((await getState(pid)).annotations.feedbackRequests)[0]!;
  expect(req.editor).toMatchObject({ name: 'Quincy' });
  await page.getByTestId('ask-feedback').click();
  await expect(page.getByTestId('review-editor')).toHaveText('Quincy');
  const options = page.getByRole('form', { name: 'Ask for feedback' }).locator('.lh-editor-option');
  await expect(options.filter({ hasText: TEST_EDITOR.name })).toHaveCount(1);
  await expect(options.filter({ hasText: 'Quincy' })).toHaveCount(0);
});
