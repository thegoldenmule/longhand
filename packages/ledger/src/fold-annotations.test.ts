import { describe, expect, it } from 'vitest';
import { LedgerBuilder } from './builder';
import { foldIssues } from './project';
import { classOf, runsOf, textOf } from './test-helpers';

function review(
  text: string,
  intensity: 'light' | 'standard' | 'thorough' = 'thorough',
): LedgerBuilder {
  const b = new LedgerBuilder({ seed: 3 });
  b.createDocument('d', 'Doc');
  b.type('d', text);
  b.requestFeedback('r', { scope: { kind: 'document', documentId: 'd' }, intensity });
  b.startReview('s', 'r');
  return b;
}

describe('proposals', () => {
  it('a sentence move keeps provenance, joins with one space and cleans the gap', () => {
    const b = review('Alpha one. Beta two. Gamma three.');
    const typed = b.commits.find((c) => c.type === 'TextEdited')!.seq;
    b.proposeMove(
      's',
      'm',
      { documentId: 'd', unit: 'sentence', ids: ['p1.s3'] },
      { position: 'before', id: 'p1.s1' },
      'r',
    );
    b.acceptProposal('m');
    const seq = b.head.seq;
    expect(textOf(b, 'd')).toBe('Gamma three. Alpha one. Beta two.');
    expect(runsOf(b, 'd')).toEqual([
      ['Gamma three.', 'typed', typed, `moves=${seq}`],
      [' ', 'typed', seq],
      ['Alpha one. Beta two.', 'typed', typed],
    ]);
    const p = b.project.annotations.proposals.m!;
    expect(p).toMatchObject({ status: 'accepted', resolvedSeq: seq, source: null, insertAt: null });
    expect(b.project.documents.d!.contentSeq).toBe(seq);
  });

  it('a paragraph move moves whole nodes; annotations inside move with the text', () => {
    const b = review('First para.\nSecond para.\nThird para.');
    b.comment(
      's',
      'c',
      { kind: 'anchor', documentId: 'd', sentenceId: 'p3.s1', quote: 'Third' },
      'Strong.',
    );
    b.proposeMove(
      's',
      'm',
      { documentId: 'd', unit: 'paragraph', ids: ['p3'] },
      { position: 'before', id: 'p1' },
      'r',
    );
    b.acceptProposal('m');
    expect(textOf(b, 'd')).toBe('Third para.¶First para.¶Second para.');
    expect(b.project.annotations.comments.c!.range).toEqual({ documentId: 'd', from: 1, to: 6 });
  });

  it('cut, split and merge derive their own steps', () => {
    const b = review('Keep this. Drop this. Then more.\nAnother one.');
    b.proposeCut(
      's',
      'cut',
      { kind: 'span', documentId: 'd', unit: 'sentence', ids: ['p1.s2'] },
      'r',
    );
    b.proposeSplit('s', 'split', 'd', 'p1', 'p1.s3', 'r');
    b.acceptProposal('split');
    expect(textOf(b, 'd')).toBe('Keep this. Drop this.¶Then more.¶Another one.');
    b.acceptProposal('cut');
    expect(textOf(b, 'd')).toBe('Keep this.¶Then more.¶Another one.');
    b.finishReview('s', 'done');
    b.requestFeedback('r2', { scope: { kind: 'project' }, intensity: 'light' });
    b.startReview('s2', 'r2');
    b.proposeMerge('s2', 'merge', 'd', 'p2', 'p3', 'r');
    b.acceptProposal('merge');
    expect(textOf(b, 'd')).toBe('Keep this.¶Then more. Another one.');
    expect(classOf(b, 'd', ' Another')).toBe('typed');
    expect(foldIssues(b.state)).toEqual([]);
  });

  it('goes stale when the writer edits inside it, and cannot then be accepted', () => {
    const b = review('One sentence here. Two sentence here.');
    b.proposeCut(
      's',
      'cut',
      { kind: 'span', documentId: 'd', unit: 'sentence', ids: ['p1.s2'] },
      'r',
    );
    b.type('d', 'X', { at: { after: 'Two' } });
    const stale = b.head.seq - 1;
    expect(b.project.annotations.proposals.cut).toMatchObject({ status: 'stale', range: null });
    expect(b.commits.at(-1)!.type).toBe('SuggestionResolved');
    expect(b.commits.at(-1)!.payload).toEqual({
      targetId: 'cut',
      targetKind: 'proposal',
      outcome: 'stale',
      triggerSeq: stale,
    });
    expect(() => b.acceptProposal('cut')).toThrow(/not-open/);
  });

  it('edits next to (not inside) a proposal do not stale it', () => {
    const b = review('One sentence here. Two sentence here.');
    b.proposeCut(
      's',
      'cut',
      { kind: 'span', documentId: 'd', unit: 'sentence', ids: ['p1.s1'] },
      'r',
    );
    b.type('d', ' Three.');
    expect(b.project.annotations.proposals.cut!.status).toBe('open');
  });

  it('is accepted at an older baseVersion from its mapped positions', () => {
    const b = review('Alpha one. Beta two.\nGamma.');
    b.proposeCut(
      's',
      'cut',
      { kind: 'span', documentId: 'd', unit: 'paragraph', ids: ['p2'] },
      'r',
    );
    const seen = b.version('d');
    b.type('d', 'Intro. ', { at: 1 });
    b.acceptProposal('cut', { baseVersion: seen });
    expect(textOf(b, 'd')).toBe('Intro. Alpha one. Beta two.');
    expect(() => b.acceptProposal('cut', { baseVersion: b.version('d') + 1 })).toThrow();
  });

  it('rejection closes the proposal', () => {
    const b = review('A. B.');
    b.proposeCut(
      's',
      'cut',
      { kind: 'anchor', documentId: 'd', sentenceId: 'p1.s1', quote: 'A.' },
      'r',
    );
    b.rejectProposal('cut', 'wrong');
    expect(b.project.annotations.proposals.cut).toMatchObject({
      status: 'rejected',
      rejectReason: 'wrong',
      range: null,
    });
  });
});

