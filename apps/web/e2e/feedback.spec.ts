/**
 * The AI editor through the real service (mock reviewer), as a chat: a reply
 * with notes streaming into the margin, a reply alone, trace-over retyping,
 * proposals, dismiss, Discuss in the chat, the selection as context, history,
 * and ghost text that can't be copied.
 */
import type { Page } from '@playwright/test';
import {
  STORY,
  TEST_EDITOR,
  askForFeedback,
  expect,
  getCommits,
  getState,
  ledgerText,
  manuscript,
  marginCard,
  marginCards,
  storyProject,
  test,
  tintClassesOf,
  chatMessages,
  chatPanel,
  chooseEditor,
  waitForReply,
  openProvenance,
  tintSwitch,
} from './helpers';

async function reviewed(page: Page, title: string): Promise<string> {
  const pid = await storyProject(page, title);
  await askForFeedback(page);
  await waitForReply(page);
  await expect(marginCards(page)).toHaveCount(5);
  return pid;
}

test('4 · asking an editor: notes stream into the margin, then the reply; a plain question gets a reply only', async ({
  page,
}) => {
  const pid = await storyProject(page, 'Review');
  // Calm by default: nothing from the AI until asked.
  await expect(marginCards(page)).toHaveCount(0);
  await expect(page.getByTestId('side-panel')).toHaveCount(0);

  // "review" asks for notes (the mock's rule); the editor reads, then leaves them.
  await askForFeedback(page, TEST_EDITOR.name, { message: 'Please review this chapter.' });
  await expect(chatPanel(page).getByTestId('chat-working')).toContainText(`${TEST_EDITOR.name} is`);
  await expect(marginCards(page).first()).toBeVisible({ timeout: 20_000 });
  const whileRunning = await marginCards(page).count();
  await waitForReply(page);
  await expect(marginCards(page)).toHaveCount(5);
  expect(whileRunning).toBeLessThan(5);
  const reply = chatMessages(page).last();
  await expect(reply).toContainText(TEST_EDITOR.name);
  await expect(reply).toContainText('I left notes on the opening');
  await expect(marginCard(page, 'comment')).toContainText('This opening carries the scene');
  await expect(marginCard(page, 'question')).toContainText('What do you want the reader');
  await expect(marginCard(page, 'suggestion')).toContainText('softly');
  await expect(page.getByTestId('annotation-margin').locator('[data-kind="proposal"]')).toHaveCount(
    2,
  );
  // The reply links to its notes; a chip focuses its card.
  const chips = reply.getByTestId('chat-reply-notes').getByRole('button');
  await expect(chips).toHaveCount(5);
  await chips.nth(1).click();
  await expect(page.locator('.lh-margin [data-card-id].is-active')).toHaveCount(1);

  // A plain question: a reply, and no new notes.
  const box = chatPanel(page).getByRole('textbox', { name: `Message ${TEST_EDITOR.name}` });
  await box.fill('Is the title working?');
  await box.press('Enter');
  await expect(chatMessages(page)).toHaveCount(4, { timeout: 20_000 });
  await waitForReply(page);
  await expect(chatMessages(page).last()).toContainText('Short answer: yes');
  await expect(chatMessages(page).last().getByTestId('chat-reply-notes')).toHaveCount(0);
  await expect(marginCards(page)).toHaveCount(5);

  const commits = await getCommits(pid);
  // Each message records the editor and its configuration at that moment.
  const sent = commits.filter((c) => c.type === 'ChatMessageSent');
  expect(sent.map((c) => c.actor.kind)).toEqual(['human', 'human']);
  expect(sent[0]!.payload).toMatchObject({
    text: 'Please review this chapter.',
    lenses: TEST_EDITOR.lenses,
    intensity: TEST_EDITOR.intensity,
    editor: { name: TEST_EDITOR.name, brief: TEST_EDITOR.brief },
    context: { scope: { kind: 'document' }, aboutId: null },
  });
  expect((sent[1]!.payload as { chatId: string }).chatId).toBe(
    (sent[0]!.payload as { chatId: string }).chatId,
  );
  const agent = commits.filter((c) => c.actor.kind === 'agent');
  expect(agent.map((c) => c.type)).toEqual([
    'FeedbackSessionStarted',
    'CommentAdded',
    'QuestionAsked',
    'SuggestionProposed',
    'MoveProposed',
    'MoveProposed',
    'ChatReplied',
    'FeedbackSessionStarted',
    'ChatReplied',
  ]);
  // The replies left the text exactly as the writer typed it.
  expect(await ledgerText(pid)).toBe(STORY.join('\n'));
});

