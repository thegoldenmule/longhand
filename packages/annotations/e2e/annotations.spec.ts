/**
 * The spec's Playwright list for the annotation layer, against the demo page (the
 * real editor over a transport that folds with @longhand/ledger).
 */
import { expect, test, type Page } from '@playwright/test';
import { commitTypes, docText, marginCard, openDemo, suggestionStatus } from './helpers';

/** Computed colours of the AI ink and the writer's ink, as `rgb(...)`. */
async function inks(page: Page): Promise<{ ai: string; writer: string }> {
  return page.evaluate(() => {
    const probe = (parent: Element, color: string): string => {
      const s = document.createElement('span');
      s.style.color = color;
      parent.appendChild(s);
      const c = getComputedStyle(s).color;
      s.remove();
      return c;
    };
    const editor = document.querySelector('.lh-editor')!;
    return { ai: probe(document.body, 'var(--lh-ann-ai)'), writer: probe(editor, 'var(--lh-ink)') };
  });
}

const colorOf = (page: Page, selector: string): Promise<string> =>
  page
    .locator(selector)
    .first()
    .evaluate((e) => getComputedStyle(e).color);

const traced = (page: Page): Promise<string> =>
  page.evaluate(() =>
    [...document.querySelectorAll('.lh-trace-typed')].map((e) => e.textContent).join(''),
  );

test.describe('trace-over', () => {
  test('turns ghost text to the human colour and resolves the suggestion as adopted (retyped)', async ({
    page,
  }) => {
    await openDemo(page, 'seed=suggestions&idle=300');
    const { ai, writer } = await inks(page);
    expect(ai).not.toBe(writer);

    await marginCard(page, 'sug-adopt').getByRole('button', { name: 'Trace over' }).click();
    const ghost = page.locator('.lh-manuscript .lh-ghost-active');
    await expect(ghost).toHaveText('weathered');
    expect(await colorOf(page, '.lh-manuscript .lh-ghost-active')).toBe(ai);

    await page.keyboard.type('weat');
    await expect.poll(() => traced(page)).toBe('weat');
    await expect(page.locator('.lh-manuscript .lh-ghost-trace')).toHaveText('hered');
    // Matching characters have turned from the AI colour to the writer's; the rest waits in AI ink.
    await expect.poll(() => colorOf(page, '.lh-trace-typed')).toBe(writer);
    expect(await colorOf(page, '.lh-manuscript .lh-ghost-trace')).toBe(ai);
    await expect(marginCard(page, 'sug-adopt').getByTestId('trace-status')).toHaveText(
      'Retyping · 4 of 9',
    );

    await page.keyboard.type('hered');
    await expect(page.locator('.lh-manuscript .lh-ghost-trace')).toHaveCount(0);
    await expect.poll(() => suggestionStatus(page, 'sug-adopt'), { timeout: 5000 }).toBe('adopted');
    await expect(marginCard(page, 'sug-adopt').getByTestId('card-outcome')).toHaveText(
      'Adopted · retyped',
    );
    expect(await docText(page)).toContain('The rain fell on the weathered roof.');
    // The typed run carried the trace hint, and the fold attributes the words to the suggestion.
    const runs = await page.evaluate(() =>
      window.__ann.transport.commits
        .filter((c) => c.type === 'TextEdited')
        .flatMap((c) => (c.payload as { runs: Array<{ traceSuggestionId?: string }> }).runs),
    );
    expect(runs.some((r) => r.traceSuggestionId === 'sug-adopt')).toBe(true);
    const fromSuggestion = await page.evaluate(() =>
      window.__ann
        .state()
        .documents['doc-s']!.provenance.some(
          (r) => r.class === 'typed-from-suggestion' && r.suggestionId === 'sug-adopt',
        ),
    );
    expect(fromSuggestion).toBe(true);
    // The hint is off once the suggestion has resolved.
    await expect
      .poll(() => page.evaluate(() => window.__ann.controller!.getSnapshot().tracingId))
      .toBeNull();
  });

  test('divergent typing resolves as adapted', async ({ page }) => {
    await openDemo(page, 'seed=suggestions&idle=300');
    await marginCard(page, 'sug-adapt').getByRole('button', { name: 'Trace over' }).click();
    await expect(page.locator('.lh-manuscript .lh-ghost-active')).toHaveText('lingered');
    await page.keyboard.type('lingerd');
    await expect.poll(() => traced(page)).toBe('linger');
    await expect(page.locator('.lh-trace-diverged')).toHaveText('d');
    await expect(page.locator('.lh-manuscript .lh-ghost-trace')).toHaveCount(0);
    await expect.poll(() => suggestionStatus(page, 'sug-adapt'), { timeout: 5000 }).toBe('adapted');
    await expect(marginCard(page, 'sug-adapt').getByTestId('card-outcome')).toHaveText('Adapted');
    expect(await docText(page)).toContain('She lingerd by the window.');
  });
});

