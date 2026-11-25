import { inlineTextBetween, schema, sha256Hex } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { LedgerBuilder } from './builder';
import { FoldError } from './issues';
import { applyCommit } from './fold';
import { foldIssues } from './project';
import { classOf, runsOf, textOf } from './test-helpers';

function fresh(): LedgerBuilder {
  const b = new LedgerBuilder({ seed: 7 });
  b.createDocument('d', 'Doc');
  return b;
}

describe('typed input', () => {
  it('assigns typed with the commit seq; Enter splits paragraphs', () => {
    const b = fresh();
    b.type('d', 'Hello there.\nSecond line.');
    const seq = b.head.seq;
    expect(textOf(b, 'd')).toBe('Hello there.¶Second line.');
    expect(runsOf(b, 'd')).toEqual([
      ['Hello there.', 'typed', seq],
      ['Second line.', 'typed', seq],
    ]);
    expect(b.project.documents.d!.version).toBe(25);
    expect(b.project.documents.d!.contentSeq).toBe(seq);
  });

  it('batches at most 50 steps per commit', () => {
    const b = fresh();
    b.type('d', 'x'.repeat(120));
    const edits = b.commits.filter((c) => c.type === 'TextEdited');
    expect(edits.map((c) => (c.payload as { steps: unknown[] }).steps.length)).toEqual([
      50, 50, 20,
    ]);
  });

  it('keeps the old provenance for a common prefix/suffix when typing over text', () => {
    const b = fresh();
    b.pasteExternal('d', 'colour');
    const pasteSeq = b.head.seq;
    // Replace "colour" with "colours" in one typed step (e.g. a spellchecker-style replace).
    b.edit('d', [
      { run: { method: 'typed' }, build: (tr) => tr.replaceWith(1, 7, schema.text('colours')) },
    ]);
    expect(runsOf(b, 'd')).toEqual([
      ['colour', 'pasted-external', pasteSeq],
      ['s', 'typed', b.head.seq],
    ]);
  });

  it('treats IME and autocorrect as typed', () => {
    const b = fresh();
    b.compose('d', ['に', 'にほ', 'にほん', '日本']);
    b.edit('d', [
      { run: { method: 'autocorrect' }, build: (tr) => tr.insert(3, schema.text('語')) },
    ]);
    expect(runsOf(b, 'd').map((r) => r[1])).toEqual(['typed', 'typed']);
  });

  it('marks and block types do not change provenance', () => {
    const b = fresh();
    b.type('d', 'Title');
    const before = runsOf(b, 'd');
    b.format('d', (tr) => tr.addMark(1, 6, schema.marks.strong!.create()));
    b.format('d', (tr) => tr.setBlockType(1, 1, schema.nodes.heading!, { level: 1 }));
    expect(runsOf(b, 'd')).toEqual(before);
  });
});