test('5 · tracing over a word-choice suggestion adopts it as typed-from-suggestion', async ({
  page,
}) => {
  const pid = await reviewed(page, 'Trace');
  const card = marginCard(page, 'suggestion');
  const id = (await card.getAttribute('data-card-id'))!;
  await card.getByRole('button', { name: 'Trace over' }).click();
  await expect(page.locator('.lh-manuscript .lh-ghost-active')).toHaveText('softly');
  await page.keyboard.type('softly', { delay: 30 });
  await expect(card.getByTestId('card-outcome')).toHaveText('Adopted · retyped', {
    timeout: 20_000,
  });
  await expect(manuscript(page)).toContainText('The rain fell softly over the harbour');

  const s = await getState(pid);
  expect(s.annotations.suggestions[id]!.status).toBe('adopted');
  const doc = Object.values(s.documents)[0]!;
  const run = doc.provenance.find((r) => r.class === 'typed-from-suggestion');
  expect(run).toMatchObject({ suggestionId: id, matchedKind: 'suggestion' });
  const commits = await getCommits(pid);
  expect(
    commits.some(
      (c) =>
        c.type === 'SuggestionResolved' &&
        c.actor.kind === 'system' &&
        (c.payload as { outcome: string }).outcome === 'adopted',
    ),
  ).toBe(true);
  const traced = commits
    .filter((c) => c.type === 'TextEdited')
    .flatMap((c) => (c.payload as { runs: Array<{ traceSuggestionId?: string }> }).runs);
  expect(traced.some((r) => r.traceSuggestionId === id)).toBe(true);

  await openProvenance(page);
  await tintSwitch(page).click();
  await expect.poll(() => tintClassesOf(page, 'softly')).toEqual(['typed-from-suggestion']);
});

test('6 · accepting a move moves the text and keeps its provenance; rejecting another', async ({
  page,
}) => {
  const pid = await reviewed(page, 'Moves');
  const before = await getState(pid);
  const doc0 = Object.values(before.documents)[0]!;
  const proposals = Object.values(before.annotations.proposals);
  const paragraphMove = proposals.find((p) => p.kind === 'move' && p.span.unit === 'paragraph')!;
  const sentenceMove = proposals.find((p) => p.id !== paragraphMove.id)!;
  // Where "At dawn…" came from, before the move.
  const startOf = (text: string, d = doc0) => {
    const full = d.content.content!.map(
      (b) => (b.content ?? []).map((t) => t.text ?? '').join('') as string,
    );
    let pos = 0;
    for (const t of full) {
      const i = t.indexOf(text);
      if (i >= 0) return pos + 1 + i;
      pos += t.length + 2;
    }
    return -1;
  };
  const runAt = (d: typeof doc0, pos: number) =>
    d.provenance.find((r) => r.from <= pos && pos < r.to)!;
  const origin = runAt(doc0, startOf('At dawn'));

  const margin = page.getByTestId('annotation-margin');
  const moveCard = margin.locator(`[data-card-id="${paragraphMove.id}"]`);
  await moveCard.getByRole('button', { name: 'Accept' }).click();
  // Resolved cards leave the margin.
  await expect(moveCard).toHaveCount(0, { timeout: 20_000 });
  await expect
    .poll(async () => (await ledgerText(pid)).split('\n')[0], { timeout: 20_000 })
    .toBe(STORY[2]);
  await expect(manuscript(page).locator('p').first()).toHaveText(STORY[2]);

  const after = await getState(pid);
  const doc1 = Object.values(after.documents)[0]!;
  const moved = runAt(doc1, startOf('At dawn', doc1));
  expect(moved.class).toBe('typed');
  expect(moved.originSeq).toBe(origin.originSeq);
  expect(moved.moves?.length).toBe(1);
  expect(after.annotations.proposals[paragraphMove.id]!.status).toBe('accepted');

  const other = margin.locator(`[data-card-id="${sentenceMove.id}"]`);
  await other.getByRole('button', { name: 'Reject' }).click();
  await other.getByRole('button', { name: 'Wrong' }).click();
  await expect
    .poll(async () => (await getState(pid)).annotations.proposals[sentenceMove.id]!.status)
    .toBe('rejected');
  const commits = await getCommits(pid);
  const accepted = commits.find((c) => c.type === 'ProposalAccepted')!;
  expect(accepted.actor.kind).toBe('human');
  const rejected = commits.find((c) => c.type === 'ProposalRejected')!;
  expect(rejected.payload).toMatchObject({ proposalId: sentenceMove.id, reason: 'wrong' });
  // Sentence order inside the second paragraph is untouched.
  expect((await ledgerText(pid)).split('\n')[2]).toBe(STORY[1]);
});

