/**
 * The verifier web page in Chrome: drop a good bundle and a tampered one, check
 * what the page says, and that nothing leaves the browser. Screenshots go to
 * test-results/screenshots for a human look.
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const examples = fileURLToPath(new URL('../examples/', import.meta.url));
const shots = fileURLToPath(new URL('../test-results/screenshots/', import.meta.url));
const read = (name: string) => readFileSync(`${examples}${name}`, 'utf8');

/** Drops a file on the drop zone the way a browser does (a DataTransfer with a File). */
async function drop(page: Page, name: string, text: string) {
  const transfer = await page.evaluateHandle(
    ([n, t]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([t], n, { type: 'application/json' }));
      return dt;
    },
    [name, text] as const,
  );
  const zone = page.getByTestId('dropzone');
  await zone.dispatchEvent('dragover', { dataTransfer: transfer });
  await zone.dispatchEvent('drop', { dataTransfer: transfer });
}

/** Requests the page makes after it has loaded (there should be none). */
function watchRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (r) => urls.push(`${r.method()} ${r.url()}`));
  return urls;
}

test('a good bundle verifies and shows the recomputed report', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Verify an authorship record' })).toBeVisible();
  const requests = watchRequests(page);
  await drop(page, 'novel.bundle.json', read('novel.bundle.json'));

  await expect(page.locator('.v-verdict-title')).toHaveText('Verified');
  for (const id of ['schema', 'key', 'chain', 'witnesses', 'fold', 'report'])
    await expect(page.locator(`[data-check="${id}"]`)).toHaveAttribute('data-status', 'pass');

  const report = page.locator('.lh-report');
  await expect(report.locator('.lh-report-disclosure-text')).toHaveText(
    /^Written in 3 sessions over 2 days\. 54 words: 100% typed directly\./,
  );
  await expect(report.getByRole('table').last()).toContainText(
    'That the account holder was the one typing',
  );
  await page.screenshot({ path: `${shots}good-top.png` });
  await page.screenshot({ path: `${shots}good-full.png`, fullPage: true });
  // Verification is local: dropping a file makes no network request.
  expect(requests).toEqual([]);
});

test('a report with several origins shows each in the chart and its table', async ({ page }) => {
  await page.goto('/');
  await drop(page, 'research.bundle.json', read('research.bundle.json'));
  await expect(page.locator('.v-verdict-title')).toHaveText('Verified');
  const bar = page.getByRole('img', { name: /Words by origin/ });
  await expect(bar).toHaveAttribute(
    'aria-label',
    'Words by origin: Typed 35.5%, Quoted from a source 51.1%, Pasted (external) 13.4%',
  );
  await expect(page.locator('.lh-report-legend tbody tr')).toHaveCount(3);
  await page.locator('#lh-report-words').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}research-words.png` });
});

test('a tampered bundle fails at the hash chain', async ({ page }) => {
  await page.goto('/');
  const requests = watchRequests(page);
  await drop(page, 'tampered-edited.bundle.json', read('tampered-edited.bundle.json'));

  await expect(page.locator('.v-verdict-title')).toHaveText('Not verified');
  await expect(page.locator('.v-verdict-text')).toContainText('Failed: Hash chain.');
  await expect(page.locator('[data-check="chain"]')).toHaveAttribute('data-status', 'fail');
  await expect(page.locator('[data-check="chain"]')).toContainText('hash-mismatch');
  await expect(page.locator('[data-check="fold"]')).toHaveAttribute('data-status', 'skip');
  // No report is shown for a ledger that was not re-folded.
  await expect(page.locator('.lh-report')).toHaveCount(0);
  await page.screenshot({ path: `${shots}tampered.png`, fullPage: true });
  expect(requests).toEqual([]);
});

test('a doctored report fails with the difference, and shows the true report', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Bundle file').setInputFiles({
    name: 'novel-doctored-report.bundle.json',
    mimeType: 'application/json',
    buffer: Buffer.from(read('novel-doctored-report.bundle.json')),
  });
  await expect(page.locator('.v-verdict-title')).toHaveText('Not verified');
  await expect(page.locator('[data-check="report"]')).toContainText(
    'words.byClass.typed: bundled 57, recomputed 54',
  );
  await expect(page.locator('.v-report-label')).toContainText('not the one in the bundle');
  await page.screenshot({ path: `${shots}doctored.png` });
});

test('a file that is not JSON is reported plainly', async ({ page }) => {
  await page.goto('/');
  await drop(page, 'notes.json', '{ this is not json');
  await expect(page.locator('.v-verdict-title')).toHaveText('Not a bundle');
});

test('the report prints calmly', async ({ page }) => {
  await page.goto('/');
  await drop(page, 'novel.bundle.json', read('novel.bundle.json'));
  await expect(page.locator('.v-verdict-title')).toHaveText('Verified');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.lh-report-copy')).toBeHidden();
  await expect(page.locator('.v-drop')).toBeHidden();
  await page.screenshot({ path: `${shots}print.png`, fullPage: true });
});

test('dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await drop(page, 'novel.bundle.json', read('novel.bundle.json'));
  await expect(page.locator('.v-verdict-title')).toHaveText('Verified');
  await page.screenshot({ path: `${shots}dark.png` });
});
