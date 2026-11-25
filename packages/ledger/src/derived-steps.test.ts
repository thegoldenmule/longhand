/**
 * The steps the fold derives for `ProposalAccepted` (`derivedStepsFor`,
 * `applyCommitWithSteps`, `validateDraft().derivedSteps`): applied to the document
 * before the commit they give exactly the fold's document after it, and they add
 * exactly what the fold's version counter adds.
 */
import { canonicalize, schema, segmentDoc, type Commit, type CommitDraft } from '@longhand/schema';
import fc from 'fast-check';
import { Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, loadFixture } from '../fixtures/index';
import { LedgerBuilder } from './builder';
import { applyCommitWithSteps, derivedStepsFor, foldCommits, type DerivedSteps } from './fold';
import { documentNode, documentVersion } from './project';
import type { LedgerState } from './state';
import { textOf } from './test-helpers';
import { validateDraft } from './validate';

/** Checks one commit's derived steps against the fold; returns them. */
function check(before: LedgerState, commit: Commit): DerivedSteps {
  const { state: after, steps } = applyCommitWithSteps(before, commit);
  const label = `${commit.type}@${commit.seq}`;
  const p = commit.payload as { documentId?: string };
  if (commit.type === 'TextEdited') {
    expect(steps, label).toEqual({ [commit.payload.documentId]: commit.payload.steps });
  } else if (commit.type !== 'ProposalAccepted') {
    expect(steps, label).toEqual({});
  } else {
    expect(Object.keys(steps), label).toEqual([p.documentId]);
  }
  for (const [id, list] of Object.entries(steps)) {
    let doc = documentNode(before, id)!;
    for (const j of list) {
      const r = Step.fromJSON(schema, j).apply(doc);
      expect(r.failed, label).toBeNull();
      doc = r.doc!;
    }
    const folded = documentNode(after, id)!;
    expect(doc.eq(folded), label).toBe(true);
    expect(canonicalize(doc.toJSON()), label).toBe(canonicalize(folded.toJSON()));
    expect(documentVersion(after, id)! - documentVersion(before, id)!, label).toBe(list.length);
  }
  // Every document whose version moved is covered.
  for (const id of Object.keys(steps)) expect(documentNode(after, id)).toBeDefined();
  expect(derivedStepsFor(before, commit)).toEqual(steps);
  return steps;
}

function draftOf(c: Commit): CommitDraft {
  const { seq: _s, prevHash: _p, serverTime: _t, accountId: _a, hash: _h, ...draft } = c;
  return draft as CommitDraft;
}

