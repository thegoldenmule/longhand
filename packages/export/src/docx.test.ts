import { strFromU8, unzipSync } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { exportDocx } from './docx';
import { goldenInput } from './fixtures.test-helpers';

type Parts = Record<string, string>;

async function unzipDocx(bytes: Uint8Array): Promise<Parts> {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

/** Paragraphs of a part as `{style, text}`, in order (text includes footnote refs as `[^n]`). */
function paragraphs(xml: string): { style: string | null; text: string; xml: string }[] {
  return [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>|<w:p [^>]*>([\s\S]*?)<\/w:p>/g)].map((m) => {
    const body = m[1] ?? m[2] ?? '';
    const style = /<w:pStyle w:val="([^"]+)"\/>/.exec(body)?.[1] ?? null;
    const text = [
      ...body.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>|<w:footnoteReference w:id="(\d+)"\/>|<w:br\/>/g),
    ]
      .map((t) => (t[1] !== undefined ? t[1] : t[2] !== undefined ? `[^${t[2]}]` : '\n'))
      .join('')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    return { style, text, xml: body };
  });
}

describe('exportDocx', () => {
  let parts: Parts;
  let body: ReturnType<typeof paragraphs>;
  beforeAll(async () => {
    parts = await unzipDocx(await exportDocx(goldenInput()));
    body = paragraphs(parts['word/document.xml'] as string);
  });

  const find = (text: string) => {
    const p = body.find((b) => b.text.includes(text));
    if (!p) throw new Error(`no paragraph contains ${JSON.stringify(text)}`);
    return p;
  };

  it('is a Word document with the expected parts', () => {
    for (const part of [
      'word/document.xml',
      'word/styles.xml',
      'word/footnotes.xml',
      'word/numbering.xml',
      'docProps/core.xml',
      '[Content_Types].xml',
    ]) {
      expect(parts[part], part).toBeDefined();
    }
    expect(parts['docProps/core.xml']).toContain('<dc:title>The Salt Road</dc:title>');
    expect(parts['docProps/core.xml']).toContain('<dc:creator>Jane Writer</dc:creator>');
  });

  it('uses Title and Heading styles, shifting document headings below document titles', () => {
    expect(find('The Salt Road').style).toBe('Title');
    expect(find('A Novel in Three Parts').style).toBe('Subtitle');
    expect(find('Chapter One').style).toBe('Heading1');
    expect(find('Chapter One').xml).toContain('<w:pageBreakBefore/>');
    expect(find('The Crossing').style).toBe('Heading2');
    expect(find('A smaller heading').style).toBe('Heading3');
    expect(find('Smallest heading').style).toBe('Heading4');
    expect(find('Bibliography').style).toBe('Heading1');
    expect(find('Provenance').style).toBe('Heading1');
  });

  it('keeps document headings at Heading 1–3 for a single untitled document', async () => {
    const one = goldenInput();
    one.documents = one.documents.slice(0, 1);
    const ps = paragraphs((await unzipDocx(await exportDocx(one)))['word/document.xml'] as string);
    expect(ps.find((p) => p.text === 'The Crossing')?.style).toBe('Heading1');
    expect(ps.find((p) => p.text === 'Smallest heading')?.style).toBe('Heading3');
    expect(ps.some((p) => p.text === 'Chapter One')).toBe(false);
  });

  it('renders marks as run properties without overriding styles', () => {
    const p = find('The rain fell');
    expect(p.xml).toMatch(/<w:i\/>[\s\S]*?<w:t xml:space="preserve">sideways<\/w:t>/);
    expect(p.xml).toMatch(/<w:b\/>[\s\S]*?<w:t xml:space="preserve">nobody<\/w:t>/);
    expect(p.xml).not.toContain('w:val="false"');
    expect(find('Line one of a poem').text).toBe(
      'Line one of a poem\nline two, after a hard break.',
    );
  });

  it('writes real Word footnotes, numbered across documents', () => {
    expect(find('The rain fell').text).toContain('late.[^1]');
    expect(find('After the quote.').text).toBe('After the quote.[^2]');
    expect(find('Chapter two opens').text).toBe('Chapter two opens[^3] with a footnote.');
    const fx = parts['word/footnotes.xml'] as string;
    const notes = Object.fromEntries(
      [...fx.matchAll(/<w:footnote w:id="(\d+)">([\s\S]*?)<\/w:footnote>/g)].map((m) => [
        m[1],
        paragraphs(m[2] as string),
      ]),
    );
    expect(notes['1']?.[0]?.style).toBe('FootnoteText');
    expect(notes['1']?.[0]?.text).toBe(
      'Or so the logbook says.\nSecond line, citing (Smith and Jones 2019, p. 50).',
    );
    expect(notes['2']?.[0]?.text).toBe('A second footnote.');
    expect(notes['3']?.[0]?.text).toBe(
      'Third footnote, strongly put, citing (Okafor et al. 2001, ch. 2).',
    );
    expect(fx).toContain('<w:footnoteRef/>');
  });

  it('uses Quote styles for block quotes and quote blocks, with an attribution', () => {
    expect(find('A writer’s own block quote').style).toBe('Quote');
    expect(find('A woman must have money').style).toBe('Quote');
    expect(find('A second quoted paragraph.').style).toBe('Quote');
    const attribution = find('Virginia Woolf');
    expect(attribution.style).toBe('QuoteAttribution');
    expect(attribution.text).toBe("— Virginia Woolf, A Room of One's Own, p. 4");
    const styles = parts['word/styles.xml'] as string;
    expect(styles).toMatch(/w:styleId="Quote"[\s\S]*?<w:name w:val="Quote"\/>/);
    expect(styles).toMatch(/w:styleId="QuoteAttribution"[\s\S]*?<w:jc w:val="right"\/>/);
  });

  it('centers scene breaks', () => {
    const breaks = body.filter((p) => p.style === 'SceneBreak');
    expect(breaks.map((p) => p.text)).toEqual(['* * *', '* * *']);
    expect(parts['word/styles.xml']).toMatch(
      /w:styleId="SceneBreak"[\s\S]*?<w:jc w:val="center"\/>/,
    );
  });

  it('numbers lists with real Word numbering, nested and restarting', () => {
    const third = find('third, nested');
    expect(third.xml).toContain('<w:ilvl w:val="1"/>');
    expect(find('deepest').xml).toContain('<w:ilvl w:val="2"/>');
    const num = (t: string) => /<w:numId w:val="(\d+)"\/>/.exec(find(t).xml)?.[1];
    // Separate ordered lists use separate numbering, so each restarts.
    expect(num('A loose item')).not.toBe(num('A separate list right after.'));
    const numbering = parts['word/numbering.xml'] as string;
    expect(numbering).toContain('<w:start w:val="3"/>');
    expect(find('with a second paragraph.').xml).not.toContain('<w:numId');
  });

  it('includes citations, bibliography and the provenance appendix', () => {
    expect(find('As Woolf argued').text).toBe(
      'As Woolf argued (Woolf 1929, p. 12), a writer needs a room; others disagree (Smith and Jones 2019).',
    );
    const bib = body.filter((p) => p.style === 'Bibliography').map((p) => p.text);
    expect(bib).toHaveLength(4);
    expect(bib[3]).toBe("Woolf, Virginia. 1929. A Room of One's Own. London: Hogarth Press.");
    const doc = parts['word/document.xml'] as string;
    expect(doc).toContain('<w:tbl>');
    expect(find('Written in 3 sessions').text).toContain('96.3% typed directly');
    for (const t of [
      'Typed from a suggestion',
      '1,234',
      '96.3%',
      'Total',
      '1,282',
      'The record proves',
    ]) {
      expect(
        body.some((p) => p.text === t),
        t,
      ).toBe(true);
    }
    expect(find('Verify at').text).toBe(
      'Verify at https://longhand.example/verify\nHead hash: 0123abcd',
    );
  });

  it('has page numbers in the footer, none on the title page', () => {
    const footers = Object.entries(parts).filter(([k]) => /^word\/footer\d+\.xml$/.test(k));
    expect(footers.some(([, x]) => x.includes('PAGE'))).toBe(true);
    expect(parts['word/document.xml']).toContain('<w:titlePg/>');
  });

  it('escapes writer text that looks like markup', () => {
    expect(find('# not a heading').text).toBe(
      '# not a heading, *not emphasis*, 1. not a list, [not](a link) and <b>not html</b> & so on_',
    );
  });
});
