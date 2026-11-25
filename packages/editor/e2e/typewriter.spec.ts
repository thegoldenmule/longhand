import { expect, test } from '@playwright/test';
import { caret, caretToEnd, docText, expectCaretAt, openDemo, runMethods } from './helpers';

const LONG =
  'This sentence keeps going long enough to wrap across several lines of the sixty-six character column, so the caret has to move down a line more than once while typing.';

test.describe('typewriter scrolling', () => {
  test('holds the caret at 50% while typing across soft wraps', async ({ page }) => {
    await openDemo(page);
    await caretToEnd(page);
    await page.keyboard.type(' ');
    await expectCaretAt(page, 0.5);
    const start = await caret(page);
    // Type in chunks and check after each one; the text wraps several times.
    for (let i = 0; i < LONG.length; i += 40) {
      await page.keyboard.type(LONG.slice(i, i + 40));
      await expectCaretAt(page, 0.5);
    }
    const end = await caret(page);
    expect(end.scrollY).toBeGreaterThan(start.scrollY + 40);
  });

  test('holds across Enter and Backspace across lines', async ({ page }) => {
    await openDemo(page);
    await caretToEnd(page);
    await page.keyboard.type(' x');
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Enter');
      await expectCaretAt(page, 0.5);
      await page.keyboard.type('New paragraph.');
      await expectCaretAt(page, 0.5);
    }
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace'); // joins with the previous paragraph
    await expectCaretAt(page, 0.5);
    await page.keyboard.press('Backspace');
    await expectCaretAt(page, 0.5);
  });

  test('holds across paste', async ({ page }) => {
    await openDemo(page);
    await caretToEnd(page);
    await page.evaluate((t) => navigator.clipboard.writeText(t), `${LONG} ${LONG}`);
    await page.keyboard.press('ControlOrMeta+V');
    await expect.poll(() => docText(page)).toContain(LONG);
    await expectCaretAt(page, 0.5);
  });

  test('holds across IME composition', async ({ page }) => {
    await openDemo(page, 'idle=300');
    await caretToEnd(page);
    await page.keyboard.type(' ');
    const cdp = await page.context().newCDPSession(page);
    const steps = ['に', 'にほ', 'にほん', 'にほんご'];
    for (const text of steps) {
      await cdp.send('Input.imeSetComposition', {
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      });
    }
    await cdp.send('Input.insertText', { text: '日本語の文章がここで長く続きます。' });
    await expect.poll(() => docText(page)).toContain('日本語の文章');
    await expectCaretAt(page, 0.5);
    await expect.poll(() => runMethods(page), { timeout: 4000 }).toContain('ime');
  });

  test('uses the configured caret height', async ({ page }) => {
    await openDemo(page, 'ratio=0.4');
    await caretToEnd(page);
    await page.keyboard.type(' More words at forty percent.');
    await expectCaretAt(page, 0.4);
    // Out-of-range settings are clamped to 33–60%.
    await page.evaluate(() => window.__longhand.handle!.setSettings({ caretRatio: 0.9 }));
    await page.keyboard.type('!');
    await expectCaretAt(page, 0.6);
  });

  test('clicking or scrolling elsewhere never jumps; the next keystroke re-centers', async ({
    page,
  }) => {
    await openDemo(page);
    await caretToEnd(page);
    await page.keyboard.type(' Locked.');
    await expectCaretAt(page, 0.5);

    // Click a word near the top of the viewport.
    const before = await caret(page);
    const target = page.locator('.lh-manuscript p').nth(3);
    const box = (await target.boundingBox())!;
    const clickY = Math.max(box.y + 10, 60);
    await page.mouse.click(box.x + 40, clickY);
    await page.waitForTimeout(300);
    const afterClick = await caret(page);
    expect(afterClick.scrollY).toBe(before.scrollY);
    expect(Math.abs(afterClick.y - clickY)).toBeLessThan(30);

    // Scrolling with the wheel moves only by the wheel amount and stays put.
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(300);
    const afterWheel = await caret(page);
    expect(afterWheel.scrollY).toBeLessThan(before.scrollY);
    await page.waitForTimeout(300);
    expect((await caret(page)).scrollY).toBe(afterWheel.scrollY);

    // The next keystroke re-centers (animated, ~120 ms).
    await page.keyboard.type('x');
    await page.waitForTimeout(250);
    await expectCaretAt(page, 0.5);
  });

  test('re-centers instantly under prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openDemo(page);
    await caretToEnd(page);
    await page.keyboard.type(' a');
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(200);
    const drift = await caret(page);
    expect(Math.abs(drift.y - drift.height * 0.5)).toBeGreaterThan(50);
    await page.keyboard.type('b');
    // No animation: centered by the next frame.
    const offset = await page.evaluate(
      () =>
        new Promise<number>((resolve) =>
          requestAnimationFrame(() => {
            const r = window.__longhand.handle!.caretRect()!;
            resolve(Math.abs((r.top + r.bottom) / 2 - window.innerHeight * 0.5));
          }),
        ),
    );
    expect(offset).toBeLessThanOrEqual(3);
  });

  test('focus mode dims all but the current sentence', async ({ page }) => {
    await openDemo(page, 'focus=sentence');
    await caretToEnd(page);
    await expect(page.locator('.lh-manuscript')).toHaveAttribute('data-focus', 'sentence');
    await expect(page.locator('.lh-focus-current')).toHaveText(
      'She waited for it to steady and then went on.',
    );
    const colors = await page.evaluate(() => {
      const cur = document.querySelector('.lh-focus-current')!;
      const other = document.querySelector('.lh-manuscript p')!;
      return [getComputedStyle(cur).color, getComputedStyle(other).color];
    });
    expect(colors[0]).not.toBe(colors[1]);
    await page.getByTestId('focus').selectOption('paragraph');
    await expect(page.locator('p.lh-focus-current')).toHaveCount(1);
  });
});
