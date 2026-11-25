// Test-only golden documents. Together they use every node and mark type in the
// Longhand schema, nested lists, footnotes (with marks, breaks and citations
// inside), citations with and without locators, quote blocks and several documents.
import type { CslItem, PMNodeJSON, ProvenanceSummary } from '@longhand/schema';
import type { ExportInput } from './types';

type MarkArg = 'em' | 'strong' | 'code' | { link: string };
const t = (text: string, ...marks: MarkArg[]): PMNodeJSON =>
  marks.length > 0
    ? {
        type: 'text',
        text,
        marks: marks.map((m) =>
          typeof m === 'string' ? { type: m } : { type: 'link', attrs: { href: m.link } },
        ),
      }
    : { type: 'text', text };
const p = (...content: PMNodeJSON[]): PMNodeJSON =>
  content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
const h = (level: 1 | 2 | 3, text: string): PMNodeJSON => ({
  type: 'heading',
  attrs: { level },
  content: [t(text)],
});
const li = (...content: PMNodeJSON[]): PMNodeJSON => ({ type: 'list_item', content });
const ul = (...items: PMNodeJSON[]): PMNodeJSON => ({ type: 'bullet_list', content: items });
const ol = (order: number, ...items: PMNodeJSON[]): PMNodeJSON => ({
  type: 'ordered_list',
  attrs: { order },
  content: items,
});
const br: PMNodeJSON = { type: 'hard_break' };
const cite = (sourceId: string, locator: string | null = null): PMNodeJSON => ({
  type: 'citation',
  attrs: { sourceId, locator },
});
const fn = (...content: PMNodeJSON[]): PMNodeJSON => ({ type: 'footnote', content });

export const SOURCES: CslItem[] = [
  {
    id: 'woolf',
    type: 'book',
    title: "A Room of One's Own",
    author: [{ family: 'Woolf', given: 'Virginia' }],
    issued: { 'date-parts': [[1929]] },
    publisher: 'Hogarth Press',
    'publisher-place': 'London',
  },
  {
    id: 'smith-jones',
    type: 'article-journal',
    title: 'Salt and Memory',
    'container-title': 'Journal of Coastal History',
    author: [
      { family: 'Smith', given: 'Ada' },
      { family: 'Jones', given: 'Ben' },
    ],
    issued: { 'date-parts': [[2019, 4]] },
    volume: 12,
    issue: 3,
    page: '45-67',
    DOI: '10.1000/xyz123',
  },
  {
    id: 'collected',
    type: 'book',
    title: 'Tides: Collected Essays',
    editor: [
      { family: 'Okafor', given: 'Chidi' },
      { family: 'Lind', given: 'Maja' },
      { family: 'Park', given: 'Soo' },
    ],
    issued: { raw: 'Spring 2001' },
    publisher: 'Harbour Books',
  },
  {
    id: 'web',
    type: 'webpage',
    title: 'Salt Roads of the North',
    URL: 'https://example.org/salt',
  },
  {
    id: 'uncited',
    type: 'book',
    title: 'An Uncited Book',
    author: [{ literal: 'Anonymous Collective' }],
    issued: { 'date-parts': [[1880]] },
  },
];