describe('pastes', () => {
  it('external pastes are pasted-external and record measured sizes', () => {
    const b = fresh();
    b.type('d', 'Mine. ');
    const id = b.pasteExternal('d', 'Theirs, two words.\nAnd more.');
    expect(classOf(b, 'd', 'Theirs')).toBe('pasted-external');
    const p = b.project.pastes[id]!;
    expect(p.insertedSeq).toBe(b.head.seq);
    expect(p.characters).toBe('Theirs, two words.And more.'.length);
    expect(p.words).toBe(5);
  });

  it('internal pastes inherit provenance and add the paste seq to moves', () => {
    const b = fresh();
    b.type('d', 'Typed words. ');
    const typedSeq = b.head.seq;
    b.pasteExternal('d', 'Pasted words.');
    const pastedSeq = b.head.seq;
    const copy = b.copy('d', 1, b.pos('d', 'end'));
    b.enter('d');
    const id = b.pasteInternal('d', copy);
    const seq = b.head.seq;
    expect(runsOf(b, 'd').slice(2)).toEqual([
      ['Typed words. ', 'typed', typedSeq, `moves=${seq}`],
      ['Pasted words.', 'pasted-external', pastedSeq, `moves=${seq}`],
    ]);
    expect(b.project.pastes[id]!.verifiedInternal).toBe(true);
  });

  it('downgrades an internal paste whose content differs from the copy', () => {
    const b = fresh();
    b.type('d', 'Alpha beta.');
    const copy = b.copy('d', 1, 6);
    const id = b.pasteInternal('d', copy, { slice: b.doc('d').slice(7, 11) });
    expect(runsOf(b, 'd').at(-1)).toEqual(['beta', 'pasted-external', b.head.seq]);
    expect(b.project.pastes[id]!.verifiedInternal).toBe(false);
  });

  it('downgrades an internal paste whose SliceCopied hash does not match', () => {
    const b = fresh();
    b.type('d', 'Alpha beta.');
    const copyId = 'copy-bad';
    b.human('SliceCopied', {
      copyId,
      documentId: 'd',
      from: 1,
      to: 6,
      version: b.version('d'),
      cut: false,
      textHash: sha256Hex('not the text'),
      characters: 5,
    });
    b.pasteInternal('d', copyId, { slice: b.doc('d').slice(1, 6) });
    expect(runsOf(b, 'd').at(-1)?.[1]).toBe('pasted-external');
  });

  it('downgrades an internal paste with a missing PasteOccurred', () => {
    const b = fresh();
    b.type('d', 'Alpha.');
    b.edit('d', [
      {
        run: { method: 'pasted-internal', pasteId: 'nope' },
        build: (tr) => tr.insert(7, schema.text(' Alpha')),
      },
    ]);
    expect(runsOf(b, 'd').at(-1)).toEqual([' Alpha', 'pasted-external', b.head.seq]);
  });

  it('a drop keeps provenance when the inserted content equals what the run deleted', () => {
    const b = fresh();
    b.type('d', 'one two three');
    const typed = b.head.seq;
    b.drop('d', 5, 9, 14);
    const seq = b.head.seq;
    expect(textOf(b, 'd')).toBe('one threetwo ');
    expect(runsOf(b, 'd')).toEqual([
      ['one three', 'typed', typed],
      ['two ', 'typed', typed, `moves=${seq}`],
    ]);
  });

  it('a drop that inserts different content is pasted-external', () => {
    const b = fresh();
    b.type('d', 'one two three');
    b.edit('d', [
      {
        run: { method: 'drop-internal' },
        build: (tr) => {
          tr.delete(5, 9);
          tr.insert(10, schema.text('TWO '));
        },
      },
    ]);
    expect(runsOf(b, 'd').at(-1)).toEqual(['TWO ', 'pasted-external', b.head.seq]);
  });
});

describe('undo / redo (history)', () => {
  it('cannot launder a paste as typing', () => {
    const b = fresh();
    b.type('d', 'Mine. ');
    b.pasteExternal('d', 'Borrowed.');
    const pasteSeq = b.head.seq;
    b.undo();
    expect(textOf(b, 'd')).toBe('Mine. ');
    b.redo();
    expect(runsOf(b, 'd').at(-1)).toEqual(['Borrowed.', 'pasted-external', pasteSeq]);
  });

  it('restores typed provenance of deleted text', () => {
    const b = fresh();
    b.type('d', 'Keep this sentence.');
    const typed = b.head.seq;
    b.backspace('d', 9);
    b.undo();
    expect(runsOf(b, 'd')).toEqual([['Keep this sentence.', 'typed', typed]]);
  });

  it('a history run inserting never-deleted text is pasted-external', () => {
    const b = fresh();
    b.type('d', 'Start.');
    b.edit('d', [
      { run: { method: 'history' }, build: (tr) => tr.insert(7, schema.text(' Invented.')) },
    ]);
    expect(runsOf(b, 'd').at(-1)).toEqual([' Invented.', 'pasted-external', b.head.seq]);
  });
});