describe('suggestion lifecycle', () => {
  it('adopted when an alternative is retyped over the anchor; text is typed-from-suggestion', () => {
    const b = review('The old roof leaked.');
    b.suggestWordChoice(
      's',
      'w',
      { documentId: 'd', sentenceId: 'p1.s1', quote: 'old' },
      ['sagging', 'weathered'],
      'r',
    );
    b.typeOver('d', 5, 8, 'weathered');
    const seq = b.head.seq - 1;
    expect(b.project.annotations.suggestions.w).toMatchObject({
      status: 'adopted',
      adoptedAlternative: 1,
      resolvedSeq: seq,
    });
    expect(runsOf(b, 'd')[1]).toEqual(['weathered', 'typed-from-suggestion', seq, 'sug=w']);
  });

  it('stays open while retyping is in progress across commits', () => {
    const b = review('The old roof leaked.');
    b.suggestWordChoice(
      's',
      'w',
      { documentId: 'd', sentenceId: 'p1.s1', quote: 'old' },
      ['weathered'],
      'r',
    );
    b.typeOver('d', 5, 8, 'weath');
    expect(b.project.annotations.suggestions.w!.status).toBe('open');
    b.type('d', 'ered', { at: 10 });
    expect(b.project.annotations.suggestions.w!.status).toBe('adopted');
    expect(classOf(b, 'd', 'weathered')).toBe('typed-from-suggestion');
  });

  it('adapted when trace-over typing diverges; near matches are typed-from-suggestion', () => {
    const b = review('She waited there.');
    b.suggestWordChoice(
      's',
      'w',
      { documentId: 'd', sentenceId: 'p1.s1', quote: 'waited' },
      ['lingered'],
      'r',
    );
    b.typeOver('d', 5, 11, 'lingerd');
    expect(b.project.annotations.suggestions.w!.status).toBe('adapted');
    expect(classOf(b, 'd', 'lingerd')).toBe('typed-from-suggestion');
  });

  it('stale when the anchored text is edited away or replaced with unrelated text', () => {
    const b = review('Nothing moved outside. A dog barked.');
    b.suggestWordChoice(
      's',
      'w1',
      { documentId: 'd', sentenceId: 'p1.s1', quote: 'moved' },
      ['stirred'],
      'r',
    );
    b.suggestWordChoice(
      's',
      'w2',
      { documentId: 'd', sentenceId: 'p1.s2', quote: 'barked' },
      ['howled'],
      'r',
    );
    b.deleteText('d', 'moved');
    const f = b.pos('d', { before: 'barked' });
    b.typeOver('d', f, f + 6, 'slept');
    expect(b.project.annotations.suggestions.w1).toMatchObject({ status: 'stale', range: null });
    expect(b.project.annotations.suggestions.w2!.status).toBe('stale');
    expect(classOf(b, 'd', 'slept')).toBe('typed');
  });

  it('pasting the alternative is never adopted', () => {
    const b = review('The old roof.');
    b.suggestWordChoice(
      's',
      'w',
      { documentId: 'd', sentenceId: 'p1.s1', quote: 'old' },
      ['weathered'],
      'r',
    );
    b.pasteExternal('d', 'weathered', { replace: [5, 8] });
    expect(b.project.annotations.suggestions.w!.status).toBe('stale');
  });

  it('stale on arrival when the text changed after the agent read it', () => {
    const b = review('The old roof.');
    const read = b.version('d');
    b.typeOver('d', 5, 8, 'new');
    b.suggestWordChoice(
      's',
      'w',
      { documentId: 'd', sentenceId: 'p1.s1', quote: 'old', readVersion: read },
      ['aged'],
      'r',
    );
    expect(b.project.annotations.suggestions.w).toMatchObject({
      status: 'stale',
      resolvedSeq: b.head.seq,
    });
  });

  it('dismissal; dismissing twice is rejected', () => {
    const b = review('The old roof.');
    b.suggestWordChoice(
      's',
      'w',
      { documentId: 'd', sentenceId: 'p1.s1', quote: 'old' },
      ['aged'],
      'r',
    );
    b.dismiss('w', 'later', 'maybe');
    expect(b.project.annotations.suggestions.w).toMatchObject({
      status: 'dismissed',
      dismissal: { reason: 'later', note: 'maybe' },
    });
    expect(() => b.dismiss('w')).toThrow(/not-open/);
  });

  it('insertions: adopted at the point; stale when their sentence is deleted', () => {
    const b = review('She waited. Nothing happened.');
    b.suggestInsertion(
      's',
      'i1',
      { documentId: 'd', position: 'after', sentenceId: 'p1.s1' },
      'The clock ticked.',
      'Time.',
    );
    b.suggestInsertion(
      's',
      'i2',
      { documentId: 'd', position: 'after', sentenceId: 'p1.s2' },
      'Then the door opened.',
      'Event.',
    );
    b.type('d', ' The clock ticked.', { at: { after: 'waited.' } });
    expect(b.project.annotations.suggestions.i1!.status).toBe('adopted');
    expect(classOf(b, 'd', 'The clock')).toBe('typed-from-suggestion');
    b.deleteText('d', ' Nothing happened.');
    expect(b.project.annotations.suggestions.i2!.status).toBe('stale');
  });

  it('rephrase hints: adapted on edits inside, stale when removed; never change provenance', () => {
    const b = review('The hedges were black. The lane was empty.');
    b.suggestRephrase(
      's',
      'r1',
      { documentId: 'd', sentenceId: 'p1.s1', quote: 'were black' },
      'Say why.',
    );
    b.suggestRephrase(
      's',
      'r2',
      { documentId: 'd', sentenceId: 'p1.s2', quote: 'was empty' },
      'Show it.',
    );
    const f = b.pos('d', { before: 'black' });
    b.typeOver('d', f, f + 5, 'dark with rain');
    b.deleteText('d', ' was empty');
    expect(b.project.annotations.suggestions.r1!.status).toBe('adapted');
    expect(b.project.annotations.suggestions.r2!.status).toBe('stale');
    expect(classOf(b, 'd', 'dark with rain')).toBe('typed');
  });

  it('four-word rule: AI text typed after it arrived, minus n-grams already in the manuscript', () => {
    const b = review('The storm broke over the harbour.');
    b.comment(
      's',
      'c',
      { kind: 'anchor', documentId: 'd', sentenceId: 'p1.s1', quote: 'storm' },
      'The storm broke over the harbour like a slammed door.',
    );
    b.finishReview('s', 'ok');
    // "the storm broke over" is in the manuscript already: not a match.
    b.type('d', ' Then the storm broke over us.');
    expect(classOf(b, 'd', 'Then')).toBe('typed');
    // "like a slammed door" is new AI text.
    b.type('d', ' It hit like a slammed door.');
    expect(classOf(b, 'd', 'like a slammed door')).toBe('typed-from-suggestion');
    expect(classOf(b, 'd', 'It hit')).toBe('typed');
  });

  it('a trace-over hint marks typed text even without a match', () => {
    const b = review('The old roof.');
    b.suggestWordChoice(
      's',
      'w',
      { documentId: 'd', sentenceId: 'p1.s1', quote: 'old' },
      ['weathered'],
      'r',
    );
    b.typeOver('d', 5, 8, 'tin', { traceSuggestionId: 'w' });
    expect(classOf(b, 'd', 'tin')).toBe('typed-from-suggestion');
    expect(b.project.annotations.suggestions.w!.status).toBe('adapted');
  });
});