test('7 · dismissing with a reason, and Discuss asks in the chat', async ({ page }) => {
  const pid = await reviewed(page, 'Dismiss and discuss');
  const comment = marginCard(page, 'comment');
  const commentId = (await comment.getAttribute('data-card-id'))!;
  await comment.getByRole('button', { name: 'Dismiss' }).click();
  await comment.getByRole('button', { name: 'Later' }).click();
  await expect
    .poll(async () => (await getState(pid)).annotations.comments[commentId]?.status)
    .toBe('dismissed');
  const dismissed = (await getCommits(pid)).find((c) => c.type === 'SuggestionDismissed')!;
  expect(dismissed.payload).toMatchObject({ targetId: commentId, reason: 'later' });

  // Discuss goes to the chat, with the note attached.
  const question = marginCard(page, 'question');
  const questionId = (await question.getAttribute('data-card-id'))!;
  await question.getByRole('button', { name: 'Discuss' }).click();
  await expect(chatPanel(page).getByTestId('chat-attach-note')).toContainText('About: Question');
  await expect(question.locator('.lh-thread')).toHaveCount(0);
  await page.keyboard.type('Should the stakes come sooner?');
  await page.keyboard.press('Enter');
  await expect(chatMessages(page).last()).toContainText('the reader needs the stakes earlier', {
    timeout: 20_000,
  });
  const commits = await getCommits(pid);
  const ask = commits.filter((c) => c.type === 'ChatMessageSent').at(-1)!;
  expect(ask.actor.kind).toBe('human');
  expect(ask.payload).toMatchObject({ context: { aboutId: questionId } });
  expect(commits.filter((c) => c.type === 'ChatReplied').at(-1)!.actor.kind).toBe('agent');
  expect(commits.some((c) => c.type === 'DiscussRequested')).toBe(false);
  // The answer lives in the annotation layer only.
  expect(await ledgerText(pid)).not.toContain('stakes');
});

