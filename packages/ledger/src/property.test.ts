/**
 * Property tests (fast-check): random interleavings of human edits and agent
 * events, built with the LedgerBuilder (so every commit passes validateDraft).
 *
 * (a) no agent or system commit changes manuscript text;
 * (b) every manuscript character traces to a human input commit;
 * (c) the fold is deterministic, and folding a prefix then the rest equals the whole;
 * (d) any single-commit tamper breaks verifyChain.
 */
import {
  canonicalize,
  checkProvenanceRuns,
  docFromJSON,
  segmentDoc,
  type Commit,
} from '@longhand/schema';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LedgerBuilder } from './builder';
import { verifyChain } from './chain';
import { foldCommits } from './fold';
import { documentNode, foldIssues, projectState } from './project';
import { stateAtSeq } from './replay';

const DOCS = ['d1', 'd2'];
const words = fc.constantFrom('rain', 'the', 'harbour', 'stone', 'quiet', 'Elena', 'ran', 'and', 'light', 'over');
const phrase = fc.array(words, { minLength: 1, maxLength: 6 }).map((w) => w.join(' '));
const frac = fc.double({ min: 0, max: 0.999, noNaN: true });

type Cmd =
  | { k: 'type'; doc: number; at: number; text: string; sentence: boolean }
  | { k: 'enter'; doc: number; at: number }
  | { k: 'delete'; doc: number; at: number; len: number }
  | { k: 'paste'; doc: number; at: number; text: string }
  | { k: 'copyPaste'; doc: number; at: number; len: number; to: number; dst: number }
  | { k: 'undo' }
  | { k: 'review' }
  | { k: 'comment'; doc: number; s: number }
  | { k: 'wordChoice'; doc: number; s: number; alt: string }
  | { k: 'proposal'; doc: number; kind: number; a: number; b: number }
  | { k: 'retype'; pick: number }
  | { k: 'resolve'; pick: number; how: number }
  | { k: 'finish' };

const cmd: fc.Arbitrary<Cmd> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ k: fc.constant('type' as const), doc: fc.nat(1), at: frac, text: phrase, sentence: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('enter' as const), doc: fc.nat(1), at: frac }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('delete' as const), doc: fc.nat(1), at: frac, len: fc.integer({ min: 1, max: 8 }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('paste' as const), doc: fc.nat(1), at: frac, text: phrase }) },
  {
    weight: 2,
    arbitrary: fc.record({ k: fc.constant('copyPaste' as const), doc: fc.nat(1), at: frac, len: fc.integer({ min: 1, max: 12 }), to: frac, dst: fc.nat(1) }),
  },
  { weight: 1, arbitrary: fc.constant({ k: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ k: 'review' as const }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('comment' as const), doc: fc.nat(1), s: frac }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('wordChoice' as const), doc: fc.nat(1), s: frac, alt: words }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant('proposal' as const), doc: fc.nat(1), kind: fc.nat(3), a: frac, b: frac }) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant('retype' as const), pick: frac }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant('resolve' as const), pick: frac, how: fc.nat(2) }) },
  { weight: 1, arbitrary: fc.constant({ k: 'finish' as const }) },
);

/** Errors that mean "this random command does not apply here", not a bug. */
const SKIPPABLE = /cap-exceeded|not-open|nothing to undo|builder: (No |The |Destination|.* is not|.* are not|text )/;

function textPos(b: LedgerBuilder, doc: string, f: number): number {
  const blocks = segmentDoc(b.doc(doc)).blocks;
  const blk = blocks[Math.floor(f * blocks.length)]!;
  return blk.contentFrom + Math.floor(f * 997) % (blk.contentTo - blk.contentFrom + 1);
}

