/**
 * The record (F6, F7, F9): replay, the authorship report, the verification
 * bundle (checked by the verifier library and on /verify) and exports.
 */
import { readFileSync } from 'node:fs';
import { computeReport } from '@longhand/report';
import type { VerificationBundle, Witness } from '@longhand/schema';
import { verifyBundle } from '@longhand/verifier';
import { unzipSync, strFromU8 } from 'fflate';
import {
  STORY,
  api,
  downloadBytes,
  expect,
  getCommits,
  ledgerText,
  manuscript,
  storyProject,
  test,
  waitSaved,
  openProvenance,
} from './helpers';

test('11 · replay scrubs back to an earlier state of the document', async ({ page }) => {
  await storyProject(page, 'Replay');
  await openProvenance(page);
  await page.getByTestId('open-replay').click();
  const view = page.getByTestId('replay-view');
  const doc = view.getByTestId('replay-doc');
  await expect(doc).toContainText(STORY[2]);
  const slider = view.getByTestId('replay-slider');
  await slider.focus();
  await page.keyboard.press('Home');
  await expect(doc).not.toContainText('Mara');
  // Step forward until some, but not all, of the text has been written.
  const full = STORY.join(' ');
  let partial = '';
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('ArrowRight');
    partial = ((await doc.textContent()) ?? '').replace(/\s+/g, ' ').trim();
    if (partial.length > 10) break;
  }
  expect(partial.length).toBeGreaterThan(10);
  expect(partial.length).toBeLessThan(full.length);
  expect(full.replace(/\s+/g, ' ').startsWith(partial)).toBe(true);
  await expect(view.getByTestId('replay-status')).toContainText('Typed');
  await page.keyboard.press('End');
  await expect(doc).toContainText(STORY[2]);
  // Back to writing with Escape.
  await page.keyboard.press('Escape');
  await expect(manuscript(page)).toBeVisible();
});

test('12 · the report shows the right numbers and the disclosure statement', async ({ page }) => {
  const pid = await storyProject(page, 'Report');
  // Four words from somewhere else.
  await page.evaluate(() => navigator.clipboard.writeText(' Ships came and went.'));
  await page.keyboard.press('ControlOrMeta+V');
  await waitSaved(page, pid, 'Ships came and went.');

  await openProvenance(page);
  await page.getByTestId('open-report').click();
  const view = page.getByTestId('report-view');
  const disclosure = view.locator('.lh-report-disclosure-text');
  await expect(disclosure).toContainText(
    '40 words: 90.0% typed directly; 10.0% pasted (1 external paste)',
    {
      timeout: 20_000,
    },
  );
  await expect(disclosure).toContainText('Written in 1 session.');
  await expect(disclosure).toContainText('No AI feedback was requested in Longhand.');

  // The page shows exactly what the report lane computes from the ledger.
  const bundle = await api<{ commits: Parameters<typeof computeReport>[0]; witnesses: Witness[] }>(
    `/v1/projects/${pid}/bundle`,
  );
  const report = computeReport(bundle.commits, {
    scope: 'project',
    witnesses: bundle.witnesses,
  });
  expect(report.words.total).toBe(40);
  expect(report.words.byClass.typed).toBe(36);
  expect(report.words.byClass['pasted-external']).toBe(4);
  expect(report.pastes.external.count).toBe(1);
  await expect(disclosure).toHaveText(report.disclosure);
  const stats = view.locator('.lh-report-stat');
  await expect(stats.filter({ hasText: 'Words' }).first()).toContainText('40');
  await expect(stats.filter({ hasText: 'Typed directly' })).toContainText('90.0%');
  await expect(view).toContainText('What this record proves');
});