describe('agent sessions and annotations', () => {
  it('tracks sessions, counts and review summaries', () => {
    const b = review('Text.', 'light');
    b.comment(
      's',
      'c',
      { kind: 'span', documentId: 'd', unit: 'paragraph', ids: ['p1'] },
      'Short.',
    );
    b.question('s', 'q', 'Why?');
    b.finishReview('s', 'Summary.', ['One'], ['Two']);
    const s = b.project.annotations.agentSessions.s!;
    expect(s).toMatchObject({
      status: 'finished',
      kind: 'review',
      annotationIds: ['c', 'q'],
      review: { summary: 'Summary.' },
    });
    expect(s.counts).toMatchObject({ items: 2, questions: 1 });
    expect(b.project.annotations.feedbackRequests.r!.status).toBe('finished');
    expect(() =>
      b.comment(
        's',
        'c2',
        { kind: 'span', documentId: 'd', unit: 'paragraph', ids: ['p1'] },
        'Late.',
      ),
    ).toThrow(/session-not-running/);
  });

  it('enforces caps', () => {
    const b = review('One. Two. Three.', 'light');
    b.question('s', 'q1', 'One?');
    b.question('s', 'q2', 'Two?');
    expect(() => b.question('s', 'q3', 'Three?')).toThrow(/cap-exceeded/);
    for (let i = 1; i <= 3; i++)
      b.comment(
        's',
        `c${i}`,
        { kind: 'span', documentId: 'd', unit: 'paragraph', ids: ['p1'] },
        'Note.',
      );
    expect(() =>
      b.comment(
        's',
        'c4',
        { kind: 'span', documentId: 'd', unit: 'paragraph', ids: ['p1'] },
        'Note.',
      ),
    ).toThrow(/cap-exceeded/);
  });

  it('comment ranges follow edits and become null when their text is deleted', () => {
    const b = review('Keep. Delete me.');
    b.comment(
      's',
      'c',
      { kind: 'anchor', documentId: 'd', sentenceId: 'p1.s2', quote: 'Delete me.' },
      'Hm.',
    );
    b.type('d', 'Intro. ', { at: 1 });
    expect(b.project.annotations.comments.c!.range).toEqual({ documentId: 'd', from: 14, to: 24 });
    b.deleteText('d', ' Delete me.');
    expect(b.project.annotations.comments.c!.range).toBeNull();
  });

  it('feedback selection scopes are mapped to the current version', () => {
    const b = new LedgerBuilder();
    b.createDocument('d', 'Doc');
    b.type('d', 'Hello world.');
    b.requestFeedback('r', {
      scope: { kind: 'selection', documentId: 'd', from: 7, to: 12, version: b.version('d') },
    });
    b.type('d', 'Oh. ', { at: 1 });
    expect(b.project.annotations.feedbackRequests.r!.scope).toEqual({
      kind: 'selection',
      documentId: 'd',
      from: 11,
      to: 16,
      version: b.version('d'),
    });
  });

  it('discuss threads and failed sessions', () => {
    const b = review('Text here.');
    b.suggestWordChoice(
      's',
      'w',
      { documentId: 'd', sentenceId: 'p1.s1', quote: 'here' },
      ['there'],
      'r',
    );
    b.finishReview('s', 'ok');
    b.discuss('t', 'w', 'Why?');
    b.startDiscuss('ds', 't');
    b.answerDiscussion('ds', 't', 'w', 'Because.');
    expect(b.project.annotations.discussions.t).toMatchObject({ status: 'answered' });
    expect(b.project.annotations.discussions.t!.messages.map((m) => m.role)).toEqual([
      'writer',
      'editor',
    ]);
    b.discuss('t', 'w', 'More?');
    b.startDiscuss('ds2', 't');
    b.system('FeedbackSessionFailed', {
      feedbackSessionId: 'ds2',
      requestId: null,
      threadId: 't',
      reason: 'x',
    });
    expect(b.project.annotations.discussions.t!.status).toBe('failed');
    expect(b.project.annotations.agentSessions.ds2!.status).toBe('failed');
  });

  it('citation flags become cited when a verified citation lands in their sentence', () => {
    const b = review('Rain doubled after 1950. Next sentence.');
    b.addSource('src', { type: 'book', title: 'T' });
    b.flagCitationNeeded(
      's',
      'f',
      { documentId: 'd', sentenceId: 'p1.s1', quote: 'Rain doubled' },
      'Rain doubled.',
    );
    b.cite('d', 'src', null, { at: { after: '1950' } });
    expect(b.project.annotations.citationFlags.f!.status).toBe('cited');
  });
});

