import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadFixture } from '@longhand/ledger/fixtures';
import { formatBibliography, formatCitation } from '@longhand/research';
import type { CslItem } from '@longhand/schema';
import { cslFormatters, htmlToSpans } from '../src/research/export';
import { startTestServer, type TestServer } from '../src/testing';
import { DB, fixtureHooks, replayFixture, replaySigner } from './helpers';

const items: CslItem[] = [
  {
    id: 'src-1',
    type: 'article-journal',
    title: 'Deep learning',
    author: [
      { family: 'LeCun', given: 'Yann' },
      { family: 'Bengio', given: 'Yoshua' },
      { family: 'Hinton', given: 'Geoffrey' },
    ],
    'container-title': 'Nature',
    volume: '521',
    page: '436-444',
    issued: { 'date-parts': [[2015]] },
  } as CslItem,
];

describe('CSL formatter adapter', () => {
  it('renders citations and bibliography entries with the research lane’s citeproc', () => {
    const f = cslFormatters(items, 'apa');
    const ctx = { source: items[0], number: 1, inFootnote: false, documentIndex: 0 };
    expect(f.formatCitation('src-1', 'p. 437', ctx)).toBe(
      formatCitation(items, 'src-1', 'p. 437', 'apa').text,
    );
    const spans = f.formatBibliographyEntry(items[0]!, { number: null });
    expect(Array.isArray(spans)).toBe(true);
    const text = (spans as Array<{ text: string; italic?: boolean }>).map((s) => s.text).join('');
    expect(text).toBe(formatBibliography(items, 'apa', ['src-1']).entries[0]!.text);
    expect(
      (spans as Array<{ text: string; italic?: boolean }>).some(
        (s) => s.italic && s.text.includes('Nature'),
      ),
    ).toBe(true);
    expect(cslFormatters(items, 'mla').formatCitation('src-1', null, ctx)).toMatch(/LeCun/);
  });

  it('formats numeric CSL fields (volume: 521) without a workaround', () => {
    const numeric = [{ ...items[0], volume: 521 } as unknown as CslItem];
    const f = cslFormatters(numeric, 'apa');
    const spans = f.formatBibliographyEntry(numeric[0]!, { number: null });
    const text = (spans as Array<{ text: string }>).map((s) => s.text).join('');
    expect(text).toContain('521');
  });

  it('turns citeproc HTML into spans', () => {
    expect(htmlToSpans('<div class="csl-entry">A &amp; B. <i>Title</i>. <b>x</b></div>')).toEqual([
      { text: 'A & B. ' },
      { text: 'Title', italic: true },
      { text: '. ' },
      { text: 'x', bold: true },
    ]);
  });
});

describe.skipIf(!DB())('export downloads', () => {
  let t: TestServer;
  const f = loadFixture('research');
  const P = f.commits[0]!.projectId;
  beforeAll(async () => {
    t = await startTestServer({
      signer: replaySigner(f),
      hooks: fixtureHooks(f),
      autoStartSessions: false,
    });
    await replayFixture(t, f);
  });
  afterAll(async () => {
    await t?.close();
  });

  it('downloads Markdown with CSL citations and a bibliography', async () => {
    const res = await fetch(`${t.url}/v1/projects/${P}/export?format=md`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/markdown/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename=".+\.md"/);
    const md = await res.text();
    const state = f.expected.state;
    expect(md).toContain(`# ${state.settings.title}`);
    // In-text citation and bibliography entry as citeproc (APA) renders them, not export's fallback.
    const okafor = state.sources['src-okafor']!;
    const item = { ...okafor.csl, id: okafor.id } as CslItem;
    expect(md).toContain(formatCitation([item], 'src-okafor', 'p. 114', 'apa').text);
    expect(md).toContain('(Okafor, 2014, p. 114)');
    expect(md).toContain('## Bibliography');
    expect(md).toContain(
      'Okafor, N. (2014). Rainfall Records of the Upper Valley, 1900–2010. *Journal of Regional Climate*',
    );
  });

  it('downloads DOCX and PDF, and validates the request', async () => {
    const docx = await fetch(`${t.url}/v1/projects/${P}/export?format=docx`);
    expect(docx.status).toBe(200);
    const bytes = new Uint8Array(await docx.arrayBuffer());
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK');
    const pdf = await fetch(`${t.url}/v1/projects/${P}/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        format: 'pdf',
        provenance: {
          wordsByClass: { typed: 10 },
          disclosure: 'Typed by hand.',
          provesTable: { proves: ['a'], doesNotProve: ['b'] },
        },
      }),
    });
    expect(pdf.status).toBe(200);
    expect(
      Buffer.from(await pdf.arrayBuffer())
        .subarray(0, 5)
        .toString(),
    ).toBe('%PDF-');
    expect((await fetch(`${t.url}/v1/projects/${P}/export?format=rtf`)).status).toBe(400);
    expect((await fetch(`${t.url}/v1/projects/${P}/export?format=md&documents=nope`)).status).toBe(
      404,
    );
  });
});
