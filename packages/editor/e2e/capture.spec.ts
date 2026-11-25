import { expect, test, type Page } from '@playwright/test';
import { caretToEnd, commits, docText, openDemo, runMethods } from './helpers';

async function queueSize(page: Page): Promise<number> {
  return page.evaluate(async () => (await window.__longhand.queue.list()).length);
}

test.describe('input capture', () => {
  test('typed input is committed as one TextEdited after ~2 s idle', async ({ page }) => {
    await openDemo(page);
    await caretToEnd(page);
    await page.keyboard.type(' abc', { delay: 40 });
    const typedAt = Date.now();
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'queued', {
      timeout: 1000,
    });
    await page.waitForTimeout(Math.max(0, 1200 - (Date.now() - typedAt)));
    // Nothing is committed before the writer has been idle for ~2 s.
    if (Date.now() - typedAt < 1900) expect(await commits(page)).toHaveLength(0);
    await expect.poll(() => commits(page), { timeout: 3000 }).toHaveLength(1);
    const [te] = await commits(page);
    expect(te!.type).toBe('TextEdited');
    expect(te!.payload.runs).toEqual([{ steps: 4, method: 'typed' }]);
    const timeline = te!.payload.timeline as Array<{ t: number; kind: string; len: number }>;
    expect(timeline.map((k) => k.kind)).toEqual(['insert', 'insert', 'insert', 'insert']);
    expect(timeline[3]!.t).toBeGreaterThan(60);
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
  });

  test('external paste is classified pasted-external', async ({ page }) => {
    await openDemo(page, 'idle=300');
    await caretToEnd(page);
    await page.evaluate(() => navigator.clipboard.writeText(' Words from somewhere else.'));
    await page.keyboard.press('ControlOrMeta+V');
    await expect.poll(() => docText(page)).toContain('Words from somewhere else.');
    await expect.poll(() => runMethods(page), { timeout: 4000 }).toEqual(['pasted-external']);
    const all = await commits(page);
    expect(all.map((c) => c.type)).toEqual(['PasteOccurred', 'TextEdited']);
    expect(all[0]!.payload).toMatchObject({
      origin: 'external',
      via: 'clipboard',
      copyId: null,
      words: 4,
    });
  });

  test('internal copy/paste is classified pasted-internal', async ({ page }) => {
    await openDemo(page, 'idle=300');
    // Select "The rain" at the very start with the keyboard.
    await page.getByTestId('manuscript').focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
    for (let i = 0; i < 8; i++) await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('ControlOrMeta+C');
    await caretToEnd(page);
    await page.keyboard.type(' ');
    await page.keyboard.press('ControlOrMeta+V');
    await expect.poll(() => docText(page)).toMatch(/went on\. The rain$/);
    await expect.poll(() => runMethods(page), { timeout: 4000 }).toContain('pasted-internal');
    const all = await commits(page);
    const copy = all.find((c) => c.type === 'SliceCopied')!;
    const paste = all.find((c) => c.type === 'PasteOccurred')!;
    expect(copy.payload).toMatchObject({ cut: false, characters: 8 });
    expect(paste.payload).toMatchObject({
      origin: 'internal',
      copyId: copy.payload.copyId,
      textHash: copy.payload.textHash,
    });
    // Ordering: the copy, then the paste record, then the steps that use it.
    const order = all.map((c) => c.type);
    expect(order.indexOf('SliceCopied')).toBeLessThan(order.indexOf('PasteOccurred'));
    expect(order.lastIndexOf('TextEdited')).toBeGreaterThan(order.indexOf('PasteOccurred'));
  });

  test('a script cannot put words in the manuscript', async ({ page }) => {
    await openDemo(page);
    const before = await docText(page);
    await page.evaluate(() => {
      const view = window.__longhand.handle!.view;
      view.dispatch(view.state.tr.insertText('Generated text. ', 1));
      view.pasteText('Injected paste.');
    });
    expect(await docText(page)).toBe(before);
  });

  test('markdown shortcuts format as you type', async ({ page }) => {
    await openDemo(page, 'idle=300');
    await caretToEnd(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('## A heading');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Some **strong** and *soft* words');
    await expect(page.locator('.lh-manuscript h2')).toHaveText('A heading');
    await expect(page.locator('.lh-manuscript strong')).toHaveText('strong');
    await expect(page.locator('.lh-manuscript em')).toHaveText('soft');
    await page.keyboard.press('Enter');
    await page.keyboard.type('***');
    await expect(page.locator('.lh-manuscript hr[data-scene-break]')).toHaveCount(1);
    await expect.poll(() => runMethods(page), { timeout: 4000 }).toEqual(['typed']);
  });
});

test.describe('offline queue', () => {
  test('survives a reload and flushes on reconnect', async ({ page }) => {
    await openDemo(page);
    await page.getByTestId('online').uncheck();
    await caretToEnd(page);
    await page.keyboard.type(' Written offline.');
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'offline');
    await expect.poll(() => queueSize(page), { timeout: 4000 }).toBe(1);
    expect(await commits(page)).toHaveLength(0);

    // Reload while still offline: the queued draft is restored and shown.
    await openDemo(page, 'offline=1', { keep: true });
    expect(await docText(page)).toMatch(/Written offline\.$/);
    expect(await queueSize(page)).toBe(1);
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'offline');

    // Reconnect: the queue drains to the ledger.
    await page.getByTestId('online').check();
    await expect.poll(() => queueSize(page), { timeout: 4000 }).toBe(0);
    await expect.poll(() => runMethods(page)).toEqual(['typed']);
    await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
    const queued = (await commits(page))[0]!;
    expect(queued.payload.baseVersion).toBe(0);

    // And the ledger (persisted by the mock) has the text after another reload.
    await openDemo(page, '', { keep: true });
    expect(await docText(page)).toMatch(/Written offline\.$/);
    expect(await queueSize(page)).toBe(0);
  });
});
