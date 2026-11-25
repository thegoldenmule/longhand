/** Research (F8): a source added by hand, cited, a clipping placed, the bibliography. */
import {
  expect,
  getCommits,
  getState,
  manuscript,
  newProject,
  test,
  tintClassesOf,
  typeParagraphs,
  waitSaved,
  openProvenance,
  tintSwitch,
} from './helpers';

test('10 · research: add a source by hand, cite it, place a clipping, see the bibliography', async ({
  page,
}) => {
  const pid = await newProject(page, 'Harbour history');
  const claim = 'Harbours shaped the first cities of the coast.';
  await typeParagraphs(page, [claim]);
  await waitSaved(page, pid, claim);

  await page.getByTestId('toggle-panel').click();
  await page.getByTestId('tab-research').click();
  const pane = page.getByTestId('research-pane');
  await pane.getByRole('button', { name: 'Enter a source by hand' }).click();
  await pane.getByLabel('Type').selectOption('book');
  await pane.getByLabel('Title', { exact: true }).fill('Rainfall Records of the Upper Valley');
  await pane.getByLabel('Authors').fill('Okafor, Nnamdi');
  await pane.getByLabel('Date').fill('2014');
  await pane.getByLabel('Publisher', { exact: true }).fill('Valley Press');
  await pane.getByRole('button', { name: 'Add to library' }).click();
  await expect(pane.getByRole('region', { name: 'Library' })).toContainText(
    'Rainfall Records of the Upper Valley',
  );
  await expect.poll(async () => Object.keys((await getState(pid)).sources).length).toBe(1);
  const sourceId = Object.keys((await getState(pid)).sources)[0]!;

  // Cite at the end of the claim.
  await manuscript(page).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await pane.getByTestId('cite-button').click();
  const picker = page.getByRole('form', { name: 'Cite a source' });
  await picker.getByRole('radio').first().check();
  await picker.getByLabel('Page or location').fill('p. 12');
  await expect(picker.locator('output')).toHaveText('(Okafor, 2014, p. 12)');
  await picker.getByRole('button', { name: 'Insert citation' }).click();
  await expect(manuscript(page).locator('span[data-citation]')).toHaveCount(1);
  await expect
    .poll(async () => (await getCommits(pid)).some((c) => c.type === 'CitationInserted'))
    .toBe(true);

  // Save a clipping and place it as a quote block.
  await pane.getByTestId('research-tab-clippings').click();
  await pane.getByRole('button', { name: 'Save a quote…' }).click();
  await pane
    .getByRole('textbox', { name: 'Quote' })
    .fill('The valley flooded every seventh spring.');
  await pane.getByLabel('Location').fill('p. 40');
  await pane.getByRole('button', { name: 'Save quote' }).click();
  await expect(pane).toContainText('The valley flooded every seventh spring.');
  await manuscript(page).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await pane.getByRole('button', { name: 'Place in manuscript' }).click();
  await expect(manuscript(page).locator('blockquote[data-quote-block]')).toContainText(
    'The valley flooded every seventh spring.',
  );
  await expect
    .poll(async () => {
      const s = await getState(pid);
      const doc = Object.values(s.documents)[0]!;
      return [...new Set(doc.provenance.map((r) => r.class))].sort();
    })
    .toEqual(['quoted', 'typed']);
  await openProvenance(page);
  await tintSwitch(page).click();
  await expect.poll(() => tintClassesOf(page, 'flooded every seventh')).toEqual(['quoted']);
  await page.getByTestId('tab-research').click();

  // The bibliography lists the cited source.
  await pane.getByTestId('research-tab-bibliography').click();
  const bib = pane.getByTestId('bibliography');
  await expect(bib).toContainText('Works cited');
  await expect(bib).toContainText(
    'Okafor, N. (2014). Rainfall Records of the Upper Valley. Valley Press.',
  );
  const s = await getState(pid);
  expect(s.sources[sourceId]!.csl.title).toBe('Rainfall Records of the Upper Valley');
  const clippings = Object.values(s.clippings);
  expect(clippings).toHaveLength(1);
  expect(clippings[0]!.sourceId).toBe(sourceId);
});
