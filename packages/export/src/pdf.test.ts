import type { PMNodeJSON } from '@longhand/schema';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { goldenInput } from './fixtures.test-helpers';
import { exportPdf } from './pdf';
import type { ExportInput } from './types';

interface Parsed {
  pages: string[];
  numPages: number;
  info: Record<string, unknown>;
  outline: string[];
  pageSize: number[];
}

async function parse(bytes: Uint8Array): Promise<Parsed> {
  const task = getDocument({ data: bytes.slice() });
  const pdf = await task.promise;
  const pages: string[] = [];
  let pageSize: number[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    if (i === 1) pageSize = [...page.view];
    const tc = await page.getTextContent();
    pages.push(
      tc.items
        .map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : ''))
        .join('')
        .replace(/[ \u00A0]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .trim(),
    );
  }
  const meta = await pdf.getMetadata();
  const outline = ((await pdf.getOutline()) ?? []).map((o) => o.title);
  const numPages = pdf.numPages;
  await task.destroy();
  return { pages, numPages, info: meta.info as Record<string, unknown>, outline, pageSize };
}

/** Text with line breaks folded to spaces, for phrase searches across wrapped lines. */
const flat = (s: string): string => s.replace(/\n/g, ' ');
const pageOf = (parsed: Parsed, phrase: string): number =>
  parsed.pages.findIndex((p) => flat(p).includes(phrase));

const CREATED = new Date('2026-11-24T12:00:00.000Z');

