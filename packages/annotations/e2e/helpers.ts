import { expect, type Locator, type Page } from '@playwright/test';

/** Opens the demo with a seed and waits for the editor and the margin. */
export async function openDemo(page: Page, query = 'seed=suggestions'): Promise<void> {
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => !!window.__ann?.handle && !!window.__ann.controller);
  await page.evaluate(() => window.__ann.handle!.ready);
  await expect(page.getByTestId('manuscript')).toBeVisible();
}

/** A margin card by annotation id. */
export function marginCard(page: Page, id: string): Locator {
  return page.getByTestId('annotation-margin').locator(`[data-card-id="${id}"]`);
}

/** The status of a suggestion in the folded state. */
export async function suggestionStatus(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate((i) => window.__ann.state().annotations.suggestions[i]?.status, id);
}

/** The manuscript text, blocks joined by newlines. */
export async function docText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const doc = window.__ann.handle!.getState().doc;
    return doc.textBetween(0, doc.content.size, '\n');
  });
}

/** Commit types in the ledger after the seed. */
export async function commitTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__ann.transport.commits.map((c) => c.type));
}

/** Selects a word in the manuscript by double-clicking it. */
export async function dblclickWord(page: Page, word: string): Promise<void> {
  const box = await page.evaluate((w) => {
    const root = document.querySelector('[data-testid="manuscript"]')!;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const parent = n.parentElement;
      if (parent?.closest('[data-lh-ghost]')) continue;
      const i = (n.nodeValue ?? '').search(new RegExp(`\\b${w}\\b`));
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + w.length);
      const rect = r.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return null;
  }, word);
  if (!box) throw new Error(`word ${word} not found`);
  await page.mouse.dblclick(box.x, box.y);
}
