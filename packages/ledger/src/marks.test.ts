import { canonicalize, schema, type CommitDraft } from '@longhand/schema';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { LedgerBuilder } from './builder';
import { verifyChain } from './chain';
import { foldCommits } from './fold';
import { documentNode, foldIssues, projectState } from './project';
import { validateDraft } from './validate';
import { charactersByClass, wordsByClass } from './words';
import { classOf, matchAt, runsOf, textOf } from './test-helpers';

const human = { kind: 'human' as const, id: 'writer-1' };
const link = (href: string) => schema.marks.link!.create({ href });
/** An href whose path reads like prose: it must never count as words or as manuscript text. */
const WORDY = 'https://example.com/the-storm-broke-over-the-harbour/and-many-more-words';

function counts(b: LedgerBuilder, id = 'd') {
  const node = documentNode(b.state, id)!;
  const runs = b.project.documents[id]!.provenance;
  return { words: wordsByClass(node, runs), chars: charactersByClass(node, runs) };
}

describe('link and code marks are formatting', () => {
  it('adding and removing links and code keeps text, provenance, word and character counts', () => {
    const b = new LedgerBuilder({ seed: 21 });
    b.createDocument('d', 'Doc');
    b.type('d', 'Read the harbour log ');
    b.pasteExternal('d', 'borrowed words');
    const runs = runsOf(b, 'd');
    const before = counts(b);
    const text = textOf(b, 'd');
    const log = b.pos('d', { before: 'harbour log' });
    const borrowed = b.pos('d', { before: 'borrowed' });
    b.format('d', (tr) => tr.addMark(log, log + 'harbour log'.length, link(WORDY)));
    b.format('d', (tr) => tr.addMark(borrowed, borrowed + 8, schema.marks.code!.create()));
    b.format('d', (tr) => tr.addMark(1, 5, link('mailto:ada@example.com')));
    expect(textOf(b, 'd')).toBe(text);
    expect(runsOf(b, 'd')).toEqual(runs);
    expect(counts(b)).toEqual(before);
    expect(classOf(b, 'd', 'borrowed')).toBe('pasted-external');
    expect(classOf(b, 'd', 'harbour')).toBe('typed');
    const marks = documentNode(b.state, 'd')!.firstChild!.content.content.map((n) => [
      n.text,
      n.marks.map((m) => m.type.name),
    ]);
    expect(marks).toEqual([
      ['Read', ['link']],
      [' the ', []],
      ['harbour log', ['link']],
      [' ', []],
      ['borrowed', ['code']],
      [' words', []],
    ]);
    // Removing them is formatting too.
    b.format('d', (tr) => tr.removeMark(0, tr.doc.content.size, schema.marks.link!));
    b.format('d', (tr) => tr.removeMark(0, tr.doc.content.size, schema.marks.code!));
    expect(runsOf(b, 'd')).toEqual(runs);
    expect(counts(b)).toEqual(before);
    expect(foldIssues(b.state)).toEqual([]);
  });

  it('records zero characters for a link and folds deterministically', () => {
    const b = new LedgerBuilder({ seed: 22 });
    b.createDocument('d', 'Doc');
    b.type('d', 'A short line.');
    b.format('d', (tr) => tr.addMark(3, 8, link(WORDY)));
    const te = b.commits.filter((c) => c.type === 'TextEdited').at(-1)!;
    expect(te.payload).toMatchObject({ characters: 0 });
    expect(b.project.documents.d!.content.content![0]!.content![1]).toEqual({
      type: 'text',
      text: 'short',
      marks: [{ type: 'link', attrs: { href: WORDY } }],
    });
    expect(verifyChain(b.commits).ok).toBe(true);
    const a = canonicalize(projectState(foldCommits(b.commits)));
    const again = canonicalize(projectState(foldCommits(JSON.parse(JSON.stringify(b.commits)))));
    expect(again).toBe(a);
    expect(a).toBe(canonicalize(b.project));
  });

  it('typing inside a link is typed text, and only its characters count', () => {
    const b = new LedgerBuilder({ seed: 23 });
    b.createDocument('d', 'Doc');
    b.type('d', 'ab');
    b.format('d', (tr) => tr.addMark(1, 3, link(WORDY)));
    b.edit('d', [
      {
        run: { method: 'typed' },
        build: (tr) => tr.insert(2, schema.text('x', [link(WORDY)])),
        keys: [{ kind: 'insert', len: 1, dt: 0 }],
      },
    ]);
    expect(textOf(b, 'd')).toBe('axb');
    expect(runsOf(b, 'd').map((r) => r[1])).toEqual(['typed', 'typed', 'typed']);
    expect(counts(b).words.total).toBe(1);
    expect(counts(b).chars.total).toBe(3);
  });
});

