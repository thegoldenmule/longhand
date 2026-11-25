/**
 * Golden fixture definitions. Each is a hand-written builder script; the JSON files
 * next to this one are generated from them by `pnpm --filter @longhand/ledger
 * fixtures` (scripts/build-fixtures.ts), and `fixtures.test.ts` asserts the files
 * are current.
 */
import { computeCommitHash, schema, type Commit } from '@longhand/schema';
import { existsSync, readFileSync } from 'node:fs';
import { LedgerBuilder } from '../src/builder';

/** Signatures for embedded `ChainHeadWitnessed` events, written by the build script. */
export const EMBEDDED_WITNESSES_URL = new URL('./embedded-witnesses.json', import.meta.url);

/** Key of an embedded witness subject. */
export function embeddedKey(s: {
  projectId: string;
  seq: number;
  hash: string;
  serverTime: string;
}): string {
  return `${s.projectId}:${s.seq}:${s.hash}:${s.serverTime}`;
}

function embeddedSignature(s: {
  projectId: string;
  seq: number;
  hash: string;
  serverTime: string;
}): {
  signature: string;
  keyId: string;
} {
  const all: Record<string, { signature: string; keyId: string }> = existsSync(
    EMBEDDED_WITNESSES_URL,
  )
    ? JSON.parse(readFileSync(EMBEDDED_WITNESSES_URL, 'utf8'))
    : {};
  return all[embeddedKey(s)] ?? { signature: 'A'.repeat(86) + '==', keyId: '0'.repeat(64) };
}

/** A fixture definition. */
export interface FixtureDefinition {
  description: string;
  /** What the fixture exercises (free-form tags). */
  covers: string[];
  build: () => LedgerBuilder;
}

const csl = {
  okafor: {
    type: 'article-journal',
    title: 'Rainfall Records of the Upper Valley, 1900–2010',
    author: [{ family: 'Okafor', given: 'Nnamdi' }],
    'container-title': 'Journal of Regional Climate',
    issued: { 'date-parts': [[2014]] },
    volume: 12,
    page: '101-129',
    DOI: '10.1000/jrc.2014.012',
  },
  lindqvist: {
    type: 'book',
    title: 'Farming the Flood Plain',
    author: [{ family: 'Lindqvist', given: 'Maja' }],
    publisher: 'Northfield Press',
    issued: { 'date-parts': [[2009]] },
    ISBN: '9780000000017',
  },
};

function plainTyping(): LedgerBuilder {
  const b = new LedgerBuilder({
    title: 'Morning Pages',
    seed: 11,
    start: '2026-11-02T07:30:00.000Z',
  });
  b.createDocument('doc-pages', 'November 2');
  b.type(
    'doc-pages',
    'The kettle took forever this morning. I stood at the counter and watched the steam.',
  );
  b.backspace('doc-pages', 6);
  b.type('doc-pages', 'window fog over.');
  b.enter('doc-pages');
  b.type(
    'doc-pages',
    'Today I want to finish the chapter about the flood. It has been sitting there for a week.',
  );
  // Fix a typo in the middle: "forever" -> "ages".
  const f = b.pos('doc-pages', { before: 'forever' });
  b.typeOver('doc-pages', f, f + 'forever'.length, 'ages');
  // Emphasis on "finish" and a heading at the top.
  const e = b.pos('doc-pages', { before: 'finish' });
  b.format('doc-pages', (tr) => tr.addMark(e, e + 'finish'.length, schema.marks.em!.create()));
  b.wait(4000);
  b.type('doc-pages', 'Morning\n', { at: 1 });
  b.format('doc-pages', (tr) => tr.setBlockType(1, 1, schema.nodes.heading!, { level: 2 }));
  return b;
}

function ime(): LedgerBuilder {
  const b = new LedgerBuilder({ title: '日記', seed: 12, start: '2026-11-03T12:00:00.000Z' });
  b.createDocument('doc-ime', 'Kyoto notes');
  b.type('doc-ime', 'Arrived in Kyoto. The sign said ');
  b.compose('doc-ime', ['き', 'きょ', 'きょう', 'きょうと', '京都']);
  b.type('doc-ime', ' and nothing else. ');
  b.compose('doc-ime', ['あ', 'あめ', '雨']);
  b.type('doc-ime', ' all afternoon.');
  return b;
}

function externalPaste(): LedgerBuilder {
  const b = new LedgerBuilder({ title: 'Essay draft', seed: 13 });
  b.createDocument('doc-essay', 'On walking');
  b.type('doc-essay', 'Walking is how I think. ');
  b.pasteExternal('doc-essay', 'Solvitur ambulando, as the saying goes.');
  b.type('doc-essay', ' I have never solved anything sitting down.');
  b.enter('doc-essay');
  b.pasteExternal(
    'doc-essay',
    'First pasted paragraph from my notes app.\nSecond pasted paragraph.',
  );
  // Paste over a typed selection.
  const f = b.pos('doc-essay', { before: 'anything' });
  b.pasteExternal('doc-essay', 'a single thing', { replace: [f, f + 'anything'.length] });
  // A typed word inside a pasted span stays typed; the word around it mixes classes.
  b.type('doc-essay', 'XX', { at: { after: 'Solvitur ambu' } });
  b.backspace('doc-essay', 2, { at: { after: 'Solvitur ambuXX' } });
  return b;
}

