/**
 * One real review from the UI with the local `claude` CLI. Skipped unless
 * LONGHAND_LIVE_CLAUDE=1 (the stack then runs MODEL_ADAPTER=claude):
 *
 *   LONGHAND_LIVE_CLAUDE=1 pnpm --filter @longhand/web e2e
 *
 * A light-touch pass by the starter editor Sam (a first reader: clarity, pacing,
 * character and dialogue) over one short document (opus for a document review,
 * AGENT_MODEL_FULL to change it), with one of Sam's canned questions. It checks what must hold for any real
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

/** Sentence, block and footnote ids (`p1.s2`, `p3`, `s3`, `fn1.s1`). */
const ID_RE = /\b(?:p\d+(?:\.s\d+)?|s\d+|fn\d+(?:\.s\d+)?)\b/;

/** The prose of a payload the writer reads (not its anchors or id fields). */
function writerFacing(payload: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key: string): void => {
    if (typeof v === 'string') {
      if (PROSE.has(key)) out.push(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) if (k !== 'target' && k !== 'anchor') walk(x, k);
  };
  walk(payload, '');
  return out;
}
const PROSE = new Set([
  'body',
  'question',
  'rationale',
  'guidance',
  'purpose',
  'sentence',
  'claim',
  'alternatives',
  'summary',
  'strengths',
  'topPriorities',
]);

test.skip(process.env.LONGHAND_LIVE_CLAUDE !== '1', 'set LONGHAND_LIVE_CLAUDE=1 to run');

test('live · a real light-touch review from the UI', async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const pid = await storyProject(page, 'Live review');
  await askForFeedback(page, 'Sam', { question: 'Where did you get confused?' });
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
  // The request names Sam, and no text the writer reads contains a sentence id.
  const req = commits.find((c) => c.type === 'FeedbackRequested')!;
  expect(req.payload).toMatchObject({ editor: { name: 'Sam' }, intensity: 'light' });
  for (const c of agent) expect(JSON.stringify(writerFacing(c.payload))).not.toMatch(ID_RE);
  const cards = await marginCards(page).count();
  console.log(
    `[live] model ${(started.payload as { model: string }).model}: ${agent.length - 2} items, ${cards} margin cards`,
  );
  console.log(`[live] summary: ${await page.getByTestId('review-summary').first().innerText()}`);
});
