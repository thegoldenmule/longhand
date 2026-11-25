import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Opens the demo with query parameters and waits for the editor (write view) or the replay. */
export async function openDemo(page: Page, query: Record<string, string> = {}): Promise<void> {
  const q = new URLSearchParams(query);
  await page.goto(`/?${q}`);
  if (query.view === 'replay') {
    await expect(page.getByTestId('replay-doc')).toBeVisible();
  } else {
    await page.waitForFunction(() => window.__prov?.ready === true);
    await expect(page.getByTestId('manuscript')).toBeVisible();
  }
}

/** Where screenshots go (`test-results/screens`, gitignored). */
export const SCREEN_DIR = fileURLToPath(new URL('../test-results/screens/', import.meta.url));
mkdirSync(SCREEN_DIR, { recursive: true });

/** Computed tint style of the first span of each class in the manuscript. */
export async function tintStyles(
  page: Page,
): Promise<Record<string, { bg: string; style: string; line: string; color: string }>> {
  return page.evaluate(() => {
    const out: Record<string, { bg: string; style: string; line: string; color: string }> = {};
    for (const el of document.querySelectorAll<HTMLElement>(
      '[data-testid="manuscript"] [data-prov]',
    )) {
      const cls = el.dataset.prov as string;
      if (out[cls]) continue;
      const cs = getComputedStyle(el);
      out[cls] = {
        bg: cs.backgroundColor,
        style: cs.textDecorationStyle,
        line: cs.textDecorationLine,
        color: cs.textDecorationColor,
      };
    }
    return out;
  });
}

/** Viewport center of the character at a ledger position (no unsynced edits in these tests). */
export async function charCenter(page: Page, pos: number): Promise<{ x: number; y: number }> {
  return page.evaluate((p) => {
    const view = window.__prov.handle!.view;
    const a = view.coordsAtPos(p, 1);
    const b = view.coordsAtPos(p + 1, -1);
    return { x: (a.left + b.left) / 2, y: (a.top + a.bottom) / 2 };
  }, pos);
}