function internalPaste(): LedgerBuilder {
  const b = new LedgerBuilder({ title: 'Copy and paste', seed: 14 });
  b.createDocument('doc-a', 'Scene A');
  b.createDocument('doc-b', 'Scene B');
  b.type('doc-a', 'The ferry left at dawn. Nobody waved. ');
  b.pasteExternal('doc-a', 'Gulls followed the wake.');
  b.type('doc-b', 'Later, she remembered: ');
  // Copy typed text from A, paste into B: inherits typed + originSeq.
  let f = b.pos('doc-a', { before: 'The ferry' });
  const c1 = b.copy('doc-a', f, f + 'The ferry left at dawn.'.length);
  b.pasteInternal('doc-b', c1);
  // Copy a span containing pasted-external text: the paste keeps its class.
  f = b.pos('doc-a', { before: 'Nobody' });
  const c2 = b.copy('doc-a', f, b.pos('doc-a', { after: 'Gulls followed' }));
  b.type('doc-b', ' ');
  b.pasteInternal('doc-b', c2);
  // Cut and paste within A (a move by clipboard).
  f = b.pos('doc-a', { before: 'Nobody waved. ' });
  const c3 = b.copy('doc-a', f, f + 'Nobody waved. '.length, { cut: true });
  b.type('doc-a', ' ');
  b.pasteInternal('doc-a', c3, { at: 'end' });
  // Copy, then edit the source before pasting: the snapshot still matches the clipboard.
  f = b.pos('doc-b', { before: 'Later' });
  const c4 = b.copy('doc-b', f, f + 'Later'.length);
  b.typeOver('doc-b', f, f + 'Later'.length, 'Years later');
  b.enter('doc-b');
  b.pasteInternal('doc-b', c4);
  // A forged internal paste (clipboard content that does not match the copy) is downgraded.
  const c5 = b.copy('doc-a', 1, 4);
  b.pasteInternal('doc-b', c5, { slice: b.doc('doc-a').slice(5, 10) });
  // Drag a word within B (drop-internal keeps provenance).
  const w = b.pos('doc-b', { before: 'remembered' });
  b.drop('doc-b', w, w + 'remembered'.length, b.pos('doc-b', 'end'));
  return b;
}

function undoPaste(): LedgerBuilder {
  const b = new LedgerBuilder({ title: 'Undo', seed: 15 });
  b.createDocument('doc-u', 'Draft');
  b.type('doc-u', 'I meant to write this myself. ');
  b.pasteExternal('doc-u', 'But here is a borrowed sentence.');
  b.undo(); // removes the paste
  b.redo(); // the paste comes back: still pasted-external, never typed
  b.undo(); // and goes again
  b.type('doc-u', 'So I wrote my own ending.');
  b.backspace('doc-u', 'ending.'.length);
  b.undo(); // restores typed text from the tombstone
  // A history run that re-inserts text that was never deleted cannot launder it.
  b.edit('doc-u', [
    {
      run: { method: 'history' },
      build: (tr) => tr.insert(b.pos('doc-u', 'end'), schema.text(' Words nobody typed.')),
      keys: [{ kind: 'undo', len: 0, dt: 0 }],
    },
  ]);
  return b;
}

function importDoc(): LedgerBuilder {
  const b = new LedgerBuilder({ title: 'Imported novel', seed: 16 });
  b.importDocument(
    'doc-old',
    'Chapter one (old draft)',
    'Marta kept the shop open late on Thursdays.\n\nThe bell over the door had been broken for years.',
    { sourceName: 'chapter-one.md' },
  );
  b.type('doc-old', ' Nobody fixed it.', { at: { after: 'for years.' } });
  // Retyping the last letter of an imported word: the word mixes imported and typed
  // characters and is attributed to the least trusted class (imported).
  b.backspace('doc-old', 1, { at: { after: 'Thursdays' } });
  b.type('doc-old', 's', { at: { after: 'Thursday' } });
  b.type('doc-old', ' and Fridays', { at: { after: 'Thursdays' } });
  return b;
}

