import MarkdownIt from 'markdown-it';
import footnotePlugin from 'markdown-it-footnote';
import type { PMNodeJSON } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import { goldenInput } from './fixtures.test-helpers';
import { exportMarkdown } from './markdown';
import type { ExportInput } from './types';

const md = new MarkdownIt({ html: true }).use(footnotePlugin);
const html = (markdown: string): string => md.render(markdown);

const one = (...content: PMNodeJSON[]): ExportInput => ({
  project: { title: 'T' },
  documents: [{ title: 'D', content: { type: 'doc', content } }],
  options: { titleBlock: false },
});
const p = (...content: PMNodeJSON[]): PMNodeJSON => ({ type: 'paragraph', content });
const t = (text: string, ...marks: string[]): PMNodeJSON =>
  marks.length
    ? { type: 'text', text, marks: marks.map((type) => ({ type })) }
    : { type: 'text', text };

describe('exportMarkdown', () => {
  it('matches the golden snapshot (author-date)', async () => {
    await expect(exportMarkdown(goldenInput())).toMatchFileSnapshot('__snapshots__/golden.md.snap');
  });

  it('matches the golden snapshot (numbered, all sources, no title block)', async () => {
    const out = exportMarkdown(
      goldenInput({
        provenance: null,
        options: { citationStyle: 'numbered', titleBlock: false, bibliography: { include: 'all' } },
      }),
    );
    await expect(out).toMatchFileSnapshot('__snapshots__/golden-numbered.md.snap');
  });

  it('parses back to the intended structure', () => {
    const out = html(exportMarkdown(goldenInput()));
    expect(out).toContain('<h1>The Salt Road</h1>');
    expect(out).toContain('<h2>Chapter One</h2>');
    expect(out).toContain('<h3>The Crossing</h3>');
    expect(out).toContain('<h4>A smaller heading</h4>');
    expect(out).toContain('<h5>Smallest heading</h5>');
    expect(out).toContain('The rain fell <em>sideways</em>, and <strong>nobody</strong> spoke.');
    expect(out).toContain('<strong>very <em>very</em></strong> <em>late</em>.');
    expect(out).toContain('Line one of a poem<br>\nline two');
    // Writer text that looks like Markdown stays literal.
    expect(out).toContain(
      '<p># not a heading, *not emphasis*, 1. not a list, [not](a link) and &lt;b&gt;not html&lt;/b&gt; &amp; so on_</p>',
    );
    expect(out).toContain('<p>1. Starts like a list</p>');
    expect(out).not.toContain('<a href="a link"');
    // Nested lists, including an ordered list starting at 3 inside a bullet list.
    expect(out).toMatch(/<li>\s*<p>First bullet<\/p>\s*<ol start="3">/);
    expect(out).toMatch(/<li>fourth, nested\s*<ul>\s*<li>deepest<\/li>/);
    // Two adjacent ordered lists stay separate.
    expect(out.match(/<ol>/g)?.length).toBe(2);
    // Block quote containing a list, and the quote block with its attribution.
    expect(out).toMatch(
      /<blockquote>\s*<p>A writer’s own block quote, with <em>emphasis<\/em>.<\/p>\s*<ul>/,
    );
    expect(out).toMatch(
      /<blockquote>\s*<p>A woman must have money[^<]*<\/p>\s*<p>A second quoted paragraph.<\/p>\s*<p>— Virginia Woolf, <em>A Room of One's Own<\/em>, p. 4<\/p>\s*<\/blockquote>/,
    );
    expect(out.match(/<hr>/g)?.length).toBe(2);
    // Footnotes are real footnotes, numbered across documents.
    expect(out.match(/class="footnote-ref"/g)?.length).toBe(3);
    expect(out).toContain(
      'Or so the <em>logbook</em> says.<br>\nSecond line, citing (Smith and Jones 2019, p. 50).',
    );
    expect(out).toContain(
      'Third footnote, <strong>strongly</strong> put, citing (Okafor et al. 2001, ch. 2).',
    );
    // Citations and bibliography.
    expect(out).toContain('As Woolf argued (Woolf 1929, p. 12), a writer needs a room');
    expect(out).toContain(
      '<p>Smith, Ada, and Ben Jones. 2019. “Salt and Memory.” <em>Journal of Coastal History</em> 12(3): 45–67.',
    );
    // Provenance tables.
    expect(out).toContain('<td>Typed from a suggestion</td>');
    expect(out).toContain('<th>The record proves</th>');
    expect(out).toContain('Verify at https://longhand.example/verify<br>\nHead hash: 0123abcd');
  });

  it('keeps numbered citations readable and unlinked', () => {
    const markdown = exportMarkdown(goldenInput({ options: { citationStyle: 'numbered' } }));
    expect(markdown).toContain('As Woolf argued [2, p. 12], a writer');
    expect(markdown).toContain('[1] Smith, Ada');
    // The only links are the footnote references and back-references.
    expect(html(markdown)).not.toMatch(/<a href="(?!#fn)/);
  });

  it('moves whitespace outside emphasis delimiters', () => {
    const out = exportMarkdown(one(p(t('a'), t(' b ', 'em'), t('c'))));
    expect(out).toBe('a *b* c\n');
    expect(html(out)).toBe('<p>a <em>b</em> c</p>\n');
  });

  it('closes and reopens emphasis around hard breaks', () => {
    const out = exportMarkdown(one(p(t('one', 'em'), { type: 'hard_break' }, t('two', 'em'))));
    expect(out).toBe('*one*\\\n*two*\n');
  });

  it('escapes line-start syntax after a hard break', () => {
    const out = exportMarkdown(
      one(
        p(
          t('x'),
          { type: 'hard_break' },
          t('- y'),
          { type: 'hard_break' },
          t('==='),
          { type: 'hard_break' },
          t('> z'),
        ),
      ),
    );
    expect(html(out)).toBe('<p>x<br>\n- y<br>\n===<br>\n&gt; z</p>\n');
  });

  it('escapes hashes in headings and footnote-like brackets', () => {
    const out = exportMarkdown(
      one(
        { type: 'heading', attrs: { level: 1 }, content: [t('Issue #5 #')] },
        p(t('see [^1] and [x]: y')),
      ),
    );
    const rendered = html(out);
    expect(rendered).toContain('<h1>Issue #5 #</h1>');
    expect(rendered).toContain('<p>see [^1] and [x]: y</p>');
  });

  it('renders a custom scene break that is not a thematic break as text', () => {
    const out = exportMarkdown({
      ...one({ type: 'scene_break' }),
      options: { titleBlock: false, sceneBreak: '#' },
    });
    expect(html(out)).toBe('<p>#</p>\n');
  });

  it('renders an empty document as a title only', () => {
    const out = exportMarkdown({
      project: { title: 'Empty' },
      documents: [{ title: 'D', content: { type: 'doc', content: [{ type: 'paragraph' }] } }],
    });
    expect(out).toBe('# Empty\n');
  });
});