test('13 · the verification bundle verifies, on /verify too, and one changed byte fails', async ({
  page,
}, testInfo) => {
  const pid = await storyProject(page, 'Bundle');
  await openProvenance(page);
  await page.getByTestId('open-report').click();
  await expect(page.getByTestId('report-view').locator('.lh-report-disclosure-text')).toBeVisible({
    timeout: 20_000,
  });
  const file = await downloadBytes(page, () => page.getByTestId('download-bundle').click());
  expect(file.name).toMatch(/\.longhand-bundle\.json$/);
  const text = new TextDecoder().decode(file.bytes);
  const bundle = JSON.parse(text) as VerificationBundle;
  expect(bundle.projectId).toBe(pid);
  expect(bundle.commits.length).toBe((await getCommits(pid)).length);

  // The open-source verifier, in this process.
  const result = await verifyBundle(bundle);
  expect(result.checks.map((c) => [c.id, c.status])).toEqual(
    result.checks.map((c) => [c.id, 'pass']),
  );
  expect(result.ok).toBe(true);
  // …against the key the service publishes.
  const key = await api<{ keyId: string }>('/.well-known/longhand-witness-key');
  expect((await verifyBundle(bundle, { expectedKeyId: key.keyId })).ok).toBe(true);

  // The standalone page, fully client-side.
  await page.goto('/verify');
  await page.getByLabel('Bundle file').setInputFiles(file.path);
  await expect(page.locator('.v-verdict-title')).toHaveText('Verified', { timeout: 20_000 });

  // One byte changed inside a typed batch (its character count): the chain no longer holds.
  const m = /"characters": (\d)/.exec(text)!;
  const at = m.index + m[0].length - 1;
  const digit = text[at] === '9' ? '8' : String(Number(text[at]) + 1);
  const tampered = `${text.slice(0, at)}${digit}${text.slice(at + 1)}`;
  expect(tampered.length).toBe(text.length);
  const bad = testInfo.outputPath('tampered.longhand-bundle.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(bad, tampered);
  expect((await verifyBundle(JSON.parse(tampered))).ok).toBe(false);
  await page.reload();
  await page.getByLabel('Bundle file').setInputFiles(bad);
  await expect(page.locator('.v-verdict-title')).toHaveText('Not verified');
  await expect(page.locator('[data-check="chain"]')).toHaveAttribute('data-status', 'fail');
});

test('14 · export to Markdown, DOCX and PDF', async ({ page }) => {
  const pid = await storyProject(page, 'Export');
  expect(await ledgerText(pid)).toBe(STORY.join('\n'));
  const exportAs = async (label: string) => {
    await openProvenance(page);
    await page.getByTestId('open-export').click();
    const dialog = page.getByTestId('export-dialog');
    await dialog.getByLabel(new RegExp(`^${label}`)).check();
    return downloadBytes(page, () => dialog.getByRole('button', { name: 'Export' }).click());
  };

  const md = await exportAs('Markdown');
  expect(md.name).toMatch(/\.md$/);
  const mdText = new TextDecoder().decode(md.bytes);
  expect(mdText).toContain('# Export');
  expect(mdText).toContain(STORY[0]);
  expect(mdText).toContain('Provenance');
  expect(mdText).toContain('typed directly');

  const docx = await exportAs('Word');
  expect(docx.name).toMatch(/\.docx$/);
  expect(docx.bytes.length).toBeGreaterThan(2000);
  const xml = strFromU8(unzipSync(docx.bytes)['word/document.xml']!);
  expect(xml).toContain('The rain fell sideways over the harbour');
  expect(xml).toContain('At dawn the bells began to ring across the water.');

  const pdf = await exportAs('PDF');
  expect(pdf.name).toMatch(/\.pdf$/);
  expect(new TextDecoder().decode(pdf.bytes.slice(0, 5))).toBe('%PDF-');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loaded = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(pdf.path)) }).promise;
  let all = '';
  for (let i = 1; i <= loaded.numPages; i++) {
    const content = await (await loaded.getPage(i)).getTextContent();
    all += content.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n';
  }
  expect(all.replace(/\s+/g, ' ')).toContain('Mara counted the boats twice.');
});
