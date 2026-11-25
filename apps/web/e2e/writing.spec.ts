/**
 * Writing: saving and reloading, paste classification, offline queueing and
 * imported drafts, through the real ledger service.
 */
import {
  expect,
  getCommits,
  getState,
  ledgerText,
  manuscript,
  newProject,
  test,
  tintClassesOf,
  typeParagraphs,
  waitSaved,
} from './helpers';

test('1 · a typed paragraph is saved and survives a reload', async ({ page }) => {
  const pid = await newProject(page, 'Persistence');
  const text = 'The tide came in quietly while the town slept.';
  await typeParagraphs(page, [text]);
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', /queued|saved/);
  await waitSaved(page, pid, text);
  await expect(page.getByTestId('save-state')).toHaveText(/Saved/);
  await expect(page.getByTestId('count-document')).toHaveText('9 words');

  await page.reload();
  await expect(manuscript(page)).toContainText(text);
  const commits = await getCommits(pid);
  const edits = commits.filter((c) => c.type === 'TextEdited');
  expect(edits.length).toBeGreaterThan(0);
  expect(edits.every((c) => c.actor.kind === 'human')).toBe(true);
});

test('2 · external paste is flagged in the tint and the legend', async ({ page }) => {
  const pid = await newProject(page, 'Paste');
  const typed = 'I wrote this sentence myself.';
  await typeParagraphs(page, [typed]);
  await waitSaved(page, pid, typed);
  const outside = ' These words came from somewhere else entirely.';
  await page.evaluate((t) => navigator.clipboard.writeText(t), outside);
  await page.keyboard.press('ControlOrMeta+V');
  await waitSaved(page, pid, outside.trim());

  const s = await getState(pid);
  const doc = Object.values(s.documents)[0]!;
  expect(doc.provenance.some((r) => r.class === 'pasted-external')).toBe(true);
  const pastes = Object.values(s.pastes);
  expect(pastes).toHaveLength(1);
  expect(pastes[0]!.origin).toBe('external');

  await page.getByTestId('toggle-tint').click();
  await expect
    .poll(() => tintClassesOf(page, 'came from somewhere else'))
    .toEqual(['pasted-external']);
  await expect.poll(() => tintClassesOf(page, 'wrote this sentence')).toEqual(['typed']);
  await page.getByTestId('toggle-panel').click();
  await page.getByTestId('tab-provenance').click();
  await expect(page.getByTestId('legend-count-pasted-external')).toHaveText('7');
  await expect(page.getByTestId('legend-count-typed')).toHaveText('5');
});

test('3 · an internal copy and paste inherits the copied text’s class', async ({ page }) => {
  const pid = await newProject(page, 'Internal paste');
  const typed = 'Salt crusted every rope on the quay.';
  await typeParagraphs(page, [typed]);
  await waitSaved(page, pid, typed);
  // Select the line, copy, and paste it as a second paragraph.
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('ControlOrMeta+C');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+V');
  await expect
    .poll(async () => (await ledgerText(pid)).split('\n'), { timeout: 20_000 })
    .toEqual([typed, typed]);

  const commits = await getCommits(pid);
  const types = commits.map((c) => c.type);
  expect(types).toContain('SliceCopied');
  const paste = commits.find((c) => c.type === 'PasteOccurred')!;
  expect((paste.payload as { origin: string }).origin).toBe('internal');
  const runs = commits
    .filter((c) => c.type === 'TextEdited')
    .flatMap((c) => (c.payload as { runs: Array<{ method: string }> }).runs.map((r) => r.method));
  expect(runs).toContain('pasted-internal');
  const doc = Object.values((await getState(pid)).documents)[0]!;
  expect(new Set(doc.provenance.map((r) => r.class))).toEqual(new Set(['typed']));

  await page.getByTestId('toggle-tint').click();
  await expect.poll(() => tintClassesOf(page, 'Salt crusted')).toEqual(['typed']);
});

test('15 · offline writing queues, flushes on reconnect, and the report shows the gap', async ({
  page,
  context,
}) => {
  const pid = await newProject(page, 'Offline');
  const first = 'The lights went out across the island.';
  await typeParagraphs(page, [first]);
  await waitSaved(page, pid, first);

  await context.setOffline(true);
  // The report counts a commit as queued offline when it reaches the server more
  // than 60 s after it was written (UNWITNESSED_LAG_MS). Rather than wait a
  // minute, the page's clock reads three minutes earlier while offline.
  await page.clock.setFixedTime(new Date(Date.now() - 3 * 60_000));
  const offline = ' We kept writing by candlelight.';
  await page.keyboard.type(offline, { delay: 4 });
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'offline', {
    timeout: 10_000,
  });
  await expect(page.getByTestId('save-state')).toContainText('Offline');
  // The batch closes after 2 s idle and waits in the queue.
  await page.waitForTimeout(2600);
  expect(await ledgerText(pid)).not.toContain('candlelight');

  await page.clock.setFixedTime(new Date());
  await context.setOffline(false);
  await waitSaved(page, pid, 'candlelight');

  await page.getByTestId('open-report').click();
  const report = page.getByTestId('report-view');
  await expect(report.locator('.lh-report-unwitnessed')).toBeVisible({ timeout: 20_000 });
  await expect(report).toContainText('reached the server late after being queued offline');
  const late = (await (await fetch(`http://127.0.0.1:3250/v1/projects/${pid}/bundle`)).json()) as {
    lateArrivals: Array<{ lagMs: number }>;
  };
  expect(late.lateArrivals.some((l) => l.lagMs > 120_000)).toBe(true);
});

test('16 · an imported draft is labeled imported (unverified) in the tint and the report', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import a draft' }).click();
  const form = page.getByRole('form', { name: 'Import a draft' });
  await form.getByLabel('Project title').fill('Imported essay');
  await form
    .getByLabel('Draft')
    .fill('# On Harbours\n\nHarbours are where *cities* begin.\n\nThey are also where they end.');
  await form.getByRole('button', { name: 'Import' }).click();
  await page.waitForURL(/\/p\//);
  await expect(page.getByTestId('document-title')).toContainText('imported (unverified)');
  await expect(page.getByTestId('manuscript')).toContainText('Harbours are where cities begin.');
  const pid = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]!);
  const commits = await getCommits(pid);
  const imported = commits.find((c) => c.type === 'DocumentImported')!;
  expect(imported.actor.kind).toBe('human');
  expect((imported.payload as { sourceFormat: string }).sourceFormat).toBe('markdown');

  await page.getByTestId('toggle-tint').click();
  await expect.poll(() => tintClassesOf(page, 'where they end')).toEqual(['imported']);

  await page.getByTestId('open-report').click();
  const report = page.getByTestId('report-view');
  await expect(report).toContainText('imported (unverified)', { timeout: 20_000 });
  await expect(report).toContainText('1 document was imported from an existing draft');
});
