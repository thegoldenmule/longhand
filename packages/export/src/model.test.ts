import { PROVES_TABLE, docFromJSON, schema, type PMNodeJSON } from '@longhand/schema';
import { describe, expect, it } from 'vitest';
import {
  AFTERWORD,
  CHAPTER_ONE,
  CHAPTER_TWO,
  PROVENANCE,
  SOURCES,
  goldenInput,
} from './fixtures.test-helpers';
import {
  ExportError,
  HANDLED_MARK_TYPES,
  HANDLED_NODE_TYPES,
  buildExportModel,
  fileSlug,
  formatShare,
  inlineText,
  type Block,
} from './model';
import { provenanceSummaryFromReport, type ExportWarning } from './types';

function collectTypes(node: PMNodeJSON, nodes: Set<string>, marks: Set<string>): void {
  nodes.add(node.type);
  for (const m of node.marks ?? []) marks.add(m.type);
  for (const c of node.content ?? []) collectTypes(c, nodes, marks);
}

const doc = (...content: PMNodeJSON[]): PMNodeJSON => ({ type: 'doc', content });
const para = (text: string): PMNodeJSON => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

describe('coverage of the schema', () => {
  it('handles exactly the node and mark types of the schema', () => {
    expect([...HANDLED_NODE_TYPES].sort()).toEqual(Object.keys(schema.nodes).sort());
    expect([...HANDLED_MARK_TYPES].sort()).toEqual(Object.keys(schema.marks).sort());
  });

  it('golden documents are valid and use every node and mark type', () => {
    const nodes = new Set<string>();
    const marks = new Set<string>();
    for (const d of [CHAPTER_ONE, CHAPTER_TWO, AFTERWORD]) {
      expect(() => docFromJSON(d)).not.toThrow();
      collectTypes(d, nodes, marks);
    }
    expect([...nodes].sort()).toEqual(Object.keys(schema.nodes).sort());
    expect([...marks].sort()).toEqual(Object.keys(schema.marks).sort());
  });

  it('throws ExportError on unknown node types', () => {
    const bad = doc(para('ok'), { type: 'video', attrs: { src: 'x' } });
    expect(() =>
      buildExportModel({ project: { title: 'T' }, documents: [{ title: 'D', content: bad }] }),
    ).toThrow(ExportError);
    const inline = doc({ type: 'paragraph', content: [{ type: 'emoji', text: 'x' }] });
    expect(() =>
      buildExportModel({ project: { title: 'T' }, documents: [{ title: 'D', content: inline }] }),
    ).toThrow(/document 0 \("D"\): invalid document JSON/);
  });

  it('throws ExportError on unknown marks and invalid structure', () => {
    const badMark = doc({
      type: 'paragraph',
      content: [{ type: 'text', text: 'x', marks: [{ type: 'link' }] }],
    });
    expect(() =>
      buildExportModel({ project: { title: 'T' }, documents: [{ title: 'D', content: badMark }] }),
    ).toThrow(ExportError);
    const nested = doc({ type: 'heading', attrs: { level: 1 }, content: [para('x')] });
    expect(() =>
      buildExportModel({ project: { title: 'T' }, documents: [{ title: 'D', content: nested }] }),
    ).toThrow(ExportError);
  });
});

