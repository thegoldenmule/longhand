/**
 * Reports for every golden fixture. The expected outputs are committed under
 * `snapshots/` so a reviewer can read them: one JSON file per fixture (the
 * project report and one report per document) and `disclosures.txt` with every
 * disclosure statement. Run `pnpm --filter @longhand/report test -u` after an
 * intended change and review the diff.
 */
import { FIXTURE_NAMES, loadFixture } from '@longhand/ledger/fixtures';
import { AuthorshipReportSchema, PROVES_TABLE, canonicalize } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { computeReport, foldForReport, sessionsFrom } from './compute';
import { prettyJson } from './test-helpers';

const disclosures: string[] = [];

describe.each(FIXTURE_NAMES)('fixture %s', (name) => {
  const f = loadFixture(name);
  const project = computeReport(f.commits, { scope: 'project', witnesses: f.witnesses });
  const docIds = Object.keys(f.expected.state.documents).sort();
  const documents = Object.fromEntries(
    docIds.map((id) => [
      id,
      computeReport(f.commits, { scope: { documentId: id }, witnesses: f.witnesses }),
    ]),
  );
  disclosures.push(
    `# ${name} (project)\n${project.disclosure}\n`,
    ...docIds.map((id) => `# ${name} / ${id}\n${documents[id]!.disclosure}\n`),
  );

  it('matches the committed snapshot', async () => {
    const text = await prettyJson({ project, documents }, `../snapshots/${name}.json`);
    await expect(text).toMatchFileSnapshot(`../snapshots/${name}.json`);
  });

  it('is a valid AuthorshipReport', () => {
    for (const r of [project, ...Object.values(documents)]) {
      const parsed = AuthorshipReportSchema.safeParse(r);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it('counts words with the shared attribution rule', () => {
    expect(project.words).toEqual(f.expected.projectWords);
    expect(project.characters).toEqual(f.expected.projectCharacters);
    for (const id of docIds) {
      expect(documents[id]!.words, id).toEqual(f.expected.documents[id]!.wordsByClass);
      expect(documents[id]!.characters, id).toEqual(f.expected.documents[id]!.charactersByClass);
    }
  });

  it('rebuilds the fold’s writing sessions from the ledger', () => {
    const { entries } = foldForReport(f.commits);
    expect(sessionsFrom(entries)).toEqual(f.expected.state.writingSessions);
    expect(project.sessions.count).toBe(f.expected.state.writingSessions.length);
  });

  it('prints the proves table verbatim', () => {
    expect(project.provesTable).toEqual({
      proves: [...PROVES_TABLE.proves],
      doesNotProve: [...PROVES_TABLE.doesNotProve],
    });
  });

  it('records the head and has no unwitnessed intervals (fixtures are all on time)', () => {
    expect(project.throughSeq).toBe(f.expected.headSeq);
    expect(project.headHash).toBe(f.expected.headHash);
    expect(project.unwitnessed).toEqual([]);
  });

  it('is deterministic (recomputing from parsed JSON gives identical canonical JSON)', () => {
    const again = computeReport(JSON.parse(JSON.stringify(f.commits)), {
      scope: { kind: 'project' },
      witnesses: JSON.parse(JSON.stringify(f.witnesses)),
    });
    expect(canonicalize(again)).toBe(canonicalize(project));
  });

  it('splits process figures by document without losing any', () => {
    const sum = (pick: (r: typeof project) => number) =>
      Object.values(documents).reduce((n, r) => n + pick(r), 0);
    expect(sum((r) => r.activeWritingMs)).toBe(project.activeWritingMs);
    expect(sum((r) => r.pastes.events.length)).toBe(project.pastes.events.length);
    expect(sum((r) => r.suggestions.total)).toBe(project.suggestions.total);
    expect(sum((r) => r.proposals.total)).toBe(project.proposals.total);
    expect(sum((r) => r.imports.documents)).toBe(project.imports.documents);
    expect(sum((r) => r.sessions.list.reduce((n, s) => n + s.charactersInserted, 0))).toBe(
      project.sessions.list.reduce((n, s) => n + s.charactersInserted, 0),
    );
  });
});

describe('disclosures', () => {
  it('match the committed list', async () => {
    await expect(disclosures.join('\n')).toMatchFileSnapshot('../snapshots/disclosures.txt');
  });
});