describe('exportPdf (golden documents)', () => {
  let bytes: Uint8Array;
  let parsed: Parsed;
  beforeAll(async () => {
    bytes = await exportPdf(goldenInput(), { creationDate: CREATED });
    parsed = await parse(bytes);
  });

  it('is a PDF with metadata, letter pages and bookmarks', () => {
    expect(new TextDecoder('latin1').decode(bytes.subarray(0, 8))).toBe('%PDF-1.7');
    expect(parsed.pageSize).toEqual([0, 0, 612, 792]);
    expect(parsed.info.Title).toBe('The Salt Road');
    expect(parsed.info.Author).toBe('Jane Writer');
    expect(parsed.outline).toEqual([
      'Chapter One',
      'Chapter Two',
      'Afterword',
      'Bibliography',
      'Provenance',
    ]);
  });

  it('has a title page, then each document, the bibliography and the appendix on new pages', () => {
    expect(parsed.numPages).toBe(7);
    expect(parsed.pages[0]).toBe(
      'The Salt Road\nA Novel in Three Parts\nJane Writer\nNovember 2026',
    );
    expect(pageOf(parsed, 'Chapter One')).toBe(1);
    expect(pageOf(parsed, 'Chapter Two')).toBe(3);
    expect(pageOf(parsed, 'Afterword')).toBe(4);
    expect(pageOf(parsed, 'Bibliography')).toBe(5);
    expect(pageOf(parsed, 'Provenance')).toBe(6);
  });

  it('numbers pages from the first page after the title page', () => {
    // The folio is the last text drawn on each page.
    expect(parsed.pages.slice(1).map((p) => p.split('\n').at(-1))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    expect(parsed.pages[0]).not.toMatch(/\n\d+$/);
  });

  it('embeds EB Garamond in regular, italic and bold faces', () => {
    const raw = new TextDecoder('latin1').decode(bytes);
    for (const face of ['EBGaramond-Regular', 'EBGaramond-Italic', 'EBGaramond-SemiBold']) {
      expect(raw, face).toContain(face);
    }
  });

  it('renders every block type, in order', () => {
    const text = flat(parsed.pages.slice(1, 3).join('\n'));
    const order = [
      'The Crossing',
      'The rain fell sideways, and nobody spoke. It was very very late.',
      'Line one of a poem',
      'line two, after a hard break.',
      'A smaller heading',
      'As Woolf argued (Woolf 1929, p. 12), a writer needs a room; others disagree (Smith and Jones 2019).',
      '# not a heading, *not emphasis*, 1. not a list, [not](a link) and <b>not html</b> & so on_',
      '1. Starts like a list',
      'Smallest heading',
      'A writer’s own block quote, with emphasis.',
      '• a list inside the quote',
      '* * *',
      '• First bullet',
      '3. third, nested',
      '4. fourth, nested',
      'deepest',
      '• Second bullet',
      'A woman must have money and a room of her own if she is to write fiction.',
      'A second quoted paragraph.',
      "— Virginia Woolf, A Room of One's Own, p. 4",
      'After the quote.',
    ];
    let at = 0;
    for (const phrase of order) {
      const i = text.indexOf(phrase, at);
      expect(i, phrase).toBeGreaterThanOrEqual(0);
      at = i + phrase.length;
    }
  });

  it('places footnotes at the foot of the page that references them', () => {
    const ref = pageOf(parsed, 'It was very very late.1');
    expect(ref).toBe(1);
    expect(pageOf(parsed, '1 Or so the logbook says.')).toBe(ref);
    expect(pageOf(parsed, 'Second line, citing (Smith and Jones 2019, p. 50).')).toBe(ref);
    expect(pageOf(parsed, 'After the quote.2')).toBe(pageOf(parsed, '2 A second footnote.'));
    expect(pageOf(parsed, 'Chapter two opens3 with a footnote.')).toBe(
      pageOf(parsed, '3 Third footnote, strongly put, citing (Okafor et al. 2001, ch. 2).'),
    );
  });

  it('renders the bibliography and the provenance appendix', () => {
    const bib = flat(parsed.pages[5] as string);
    expect(bib).toContain(
      'Smith, Ada, and Ben Jones. 2019. “Salt and Memory.” Journal of Coastal History 12(3): 45–67.',
    );
    expect(bib).toContain("Woolf, Virginia. 1929. A Room of One's Own. London: Hogarth Press.");
    const app = parsed.pages[6] as string;
    expect(app).toContain('Typed from a suggestion 21 1.6%');
    expect(app).toContain('Total 1,282 100.0%');
    expect(app).toContain('The record proves It does not prove');
    expect(app).toContain('Verify at https://longhand.example/verify\nHead hash: 0123abcd');
  });
});

describe('exportPdf layout', () => {
  const lorem =
    'It was a bright cold day in April, and the clocks were striking thirteen, and the wind blew grit along the street.';
  const para = (...content: PMNodeJSON[]): PMNodeJSON => ({ type: 'paragraph', content });
  const text = (t: string): PMNodeJSON => ({ type: 'text', text: t });
  const input = (content: PMNodeJSON[], extra: Partial<ExportInput> = {}): ExportInput => ({
    project: { title: 'Layout' },
    documents: [{ title: 'Doc', content: { type: 'doc', content } }],
    options: { titleBlock: false },
    ...extra,
  });

  it('continues a long footnote on the next page, keeping all its text', async () => {
    const longNote = Array.from(
      { length: 40 },
      (_, i) => `Sentence ${i + 1} of the long note.`,
    ).join(' ');
    const content: PMNodeJSON[] = [];
    for (let i = 0; i < 14; i++) content.push(para(text(`Paragraph ${i + 1}. ${lorem}`)));
    content.push(
      para(text('The paragraph with the long note.'), {
        type: 'footnote',
        content: [text(longNote)],
      }),
    );
    for (let i = 0; i < 4; i++) content.push(para(text(`Tail ${i + 1}. ${lorem}`)));
    const parsed = await parse(await exportPdf(input(content), { pageSize: 'a5' }));
    const ref = pageOf(parsed, 'The paragraph with the long note.1');
    expect(ref).toBeGreaterThanOrEqual(0);
    expect(pageOf(parsed, '1 Sentence 1 of the long note.')).toBe(ref);
    expect(pageOf(parsed, 'Sentence 40 of the long note.')).toBeGreaterThan(ref);
    const all = flat(parsed.pages.join(' '));
    // The note may break mid-sentence at the page boundary.
    for (let i = 1; i <= 40; i++) expect(all).toContain(`Sentence ${i} of the`);
    for (let i = 1; i <= 4; i++) expect(all).toContain(`Tail ${i}.`);
  });

  it('breaks words longer than a line without losing characters', async () => {
    const url = `https://example.org/${'segment/'.repeat(30)}end`;
    const parsed = await parse(await exportPdf(input([para(text(`See ${url} for more.`))])));
    expect(parsed.pages.join('').replace(/\s+/g, '')).toContain(`See${url}formore.`);
  });

  it('honours page size and single-document defaults', async () => {
    const parsed = await parse(
      await exportPdf(input([para(text('Only text.'))]), { pageSize: 'trade' }),
    );
    expect(parsed.pageSize).toEqual([0, 0, 432, 648]);
    expect(parsed.numPages).toBe(1);
    expect(parsed.pages[0]).toBe('Only text.\n1');
  });

  it('still produces a page for an empty export', async () => {
    const parsed = await parse(
      await exportPdf({
        project: { title: 'Empty' },
        documents: [],
        options: { titleBlock: false },
      }),
    );
    expect(parsed.numPages).toBe(1);
  });

  it('is reproducible with a fixed creation date', async () => {
    const a = await exportPdf(goldenInput(), { creationDate: CREATED });
    const b = await exportPdf(goldenInput(), { creationDate: CREATED });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