test.describe('ghost text', () => {
  test('cannot be copied: select across it, copy, check the clipboard', async ({ page }) => {
    await openDemo(page, 'seed=suggestions');
    const ghost = page.locator('.lh-manuscript .lh-ghost-insertion');
    await expect(ghost).toHaveText(' Her tea had gone cold.');
    expect(await ghost.evaluate((e) => getComputedStyle(e).userSelect)).toBe('none');
    expect(await ghost.getAttribute('aria-hidden')).toBe('true');

    // Drag a selection from the start of the paragraph to its end, across the ghost sentence.
    const p = page.locator('.lh-manuscript p').first();
    const box = (await p.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + box.width - 2, box.y + box.height - 6, { steps: 5 });
    await page.mouse.up();
    const selected = await page.evaluate(() => {
      const s = window.__ann.handle!.getState().selection;
      return s.to - s.from;
    });
    expect(selected).toBeGreaterThan(80);
    await page.keyboard.press('ControlOrMeta+C');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('by the window. Nothing moved outside.');
    expect(text).not.toContain('Her tea');
    const html = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find((i) => i.types.includes('text/html'));
      return item ? await (await item.getType('text/html')).text() : '';
    });
    expect(html).not.toContain('Her tea');

    // On a card: select across the alternatives and copy.
    const card = marginCard(page, 'sug-adopt');
    const cb = (await card.boundingBox())!;
    await page.mouse.move(cb.x + 12, cb.y + 22);
    await page.mouse.down();
    await page.mouse.move(cb.x + cb.width - 12, cb.y + cb.height - 40, { steps: 8 });
    await page.mouse.up();
    const sel = await page.evaluate(() => document.getSelection()?.toString() ?? '');
    expect(sel).not.toContain('weathered');
    await page.keyboard.press('ControlOrMeta+C');
    const fromCard = await page.evaluate(() => navigator.clipboard.readText());
    expect(fromCard).toContain('Gives the roof texture.');
    expect(fromCard).not.toContain('weathered');
    expect(fromCard).not.toContain('sagging');
    expect(await docText(page)).not.toContain('Her tea');
  });
});

test.describe('proposals', () => {
  test('accepting a move moves the text and keeps its provenance', async ({ page }) => {
    await openDemo(page, 'seed=proposals');
    const sentence = 'The town was built anyway.';
    const runOf = (text: string) =>
      page.evaluate((t) => {
        const state = window.__ann.state();
        const doc = window.__ann.handle!.getState().doc;
        let pos = -1;
        doc.descendants((n, p) => {
          if (pos < 0 && n.isText && n.text!.includes(t)) pos = p + n.text!.indexOf(t);
        });
        const run = state.documents['doc-p']!.provenance.find((r) => r.from <= pos && r.to > pos)!;
        return { class: run.class, originSeq: run.originSeq, pos };
      }, text);
    const before = await runOf(sentence);
    expect(before.class).toBe('typed');

    const card = marginCard(page, 'mv-sentence');
    await card.hover();
    await expect(page.locator('.lh-manuscript .lh-prop-source')).toHaveText(sentence);
    await expect(page.locator('.lh-manuscript .lh-prop-drop')).toHaveText('move here');
    await card.getByRole('button', { name: 'Accept' }).click();

    await expect
      .poll(() =>
        page.evaluate(() => window.__ann.state().annotations.proposals['mv-sentence']!.status),
      )
      .toBe('accepted');
    await expect
      .poll(async () => (await docText(page)).split('\n')[0])
      .toBe(
        'The town was built anyway. The river floods every spring. Nobody here remembers a dry year.',
      );
    const after = await runOf(sentence);
    expect(after.pos).toBeLessThan(before.pos);
    expect(after.class).toBe('typed');
    expect(after.originSeq).toBe(before.originSeq);
    expect(await commitTypes(page)).toContain('ProposalAccepted');
    await expect(page.locator('.lh-manuscript .lh-prop-source')).toHaveCount(0);
  });
});

test.describe('dismiss', () => {
  test('dismiss with a reason', async ({ page }) => {
    await openDemo(page, 'seed=suggestions');
    const card = marginCard(page, 'sug-dismiss');
    await card.getByRole('button', { name: 'Dismiss' }).click();
    await card.getByRole('button', { name: 'Not my voice' }).click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const c = window.__ann.transport.commits.find((x) => x.type === 'SuggestionDismissed');
          return c?.payload;
        }),
      )
      .toEqual({ targetId: 'sug-dismiss', reason: 'not-my-voice', note: null });
    await expect.poll(() => suggestionStatus(page, 'sug-dismiss')).toBe('dismissed');
    await expect(card.getByTestId('card-outcome')).toHaveText('Dismissed · not my voice');
    // Its underline is gone from the manuscript.
    await expect(page.locator('.lh-manuscript [data-ann-id="sug-dismiss"]')).toHaveCount(0);
  });
});