function feedbackSession(): LedgerBuilder {
  const b = new LedgerBuilder({ title: 'The Lighthouse Keeper', seed: 17 });
  b.createDocument('doc-ch1', 'Chapter 1');
  b.type(
    'doc-ch1',
    'The lighthouse had been dark for three winters. Elena climbed the stairs anyway, counting each one.\nAt the top she found the lamp, cracked and furred with salt. She sat down beside it and waited for the light to come back.',
  );
  b.requestFeedback('req-1', {
    scope: { kind: 'document', documentId: 'doc-ch1' },
    lenses: ['pacing', 'clarity', 'character-dialogue'],
    intensity: 'standard',
    ask: 'Is the opening too slow?',
  });
  b.startReview('fs-1', 'req-1');
  b.comment(
    'fs-1',
    'com-1',
    { kind: 'anchor', documentId: 'doc-ch1', sentenceId: 'p1.s2', quote: 'counting each one' },
    'Counting is a good habit for her; it shows nerves without saying so.',
    { category: 'character-dialogue', severity: 'minor' },
  );
  b.comment(
    'fs-1',
    'com-2',
    { kind: 'span', documentId: 'doc-ch1', unit: 'paragraph', ids: ['p2'] },
    'This paragraph carries the turn; consider letting it breathe with one more beat before she sits.',
    { category: 'pacing', severity: 'moderate' },
  );
  b.question(
    'fs-1',
    'q-1',
    'Why has the lighthouse been dark for three winters, and does Elena know?',
    { documentId: 'doc-ch1', sentenceId: 'p1.s1', quote: 'three winters' },
  );
  b.question('fs-1', 'q-2', 'Who is the story for: readers who know the coast, or newcomers?');
  b.finishReview(
    'fs-1',
    'A quiet, confident opening. The pace suits the mood; the question is what Elena wants.',
    ['Concrete sensory detail', 'Restraint'],
    ['Clarify what Elena wants from the lamp', 'Plant the reason the light failed'],
  );
  b.wait(60_000);
  b.dismiss('com-1', 'later', 'Will revisit after chapter 2.');
  b.type('doc-ch1', ' She wanted to know who had let it fail.', {
    at: { after: 'counting each one.' },
  });
  // A second request whose session fails.
  b.requestFeedback('req-2', {
    scope: {
      kind: 'selection',
      documentId: 'doc-ch1',
      from: 1,
      to: 20,
      version: b.version('doc-ch1'),
    },
    lenses: ['word-choice'],
    intensity: 'light',
  });
  b.startReview('fs-2', 'req-2', 'sonnet');
  b.system('FeedbackSessionFailed', {
    feedbackSessionId: 'fs-2',
    requestId: 'req-2',
    threadId: null,
    reason: 'model timeout',
  });
  // The selection scope of req-2 is mapped through later edits.
  b.type('doc-ch1', 'Night. ', { at: 1 });
  return b;
}

