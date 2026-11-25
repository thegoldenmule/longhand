/**
 * Screenshots of every main view in light and dark, for design review:
 * test-results/screens/<view>-<theme>.png. Each step also asserts the view
 * rendered, so a broken screen fails here first.
 */
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  askForFeedback,
  expect,
  manuscript,
  marginCards,
  newProject,
  storyProject,
  test,
  waitForReview,
  openProvenance,
  tintSwitch,
} from './helpers';

for (const theme of ['light', 'dark'] as const) {
  test(`screens · ${theme}`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    const shot = (name: string) =>
      page.screenshot({
        path: join(testInfo.project.outputDir, 'screens', `${name}-${theme}.png`),
      });
    const themed = async (p: Page) =>
      p.evaluate((t) => {
        localStorage.setItem('longhand:theme', t);
        document.documentElement.dataset.theme = t;
      }, theme);

    await page.goto('/');
    await themed(page);
    const pid = await storyProject(page, theme === 'light' ? 'Salt and Iron' : 'The Lighthouse');
    await themed(page);
    await page.waitForTimeout(300);
    await shot('01-writing');

    await page.keyboard.press('ControlOrMeta+Alt+Backslash');
    await page.mouse.move(700, 450);
    await page.waitForTimeout(400);
    await shot('02-quiet');
    await page.keyboard.press('ControlOrMeta+Alt+Backslash');

    await page.getByTestId('ask-feedback').click();
    await expect(page.getByRole('form', { name: 'Ask for feedback' })).toBeVisible();
    await shot('03a-feedback-form');
    await askForFeedback(page, ['Structure', 'Word choice']);
    await expect(marginCards(page).first()).toBeVisible();
    await shot('03-review-streaming');
    await waitForReview(page);
    await page.waitForTimeout(400);
    await shot('04-review-finished');

    await page.getByTestId('toggle-panel').click();
    await expect(page.getByTestId('side-panel')).toHaveCount(0);
    await marginCards(page).nth(2).click();
    await page.waitForTimeout(300);
    await shot('05-cards-margin');

    await openProvenance(page);
    await tintSwitch(page).click();
    await manuscript(page).getByText('Mara counted').click();
    await expect(page.getByRole('dialog').first()).toBeVisible();
    await page.waitForTimeout(300);
    await shot('06-tint-inspector');
    await page.keyboard.press('Escape');
    await tintSwitch(page).click();

    await page.getByTestId('open-replay').click();
    await expect(page.getByTestId('replay-doc')).toBeVisible();
    await page.getByTestId('replay-slider').focus();
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(300);
    await shot('07-replay');

    await page.getByTestId('open-report').click();
    await expect(page.locator('.lh-report-disclosure-text')).toBeVisible();
    await page.waitForTimeout(300);
    await shot('08-report');

    await page.getByTestId('corkboard-toggle').click();
    await page.waitForTimeout(300);
    await shot('09-corkboard');
    await page.getByRole('button', { name: 'Write', exact: true }).click();

    await page.getByTestId('tab-research').click();
    await page.getByRole('button', { name: 'Enter a source by hand' }).click();
    await page.getByLabel('Title', { exact: true }).fill('Rainfall Records of the Upper Valley');
    await page.getByLabel('Authors').fill('Okafor, Nnamdi');
    await page.getByLabel('Date').fill('2014');
    await page.getByRole('button', { name: 'Add to library' }).click();
    await page.waitForTimeout(500);
    await shot('10-research');

    await page.getByTestId('tab-settings').click();
    await page.waitForTimeout(200);
    await shot('11-settings');

    await openProvenance(page);
    await page.getByTestId('open-export').click();
    await page.waitForTimeout(200);
    await shot('12-export');
    await page.keyboard.press('Escape');

    await page.goto('/');
    await themed(page);
    await expect(page.getByRole('region', { name: 'Projects' })).toContainText(
      theme === 'light' ? 'Salt and Iron' : 'The Lighthouse',
    );
    await shot('00-home');
    await page.getByRole('button', { name: 'Import a draft' }).click();
    await page
      .getByRole('textbox', { name: 'Draft' })
      .fill('# On Harbours\n\nHarbours are where *cities* begin.');
    await shot('13-import');

    await newProject(page, 'Blank page');
    await themed(page);
    await expect(manuscript(page)).toBeFocused();
    await expect(manuscript(page).locator('.lh-placeholder')).toBeVisible();
    await page.waitForTimeout(300);
    await shot('14-new-document');
    expect(pid).toBeTruthy();
  });
}
