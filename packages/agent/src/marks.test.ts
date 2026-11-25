import { docFromJSON, segmentDoc, type PMNodeJSON } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { blockFormatting, formattingNote } from './format';
import { buildReviewContext, InMemoryAnnotationSink, ToolExecutor } from './index';
import { deterministic, docRequest, makeState } from './fixtures.test-helpers';

const link = (href: string) => ({ type: 'link', attrs: { href } });

/** Chapter 1 with a link (across an emphasis change), inline code, and a footnote with a link. */
const CONTENT: PMNodeJSON = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'The Storm' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'She read ' },
        { type: 'text', text: 'the harbour ', marks: [link('https://example.org/log')] },
        {
          type: 'text',
          text: 'log',
          marks: [link('https://example.org/log'), { type: 'em' }],
        },
        { type: 'text', text: ' twice. Then she typed ' },
        { type: 'text', text: 'rm -rf', marks: [{ type: 'code' }] },
        { type: 'text', text: ' and stopped.' },
        {
          type: 'footnote',
          content: [
            { type: 'text', text: 'See ' },
            { type: 'text', text: 'the notes', marks: [link('mailto:ada@example.com')] },
            { type: 'text', text: '.' },
          ],
        },
      ],
    },
  ],
};

function state() {
  const s = makeState();
  s.documents.ch1 = { ...s.documents.ch1!, content: CONTENT };
  return s;
}

describe('the AI reads links and inline code as readable text', () => {
  it('keeps sentences plain and lists each block’s links and code after it', () => {
    const ctx = buildReviewContext({
      state: state(),
      request: docRequest(),
      feedbackSessionId: 'fs',
    });
    const t = ctx.sections.target;
    expect(t).toContain(
      '[p2] [p2.s1] She read the harbour log twice. [p2.s2] Then she typed rm -rf and stopped. [links: "the harbour log" <https://example.org/log>] [inline code: "rm -rf"]',
    );
    expect(t).toContain('[links: "the notes" <mailto:ada@example.com>]');
    // The heading has neither, so it carries no note.
    expect(t).toContain('[p1 · heading 1] [p1.s1] The Storm\n');
    // Ids are still exactly the segmenter's.
    const seg = segmentDoc(docFromJSON(CONTENT));
    const shown = [...t.matchAll(/\[(p\d+\.s\d+|fn\d+\.s\d+)\]/g)].map((m) => m[1]);
    expect(shown).toEqual([...seg.sentences.map((s) => s.id)]);
  });

  it('serves the same rendering from read_document, and quotes of linked words resolve', async () => {
    const ctx = buildReviewContext({
      state: state(),
      request: docRequest(),
      feedbackSessionId: 'fs',
    });
    const sink = new InMemoryAnnotationSink();
    const ex = new ToolExecutor({ snapshot: ctx.snapshot, sink, ...deterministic() });
    const doc = await ex.call('read_document', { documentId: 'ch1' });
    expect(doc.result.ok && doc.result.content).toContain('<https://example.org/log>');
    const comment = (quote: string) => ({
      anchor: { documentId: 'ch1', sentenceId: 'p2.s1', quote },
      category: 'clarity',
      severity: 'minor',
      body: 'Name the log once, early.',
    });
    const o = await ex.call('comment', comment('the harbour log'));
    expect(o.result.ok).toBe(true);
    // A quote that includes the href is not manuscript text.
    const bad = await ex.call('comment', comment('example.org'));
    expect(bad.result.ok).toBe(false);
    expect(sink.drafts).toHaveLength(1);
  });

  it('merges a link split by other marks and skips empty runs', () => {
    const node = docFromJSON(CONTENT);
    const seg = segmentDoc(node);
    const f = blockFormatting(node, seg.blocks[1]!);
    expect(f).toEqual({
      links: [{ text: 'the harbour log', href: 'https://example.org/log' }],
      code: ['rm -rf'],
    });
    expect(formattingNote({ links: [], code: [] })).toBe('');
  });
});
