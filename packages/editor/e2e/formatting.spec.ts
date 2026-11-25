/**
 * The bubble toolbar, links and inline code in a real browser.
 *
 * Written alongside the jsdom tests in `src/formatting.test.ts`, which cover the
 * same behaviour without layout. Not yet run: this suite needs Chrome.
 */
import { expect, test, type Page } from '@playwright/test';
import { caretToEnd, commits, docText, openDemo, runMethods } from './helpers';

const bubble = (page: Page) => page.getByTestId('bubble-toolbar');
const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Formatting' });

/** Types a fresh last paragraph and selects `word` in it with the mouse. */
async function typeAndSelect(page: Page, text: string, word: string): Promise<void> {
  await caretToEnd(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await page.evaluate((w) => {
    const view = window.__longhand.handle!.view;
    const doc = view.state.doc;
    let at = -1;
    doc.descendants((n, pos) => {
      if (at < 0 && n.isText && n.text!.includes(w)) at = pos + n.text!.indexOf(w);
    });
    // After typing the selection is a TextSelection: reuse its class to make a range.
    const Sel = view.state.selection.constructor as unknown as {
      create(d: typeof doc, from: number, to: number): typeof view.state.selection;
    };
    view.dispatch(view.state.tr.setSelection(Sel.create(doc, at, at + w.length)));
    view.focus();
  }, word);
}

test.describe('bubble toolbar', () => {
  test('appears above a selection and formats as formatting only', async ({ page }) => {
    await openDemo(page, 'idle=300');
    await typeAndSelect(page, 'Format this word please', 'this');
    await expect(bubble(page)).toBeVisible();
    // Above the selection, not over it.
    const box = (await bubble(page).boundingBox())!;
    const sel = await page.evaluate(() => {
      const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      return { top: r.top, left: r.left, right: r.right };
    });
    expect(box.y + box.height).toBeLessThanOrEqual(sel.top);
    expect(box.x).toBeLessThan(sel.right);
    // The editor keeps focus while the toolbar shows.
    await expect(page.getByTestId('manuscript')).toBeFocused();
    await toolbar(page).getByRole('button', { name: 'Bold' }).click();
    await expect(page.locator('.lh-manuscript strong')).toHaveText('this');
    await expect(toolbar(page).getByRole('button', { name: 'Bold' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await toolbar(page).getByRole('button', { name: 'Code' }).click();
    await expect(page.locator('.lh-manuscript code')).toHaveText('this');
    await toolbar(page).getByRole('button', { name: 'Heading' }).click();
    await expect(page.locator('.lh-manuscript h1')).toContainText('Format this word please');
    await toolbar(page).getByRole('button', { name: 'Heading' }).click();
    await toolbar(page).getByRole('button', { name: 'Quote' }).click();
    await expect(page.locator('.lh-manuscript blockquote')).toContainText('Format this word');
    // Collapsing the selection hides it.
    await page.keyboard.press('ArrowRight');
    await expect(bubble(page)).toBeHidden();
    await expect.poll(() => runMethods(page), { timeout: 4000 }).not.toContain('pasted-external');
    const edits = (await commits(page)).filter((c) => c.type === 'TextEdited');
    const formats = edits.flatMap((c) =>
      (c.payload.timeline as Array<{ kind: string; len: number }>).filter(
        (k) => k.kind === 'format',
      ),
    );
    expect(formats.length).toBeGreaterThanOrEqual(4);
    expect(formats.every((k) => k.len === 0)).toBe(true);
  });

  test('is keyboard reachable: Alt+F10 in, arrows across, Esc back', async ({ page }) => {
    await openDemo(page);
    await typeAndSelect(page, 'Keyboard only', 'only');
    await page.keyboard.press('Alt+F10');
    await expect(toolbar(page).getByRole('button', { name: 'Bold' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(toolbar(page).getByRole('button', { name: 'Italic' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.lh-manuscript em')).toHaveText('only');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('manuscript')).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.getSelection()!.toString())).toBe('only');
  });

  test('links: Mod+K field, bad hrefs refused, caret popover, Remove', async ({ page }) => {
    await openDemo(page, 'idle=300');
    await typeAndSelect(page, 'Read the notes today', 'the notes');
    await page.keyboard.press('ControlOrMeta+K');
    const field = bubble(page).getByRole('textbox', { name: 'Link address' });
    await expect(field).toBeFocused();
    await field.fill('javascript:alert(1)');
    await field.press('Enter');
    await expect(bubble(page).getByRole('alert')).toHaveText('Use an http, https or mailto link');
    await field.fill('example.com/notes');
    await field.press('Enter');
    const link = page.locator('.lh-manuscript a');
    await expect(link).toHaveText('the notes');
    await expect(link).toHaveAttribute('href', 'https://example.com/notes');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(await docText(page)).toContain('Read the notes today');
    // A plain click puts the caret in the link and shows the popover; it never navigates.
    const url = page.url();
    await link.click();
    expect(page.url()).toBe(url);
    await expect(bubble(page)).toHaveAttribute('data-mode', 'view');
    await expect(bubble(page).getByRole('link')).toHaveText('example.com/notes');
    // Mod+click opens a new tab.
    const popup = page.context().waitForEvent('page');
    await link.click({ modifiers: ['ControlOrMeta'] });
    const tab = await popup;
    expect(tab.url()).toContain('example.com/notes');
    await tab.close();
    expect(page.url()).toBe(url);
    await link.click();
    await bubble(page).getByRole('button', { name: 'Remove link' }).click();
    await expect(page.locator('.lh-manuscript a')).toHaveCount(0);
    expect(await docText(page)).toContain('Read the notes today');
  });

  test('pasting a URL over a selection links it without adding words', async ({ page }) => {
    await openDemo(page, 'idle=300');
    await typeAndSelect(page, 'Paste over these words', 'these');
    await page.evaluate(() => navigator.clipboard.writeText('https://example.org/x'));
    await page.keyboard.press('ControlOrMeta+V');
    await expect(page.locator('.lh-manuscript a')).toHaveText('these');
    expect(await docText(page)).toContain('Paste over these words');
    await expect.poll(() => runMethods(page), { timeout: 4000 }).toContain('typed');
    const all = await commits(page);
    expect(all.map((c) => c.type)).not.toContain('PasteOccurred');
  });

  test('markdown: `code` and [text](url) as you type', async ({ page }) => {
    await openDemo(page, 'idle=300');
    await caretToEnd(page);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Run `make book` and see [the site](example.com) now');
    await expect(page.locator('.lh-manuscript code')).toHaveText('make book');
    await expect(page.locator('.lh-manuscript a')).toHaveText('the site');
    await expect(page.locator('.lh-manuscript a')).toHaveAttribute('href', 'https://example.com');
    expect(await docText(page)).toContain('Run make book and see the site now');
    await expect.poll(() => runMethods(page), { timeout: 4000 }).toEqual(['typed']);
  });

  test('looks right in light and dark', async ({ page }) => {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openDemo(page);
      await typeAndSelect(page, `A ${scheme} selection`, scheme);
      await expect(bubble(page)).toBeVisible();
      await bubble(page).screenshot({ path: `test-results/bubble-${scheme}.png` });
      const bg = await bubble(page).evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).not.toBe('rgba(0, 0, 0, 0)');
    }
  });
});