describe('derived steps for ProposalAccepted', () => {
  it('reproduce every accepted proposal in the proposals fixture', () => {
    const { commits } = loadFixture('proposals');
    let s = foldCommits([]);
    let accepted = 0;
    for (const c of commits) {
      if (c.type === 'ProposalAccepted') {
        const steps = check(s, c);
        expect(steps[c.payload.documentId]!.length).toBeGreaterThan(0);
        // validateDraft hands back the same steps (and the same commit).
        const v = validateDraft(s, draftOf(c), c.actor, { serverTime: c.serverTime });
        expect(v.ok).toBe(true);
        if (v.ok) {
          expect(v.commit.hash).toBe(c.hash);
          expect(v.derivedSteps).toEqual(steps);
        }
        accepted++;
      }
      s = foldCommits([c], s);
    }
    expect(accepted).toBe(5);
  });

  it('match the fold for every commit of every golden fixture', () => {
    for (const name of FIXTURE_NAMES) {
      let s = foldCommits([]);
      for (const c of loadFixture(name).commits) {
        check(s, c);
        s = foldCommits([c], s);
      }
    }
  });

  it('include the joining space of a merge and of a sentence move', () => {
    const b = new LedgerBuilder({ seed: 3 });
    b.createDocument('d', 'D');
    b.type('d', 'Alpha one.\nBravo two.\nBeta two. Gamma three.');
    b.requestFeedback('r', { scope: { kind: 'project' }, intensity: 'thorough' });
    b.startReview('s', 'r');
    b.proposeMerge('s', 'm', 'd', 'p1', 'p2', 'Join.');
    b.proposeMove(
      's',
      'mv',
      { documentId: 'd', unit: 'sentence', ids: ['p3.s2'] },
      { position: 'before', id: 'p3.s1' },
      'Order.',
    );
    b.finishReview('s', 'Two.');
    for (const id of ['mv', 'm']) {
      const before = b.state;
      const at = b.commits.length;
      b.acceptProposal(id);
      const steps = check(before, b.commits[at]!);
      expect(JSON.stringify(steps)).toContain('"text":" "');
    }
    expect(textOf(b, 'd')).toBe('Alpha one. Bravo two.¶Gamma three. Beta two.');
  });

  it('validateDraft returns them (and {} for commits without text changes)', () => {
    const b = new LedgerBuilder({ seed: 4 });
    b.createDocument('d', 'D');
    b.type('d', 'One. Two.');
    const created = b.commits[1]!;
    const v = validateDraft(foldCommits(b.commits.slice(0, 1)), draftOf(created), created.actor, {
      serverTime: created.serverTime,
    });
    expect(v.ok && v.derivedSteps).toEqual({});
    const typed = b.commits.at(-1)!;
    const v2 = validateDraft(foldCommits(b.commits.slice(0, -1)), draftOf(typed), typed.actor, {
      serverTime: typed.serverTime,
    });
    expect(v2.ok && v2.derivedSteps).toEqual({
      d: (typed as Extract<Commit, { type: 'TextEdited' }>).payload.steps,
    });
  });

  it('match the fold on random documents, edits and proposals (property)', () => {
    const words = fc.constantFrom('rain', 'the', 'harbour', 'Elena', 'light', 'stone');
    const sentence = fc
      .tuple(fc.array(words, { minLength: 1, maxLength: 4 }), fc.constantFrom('.', '!', '?'))
      .map(([w, p]) => w.join(' ') + p);
    const paragraph = fc
      .tuple(fc.array(sentence, { minLength: 1, maxLength: 4 }), fc.constantFrom(' ', '', '  '))
      .map(([s, sep]) => s.join(sep));
    const frac = fc.double({ min: 0, max: 0.999, noNaN: true });
    const proposal = fc.record({ kind: fc.nat(5), a: frac, b: frac, c: frac });
    const edit = fc.record({ at: frac, text: fc.constantFrom('x', ' ', 'and ', 'so.') });
    let acceptedTotal = 0;
    fc.assert(
      fc.property(
        fc.array(paragraph, { minLength: 1, maxLength: 5 }),
        fc.array(proposal, { minLength: 1, maxLength: 6 }),
        fc.array(edit, { maxLength: 3 }),
        (paras, props, edits) => {
          const b = new LedgerBuilder({ seed: 5 });
          b.createDocument('d', 'D');
          b.type('d', paras.join('\n'));
          b.requestFeedback('r', { scope: { kind: 'project' }, intensity: 'thorough' });
          b.startReview('s', 'r');
          const ids: string[] = [];
          props.forEach((pr, n) => {
            const seg = segmentDoc(b.doc('d'));
            const blocks = seg.blocks;
            const bi = Math.floor(pr.a * blocks.length);
            const blk = blocks[bi]!;
            const sents = blk.sentences;
            const id = `p${n}`;
            try {
              if (pr.kind === 0 && sents.length > 1) {
                const i = Math.floor(pr.b * sents.length);
                const j = (i + 1 + Math.floor(pr.c * (sents.length - 1))) % sents.length;
                b.proposeMove(
                  's',
                  id,
                  { documentId: 'd', unit: 'sentence', ids: [sents[i]!.id] },
                  { position: j > i ? 'after' : 'before', id: sents[j]!.id },
                  'Order.',
                );
              } else if (pr.kind === 1 && blocks.length > 1) {
                const bj = (bi + 1 + Math.floor(pr.b * (blocks.length - 1))) % blocks.length;
                b.proposeMove(
                  's',
                  id,
                  { documentId: 'd', unit: 'paragraph', ids: [blk.id] },
                  { position: bj > bi ? 'after' : 'before', id: blocks[bj]!.id },
                  'Order.',
                );
              } else if (pr.kind === 2 && sents.length > 0) {
                const i = Math.floor(pr.b * sents.length);
                b.proposeCut(
                  's',
                  id,
                  { kind: 'span', documentId: 'd', unit: 'sentence', ids: [sents[i]!.id] },
                  'Trim.',
                );
              } else if (pr.kind === 3) {
                b.proposeCut(
                  's',
                  id,
                  { kind: 'span', documentId: 'd', unit: 'paragraph', ids: [blk.id] },
                  'Trim.',
                );
              } else if (pr.kind === 4 && sents.length > 1) {
                const i = 1 + Math.floor(pr.b * (sents.length - 1));
                b.proposeSplit('s', id, 'd', blk.id, sents[i]!.id, 'Split.');
              } else if (pr.kind === 5 && bi + 1 < blocks.length) {
                b.proposeMerge('s', id, 'd', blk.id, blocks[bi + 1]!.id, 'Merge.');
              } else return;
              ids.push(id);
            } catch (e) {
              if (!/builder:|cap-exceeded/.test((e as Error).message)) throw e;
            }
          });
          b.finishReview('s', 'Done.');
          // A few edits elsewhere (some proposals go stale), then accept every open one,
          // the first at the version the writer saw before the edits.
          const seen = b.version('d');
          for (const e of edits) {
            const n = documentNode(b.state, 'd')!;
            const blocks = segmentDoc(b.doc('d')).blocks;
            const blk = blocks[Math.floor(e.at * blocks.length)]!;
            const at = blk.contentFrom + Math.floor(e.at * (blk.contentTo - blk.contentFrom + 1));
            if (at <= n.content.size) b.type('d', e.text, { at });
          }
          let first = true;
          for (const id of ids) {
            if (b.project.annotations.proposals[id]?.status !== 'open') continue;
            const before = b.state;
            const at = b.commits.length;
            try {
              b.acceptProposal(id, first ? { baseVersion: seen } : {});
            } catch (e) {
              if (/proposal-failed|not-open/.test((e as Error).message)) continue;
              throw e;
            }
            first = false;
            const c = b.commits[at]!;
            expect(c.type).toBe('ProposalAccepted');
            check(before, c);
            acceptedTotal++;
          }
        },
      ),
      { numRuns: Number(process.env.FC_RUNS ?? 150) },
    );
    expect(acceptedTotal).toBeGreaterThan(50);
  });
});
