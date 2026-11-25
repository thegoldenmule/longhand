import { expect, test, type Page } from '@playwright/test';
import { charCenter, openDemo, SCREEN_DIR, tintStyles } from './helpers';

const LIGHT = {
  // Typed, almost everything, stays plain so the other classes stand out.
  typed: { bg: 'rgba(0, 0, 0, 0)', line: 'none' },
  'typed-from-suggestion': { bg: 'rgba(118, 86, 168, 0.13)', line: 'underline', style: 'dotted' },
  'pasted-external': { bg: 'rgba(194, 112, 42, 0.17)', line: 'underline', style: 'wavy' },
  imported: { bg: 'rgba(86, 112, 143, 0.13)', line: 'underline', style: 'dashed' },
  quoted: { bg: 'rgba(43, 130, 124, 0.13)', line: 'underline', style: 'double' },
} as const;

const DARK_BG = {
  typed: 'rgba(0, 0, 0, 0)',
  'typed-from-suggestion': 'rgba(181, 157, 224, 0.16)',
  'pasted-external': 'rgba(224, 154, 85, 0.18)',
  imported: 'rgba(154, 176, 204, 0.15)',
  quoted: 'rgba(118, 194, 187, 0.15)',
} as const;

/**
 * The spans of each class carry exactly that class's run text, in order, and
 * each span's seqs belong to runs of its class. Touching runs that look the same
 * share one span, so its `data-prov-seq` lists several seqs.
 */
async function expectSpansMatchRuns(page: Page): Promise<void> {
  const mismatches = await page.evaluate(() => {
    const { tint, handle } = window.__prov;
    const doc = handle!.view.state.doc;
    const out: string[] = [];
    const cls = (c: string) => (c === 'pasted-internal' ? 'pasted-external' : c);
    const text = new Map<string, string>();
    const seqs = new Map<string, Set<string>>();
    for (const r of [...tint.getSnapshot().runs].sort((a, b) => a.from - b.from)) {
      const k = cls(r.class);
      text.set(k, (text.get(k) ?? '') + doc.textBetween(r.from, r.to, '', ''));
      seqs.set(k, (seqs.get(k) ?? new Set()).add(String(r.originSeq)));
    }
    const shown = new Map<string, string>();
    for (const el of document.querySelectorAll<HTMLElement>(
      '[data-testid="manuscript"] [data-prov]',
    )) {
      const k = el.dataset.prov as string;
      shown.set(k, (shown.get(k) ?? '') + (el.textContent ?? ''));
      for (const seq of (el.dataset.provSeq ?? '').split(' ')) {
        if (!seqs.get(k)?.has(seq)) out.push(`${k}: seq ${seq} has no run of that class`);
      }
    }
    for (const [k, v] of text) if (shown.get(k) !== v) out.push(`${k}: ${shown.get(k)} != ${v}`);
    for (const k of shown.keys()) if (!text.has(k)) out.push(`extra ${k}`);
    return out;
  });
  expect(mismatches).toEqual([]);
}

/** Visible gaps: two touching tint spans of the same look would show a seam. */
async function touchingTwins(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const look = (el: HTMLElement) =>
      `${el.dataset.prov}|${el.dataset.provMatched ?? ''}|${el.dataset.provMoved ?? ''}`;
    for (const el of document.querySelectorAll<HTMLElement>(
      '[data-testid="manuscript"] [data-prov]',
    )) {
      const next = el.nextSibling;
      if (next instanceof HTMLElement && next.dataset.prov && look(next) === look(el)) {
        out.push(`${el.textContent}|${next.textContent}`);
      }
    }
    return out;
  });
}