function suggestions(): LedgerBuilder {
  const b = new LedgerBuilder({ title: 'Storm Season', seed: 18 });
  b.createDocument('doc-s', 'Storm');
  b.type(
    'doc-s',
    'The rain fell on the old roof. She waited by the window. Nothing moved outside. The lane was empty and the hedges were black.',
  );
  b.requestFeedback('req-s', {
    scope: { kind: 'document', documentId: 'doc-s' },
    lenses: ['word-choice', 'tone-voice'],
    intensity: 'thorough',
  });
  const readVersion = b.version('doc-s');
  b.startReview('fs-s', 'req-s');
  b.suggestWordChoice(
    'fs-s',
    'sug-adopt',
    { documentId: 'doc-s', sentenceId: 'p1.s1', quote: 'old' },
    ['weathered', 'sagging'],
    'Gives the roof texture.',
  );
  b.suggestWordChoice(
    'fs-s',
    'sug-adapt',
    { documentId: 'doc-s', sentenceId: 'p1.s2', quote: 'waited' },
    ['lingered'],
    'Slows the beat.',
  );
  b.suggestWordChoice(
    'fs-s',
    'sug-stale',
    { documentId: 'doc-s', sentenceId: 'p1.s3', quote: 'moved' },
    ['stirred'],
    'Quieter verb.',
  );
  b.suggestWordChoice(
    'fs-s',
    'sug-dismiss',
    { documentId: 'doc-s', sentenceId: 'p1.s1', quote: 'roof' },
    ['eaves'],
    'More specific.',
  );
  b.suggestInsertion(
    'fs-s',
    'sug-insert',
    { documentId: 'doc-s', position: 'after', sentenceId: 'p1.s2' },
    'Her tea had gone cold.',
    'Show time passing.',
  );
  b.suggestRephrase(
    'fs-s',
    'sug-rephrase',
    { documentId: 'doc-s', sentenceId: 'p1.s4', quote: 'the hedges were black' },
    'Name what makes the hedges black: shadow, rain or night.',
  );
  b.comment(
    'fs-s',
    'com-s',
    { kind: 'anchor', documentId: 'doc-s', sentenceId: 'p1.s4', quote: 'The lane was empty' },
    'Consider ending on a sound: the gutters overflowing into the lane.',
    { category: 'tone-voice', severity: 'minor' },
  );
  b.finishReview(
    'fs-s',
    'Atmospheric; a few verbs could work harder.',
    ['Mood'],
    ['Sharpen verbs'],
  );
  // Meanwhile the writer edited the last sentence; a suggestion resolved against the
  // version the agent read is stale on arrival.
  b.type('doc-s', ' Somewhere a dog barked.', { at: 'end' });
  b.requestFeedback('req-s2', {
    scope: { kind: 'document', documentId: 'doc-s' },
    lenses: ['word-choice'],
    intensity: 'light',
  });
  b.startReview('fs-s2', 'req-s2', 'sonnet');
  b.typeOver(
    'doc-s',
    b.pos('doc-s', { before: 'empty' }),
    b.pos('doc-s', { after: 'empty' }),
    'deserted',
  );
  b.suggestWordChoice(
    'fs-s2',
    'sug-arrival',
    {
      documentId: 'doc-s',
      sentenceId: 'p1.s4',
      quote: 'empty',
      readVersion: b.version('doc-s') - 'deserted'.length,
    },
    ['bare'],
    'Plainer.',
  );
  b.finishReview('fs-s2', 'One small note.');
  void readVersion;
  // Adopted: retyped exactly over the anchor.
  b.typeOver(
    'doc-s',
    b.pos('doc-s', { before: 'old' }),
    b.pos('doc-s', { after: 'old' }),
    'weathered',
  );
  // Adapted: trace-over typing that diverged.
  b.typeOver(
    'doc-s',
    b.pos('doc-s', { before: 'waited' }),
    b.pos('doc-s', { after: 'waited' }),
    'lingerd',
    { traceSuggestionId: 'sug-adapt' },
  );
  // Stale: the anchored word was edited away.
  b.deleteText('doc-s', ' moved');
  // Dismissed.
  b.dismiss('sug-dismiss', 'not-my-voice', null);
  // Insertion retyped at its point.
  b.type('doc-s', ' Her tea had gone cold.', { at: { after: 'window.' } });
  // Rephrase hint: the writer edits inside the span.
  b.typeOver(
    'doc-s',
    b.pos('doc-s', { before: 'black' }),
    b.pos('doc-s', { after: 'black' }),
    'dark with rain',
  );
  // Four-word rule: typing words from the comment body.
  b.type('doc-s', ' The gutters were overflowing into the lane.', { at: 'end' });
  return b;
}

function proposals(): LedgerBuilder {
  const b = new LedgerBuilder({ title: 'Field Notes', seed: 19 });
  b.createDocument('doc-p', 'Essay');
  b.type(
    'doc-p',
    'The river floods every spring. Nobody here remembers a dry year. The town was built anyway.\nFarmers moved uphill after 1952. Their old fields became marsh.\nThe church still stands. Its bell rings for every flood.\nIn the end, the river decides.',
  );
  b.requestFeedback('req-p', {
    scope: { kind: 'document', documentId: 'doc-p' },
    lenses: ['structure'],
    intensity: 'thorough',
  });
  b.startReview('fs-p', 'req-p');
  b.proposeMove(
    'fs-p',
    'mv-sentence',
    { documentId: 'doc-p', unit: 'sentence', ids: ['p1.s3'] },
    { position: 'before', id: 'p1.s1' },
    'Open with the stubbornness.',
  );
  b.proposeCut(
    'fs-p',
    'cut-anchor',
    { kind: 'anchor', documentId: 'doc-p', sentenceId: 'p1.s2', quote: ' here' },
    'Implied.',
  );
  b.proposeSplit('fs-p', 'split-1', 'doc-p', 'p2', 'p2.s2', 'The marsh deserves its own beat.');
  b.proposeMerge(
    'fs-p',
    'merge-rejected',
    'doc-p',
    'p3',
    'p4',
    'The ending belongs with the bell.',
  );
  b.proposeMove(
    'fs-p',
    'mv-paragraph',
    { documentId: 'doc-p', unit: 'paragraph', ids: ['p3'] },
    { position: 'before', id: 'p2' },
    'The church is the anchor; bring it forward.',
  );
  b.proposeCut(
    'fs-p',
    'cut-rejected',
    { kind: 'span', documentId: 'doc-p', unit: 'sentence', ids: ['p3.s2'] },
    'Sentimental.',
  );
  b.proposeMerge('fs-p', 'merge-stale', 'doc-p', 'p1', 'p2', 'Same idea.');
  b.finishReview(
    'fs-p',
    'Strong material; the order can do more work.',
    ['Specific dates'],
    ['Lead with the town', 'Group the church and the ending'],
  );
  b.acceptProposal('mv-sentence');
  b.acceptProposal('cut-anchor');
  b.rejectProposal('merge-rejected', 'wrong');
  b.acceptProposal('split-1');
  b.acceptProposal('mv-paragraph');
  b.rejectProposal('cut-rejected', 'not-my-voice');
  // A second session: merge two paragraphs, accepted.
  b.requestFeedback('req-p2', {
    scope: { kind: 'document', documentId: 'doc-p' },
    lenses: ['structure'],
    intensity: 'light',
  });
  b.startReview('fs-p2', 'req-p2');
  b.proposeMerge(
    'fs-p2',
    'merge-1',
    'doc-p',
    'p3',
    'p4',
    'The marsh line finishes the farmers thought.',
  );
  b.finishReview('fs-p2', 'One merge.');
  // The writer keeps typing elsewhere, then accepts from the card they saw earlier:
  // ProposalAccepted at an older baseVersion uses the proposal's mapped positions.
  const seen = b.version('doc-p');
  b.type('doc-p', 'Every year ', { at: 1 });
  b.acceptProposal('merge-1', { baseVersion: seen });
  return b;
}