describe('binder', () => {
  it('orders children by {parentId, index} counted after removal, clamped', () => {
    const b = new LedgerBuilder();
    b.createFolder('f', 'F');
    for (const id of ['a', 'b', 'c']) b.createDocument(id, id.toUpperCase(), { parentId: 'f' });
    b.human('DocumentMoved', { documentId: 'a', parentId: 'f', index: 99 });
    expect(b.project.folders.f!.children.map((r) => r.id)).toEqual(['b', 'c', 'a']);
    b.human('DocumentMoved', { documentId: 'a', parentId: 'f', index: 0 });
    expect(b.project.folders.f!.children.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    b.human('DocumentMoved', { documentId: 'c', parentId: null, index: 0 });
    expect(b.project.binder.manuscript.map((r) => r.id)).toEqual(['c', 'f']);
    expect(b.project.documents.c!.parentId).toBeNull();
  });

  it('rejects cycles, cross-area moves and duplicate ids within a collection', () => {
    const b = new LedgerBuilder();
    b.createFolder('f', 'F');
    b.createFolder('g', 'G', { parentId: 'f' });
    b.createFolder('n', 'Notes', { area: 'notes' });
    b.createDocument('d', 'D');
    expect(() => b.human('FolderMoved', { folderId: 'f', parentId: 'g', index: 0 })).toThrow(
      /cycle/,
    );
    expect(() => b.human('DocumentMoved', { documentId: 'd', parentId: 'n', index: 0 })).toThrow(
      /area-mismatch/,
    );
    expect(() => b.createDocument('d', 'Again')).toThrow(/duplicate-id/);
    b.createFolder('d', 'A folder named like a document');
    expect(b.project.folders.d).toBeDefined();
  });

  it('bumps a folder updatedSeq when children are added, and allows moves into archived folders', () => {
    const b = new LedgerBuilder();
    b.createFolder('f', 'F');
    b.human('FolderArchived', { folderId: 'f', archived: true });
    b.createDocument('d', 'D');
    b.human('DocumentMoved', { documentId: 'd', parentId: 'f', index: 0 });
    expect(b.project.folders.f).toMatchObject({ archived: true, updatedSeq: b.head.seq });
    expect(b.project.documents.d!.parentId).toBe('f');
  });

  it('folds document and folder synopses separately, even when ids are shared', () => {
    const b = new LedgerBuilder();
    b.createFolder('x', 'Folder');
    b.createDocument('x', 'Document');
    expect(b.project.folders.x!.synopsis).toBe('');
    b.human('SynopsisEdited', { folderId: 'x', synopsis: 'Folder card' });
    expect(b.project.folders.x).toMatchObject({ synopsis: 'Folder card', updatedSeq: b.head.seq });
    expect(b.project.documents.x!.synopsis).toBe('');
    b.human('SynopsisEdited', { documentId: 'x', synopsis: 'Document card' });
    expect(b.project.documents.x!.synopsis).toBe('Document card');
    expect(b.project.folders.x!.synopsis).toBe('Folder card');
    expect(() => b.human('SynopsisEdited', { folderId: 'nope', synopsis: 'A' })).toThrow(
      /unknown-parent/,
    );
  });
});
