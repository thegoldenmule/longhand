/**
 * Screenshots of the demo in light and dark themes, for a human (or agent) to
 * look at: is the AI colour distinct from the writer's, is the page calm and
 * legible? Written to test-results/screens/ (or $SHOTS_DIR).
 */
import { expect, test, type Page } from '@playwright/test';
import { marginCard, openDemo } from './helpers';

const SHOTS = process.env.SHOTS_DIR ?? 'test-results/screens';

/** Scrolls so the first paragraph sits near the top of the viewport. */
async function scrollToText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const p = document.querySelector('[data-testid="manuscript"] > *')!;
    window.scrollTo(0, p.getBoundingClientRect().top + window.scrollY - 90);
  });
  await page.waitForTimeout(250);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use({ colorScheme: theme });

    test('suggestions, margin and panel', async ({ page }) => {
      await openDemo(page, 'seed=suggestions');
      await expect(marginCard(page, 'sug-adopt')).toBeVisible();
      await scrollToText(page);
      await page.evaluate(() => window.__ann.controller!.focus('sug-adopt', { scroll: false }));
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${SHOTS}/suggestions-${theme}.png` });
    });

    test('trace-over in progress', async ({ page }) => {
      await openDemo(page, 'seed=suggestions');
      await page.evaluate(() => window.__ann.controller!.startTrace('sug-adopt'));
      await page.keyboard.type('weat');
      await scrollToText(page);
      await page.screenshot({ path: `${SHOTS}/trace-${theme}.png` });
    });

    test('proposal preview', async ({ page }) => {
      await openDemo(page, 'seed=proposals');
      await scrollToText(page);
      await page.evaluate(() => window.__ann.controller!.focus('mv-paragraph', { scroll: false }));
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${SHOTS}/proposals-move-${theme}.png` });
      await page.evaluate(() => window.__ann.controller!.focus('cut-anchor', { scroll: false }));
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${SHOTS}/proposals-cut-${theme}.png` });
    });

    test('finished and failed reviews', async ({ page }) => {
      await openDemo(page, 'seed=feedback-session&upto=all');
      await scrollToText(page);
      await page.screenshot({ path: `${SHOTS}/feedback-${theme}.png` });
    });

    test('research cards', async ({ page }) => {
      await openDemo(page, 'seed=research');
      await scrollToText(page);
      await page.screenshot({ path: `${SHOTS}/research-${theme}.png` });
    });

    test('nothing until asked, then a live review', async ({ page }) => {
      await openDemo(page, 'seed=empty&step=500');
      await expect(page.getByTestId('annotation-margin').locator('[data-card-id]')).toHaveCount(0);
      await scrollToText(page);
      await page.screenshot({ path: `${SHOTS}/empty-${theme}.png` });
      await page.getByRole('button', { name: 'Ask the editor' }).click();
      await expect(page.getByTestId('review-session').first()).toHaveAttribute(
        'data-phase',
        'reviewing',
      );
      await page.waitForTimeout(1600);
      await page.screenshot({ path: `${SHOTS}/reviewing-${theme}.png` });
    });
  });
}