function run(cmds: Cmd[]): LedgerBuilder {
  const b = new LedgerBuilder({ seed: 9 });
  for (const d of DOCS) b.createDocument(d, d);
  b.type('d1', 'Rain fell on the harbour. Elena waited.\nThe light went out. Nobody came.');
  b.type('d2', 'Stone and quiet.\nOver the harbour.');
  b.requestFeedback('r0', { scope: { kind: 'project' }, intensity: 'thorough' });
  b.startReview('s0', 'r0');
  let session: string | null = 's0';
  let n = 0;
  for (const c of cmds) {
    n++;
    const doc = 'doc' in c ? DOCS[c.doc]! : 'd1';
    try {
      switch (c.k) {
        case 'type':
          b.type(doc, c.sentence ? ` ${c.text}.` : c.text, { at: textPos(b, doc, c.at) });
          break;
        case 'enter':
          b.enter(doc, { at: textPos(b, doc, c.at) });
          break;
        case 'delete': {
          const from = textPos(b, doc, c.at);
          const $f = b.doc(doc).resolve(from);
          const to = Math.min(from + c.len, $f.end());
          if (to > from) b.deleteRange(doc, from, to);
          break;
        }
        case 'paste':
          b.pasteExternal(doc, c.text, { at: textPos(b, doc, c.at) });
          break;
        case 'copyPaste': {
          const from = textPos(b, doc, c.at);
          const to = Math.min(from + c.len, b.doc(doc).resolve(from).end());
          if (to <= from) break;
          const id = b.copy(doc, from, to);
          b.pasteInternal(DOCS[c.dst]!, id, { at: textPos(b, DOCS[c.dst]!, c.to) });
          break;
        }
        case 'undo':
          b.undo();
          break;
        case 'review':
          if (session) break;
          session = `s${n}`;
          b.requestFeedback(`r${n}`, { scope: { kind: 'project' }, intensity: 'thorough' });
          b.startReview(session, `r${n}`);
          break;
        case 'finish':
          if (!session) break;
          b.finishReview(session, 'Done for now.');
          session = null;
          break;
        case 'comment':
        case 'wordChoice': {
          if (!session) break;
          const sents = segmentDoc(b.doc(doc)).sentences.filter((s) => s.text.length > 0);
          if (sents.length === 0) break;
          const s = sents[Math.floor(c.s * sents.length)]!;
          const quote = s.text.split(' ')[0]!;
          if (!quote.trim()) break;
          if (c.k === 'comment') {
            b.comment(session, `c${n}`, { kind: 'anchor', documentId: doc, sentenceId: s.id, quote, occurrence: 0 }, `Look again at the harbour light and ${quote}.`);
          } else {
            b.suggestWordChoice(session, `w${n}`, { documentId: doc, sentenceId: s.id, quote, occurrence: 0 }, [c.alt], 'Try this.');
          }
          break;
        }
        case 'proposal': {
          if (!session) break;
          const seg = segmentDoc(b.doc(doc));
          const blocks = seg.blocks;
          const bi = Math.floor(c.a * blocks.length);
          const blk = blocks[bi]!;
          if (c.kind === 0 && blocks.length > 1) {
            const bj = (bi + 1 + Math.floor(c.b * (blocks.length - 1))) % blocks.length;
            const position = bj > bi ? 'after' : 'before';
            b.proposeMove(session, `p${n}`, { documentId: doc, unit: 'paragraph', ids: [blk.id] }, { position, id: blocks[bj]!.id }, 'Order.');
          } else if (c.kind === 0 && blk.sentences.length > 1) {
            b.proposeMove(session, `p${n}`, { documentId: doc, unit: 'sentence', ids: [blk.sentences.at(-1)!.id] }, { position: 'before', id: blk.sentences[0]!.id }, 'Order.');
          } else if (c.kind === 1 && blk.sentences.length > 0) {
            b.proposeCut(session, `p${n}`, { kind: 'span', documentId: doc, unit: 'sentence', ids: [blk.sentences[0]!.id] }, 'Trim.');
          } else if (c.kind === 2 && blk.sentences.length > 1) {
            b.proposeSplit(session, `p${n}`, doc, blk.id, blk.sentences[1]!.id, 'Split.');
          } else if (c.kind === 3 && bi + 1 < blocks.length) {
            b.proposeMerge(session, `p${n}`, doc, blk.id, blocks[bi + 1]!.id, 'Merge.');
          }
          break;
        }
        case 'retype': {
          const open = Object.values(b.project.annotations.suggestions).filter((s) => s.status === 'open' && s.kind === 'word-choice' && s.range);
          if (open.length === 0) break;
          const s = open[Math.floor(c.pick * open.length)]!;
          if (s.kind !== 'word-choice' || !s.range) break;
          b.typeOver(s.anchor.documentId, s.range.from, s.range.to, s.alternatives[0]!);
          break;
        }
        case 'resolve': {
          const props = Object.values(b.project.annotations.proposals).filter((p) => p.status === 'open');
          const sugs = Object.values(b.project.annotations.suggestions).filter((s) => s.status === 'open');
          if (c.how < 2 && props.length > 0) {
            const p = props[Math.floor(c.pick * props.length)]!;
            if (c.how === 0) b.acceptProposal(p.id);
            else b.rejectProposal(p.id, 'later');
          } else if (sugs.length > 0) {
            b.dismiss(sugs[Math.floor(c.pick * sugs.length)]!.id, 'wrong');
          }
          break;
        }
      }
    } catch (e) {
      if (!SKIPPABLE.test((e as Error).message)) throw e;
      if (process.env.FC_DEBUG) console.log('skip', c.k, (e as Error).message.slice(0, 100));
    }
  }
  return b;
}