describe('the href is never manuscript text for the matcher', () => {
  function review(): LedgerBuilder {
    const b = new LedgerBuilder({ seed: 24 });
    b.createDocument('d', 'Doc');
    b.type('d', 'See the log.');
    const at = b.pos('d', { before: 'log' });
    b.format('d', (tr) => tr.addMark(at, at + 3, link(WORDY)));
    b.requestFeedback('r', { scope: { kind: 'document', documentId: 'd' }, intensity: 'thorough' });
    b.startReview('s', 'r');
    b.comment(
      's',
      'c',
      { kind: 'anchor', documentId: 'd', sentenceId: 'p1.s1', quote: 'log' },
      'Say the storm broke over the harbour first.',
    );
    return b;
  }

  it('words that appear only in an href do not shield retyped AI words', () => {
    const b = review();
    // "the storm broke over the harbour" is in the href, not the manuscript, so typing it
    // after the AI wrote it is a match.
    b.type('d', ' Then the storm broke over the harbour.');
    expect(classOf(b, 'd', 'the storm broke')).toBe('typed-from-suggestion');
    expect(matchAt(b, 'd', 'the storm broke')).toBe('c:comment');
    expect(classOf(b, 'd', 'See')).toBe('typed');
  });

  it('a link whose href holds AI words does not make the linked text AI-assisted', () => {
    const b = review();
    b.type('d', ' Then rain.');
    const at = b.pos('d', { before: 'rain' });
    b.format('d', (tr) =>
      tr.addMark(at, at + 4, link('https://example.com/say-the-storm-broke-over-the-harbour')),
    );
    expect(classOf(b, 'd', 'rain')).toBe('typed');
    expect(matchAt(b, 'd', 'rain')).toBeUndefined();
  });
});

describe('ingest rejects links the policy forbids', () => {
  function setup(): LedgerBuilder {
    const b = new LedgerBuilder({ seed: 25 });
    b.createDocument('d', 'Doc');
    b.type('d', 'Hello world.');
    return b;
  }
  const envelope = (b: LedgerBuilder) => ({
    commitId: 'c-new',
    projectId: b.projectId,
    clientTime: b.now(),
    actor: human,
    deviceId: 'device-1',
    sessionId: 'editor-1',
    schemaVersion: 1,
  });

  it('refuses a TextEdited whose step adds a javascript: link', () => {
    const b = setup();
    const ok = new Transform(b.doc('d')).addMark(1, 6, link('https://example.com'));
    const step = ok.steps[0]!.toJSON() as { mark: { attrs: { href: string } } };
    step.mark.attrs.href = 'javascript:alert(1)';
    const draft = {
      ...envelope(b),
      type: 'TextEdited',
      payload: {
        documentId: 'd',
        baseVersion: b.version('d'),
        steps: [step],
        runs: [{ steps: 1, method: 'typed' }],
        timeline: [{ t: 0, kind: 'format', len: 0 }],
        characters: 0,
        durationMs: 0,
      },
    } as unknown as CommitDraft;
    const r = validateDraft(b.state, draft, human);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe('invalid-step');
    // The same step with an allowed href is accepted.
    step.mark.attrs.href = 'https://example.com';
    expect(validateDraft(b.state, draft, human).ok).toBe(true);
  });

  it('refuses an import whose content carries a bad href', () => {
    const b = setup();
    const draft = {
      ...envelope(b),
      type: 'DocumentImported',
      payload: {
        documentId: 'd2',
        kind: 'manuscript',
        title: 'Imported',
        parentId: null,
        index: 1,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'x',
                  marks: [{ type: 'link', attrs: { href: 'data:text/html,hi' } }],
                },
              ],
            },
          ],
        },
        sourceFormat: 'markdown',
        sourceName: 'x.md',
        sourceHash: '0'.repeat(64),
      },
    } as unknown as CommitDraft;
    expect(validateDraft(b.state, draft, human).ok).toBe(false);
    const mark = (
      draft.payload as unknown as {
        content: { content: [{ content: [{ marks: [{ attrs: { href: string } }] }] }] };
      }
    ).content.content[0].content[0].marks[0];
    mark.attrs.href = 'https://example.com';
    expect(validateDraft(b.state, draft, human).ok).toBe(true);
  });
});