function discuss(): LedgerBuilder {
  const b = new LedgerBuilder({ title: 'Discuss', seed: 20 });
  b.createDocument('doc-d', 'Letter');
  b.type(
    'doc-d',
    'Dear Tom, the garden is ruined but the roses survived. I think of you when I prune them.',
  );
  b.requestFeedback('req-d', {
    scope: { kind: 'document', documentId: 'doc-d' },
    lenses: ['word-choice'],
    intensity: 'light',
  });
  b.startReview('fs-d', 'req-d');
  b.suggestWordChoice(
    'fs-d',
    'sug-d',
    { documentId: 'doc-d', sentenceId: 'p1.s1', quote: 'ruined' },
    ['wrecked', 'gone to seed'],
    'Ruined sounds final; the roses contradict it.',
  );
  b.finishReview('fs-d', 'Warm and direct.');
  b.discuss('thr-1', 'sug-d', 'Why not keep ruined? It is how it felt.');
  b.startDiscuss('fs-d2', 'thr-1');
  b.answerDiscussion(
    'fs-d2',
    'thr-1',
    'sug-d',
    'Keep it if the feeling matters more than accuracy; the roses then read as a small surprise.',
  );
  b.discuss('thr-1', 'sug-d', 'And gone to seed?');
  b.startDiscuss('fs-d3', 'thr-1');
  b.system('FeedbackSessionFailed', {
    feedbackSessionId: 'fs-d3',
    requestId: null,
    threadId: 'thr-1',
    reason: 'model unavailable',
  });
  b.dismiss('sug-d', 'not-my-voice', 'Keeping ruined.');
  return b;
}

function research(): LedgerBuilder {
  const b = new LedgerBuilder({ title: 'The Wet Valley', seed: 21 });
  b.createDocument('doc-r', 'Essay');
  b.type(
    'doc-r',
    'Rainfall in the valley doubled between 1950 and 2000. Farmers adapted slowly, and some never did.',
  );
  b.addSource('src-okafor', csl.okafor, { kind: 'doi', value: '10.1000/jrc.2014.012' });
  b.saveClipping(
    'clip-1',
    'src-okafor',
    'Annual totals rose from 610 mm to 1,240 mm.\nThe change was steady rather than sudden.',
    'p. 114',
  );
  b.saveClipping('clip-2', 'src-okafor', 'No single year accounts for the trend.', 'p. 117');
  b.saveClipping('clip-3', 'src-okafor', 'Wet years cluster.\n\nDry years do not.', 'p. 120');
  b.requestFeedback('req-r', {
    scope: { kind: 'document', documentId: 'doc-r' },
    lenses: ['claims-citations'],
    intensity: 'standard',
  });
  b.startReview('fs-r', 'req-r');
  b.flagCitationNeeded(
    'fs-r',
    'flag-1',
    {
      documentId: 'doc-r',
      sentenceId: 'p1.s1',
      quote: 'Rainfall in the valley doubled between 1950 and 2000',
    },
    'Valley rainfall doubled from 1950 to 2000.',
  );
  b.flagCitationNeeded(
    'fs-r',
    'flag-2',
    { documentId: 'doc-r', sentenceId: 'p1.s2', quote: 'some never did' },
    'Some farmers never adapted.',
  );
  b.surfaceSources(
    'fs-r',
    'surf-1',
    'farmers adaptation flood plain',
    [
      {
        csl: { ...csl.lindqvist, id: 'cand-1' },
        provider: 'openlibrary',
        url: 'https://openlibrary.org/isbn/9780000000017',
      },
      {
        csl: { id: 'cand-2', type: 'webpage', title: 'Flood farming forum thread' },
        provider: 'web',
        url: 'https://example.org/thread',
      },
    ],
    { documentId: 'doc-r', sentenceId: 'p1.s2', quote: 'some never did' },
  );
  b.suggestSource(
    'fs-r',
    'ss-1',
    { documentId: 'doc-r', sentenceId: 'p1.s1', quote: 'doubled' },
    'src-okafor',
    'Table 3 gives the annual totals.',
  );
  b.finishReview('fs-r', 'Two claims need support.', [], ['Cite the rainfall figure']);
  // The writer verifies a surfaced candidate and adds it.
  b.addSource(
    'src-lindqvist',
    csl.lindqvist,
    { kind: 'isbn', value: '9780000000017' },
    { surfacedId: 'surf-1', candidateIndex: 0 },
  );
  b.human('SourceUpdated', { sourceId: 'src-lindqvist', note: 'Library copy, chapter 4.' });
  // Cite: the flag becomes cited.
  b.cite('doc-r', 'src-okafor', 'p. 114', { at: { after: '2000' } });
  // Place a clipping as a quote block (quoted).
  b.placeClipping('doc-r', 'clip-1');
  // Blank lines are collapsed on both sides before comparing: still quoted.
  b.placeClipping('doc-r', 'clip-3', { text: 'Wet years cluster.\nDry years do not.' });
  // A clipping run whose text does not match the clipping is downgraded.
  b.placeClipping('doc-r', 'clip-2', { text: 'No single year accounts for it.' });
  b.dismiss('ss-1', 'later', null);
  b.human('ClippingRemoved', { clippingId: 'clip-2' });
  return b;
}

