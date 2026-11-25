/**
 * One real review from the UI with the local `claude` CLI. Skipped unless
 * LONGHAND_LIVE_CLAUDE=1 (the stack then runs MODEL_ADAPTER=claude):
 *
 *   LONGHAND_LIVE_CLAUDE=1 pnpm --filter @longhand/web e2e
 *
 * A light-touch Clarity pass over one short document (opus for a document
 * review, AGENT_MODEL_FULL to change it). It checks what must hold for any real
 * model: the review finishes, its items are agent annotations of this session,
 * the text is exactly what the writer typed, and the invariant holds.
 */
import {
  STORY,
  askForFeedback,
  expect,
  getCommits,
  ledgerText,
  marginCards,
  storyProject,
  test,
} from './helpers';

test.skip(process.env.LONGHAND_LIVE_CLAUDE !== '1', 'set LONGHAND_LIVE_CLAUDE=1 to run');

test('live · a real light-touch review from the UI', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const pid = await storyProject(page, 'Live review');
  await askForFeedback(page, ['Clarity'], 'Light touch');
  await expect(page.getByTestId('review-summary').first()).toBeVisible({ timeout: 14 * 60_000 });

  const commits = await getCommits(pid);
  const started = commits.find((c) => c.type === 'FeedbackSessionStarted')!;
  const session = (started.payload as { feedbackSessionId: string }).feedbackSessionId;
  const agent = commits.filter((c) => c.actor.kind === 'agent');
  expect(agent.at(-1)!.type).toBe('ReviewFinished');
  for (const c of agent) expect(c.sessionId).toBe(session);
  // Light touch: at most 5 items.
  expect(
    agent.filter((c) => !['FeedbackSessionStarted', 'ReviewFinished'].includes(c.type)).length,
  ).toBeLessThanOrEqual(5);
  expect(await ledgerText(pid)).toBe(STORY.join('\n'));
  const cards = await marginCards(page).count();
  console.log(
    `[live] model ${(started.payload as { model: string }).model}: ${agent.length - 2} items, ${cards} margin cards`,
  );
  console.log(`[live] summary: ${await page.getByTestId('review-summary').first().innerText()}`);
});