test('18 · the chat: the selection as context, a new chat from a canned question, history', async ({
  page,
}) => {
  const pid = await storyProject(page, 'Chat');
  // Select the first paragraph, then ask: the selection is attached as a quoted chip.
  await manuscript(page).getByText('nobody came to the door').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await page.keyboard.press(process.platform === 'darwin' ? 'Shift+Meta+ArrowRight' : 'Shift+End');
  await page.getByTestId('ask-feedback').click();
  const chip = chatPanel(page).getByTestId('chat-attach-selection');
  await expect(chip).toContainText('The rain fell sideways');
  const box = chatPanel(page).getByRole('textbox', { name: /^Message/ });
  await expect(box).toBeFocused();
  await page.keyboard.type('Is this line too long?');
  await page.keyboard.press('Enter');
  await waitForReply(page);
  await expect(chatMessages(page).first()).toContainText('“The rain fell sideways');
  const first = (await getCommits(pid)).find((c) => c.type === 'ChatMessageSent')!;
  expect(first.payload).toMatchObject({ context: { scope: { kind: 'selection' } } });

  // New chat: an empty chat offers the editor's questions; one tap fills the composer.
  await chatPanel(page).getByRole('button', { name: 'New chat' }).click();
  await expect(chatMessages(page)).toHaveCount(0);
  await chooseEditor(page, TEST_EDITOR.name);
  await chatPanel(page)
    .getByTestId('chat-starters')
    .getByRole('button', { name: TEST_EDITOR.questions[0]! })
    .click();
  await expect(box).toHaveValue(TEST_EDITOR.questions[0]!);
  await box.press('Enter');
  await waitForReply(page);
  const chats = (await getCommits(pid))
    .filter((c) => c.type === 'ChatMessageSent')
    .map((c) => (c.payload as { chatId: string }).chatId);
  expect(new Set(chats).size).toBe(2);

  // History lists both; reopening the first shows its conversation.
  await chatPanel(page).getByRole('button', { name: 'History' }).click();
  const history = chatPanel(page).getByRole('navigation', { name: 'Chat history' });
  await expect(history.getByRole('button')).toHaveCount(2);
  await history.getByRole('button', { name: /Is this line too long/ }).click();
  await expect(chatMessages(page).first()).toContainText('Is this line too long?');
  // The chat panel is locked to the viewport: only the messages scroll.
  const panelBox = await page.getByTestId('side-panel').boundingBox();
  const vh = page.viewportSize()!.height;
  expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(vh + 1);
  await expect(chatPanel(page).getByTestId('chat-composer')).toBeInViewport();
});

test('8 · ghost text cannot be selected or copied', async ({ page }) => {
  const pid = await reviewed(page, 'Ghost');
  const card = marginCard(page, 'suggestion');
  await card.click();
  const ghost = page.locator('.lh-manuscript .lh-ghost-alt').first();
  await expect(ghost).toHaveText('softly');
  expect(await ghost.evaluate((e) => getComputedStyle(e).userSelect)).toBe('none');
  expect(await ghost.getAttribute('aria-hidden')).toBe('true');

  // Select the whole first paragraph, across the inline ghost, with the pointer
  // resting on the suggestion (so the ghost stays up), and copy.
  await page.locator('.lh-manuscript .lh-ann-suggestion').first().hover();
  await manuscript(page).focus();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await page.keyboard.press(process.platform === 'darwin' ? 'Shift+Meta+ArrowRight' : 'Shift+End');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(ghost).toBeVisible();
  expect(await page.evaluate(() => document.getSelection()?.toString() ?? '')).toContain(
    'over the harbour',
  );
  await page.keyboard.press('ControlOrMeta+C');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('over the harbour');
  expect(text).not.toContain('softly');
  const html = await page.evaluate(async () => {
    const items = await navigator.clipboard.read();
    const item = items.find((i) => i.types.includes('text/html'));
    return item ? await (await item.getType('text/html')).text() : '';
  });
  expect(html).not.toContain('softly');

  // Selecting across the card's alternatives copies none of them.
  const cb = (await card.boundingBox())!;
  await page.mouse.move(cb.x + 10, cb.y + 12);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width - 10, cb.y + cb.height - 30, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('ControlOrMeta+C');
  const fromCard = await page.evaluate(() => navigator.clipboard.readText());
  expect(fromCard).not.toContain('softly');
  expect(fromCard).not.toContain('steadily');
  expect(await ledgerText(pid)).not.toContain('softly');
});