function binder(): LedgerBuilder {
  const b = new LedgerBuilder({ title: 'Binder', seed: 22 });
  b.createFolder('f-part1', 'Part One');
  b.createFolder('f-ch1', 'Chapter 1', { parentId: 'f-part1' });
  b.createFolder('f-ch2', 'Chapter 2', { parentId: 'f-part1' });
  b.createDocument('doc-s1', 'Scene 1', { parentId: 'f-ch1' });
  b.createDocument('doc-s2', 'Scene 2', { parentId: 'f-ch1' });
  b.createDocument('doc-s3', 'Scene 3', { parentId: 'f-ch2' });
  b.createFolder('f-part2', 'Part Two');
  b.createFolder('f-chars', 'Characters', { area: 'notes' });
  b.createDocument('note-elena', 'Elena', { kind: 'note', parentId: 'f-chars' });
  b.createDocument('note-outline', 'Outline', { kind: 'note', index: 0 });
  b.type('note-elena', 'Forty-one. Keeps lists. Afraid of heights but climbs anyway.');
  b.type('doc-s1', 'She arrived on the last ferry.');
  b.human('SynopsisEdited', { documentId: 'doc-s1', synopsis: 'Elena arrives on the island.' });
  b.human('DocumentRenamed', { documentId: 'doc-s2', title: 'Scene 2: The keeper' });
  // Reorder within a folder, then move across folders.
  b.human('DocumentMoved', { documentId: 'doc-s2', parentId: 'f-ch1', index: 0 });
  b.human('DocumentMoved', { documentId: 'doc-s3', parentId: 'f-ch1', index: 1 });
  // Nest Chapter 2 under Part Two, rename, archive and restore.
  b.human('FolderMoved', { folderId: 'f-ch2', parentId: 'f-part2', index: 0 });
  b.human('FolderRenamed', { folderId: 'f-ch2', title: 'Chapter 2 (draft)' });
  b.human('FolderArchived', { folderId: 'f-part2', archived: true });
  // The fold accepts moves into an archived folder (the UI refuses them).
  b.human('DocumentMoved', { documentId: 'doc-s2', parentId: 'f-part2', index: 1 });
  b.human('FolderArchived', { folderId: 'f-part2', archived: false });
  b.human('DocumentArchived', { documentId: 'doc-s1', archived: true });
  b.human('DocumentArchived', { documentId: 'doc-s1', archived: false });
  b.human('DocumentArchived', { documentId: 'doc-s3', archived: true });
  // Move Part Two before Part One.
  b.human('FolderMoved', { folderId: 'f-part2', parentId: null, index: 0 });
  // Ids are unique per collection: a folder and a document may share one.
  b.createFolder('shared-id', 'Drafts', { parentId: 'f-part1' });
  b.createDocument('shared-id', 'Draft scene', { parentId: 'shared-id' });
  b.human('ProjectSettingsChanged', {
    patch: { genre: 'literary fiction', audience: 'adult readers', dailyWordGoal: 750 },
  });
  // Folder synopses, edited twice; a folder synopsis never touches a document sharing its id.
  b.human('SynopsisEdited', { folderId: 'f-ch1', synopsis: 'Elena reaches the island.' });
  b.human('SynopsisEdited', {
    folderId: 'f-ch1',
    synopsis: 'Elena reaches the island and meets the keeper.',
  });
  b.human('SynopsisEdited', { folderId: 'shared-id', synopsis: 'Scenes not yet placed.' });
  return b;
}

