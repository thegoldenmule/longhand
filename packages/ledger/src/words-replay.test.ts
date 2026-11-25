import { canonicalize, schema, type ProvenanceRun } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, loadFixture } from '../fixtures/index';
import { LedgerBuilder } from './builder';
import { applyCommit, foldCommits } from './fold';
import { projectState } from './project';
import { Replay, spanHistory, stateAtSeq } from './replay';
import { attributeWords, charactersByClass, projectWordsByClass, wordsByClass } from './words';

describe('attributeWords', () => {
  const doc = schema.nodes.doc!.create(null, [
    schema.nodes.paragraph!.create(null, [
      schema.text('typed mixword pasted'),
      schema.nodes.footnote!.create(null, schema.text('note here')),
    ]),
  ]);
  // positions: "typed " 1-7, "mixword " 7-15 ("mix" typed, "word" pasted), "pasted" 15-21, footnote 21..
  const runs: ProvenanceRun[] = [
    { from: 1, to: 10, class: 'typed', originSeq: 2 },
    { from: 10, to: 21, class: 'pasted-external', originSeq: 3 },
    { from: 22, to: 26, class: 'imported', originSeq: 1 },
    { from: 26, to: 31, class: 'typed-from-suggestion', originSeq: 4, suggestionId: 's1' },
  ];

  it('gives a mixed word its least trusted class and counts footnotes as their own block', () => {
    const words = attributeWords(doc, runs);
    expect(words.map((w) => [w.text, w.class, w.blockId])).toEqual([
      ['typed', 'typed', 'p1'],
      ['mixword', 'pasted-external', 'p1'],
      ['pasted', 'pasted-external', 'p1'],
      ['note', 'imported', 'fn1'],
      ['here', 'typed-from-suggestion', 'fn1'],
    ]);
    expect(words[1]!.originSeqs).toEqual([2, 3]);
    expect(words[4]!.suggestionIds).toEqual(['s1']);
  });

  it('counts words and characters by class', () => {
    expect(wordsByClass(doc, runs)).toEqual({
      total: 5,
      byClass: { typed: 1, 'typed-from-suggestion': 1, 'pasted-external': 2, 'pasted-internal': 0, imported: 1, quoted: 0 },
    });
    const chars = charactersByClass(doc.toJSON(), runs);
    expect(chars.total).toBe(29);
    expect(chars.byClass.typed).toBe(9);
  });

  it('never overclaims text with no run', () => {
    expect(wordsByClass(doc, []).byClass['pasted-external']).toBe(5);
  });

  it('matches the fixtures', () => {
    const f = loadFixture('external-paste');
    const ps = f.expected.state;
    expect(projectWordsByClass(ps)).toEqual(f.expected.projectWords);
  });
});

describe('replay', () => {
  it('stateAtSeq equals folding the prefix, for every seq of every fixture', () => {
    for (const name of FIXTURE_NAMES) {
      const commits = loadFixture(name).commits;
      const r = new Replay(commits, { snapshotEvery: 4 });
      r.head();
      for (let seq = 0; seq <= commits.length; seq += 3) {
        const a = canonicalize(projectState(r.stateAt(seq)));
        const b = canonicalize(projectState(foldCommits(commits.slice(0, seq))));
        expect(a, `${name}@${seq}`).toBe(b);
      }
      expect(canonicalize(projectState(stateAtSeq(commits, commits.length)))).toBe(canonicalize(loadFixture(name).expected.state));
    }
  });

  it('older states are unaffected by later commits (structural sharing is safe)', () => {
    const commits = loadFixture('suggestions').commits;
    const mid = foldCommits(commits.slice(0, 15));
    const before = canonicalize(projectState(mid));
    let s = mid;
    for (const c of commits.slice(15)) s = applyCommit(s, c);
    applyCommit(mid, commits[15]!);
    expect(canonicalize(projectState(mid))).toBe(before);
  });

  it('rejects out-of-range seqs', () => {
    const r = new Replay(loadFixture('ime').commits);
    expect(() => r.stateAt(-1)).toThrow(RangeError);
    expect(() => r.stateAt(999)).toThrow(RangeError);
  });
});

describe('spanHistory', () => {
  it('reports origin, session, visible suggestions and moves', () => {
    const b = new LedgerBuilder();
    b.createDocument('d', 'Doc');
    b.type('d', 'Alpha one. Beta two.');
    const typed = b.head.seq;
    b.requestFeedback('r', { scope: { kind: 'document', documentId: 'd' } });
    b.startReview('s', 'r');
    b.suggestWordChoice('s', 'w', { documentId: 'd', sentenceId: 'p1.s1', quote: 'one' }, ['first'], 'r');
    b.proposeMove('s', 'm', { documentId: 'd', unit: 'sentence', ids: ['p1.s2'] }, { position: 'before', id: 'p1.s1' }, 'r');
    b.finishReview('s', 'ok');
    b.typeOver('d', b.pos('d', { before: 'one' }), b.pos('d', { after: 'one' }), 'first');
    b.acceptProposal('m');
    const h = spanHistory(b.state, 'd', b.pos('d', { before: 'Beta' }))!;
    expect(h.origin).toMatchObject({ seq: typed, type: 'TextEdited', editorSessionId: 'editor-1', methods: ['typed'], writingSessionIndex: 0 });
    expect(h.moves).toEqual([expect.objectContaining({ seq: b.head.seq, kind: 'move', proposalId: 'm' })]);
    const h2 = spanHistory(b.state, 'd', b.pos('d', { before: 'first' }))!;
    expect(h2.run.class).toBe('typed-from-suggestion');
    expect(h2.matched).toEqual({ id: 'w', group: 'suggestions' });
    expect(h2.visibleSuggestions.map((v) => v.id)).toEqual(['w']);
    expect(spanHistory(b.state, 'd', 0)).toBeNull();
    expect(spanHistory(b.state, 'nope', 1)).toBeNull();
  });
});

describe('writing sessions', () => {
  it('split on 30-minute gaps of clientTime', () => {
    const s = loadFixture('novel').expected.state.writingSessions;
    expect(s).toHaveLength(3);
    expect(s.map((x) => x.index)).toEqual([0, 1, 2]);
    for (const x of s) expect(x.activeMs).toBeGreaterThan(0);
    expect(s[2]!.documentIds).toEqual(['doc-2']);
  });
});
