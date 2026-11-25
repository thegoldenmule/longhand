import { docFromJSON, schema } from '@longhand/schema';
import { EditorState, TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { docOf } from './test/helpers';
import { countDocumentWords, countingText, countSelectionWords, WordCounter } from './wordCount';

const withFootnote = docFromJSON({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'The rain fell' },
        { type: 'footnote', content: [{ type: 'text', text: 'Mostly sideways.' }] },
        { type: 'text', text: ' all night.' },
      ],
    },
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Part two' }] },
  ],
});

function memoryStorage(): {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

describe('word counts', () => {
  it('counts document words including footnotes, without fusing notes to words', () => {
    expect(countingText(withFootnote)).toBe(
      'The rain fell  all night.\nPart two\nMostly sideways.',
    );
    expect(countDocumentWords(withFootnote)).toBe(9);
  });

  it('counts the selection', () => {
    const doc = docOf("Don't stop me now", 'well-known 3.14');
    const state = EditorState.create({ doc, schema, selection: TextSelection.create(doc, 1, 14) });
    expect(countSelectionWords(state)).toBe(3);
    const all = EditorState.create({
      doc,
      schema,
      selection: TextSelection.create(doc, 1, doc.content.size - 1),
    });
    expect(countSelectionWords(all)).toBe(6);
    expect(countSelectionWords(EditorState.create({ doc, schema }))).toBe(0);
  });

  it('tracks session words and daily progress from a stored baseline', () => {
    const storage = memoryStorage();
    const start = docOf('one two three');
    const counter = new WordCounter(start, {
      documentId: 'd',
      dailyGoal: 10,
      storage,
      today: () => '2026-11-24',
    });
    const later = EditorState.create({ doc: docOf('one two three four five'), schema });
    expect(counter.counts(later)).toMatchObject({
      document: 5,
      session: 2,
      daily: { goal: 10, written: 2, progress: 0.2 },
    });

    // A second editor the same day keeps counting from the morning baseline.
    const again = new WordCounter(later.doc, {
      documentId: 'd',
      dailyGoal: 10,
      storage,
      today: () => '2026-11-24',
    });
    const evening = EditorState.create({ doc: docOf('one two three four five six'), schema });
    expect(again.counts(evening)).toMatchObject({ session: 1, daily: { written: 3 } });

    // Deleting never makes session count negative.
    expect(again.counts(EditorState.create({ doc: docOf('one'), schema })).session).toBe(0);
  });

  it('uses an explicit daily baseline and reports no goal when unset', () => {
    const c = new WordCounter(docOf('a b'), {
      documentId: 'd',
      dailyBaseline: 100,
      dailyGoal: 500,
      storage: null,
    });
    expect(c.counts(EditorState.create({ doc: docOf('a b c'), schema })).daily).toEqual({
      goal: 500,
      written: 101,
      progress: 101 / 500,
    });
    c.setGoal(null);
    expect(c.counts(EditorState.create({ doc: docOf('a b c'), schema })).daily).toBeNull();
  });
});