export const CHAPTER_ONE: PMNodeJSON = {
  type: 'doc',
  content: [
    h(1, 'The Crossing'),
    p(
      t('The rain fell '),
      t('sideways', 'em'),
      t(', and '),
      t('nobody', 'strong'),
      t(' spoke. It was '),
      t('very ', 'strong'),
      t('very', 'strong', 'em'),
      t(' late', 'em'),
      t('.'),
      fn(
        t('Or so the '),
        t('logbook', 'em'),
        t(' says.'),
        br,
        t('Second line, citing '),
        cite('smith-jones', '50'),
        t('.'),
      ),
    ),
    p(t('Line one of a poem'), br, t('line two, after a hard break.')),
    h(2, 'A smaller heading'),
    p(
      t('As Woolf argued '),
      cite('woolf', '12'),
      t(', a writer needs a room; others disagree '),
      cite('smith-jones'),
      t('.'),
    ),
    p(
      t(
        '# not a heading, *not emphasis*, 1. not a list, [not](a link) and <b>not html</b> & so on_',
      ),
    ),
    p(t('1. Starts like a list')),
    p(),
    h(3, 'Smallest heading'),
    {
      type: 'blockquote',
      content: [
        p(t('A writer’s own block quote, with '), t('emphasis', 'em'), t('.')),
        ul(li(p(t('a list inside the quote'))), li(p(t('second item')))),
      ],
    },
    { type: 'scene_break' },
    ul(
      li(
        p(t('First bullet')),
        ol(3, li(p(t('third, nested'))), li(p(t('fourth, nested')), ul(li(p(t('deepest')))))),
      ),
      li(p(t('Second bullet'))),
    ),
    {
      type: 'quote_block',
      attrs: { sourceId: 'woolf', clippingId: 'clip1', locator: '4' },
      content: [
        p(t('A woman must have money and a room of her own if she is to write fiction.')),
        p(t('A second quoted paragraph.')),
      ],
    },
    p(t('After the quote.'), fn(t('A second footnote.'))),
  ],
};

export const CHAPTER_TWO: PMNodeJSON = {
  type: 'doc',
  content: [
    p(
      t('Chapter two opens'),
      fn(
        t('Third footnote, '),
        t('strongly', 'strong'),
        t(' put, citing '),
        cite('collected', 'ch. 2'),
        t('.'),
      ),
      t(' with a footnote.'),
    ),
    ol(
      1,
      li(p(t('A loose item')), p(t('with a second paragraph.'))),
      li(p(t('Another item, citing the web '), cite('web'), t('.'))),
    ),
    ol(1, li(p(t('A separate list right after.')))),
    { type: 'scene_break' },
    p(t('Woolf again '), cite('woolf', '20-24'), t('.')),
  ],
};

export const AFTERWORD: PMNodeJSON = {
  type: 'doc',
  content: [
    p(t('A short afterword.')),
    p(
      t('Notes live in '),
      t('the archive', { link: 'https://example.org/archive_(2026)' }),
      t(', and '),
      t('the ', 'em', { link: 'mailto:jane@example.org' }),
      t('editor', 'strong', 'em', { link: 'mailto:jane@example.org' }),
      t(' answers. Build it with '),
      t('make `book`', 'code'),
      t(' or see '),
      t('README', 'code', { link: 'https://example.org/readme' }),
      t('.'),
    ),
  ],
};

export const PROVENANCE: ProvenanceSummary = {
  wordsByClass: {
    typed: 1234,
    'typed-from-suggestion': 21,
    'pasted-external': 8,
    'pasted-internal': 0,
    imported: 0,
    quoted: 19,
  },
  disclosure:
    'Written in 3 sessions over 2 days. 96.3% typed directly; 1.6% retyped from 2 AI word-choice suggestions; 0.6% pasted.',
  provesTable: {
    proves: ['The text came in through the editor’s input channel', 'The history hasn’t changed'],
    doesNotProve: ['That the account holder was the one typing'],
  },
  verificationNote: 'Verify at https://longhand.example/verify\nHead hash: 0123abcd',
};

export function goldenInput(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    project: {
      title: 'The Salt Road',
      subtitle: 'A Novel in Three Parts',
      author: 'Jane Writer',
      date: 'November 2026',
    },
    documents: [
      { id: 'd1', title: 'Chapter One', content: CHAPTER_ONE },
      { id: 'd2', title: 'Chapter Two', content: CHAPTER_TWO },
      { id: 'd3', title: 'Afterword', content: AFTERWORD },
    ],
    sources: SOURCES,
    provenance: PROVENANCE,
    ...overrides,
  };
}