function novel(): LedgerBuilder {
  const b = new LedgerBuilder({
    title: 'Salt and Iron',
    seed: 23,
    start: '2026-11-05T20:00:00.000Z',
  });
  b.createFolder('f-book', 'Book One');
  b.createDocument('doc-1', 'The Harbour', { parentId: 'f-book' });
  b.createDocument('doc-2', 'The Foundry', { parentId: 'f-book' });
  b.createDocument('doc-3', 'The Storm', { parentId: 'f-book' });
  b.createDocument('note-style', 'Style guide', { kind: 'note' });
  b.type('note-style', 'Short sentences in the storm. No adverbs in dialogue tags.');
  b.type('doc-1', 'Iron came in by sea and left as nails. Josef counted the crates twice.');
  b.type('doc-2', 'The foundry ran all night. Its windows glowed like a stove.');
  b.wait(45 * 60_000); // a new writing session
  b.type('doc-3', 'The storm came in from the west. It took the pier first.');
  b.type('doc-1', ' The harbourmaster did not trust him.');
  const cp = b.copy(
    'doc-2',
    b.pos('doc-2', { before: 'Its windows' }),
    b.pos('doc-2', { after: 'stove.' }),
  );
  b.type('doc-3', ' ');
  b.pasteInternal('doc-3', cp);
  b.requestFeedback('req-n', {
    scope: { kind: 'project' },
    lenses: ['structure', 'pacing'],
    intensity: 'light',
  });
  b.startReview('fs-n', 'req-n');
  b.comment(
    'fs-n',
    'com-n',
    { kind: 'span', documentId: 'doc-3', unit: 'sentence', ids: ['p1.s3'] },
    'This echo of the foundry is deliberate? It reads as a repeat.',
    { category: 'structure' },
  );
  b.suggestWordChoice(
    'fs-n',
    'sug-n',
    { documentId: 'doc-1', sentenceId: 'p1.s2', quote: 'counted' },
    ['checked'],
    'Counted is fine; checked is colder.',
  );
  b.finishReview(
    'fs-n',
    'Three strong openings; link them.',
    ['Images'],
    ['Connect the foundry and the storm'],
  );
  b.wait(26 * 3600_000); // next day
  b.newEditorSession('editor-2', 'device-2');
  b.type('doc-2', ' Josef slept beside the furnace.');
  b.dismiss('sug-n', 'not-my-voice', null);
  // Embed the witness of an earlier commit in the chain itself.
  const w = b.commits[9]!;
  const sig = embeddedSignature({
    projectId: w.projectId,
    seq: w.seq,
    hash: w.hash,
    serverTime: w.serverTime,
  });
  b.system('ChainHeadWitnessed', {
    witnessedSeq: w.seq,
    witnessedHash: w.hash,
    serverTime: w.serverTime,
    signature: sig.signature,
    keyId: sig.keyId,
  });
  return b;
}