test.describe('tint', () => {
  test('toggling the tint colours the expected spans, with an underline per class', async ({
    page,
  }) => {
    await openDemo(page, { fixture: 'suggestions', theme: 'light' });
    await expect(page.locator('[data-testid="manuscript"] [data-prov]')).toHaveCount(0);
    const toggle = page.getByRole('switch', { name: 'Tint' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expectSpansMatchRuns(page);
    expect(await touchingTwins(page)).toEqual([]);
    const styles = await tintStyles(page);
    expect(styles.typed).toMatchObject({ bg: LIGHT.typed.bg, line: 'none' });
    expect(styles['typed-from-suggestion']).toMatchObject({
      bg: LIGHT['typed-from-suggestion'].bg,
      line: 'underline',
      style: 'dotted',
    });
    // The matched kind is on the span.
    const kinds = await page
      .locator('[data-testid="manuscript"] [data-prov-matched]')
      .evaluateAll((els) =>
        [...new Set(els.map((e) => e.getAttribute('data-prov-matched')))].sort(),
      );
    expect(kinds).toEqual(['comment', 'insertion', 'suggestion']);
    await page.waitForTimeout(250); // let the 160 ms ease finish
    await page.screenshot({ path: `${SCREEN_DIR}/tint-light.png` });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SCREEN_DIR}/tint-dark.png` });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    await toggle.click();
    await expect(page.locator('[data-testid="manuscript"] [data-prov]')).toHaveCount(0);
  });

  test('pasted, imported and quoted classes', async ({ page }) => {
    await openDemo(page, { fixture: 'research', theme: 'light', tint: '1' });
    await expectSpansMatchRuns(page);
    expect(await touchingTwins(page)).toEqual([]);
    const r = await tintStyles(page);
    expect(r.quoted).toMatchObject({ bg: LIGHT.quoted.bg, line: 'underline', style: 'double' });
    expect(r['pasted-external']).toMatchObject({
      bg: LIGHT['pasted-external'].bg,
      line: 'underline',
      style: 'wavy',
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SCREEN_DIR}/research-light.png` });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SCREEN_DIR}/research-dark.png` });
    await openDemo(page, { fixture: 'import', theme: 'light', tint: '1' });
    expect((await tintStyles(page)).imported).toMatchObject({
      bg: LIGHT.imported.bg,
      line: 'underline',
      style: 'dashed',
    });
  });

  test('dark theme colours', async ({ page }) => {
    await openDemo(page, { fixture: 'research', theme: 'dark', tint: '1' });
    const r = await tintStyles(page);
    expect(r.quoted?.bg).toBe(DARK_BG.quoted);
    expect(r['pasted-external']?.bg).toBe(DARK_BG['pasted-external']);
    expect(r.typed?.bg).toBe(DARK_BG.typed);
  });

  test('legend counts and highlighting a class', async ({ page }) => {
    await openDemo(page, { fixture: 'suggestions', theme: 'light' });
    await expect(page.getByTestId('legend-count-typed')).toHaveText('30');
    await expect(page.getByTestId('legend-count-typed-from-suggestion')).toHaveText('11');
    await page.getByTestId('legend-typed-from-suggestion').click();
    await expect(page.getByRole('switch', { name: 'Tint' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page.getByTestId('manuscript')).toHaveAttribute(
      'data-prov-highlight',
      'typed-from-suggestion',
    );
    // (The tint eases over 160 ms.)
    await expect.poll(async () => (await tintStyles(page)).typed?.bg).toBe('rgba(0, 0, 0, 0)');
    await expect
      .poll(async () => (await tintStyles(page))['typed-from-suggestion']?.bg)
      .toBe('rgba(118, 86, 168, 0.26)');
    await page.screenshot({ path: `${SCREEN_DIR}/highlight-light.png` });
  });
});

test.describe('span inspector', () => {
  test('opens on click', async ({ page }) => {
    await openDemo(page, { fixture: 'suggestions', theme: 'light', tint: '1' });
    // "...the lane": typed from a margin comment (positions 204–229).
    const pt = await charCenter(page, 210);
    await page.mouse.click(pt.x, pt.y);
    const dialog = page.getByRole('dialog', { name: 'Typed from a suggestion' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('inspector-suggestion')).toContainText(
      'Matched a margin comment',
    );
    await expect(dialog.getByTestId('inspector-session')).toContainText('Writing session 1 of 1');
    await expect(page.locator('.lh-prov-inspected')).toHaveCount(1);
    await page.screenshot({ path: `${SCREEN_DIR}/inspector-light.png` });
    // Escape closes it; clicking other text opens that text's history.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const typed = await charCenter(page, 3);
    await page.mouse.click(typed.x, typed.y);
    await expect(page.getByRole('dialog', { name: 'Typed' })).toBeVisible();
    await expect(page.getByTestId('inspector-suggestion')).toContainText(
      'Did not match any AI text',
    );
  });

  test('opens with the keyboard and returns focus to the editor', async ({ page }) => {
    await openDemo(page, { fixture: 'internal-paste', doc: 'doc-a', theme: 'light', tint: '1' });
    // Caret into the external paste (positions 25–49), with the keyboard only.
    await page.getByTestId('manuscript').focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
    for (let i = 0; i < 26; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Alt+Enter');
    const dialog = page.getByRole('dialog', { name: 'Pasted (external)' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    await expect(dialog.getByTestId('inspector-paste')).toHaveText(
      'Paste size24 characters, 4 words from outside the project',
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('manuscript')).toBeFocused();
    // The close button is reachable and works from the keyboard too.
    await page.keyboard.press('Alt+Enter');
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Close' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('manuscript')).toBeFocused();
  });

  test('shows moves for an accepted proposal', async ({ page }) => {
    await openDemo(page, { fixture: 'proposals', theme: 'dark', tint: '1' });
    const pt = await charCenter(page, 20);
    await page.mouse.click(pt.x, pt.y);
    await expect(page.getByTestId('inspector-moves')).toContainText(
      'Moved by accepting a proposal (move sentence)',
    );
    await page.screenshot({ path: `${SCREEN_DIR}/inspector-dark.png` });
  });
});

test.describe('replay', () => {
  test('scrubs to any seq and plays back', async ({ page }) => {
    await openDemo(page, { fixture: 'suggestions', view: 'replay', theme: 'light' });
    const root = page.getByTestId('replay');
    const slider = page.getByTestId('replay-slider');
    const doc = page.getByTestId('replay-doc');
    const textAt = (seq: number) =>
      page.evaluate(([s, d]) => window.__prov.textAt(s as number, d as string), [seq, 'doc-s']);

    // Head first.
    const head = Number(await root.getAttribute('data-seq'));
    expect(head).toBe(33);
    await expect(doc).toHaveText((await textAt(head))!);

    // Keyboard scrubbing on the slider.
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(root).toHaveAttribute('data-seq', '0');
    await expect(page.getByTestId('replay-empty')).toBeVisible();
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    const seq = Number(await root.getAttribute('data-seq'));
    expect(seq).toBeGreaterThan(0);
    await expect(doc).toHaveText((await textAt(seq))!);
    await expect(slider).toHaveAttribute('aria-valuetext', /^Edit 3 of \d+\. Typed/);

    // Markers for both AI sessions.
    await expect(page.getByTestId('marker-ai-session')).toHaveCount(2);

    // Tint the replay.
    await page.getByTestId('replay-tint').click();
    await expect(doc.locator('[data-prov]').first()).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SCREEN_DIR}/replay-light.png` });

    // Play at 64x from the start: the seq only moves forward and reaches the head.
    await page.getByTestId('replay-speed').selectOption('64');
    await slider.focus();
    await page.keyboard.press('Home');
    const started = Date.now();
    await page.getByTestId('replay-play').click();
    await expect(root).toHaveAttribute('data-playing', 'true');
    const seen: number[] = [];
    while ((await root.getAttribute('data-playing')) === 'true' && Date.now() - started < 15_000) {
      seen.push(Number(await root.getAttribute('data-seq')));
      await page.waitForTimeout(50);
    }
    const elapsed = Date.now() - started;
    expect(await root.getAttribute('data-seq')).toBe('33');
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
    expect(new Set(seen).size).toBeGreaterThan(3);
    // About a minute of ledger time (idle gaps capped at 4 s) at 64x is about a second.
    expect(elapsed).toBeGreaterThan(400);
    expect(elapsed).toBeLessThan(6000);
    await expect(doc).toHaveText((await textAt(33))!);
  });

  test('project-wide timeline over another document', async ({ page }) => {
    await openDemo(page, { fixture: 'novel', view: 'replay', theme: 'dark' });
    await page.getByTestId('replay-document').selectOption('doc-3');
    await page.getByTestId('replay-scope-project').check();
    const slider = page.getByTestId('replay-slider');
    await expect(slider).toHaveAttribute('max', '27');
    await slider.focus();
    await page.keyboard.press('Home');
    for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
    const root = page.getByTestId('replay');
    await expect(root).toHaveAttribute('data-seq', '20');
    const want = await page.evaluate(() => window.__prov.textAt(20, 'doc-3'));
    if (want === null) await expect(page.getByTestId('replay-empty')).toBeVisible();
    else await expect(page.getByTestId('replay-doc')).toHaveText(want);
    await page.getByTestId('replay-tint').click();
    await slider.focus();
    await page.keyboard.press('End');
    await expect(root).toHaveAttribute('data-seq', '27');
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SCREEN_DIR}/replay-dark.png` });
  });
});
