// Dev smoke walkthrough: opens the app in Chrome, writes, asks for a review,
// toggles provenance, opens replay and the report, and screenshots each step in
// both themes. node scripts/smoke.mjs <outDir> [baseUrl]
import { chromium } from '@playwright/test';
const out = process.argv[2] ?? '.';
const base = process.argv[3] ?? 'http://localhost:3100';
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const logs = [];
page.on(
  'console',
  (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`[${m.type()}] ${m.text()}`),
);
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
const shot = async (name) => page.screenshot({ path: `${out}/${name}.png` });

await page.goto(base);
await page.getByRole('button', { name: 'New project' }).click();
await page.getByLabel('Title').fill('Salt and Iron');
await page.getByLabel('Genre').fill('Literary fiction');
await page.getByRole('button', { name: 'Create project' }).click();
await page.waitForURL(/\/p\//, { timeout: 15000 });
const ed = page.getByTestId('manuscript');
await ed.waitFor();
await ed.click();
await page.keyboard.type('The rain fell sideways over the harbour, and nobody came to the door.', {
  delay: 2,
});
await page.keyboard.press('Enter');
await page.keyboard.type(
  'Mara counted the boats twice. She waited for the signal from the lighthouse.',
  { delay: 2 },
);
await page.keyboard.press('Enter');
await page.keyboard.type('At dawn the bells began to ring across the water.', { delay: 2 });
await page.getByTestId('save-state').filter({ hasText: 'Saved' }).waitFor({ timeout: 15000 });
await shot('01-writing');

await page.getByTestId('ask-feedback').click();
await shot('02-feedback-form');
await page.locator('label.lh-chip', { hasText: 'Structure' }).click();
await page.locator('label.lh-chip', { hasText: 'Word choice' }).click();
await page.getByRole('button', { name: 'Ask the editor' }).click();
await page.waitForTimeout(900);
await shot('03-review-streaming');
await page.getByText('A clear start').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(600);
await shot('04-review-finished');

await page.getByTestId('toggle-tint').click();
await page.getByTestId('tab-provenance').click();
await page.waitForTimeout(400);
await shot('05-tint');

await page.getByTestId('open-replay').click();
await page.waitForTimeout(800);
await shot('06-replay');
await page.getByTestId('open-report').click();
await page.waitForTimeout(1500);
await shot('07-report');

await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
await page.waitForTimeout(300);
await shot('08-report-dark');
await page.getByTestId('open-report').click();
await page.waitForTimeout(500);
await shot('09-writing-dark');

console.log(logs.slice(0, 40).join('\n'));
await browser.close();