const MANUSCRIPT = new Set(['TextEdited', 'ProposalAccepted', 'DocumentImported']);
const settings = { numRuns: Number(process.env.FC_RUNS ?? 40) };

describe('fold invariants (property)', () => {
  it('(a) no agent or system event changes manuscript text; (b) every character traces to a human input event', () => {
    fc.assert(
      fc.property(fc.array(cmd, { minLength: 5, maxLength: 40 }), (cmds) => {
        const b = run(cmds);
        const commits = b.commits;
        if (process.env.FC_DEBUG) console.log('types', commits.map((x) => x.type).join(' '));
        let s = foldCommits(commits.slice(0, 1));
        const contents = (ids: readonly string[]) => ids.map((d) => canonicalize(documentNode(s, d)!.toJSON()));
        for (const c of commits.slice(1)) {
          const existing = DOCS.filter((d) => documentNode(s, d) !== undefined);
          const before = contents(existing);
          s = foldCommits([c], s);
          if (!MANUSCRIPT.has(c.type)) expect(contents(existing), `${c.type}@${c.seq}`).toEqual(before);
          if (c.actor.kind !== 'human') expect(MANUSCRIPT.has(c.type)).toBe(false);
        }
        expect(foldIssues(s)).toEqual([]);
        const ps = projectState(s);
        for (const d of Object.values(ps.documents)) {
          expect(checkProvenanceRuns(docFromJSON(d.content), d.provenance)).toBeNull();
          for (const r of d.provenance) {
            const origin = commits[r.originSeq - 1]!;
            expect(origin.actor.kind).toBe('human');
            expect(MANUSCRIPT.has(origin.type), `${r.class} from ${origin.type}`).toBe(true);
            for (const m of r.moves ?? []) expect(commits[m - 1]!.actor.kind).toBe('human');
          }
        }
      }),
      settings,
    );
  });

  it('(c) the fold is deterministic and composes with stateAtSeq', () => {
    fc.assert(
      fc.property(fc.array(cmd, { minLength: 5, maxLength: 30 }), frac, (cmds, cut) => {
        const commits = JSON.parse(JSON.stringify(run(cmds).commits)) as Commit[];
        const whole = canonicalize(projectState(foldCommits(commits)));
        expect(canonicalize(projectState(foldCommits(commits)))).toBe(whole);
        const k = Math.floor(cut * commits.length);
        const resumed = foldCommits(commits.slice(k), stateAtSeq(commits, k));
        expect(canonicalize(projectState(resumed))).toBe(whole);
      }),
      settings,
    );
  });

  it('(d) any single-commit tamper breaks verifyChain', () => {
    const commits = run([
      { k: 'type', doc: 0, at: 0.5, text: 'quiet stone', sentence: true },
      { k: 'review' },
      { k: 'comment', doc: 0, s: 0.1 },
      { k: 'paste', doc: 1, at: 0, text: 'over the light' },
      { k: 'finish' },
    ]).commits;
    const mutations: Array<(c: Record<string, unknown>) => void> = [
      (c) => (c.clientTime = '2020-01-01T00:00:00.000Z'),
      (c) => (c.serverTime = '2020-01-01T00:00:00.000Z'),
      (c) => (c.deviceId = 'evil'),
      (c) => (c.sessionId = 'evil'),
      (c) => ((c.actor as { id: string }).id = 'evil'),
      (c) => (c.commitId = 'evil'),
      (c) => (c.payload = { ...(c.payload as object), injected: 'x' }),
      (c) => (c.seq = (c.seq as number) + 1),
      (c) => (c.prevHash = 'f'.repeat(64)),
      (c) => (c.hash = 'e'.repeat(64)),
    ];
    fc.assert(
      fc.property(fc.nat(commits.length - 1), fc.nat(mutations.length - 1), (i, m) => {
        const cs = JSON.parse(JSON.stringify(commits)) as Array<Record<string, unknown>>;
        mutations[m]!(cs[i]!);
        expect(verifyChain(cs).ok).toBe(false);
      }),
      { numRuns: 200 },
    );
    fc.assert(
      fc.property(fc.nat(commits.length - 2), fc.boolean(), (i, swap) => {
        const cs = JSON.parse(JSON.stringify(commits)) as unknown[];
        if (swap) [cs[i], cs[i + 1]] = [cs[i + 1], cs[i]];
        else cs.splice(i, 1);
        expect(verifyChain(cs).ok).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