/** Every golden fixture, by name. */
export const FIXTURE_DEFINITIONS: Readonly<Record<string, FixtureDefinition>> = {
  'plain-typing': {
    description:
      'One document typed in batches with backspaces, a typo fixed by typing over it, an emphasis mark and a heading added later.',
    covers: ['typed', 'backspace', 'type-over', 'marks', 'heading', 'writing-sessions'],
    build: plainTyping,
  },
  ime: {
    description: 'Typing mixed with IME composition (Japanese): composed text is typed.',
    covers: ['ime', 'typed'],
    build: ime,
  },
  'external-paste': {
    description:
      'External pastes: inline, multi-paragraph, over a typed selection, and typing inside a pasted span.',
    covers: ['pasted-external', 'paste-replace', 'multi-paragraph-paste', 'mixed-word'],
    build: externalPaste,
  },
  'internal-paste': {
    description:
      'Copy/paste inside the project inherits provenance (typed and pasted-external spans, across documents, cut and paste, editing the source after copying); a mismatching internal paste is downgraded; a drag-and-drop keeps provenance.',
    covers: [
      'pasted-internal',
      'slice-copied',
      'cut',
      'cross-document',
      'downgrade',
      'drop-internal',
    ],
    build: internalPaste,
  },
  'undo-paste': {
    description:
      'Undo/redo of a paste never launders it as typing; undo of a deletion restores typed text; a history run with text that was never deleted is pasted-external.',
    covers: ['history', 'tombstones', 'downgrade'],
    build: undoPaste,
  },
  import: {
    description:
      'An imported draft edited afterwards: imported text stays imported; a word mixing imported and typed characters counts as imported.',
    covers: ['imported', 'mixed-word'],
    build: importDoc,
  },
  'feedback-session': {
    description:
      'A feedback request, a review session with anchored and span comments, anchored and unanchored questions and finish_review; a dismissal; a second session that fails.',
    covers: [
      'feedback-request',
      'agent-session',
      'comments',
      'questions',
      'finish-review',
      'dismiss',
      'session-failed',
      'selection-scope',
      'selection-scope-mapped',
    ],
    build: feedbackSession,
  },
  suggestions: {
    description:
      'Word-choice suggestions adopted (retyped exactly), adapted (trace-over that diverged), stale (edited away), dismissed and stale on arrival; an insertion retyped; a rephrase hint adapted; the four-word rule matching a comment.',
    covers: [
      'word-choice',
      'adopted',
      'adapted',
      'stale',
      'dismissed',
      'stale-on-arrival',
      'insertion',
      'rephrase',
      'typed-from-suggestion',
      'four-word-rule',
      'trace-hint',
      'suggestion-resolved',
    ],
    build: suggestions,
  },
  proposals: {
    description:
      'Move (sentence and paragraph), cut, split and merge proposals: accepted, rejected and gone stale; moved text keeps its provenance.',
    covers: [
      'move',
      'cut',
      'split',
      'merge',
      'accepted',
      'rejected',
      'stale',
      'joining-whitespace',
      'accept-old-base-version',
    ],
    build: proposals,
  },
  discuss: {
    description:
      'A Discuss thread on a suggestion: answered, followed up, the follow-up session fails; the suggestion is then dismissed.',
    covers: ['discuss', 'discuss-answered', 'session-failed'],
    build: discuss,
  },
  research: {
    description:
      'Sources, clippings, citation-needed flags (one becomes cited), AI-surfaced sources with a verified candidate added, a source suggestion, a clipping placed as a quote block, a mismatching clipping run downgraded.',
    covers: [
      'sources',
      'clippings',
      'citation',
      'quoted',
      'citation-flag',
      'cited',
      'surfaced-sources',
      'source-suggestion',
      'quote-block',
      'clipping-blank-lines',
    ],
    build: research,
  },
  binder: {
    description:
      'Folders nested three deep, documents and notes, reorder and move, rename, document and folder synopses, archive and restore, project settings.',
    covers: [
      'binder',
      'folders',
      'notes',
      'reorder',
      'archive',
      'synopsis',
      'folder-synopsis',
      'settings',
      'move-into-archived',
      'shared-id-across-collections',
    ],
    build: binder,
  },
  novel: {
    description:
      'A three-chapter project with a style note, writing sessions on two days and two devices, an internal paste across chapters, a light review, and an embedded chain-head witness.',
    covers: [
      'multi-document',
      'writing-sessions',
      'pasted-internal',
      'feedback',
      'chain-head-witnessed',
    ],
    build: novel,
  },
};

/** Tampered copies of a fixture's ledger. */
export interface TamperDefinition {
  description: string;
  base: string;
  /** Mutates a deep copy of the base commits (and witnesses). */
  apply: (commits: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
}

/** The tampered fixtures. Each must fail `verifyChain` (or witness verification) with precise errors. */
export const TAMPER_DEFINITIONS: Readonly<Record<string, TamperDefinition>> = {
  'tampered-edited': {
    description: 'The text of a TextEdited step was changed (hash left as it was).',
    base: 'plain-typing',
    apply: (cs) => {
      const c = cs[3] as {
        payload: { steps: Array<{ slice?: { content?: Array<{ text?: string }> } }> };
      };
      const step = c.payload.steps[0]!;
      step.slice!.content![0]!.text = 'X';
      return cs;
    },
  },
  'tampered-rehashed': {
    description:
      'A commit was edited and its own hash recomputed, so the next commit no longer links to it.',
    base: 'plain-typing',
    apply: (cs) => {
      const c = cs[3] as { payload: { durationMs: number }; hash: string };
      c.payload.durationMs += 1000;
      c.hash = computeCommitHash(c as unknown as Commit);
      return cs;
    },
  },
  'tampered-reordered': {
    description: 'Two adjacent commits were swapped.',
    base: 'plain-typing',
    apply: (cs) => {
      const a = cs[4]!;
      cs[4] = cs[5]!;
      cs[5] = a;
      return cs;
    },
  },
  'tampered-dropped': {
    description: 'A commit in the middle was removed.',
    base: 'plain-typing',
    apply: (cs) => {
      cs.splice(4, 1);
      return cs;
    },
  },
  'tampered-actor': {
    description:
      'An agent commit was relabelled as human (and rehashed): the hash chain breaks at the next commit.',
    base: 'feedback-session',
    apply: (cs) => {
      const i = cs.findIndex((c) => (c as { actor: { kind: string } }).actor.kind === 'agent');
      const c = cs[i] as { actor: { kind: string; id: string }; hash: string };
      c.actor = { kind: 'human', id: 'writer-1' };
      c.hash = computeCommitHash(c as unknown as Commit);
      return cs;
    },
  },
  'tampered-truncated': {
    description:
      'The last commits were removed. The chain alone is consistent; the witnesses (and an expected head) expose it.',
    base: 'plain-typing',
    apply: (cs) => cs.slice(0, cs.length - 2),
  },
};
