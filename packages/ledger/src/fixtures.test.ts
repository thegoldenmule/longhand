import { canonicalize, checkProvenanceRuns, CommitSchema, docFromJSON } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { TAMPER_DEFINITIONS } from '../fixtures/definitions';
import { buildFixture, buildTampered, plain } from '../fixtures/generate';
import {
  FIXTURE_NAMES,
  TAMPERED_FIXTURE_NAMES,
  loadFixture,
  loadFixtureWitnessKey,
  loadTamperedFixture,
} from '../fixtures/index';
import { verifyChain, verifyWitnesses } from './chain';
import { foldCommits } from './fold';
import { foldIssues, projectState } from './project';

const REGEN = 'run `pnpm --filter @longhand/ledger fixtures` to regenerate';

describe('golden fixtures', () => {
  it('cover what other lanes need', () => {
    const covers = new Set(FIXTURE_NAMES.flatMap((n) => loadFixture(n).covers));
    for (const tag of [
      'typed',
      'ime',
      'pasted-external',
      'pasted-internal',
      'history',
      'imported',
      'comments',
      'questions',
      'finish-review',
      'adopted',
      'adapted',
      'stale',
      'dismissed',
      'insertion',
      'rephrase',
      'move',
      'cut',
      'split',
      'merge',
      'accepted',
      'rejected',
      'discuss',
      'sources',
      'quote-block',
      'citation',
      'cited',
      'folders',
      'folder-synopsis',
      'reorder',
      'archive',
      'notes',
      'multi-document',
    ]) {
      expect(covers.has(tag), tag).toBe(true);
    }
    expect(
      Object.keys(loadFixture('novel').expected.state.documents).length,
    ).toBeGreaterThanOrEqual(3);
  });

  for (const name of FIXTURE_NAMES) {
    describe(name, () => {
      const file = loadFixture(name);

      it(`is current (${REGEN})`, () => {
        const built = buildFixture(name);
        expect(canonicalize(built.commits), 'commits').toBe(canonicalize(file.commits));
        expect(canonicalize(built.expected), 'expected outputs').toBe(canonicalize(file.expected));
      });

      it('is a valid, witnessed chain', async () => {
        for (const c of file.commits)
          expect(CommitSchema.safeParse(c).success, `seq ${c.seq}`).toBe(true);
        expect(verifyChain(file.commits).ok).toBe(true);
        const key = loadFixtureWitnessKey();
        expect(file.publicKeyPem).toBe(key.publicKeyPem);
        const w = await verifyWitnesses(file.commits, file.witnesses, file.publicKeyPem);
        expect(w.problems).toEqual([]);
        expect(w.witnessed).toHaveLength(file.commits.length);
      });

      it('folds to the expected state with canonical provenance and no issues', () => {
        const state = foldCommits(file.commits);
        expect(foldIssues(state)).toEqual([]);
        const ps = plain(projectState(state));
        expect(canonicalize(ps)).toBe(canonicalize(file.expected.state));
        for (const d of Object.values(ps.documents)) {
          expect(checkProvenanceRuns(docFromJSON(d.content), d.provenance), d.id).toBeNull();
          for (const r of d.provenance) expect(r.class).not.toBe('pasted-internal');
        }
      });
    });
  }
});

describe('tampered fixtures', () => {
  it('cover every tamper type', () => {
    expect([...TAMPERED_FIXTURE_NAMES].sort()).toEqual(
      [
        'tampered-actor',
        'tampered-dropped',
        'tampered-edited',
        'tampered-reordered',
        'tampered-rehashed',
        'tampered-truncated',
      ].sort(),
    );
  });

  for (const name of TAMPERED_FIXTURE_NAMES) {
    it(`${name} is current and fails verification precisely`, async () => {
      const file = loadTamperedFixture(name);
      const rebuilt = await buildTampered(name, loadFixture(TAMPER_DEFINITIONS[name]!.base));
      expect(canonicalize(rebuilt), REGEN).toBe(canonicalize(file));
      const chain = verifyChain(file.commits);
      const withHead = verifyChain(file.commits, { expectedHead: file.trueHead });
      expect(withHead.ok, 'chain + expected head').toBe(false);
      if (chain.ok) {
        const w = await verifyWitnesses(file.commits as never, file.witnesses, file.publicKeyPem);
        expect(w.ok).toBe(false);
      }
    });
  }

  it('report the exact problems', () => {
    const codes = (n: string) =>
      loadTamperedFixture(n).expected.chain.problems.map((p) => `${p.code}@${p.seq}`);
    expect(codes('tampered-edited')).toEqual(['hash-mismatch@4']);
    expect(codes('tampered-rehashed')).toEqual(['prev-hash-mismatch@5']);
    expect(codes('tampered-dropped')).toEqual(['seq-gap@6', 'prev-hash-mismatch@6']);
    expect(codes('tampered-reordered')).toEqual([
      'seq-gap@6',
      'prev-hash-mismatch@6',
      'seq-out-of-order@5',
      'prev-hash-mismatch@5',
      'prev-hash-mismatch@7',
    ]);
    expect(codes('tampered-actor')).toEqual(['invalid-commit@9', 'prev-hash-mismatch@10']);
    const t = loadTamperedFixture('tampered-truncated');
    expect(t.expected.chain.ok).toBe(true);
    expect(t.expected.chainWithHead.problems.map((p) => p.code)).toEqual(['head-mismatch']);
    expect(t.expected.witnesses?.problems.map((p) => p.code)).toEqual([
      'extra-witness',
      'extra-witness',
    ]);
  });
});