test.describe('feedback chat', () => {
  const chat = (page: Page) => page.getByTestId('feedback-chat');
  const messages = (page: Page) => page.getByTestId('chat-message');

  test('nothing appears until asked; a plain question gets a reply only', async ({ page }) => {
    await openDemo(page, 'seed=empty&step=120');
    await expect(page.locator('.lh-manuscript .lh-ann-mark, .lh-manuscript .lh-ghost')).toHaveCount(
      0,
    );
    await expect(page.getByTestId('annotation-margin').locator('[data-card-id]')).toHaveCount(0);
    // The persona is a dropdown; an empty chat offers the editor's questions.
    await chat(page).getByRole('combobox', { name: 'Editor' }).selectOption('editor-4');
    await chat(page)
      .getByTestId('chat-starters')
      .getByRole('button', { name: 'Where did you get confused?' })
      .click();
    const box = chat(page).getByRole('textbox', { name: 'Message Sam' });
    await expect(box).toHaveValue('Where did you get confused?');
    await box.press('Enter');
    await expect(chat(page).getByTestId('chat-working')).toContainText('Sam');
    await expect(messages(page).last()).toHaveAttribute('data-role', 'editor', { timeout: 10_000 });
    await expect(messages(page).last()).toContainText('Ask me to review it');
    await expect(page.getByTestId('annotation-margin').locator('[data-card-id]')).toHaveCount(0);
    const sent = await page.evaluate(
      () => window.__ann.transport.commits.find((c) => c.type === 'ChatMessageSent')!.payload,
    );
    expect(sent).toMatchObject({
      text: 'Where did you get confused?',
      lenses: ['clarity', 'pacing', 'character-dialogue'],
      intensity: 'light',
      editor: { id: 'editor-4', name: 'Sam' },
      context: { scope: { kind: 'document' }, aboutId: null },
    });
  });

  test('"review" leaves notes that stream in, and the reply links to them', async ({ page }) => {
    await openDemo(page, 'seed=empty&step=700');
    const box = chat(page).getByRole('textbox', { name: /Message/ });
    await box.fill('Please review this.');
    await box.press('Enter');
    const working = chat(page).getByTestId('chat-working');
    await expect(working).toContainText(/Left a note on “/, { timeout: 10_000 });
    await expect(chat(page).getByTestId('chat-stop')).toBeVisible();
    const reply = messages(page).last();
    await expect(reply).toHaveAttribute('data-role', 'editor', { timeout: 15_000 });
    const chips = reply.getByTestId('chat-reply-notes').getByRole('button');
    await expect(chips).toHaveCount(2);
    await chips.first().click();
    await expect(page.locator('.lh-margin [data-card-id].is-active')).toHaveCount(1);
  });

  test('Discuss on a card opens the chat with the note attached', async ({ page }) => {
    await openDemo(page, 'seed=suggestions&step=100');
    const card = page.getByTestId('annotation-margin').locator('[data-card-id]').first();
    await card.click();
    await card.getByRole('button', { name: 'Discuss' }).click();
    await expect(chat(page).getByTestId('chat-attach-note')).toContainText('About:');
    await expect(chat(page).getByRole('textbox', { name: /Message/ })).toBeFocused();
    await page.keyboard.type('Why this one?');
    await page.keyboard.press('Enter');
    await expect(messages(page).last()).toContainText('Fair challenge', { timeout: 10_000 });
    expect(
      await page.evaluate(() =>
        window.__ann.transport.commits.some((c) => c.type === 'DiscussRequested'),
      ),
    ).toBe(false);
  });

  test('a failed reply is calm and can be retried', async ({ page }) => {
    await openDemo(page, 'seed=empty&step=100&fail=1');
    const box = chat(page).getByRole('textbox', { name: /Message/ });
    await box.fill('Is the title working?');
    await box.press('Enter');
    const failed = chat(page).getByTestId('chat-failed');
    await expect(failed).toContainText('couldn’t reply', { timeout: 10_000 });
    await failed.getByRole('button', { name: 'Retry' }).click();
    await expect(chat(page).getByTestId('chat-failed')).toHaveCount(2, { timeout: 10_000 });
    const texts = await page.evaluate(() =>
      window.__ann.transport.commits
        .filter((c) => c.type === 'ChatMessageSent')
        .map((c) => (c.payload as { text: string }).text),
    );
    expect(texts).toEqual(['Is the title working?', 'Is the title working?']);
  });

  test('Stop cancels a running reply', async ({ page }) => {
    await openDemo(page, 'seed=empty&step=600');
    const box = chat(page).getByRole('textbox', { name: /Message/ });
    await box.fill('Please review this.');
    await box.press('Enter');
    const stop = chat(page).getByTestId('chat-stop');
    await expect(stop).toBeEnabled({ timeout: 10_000 });
    await stop.click();
    await expect(chat(page).getByTestId('chat-failed')).toContainText('cancelled', {
      timeout: 10_000,
    });
  });
});