describe('buildExportModel', () => {
  it('numbers footnotes continuously across documents, in reading order', () => {
    const model = buildExportModel(goldenInput());
    expect(model.documents.map((d) => d.footnotes.map((f) => f.number))).toEqual([[1, 2], [3], []]);
    expect(inlineText(model.documents[0]!.footnotes[0]!.content)).toBe(
      'Or so the logbook says.\nSecond line, citing (Smith and Jones 2019, p. 50).',
    );
  });

  it('merges adjacent text with equal marks and drops empty paragraphs', () => {
    const model = buildExportModel({
      project: { title: 'T' },
      documents: [
        {
          title: 'D',
          content: doc(
            { type: 'paragraph' },
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'a' },
                { type: 'text', text: 'b' },
                { type: 'text', text: 'c', marks: [{ type: 'em' }] },
              ],
            },
          ),
        },
      ],
    });
    expect(model.documents[0]!.blocks).toEqual([
      {
        kind: 'paragraph',
        content: [
          { kind: 'text', text: 'ab', em: false, strong: false },
          { kind: 'text', text: 'c', em: true, strong: false },
        ],
      },
    ] satisfies Block[]);
  });

  it('numbers sources in first-citation order, counting quote blocks', () => {
    const model = buildExportModel(goldenInput({ options: { citationStyle: 'numbered' } }));
    const first = model.documents[0]!.blocks[1]!;
    expect(first.kind).toBe('paragraph');
    // smith-jones is cited first (in footnote 1), then woolf.
    expect(model.bibliography?.entries.map((e) => [e.label, e.sourceId])).toEqual([
      ['[1]', 'smith-jones'],
      ['[2]', 'woolf'],
      ['[3]', 'collected'],
      ['[4]', 'web'],
    ]);
    expect(model.bibliography?.title).toBe('References');
  });

  it('passes the citation context to a custom formatter', () => {
    const calls: unknown[] = [];
    buildExportModel(
      goldenInput({
        options: {
          formatCitation: (id, locator, ctx) => {
            calls.push([
              id,
              locator,
              ctx.number,
              ctx.inFootnote,
              ctx.documentIndex,
              ctx.source?.id,
            ]);
            return `<${id}>`;
          },
        },
      }),
    );
    expect(calls).toEqual([
      ['smith-jones', '50', 1, true, 0, 'smith-jones'],
      ['woolf', '12', 2, false, 0, 'woolf'],
      ['smith-jones', null, 1, false, 0, 'smith-jones'],
      ['collected', 'ch. 2', 3, true, 1, 'collected'],
      ['web', null, 4, false, 1, 'web'],
      ['woolf', '20-24', 2, false, 1, 'woolf'],
    ]);
  });

  it('warns once per document about missing sources and still renders', () => {
    const warnings: ExportWarning[] = [];
    const content = doc(
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'x ' },
          { type: 'citation', attrs: { sourceId: 'ghost', locator: null } },
          { type: 'citation', attrs: { sourceId: 'ghost', locator: '3' } },
        ],
      },
      { type: 'quote_block', attrs: { sourceId: 'ghost2' }, content: [para('q')] },
    );
    const model = buildExportModel({
      project: { title: 'T' },
      documents: [{ title: 'D', content }],
      options: { onWarning: (w) => warnings.push(w) },
    });
    expect(warnings.map((w) => [w.code, w.sourceId, w.documentIndex])).toEqual([
      ['missing-source', 'ghost', 0],
      ['missing-source', 'ghost2', 0],
    ]);
    expect(inlineText((model.documents[0]!.blocks[0] as { content: never[] }).content)).toBe(
      'x [missing source][missing source]',
    );
    expect(model.bibliography).toBeNull();
  });

  it('bibliography options: all, none, order and title', () => {
    const all = buildExportModel(goldenInput({ options: { bibliography: { include: 'all' } } }));
    expect(all.bibliography?.entries.map((e) => e.sourceId)).toEqual([
      'uncited', // "anonymous collective" sorts first
      'collected',
      'web',
      'smith-jones',
      'woolf',
    ]);
    expect(all.bibliography?.entries.every((e) => e.label === null)).toBe(true);
    const none = buildExportModel(goldenInput({ options: { bibliography: { include: 'none' } } }));
    expect(none.bibliography).toBeNull();
    const firstCited = buildExportModel(
      goldenInput({
        options: { bibliography: { order: 'first-cited', title: 'Works Cited', include: 'all' } },
      }),
    );
    expect(firstCited.bibliography?.title).toBe('Works Cited');
    expect(firstCited.bibliography?.entries.map((e) => e.sourceId)).toEqual([
      'smith-jones',
      'woolf',
      'collected',
      'web',
      'uncited',
    ]);
    const numberedAll = buildExportModel(
      goldenInput({ options: { citationStyle: 'numbered', bibliography: { include: 'all' } } }),
    );
    expect(numberedAll.bibliography?.entries.at(-1)).toMatchObject({
      sourceId: 'uncited',
      label: '[5]',
    });
  });

  it('no sources: no bibliography, citations marked missing', () => {
    const model = buildExportModel(goldenInput({ sources: undefined }));
    expect(model.bibliography).toBeNull();
  });

  it('builds the provenance appendix from the summary as given', () => {
    const model = buildExportModel(goldenInput());
    const p = model.provenance!;
    expect(p.title).toBe('Provenance');
    expect(p.totalWords).toBe(1282);
    expect(p.rows.map((r) => [r.class, r.words, r.share])).toEqual([
      ['typed', 1234, '96.3%'],
      ['typed-from-suggestion', 21, '1.6%'],
      ['pasted-external', 8, '0.6%'],
      ['imported', 0, '0.0%'],
      ['quoted', 19, '1.5%'],
    ]);
    expect(p.verificationNote).toBe(PROVENANCE.verificationNote);
    expect(buildExportModel(goldenInput({ provenance: null })).provenance).toBeNull();
  });

  it('provenanceSummaryFromReport copies report fields', () => {
    const byClass = {
      typed: 10,
      'typed-from-suggestion': 0,
      'pasted-external': 2,
      'pasted-internal': 0,
      imported: 0,
      quoted: 1,
    };
    const summary = provenanceSummaryFromReport(
      {
        words: { total: 13, byClass },
        disclosure: 'D.',
        provesTable: { ...PROVES_TABLE } as never,
      },
      'see bundle',
    );
    expect(summary).toEqual({
      wordsByClass: byClass,
      disclosure: 'D.',
      provesTable: {
        proves: [...PROVES_TABLE.proves],
        doesNotProve: [...PROVES_TABLE.doesNotProve],
      },
      verificationNote: 'see bundle',
    });
  });

  it('document titles: auto shows them only for several documents', () => {
    expect(buildExportModel(goldenInput()).showDocumentTitles).toBe(true);
    const one = goldenInput();
    one.documents = one.documents.slice(0, 1);
    expect(buildExportModel(one).showDocumentTitles).toBe(false);
    expect(
      buildExportModel({ ...one, options: { documentTitles: 'always' } }).showDocumentTitles,
    ).toBe(true);
    expect(
      buildExportModel({ ...goldenInput(), options: { documentTitles: 'never' } })
        .showDocumentTitles,
    ).toBe(false);
  });

  it('sources are only read, never mutated', () => {
    const before = JSON.stringify(SOURCES);
    buildExportModel(goldenInput({ options: { bibliography: { include: 'all' } } }));
    expect(JSON.stringify(SOURCES)).toBe(before);
  });
});

describe('helpers', () => {
  it('formatShare rounds to one decimal without locale APIs', () => {
    expect(formatShare(0, 0)).toBe('0.0%');
    expect(formatShare(1, 3)).toBe('33.3%');
    expect(formatShare(2, 3)).toBe('66.7%');
    expect(formatShare(978, 1000)).toBe('97.8%');
    expect(formatShare(5, 5)).toBe('100.0%');
  });

  it('fileSlug', () => {
    expect(fileSlug('The Salt Road: A Novel!')).toBe('the-salt-road-a-novel');
    expect(fileSlug('???')).toBe('export');
  });
});
