import { expect, type Page } from '@playwright/test';

/** Opens the demo (fresh ledger and queue unless `keep`) and waits for the editor. */
export async function openDemo(
  page: Page,
  query = '',
  opts: { keep?: boolean } = {},
): Promise<void> {
  const q = new URLSearchParams(query);
  if (!opts.keep) q.set('reset', '1');
  await page.goto(`/?${q}`);
  await page.waitForFunction(() => !!window.__longhand?.handle);
  await page.evaluate(() => window.__longhand.handle!.ready);
  await expect(page.getByTestId('manuscript')).toBeVisible();
}

/** Vertical center of the caret (ProseMirror coords) and of the DOM selection, plus the viewport height. */
export async function caret(
  page: Page,
): Promise<{ y: number; domY: number | null; height: number; scrollY: number }> {
  return page.evaluate(() => {
    const r = window.__longhand.handle!.caretRect()!;
    const sel = window.getSelection();
    let domY: number | null = null;
    if (sel && sel.rangeCount) {
      const rects = sel.getRangeAt(0).getClientRects();
      const rect = rects[rects.length - 1];
      if (rect && rect.height > 0) domY = (rect.top + rect.bottom) / 2;
    }
    return { y: (r.top + r.bottom) / 2, domY, height: window.innerHeight, scrollY: window.scrollY };
  });
}

/** Asserts the caret line sits at `ratio` of the viewport (within a few pixels). */
export async function expectCaretAt(page: Page, ratio = 0.5, tolerance = 3): Promise<void> {
  await expect
    .poll(
      async () => {
        const c = await caret(page);
        return Math.abs(c.y - c.height * ratio);
      },
      { timeout: 2000, intervals: [50, 100, 200] },
    )
    .toBeLessThanOrEqual(tolerance);
  const c = await caret(page);
  if (c.domY !== null)
    expect(Math.abs(c.domY - c.height * ratio)).toBeLessThanOrEqual(tolerance + 12);
}

/** Puts the caret at the end of the document with the keyboard (Cmd+Down / Ctrl+End). */
export async function caretToEnd(page: Page): Promise<void> {
  await page.getByTestId('manuscript').focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
}

/** Ledger commits of the mock transport. */
export async function commits(
  page: Page,
): Promise<Array<{ type: string; payload: Record<string, unknown> }>> {
  return page.evaluate(() =>
    window.__longhand.transport
      .commits()
      .map((d) => ({ type: d.type, payload: d.payload as Record<string, unknown> })),
  );
}

/** The manuscript text, paragraphs joined by newlines. */
export async function docText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const doc = window.__longhand.handle!.getState().doc;
    return doc.textBetween(0, doc.content.size, '\n');
  });
}

/** Methods of every run in every TextEdited commit. */
export async function runMethods(page: Page): Promise<string[]> {
  const all = await commits(page);
  return all
    .filter((c) => c.type === 'TextEdited')
    .flatMap((c) => (c.payload.runs as Array<{ method: string }>).map((r) => r.method));
}