describe('citations and clippings', () => {
  function withSource(): LedgerBuilder {
    const b = fresh();
    b.type('d', 'A claim.');
    b.addSource('s1', { type: 'book', title: 'A Book' });
    b.saveClipping('k1', 's1', 'Quoted line one.\nQuoted line two.', 'p. 3');
    return b;
  }

  it('a citation run inserting a citation node is quoted', () => {
    const b = withSource();
    b.cite('d', 's1', 'p. 3', { at: 8 });
    const run = b.project.documents.d!.provenance.find((r) => r.from === 8)!;
    expect(run).toMatchObject({ from: 8, to: 9, class: 'quoted' });
  });

  it('a citation run inserting text, or a citation of another source, is pasted-external', () => {
    const b = withSource();
    b.human('CitationInserted', {
      citationId: 'ci',
      documentId: 'd',
      sourceId: 's1',
      locator: null,
    });
    b.edit('d', [
      {
        run: { method: 'citation', citationId: 'ci' },
        build: (tr) => tr.insert(9, schema.text('(Doe)')),
      },
    ]);
    expect(runsOf(b, 'd').at(-1)).toEqual(['(Doe)', 'pasted-external', b.head.seq]);
    b.addSource('s2', { type: 'book', title: 'Other' });
    b.human('CitationInserted', {
      citationId: 'ci2',
      documentId: 'd',
      sourceId: 's1',
      locator: null,
    });
    b.edit('d', [
      {
        run: { method: 'citation', citationId: 'ci2' },
        build: (tr) =>
          tr.insert(1, schema.nodes.citation!.create({ sourceId: 's2', locator: null })),
      },
    ]);
    expect(b.project.documents.d!.provenance[0]).toMatchObject({
      from: 1,
      to: 2,
      class: 'pasted-external',
    });
  });

  it('a clipping placed as one quote block with the clipping text is quoted', () => {
    const b = withSource();
    b.placeClipping('d', 'k1');
    expect(
      runsOf(b, 'd')
        .slice(1)
        .map((r) => [r[0], r[1]]),
    ).toEqual([
      ['Quoted line one.', 'quoted'],
      ['Quoted line two.', 'quoted'],
    ]);
  });

  it('a clipping run with different text is pasted-external', () => {
    const b = withSource();
    b.placeClipping('d', 'k1', { text: 'Quoted line one.\nAltered.' });
    expect(
      runsOf(b, 'd')
        .slice(1)
        .map((r) => r[1]),
    ).toEqual(['pasted-external', 'pasted-external']);
  });

  it('a removed clipping can no longer be verified', () => {
    const b = withSource();
    b.human('ClippingRemoved', { clippingId: 'k1' });
    b.placeClipping('d', 'k1');
    expect(
      runsOf(b, 'd')
        .slice(1)
        .map((r) => r[1]),
    ).toEqual(['pasted-external', 'pasted-external']);
  });
});

describe('imports', () => {
  it('imported text is imported; edits inside it are typed', () => {
    const b = new LedgerBuilder();
    b.importDocument('d', 'Old', 'An old draft.\n\nSecond paragraph.');
    const seq = b.head.seq;
    b.type('d', ' New.', { at: { after: 'draft.' } });
    expect(runsOf(b, 'd')).toEqual([
      ['An old draft.', 'imported', seq],
      [' New.', 'typed', b.head.seq],
      ['Second paragraph.', 'imported', seq],
    ]);
    expect(b.project.documents.d!.imported).toMatchObject({ seq, sourceFormat: 'markdown' });
    expect(b.project.documents.d!.version).toBe(5);
  });
});

describe('fold errors', () => {
  it('rejects gaps, wrong prevHash, base version mismatch and steps that do not apply', () => {
    const b = fresh();
    b.type('d', 'abc');
    const commits = b.commits;
    const before = b.state;
    const last = commits.at(-1)!;
    expect(() => applyCommit(before, last)).toThrow(FoldError);
    const bogus = {
      ...last,
      seq: last.seq + 1,
      prevHash: last.hash,
      payload: { ...last.payload, baseVersion: 0 },
    };
    expect(() => applyCommit(before, bogus as never)).toThrow(/baseVersion/);
    const bad = {
      ...last,
      seq: last.seq + 1,
      prevHash: last.hash,
      payload: {
        ...last.payload,
        baseVersion: 3,
        steps: [{ stepType: 'replace', from: 900, to: 900 }],
      },
    };
    expect(() => applyCommit(before, bad as never)).toThrow(/does not apply/);
    expect(foldIssues(before)).toEqual([]);
  });

  it('text helpers agree with the schema inline-text rules', () => {
    const b = fresh();
    b.type('d', 'One.\nTwo.');
    const n = b.doc('d');
    expect(inlineTextBetween(n, 0, n.content.size)).toBe('One.\nTwo.');
  });
});
