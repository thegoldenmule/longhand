/**
 * DOCX export with the `docx` package.
 *
 * Isomorphic: `docx` runs in Node and browsers, and {@link exportDocx} returns a
 * `Uint8Array` either way.
 *
 * Styles: the project title uses Word's `Title` style; document titles,
 * bibliography and appendix headings use `Heading 1`; document headings use
 * `Heading 1–3`, moved down one level (`Heading 2–4`) when document titles
 * print. Block quotes and quote blocks use `Quote`, the quote-block attribution
 * `Quote Attribution`, scene breaks the centered `Scene Break` style, and
 * bibliography entries `Bibliography` (hanging indent). Footnotes are real Word
 * footnotes, numbered continuously across the export.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  FootnoteReferenceRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ILevelsOptions,
  type ParagraphChild,
} from 'docx';
import { groupThousands } from './format';
import { buildExportModel, type Block, type ExportModel, type Inline } from './model';
import type { ExportInput, TextSpan } from './types';

/** DOCX-only options. */
export interface DocxOptions {
  /** Body font family. Default `"Georgia"`. */
  fontFamily?: string;
  /** Body font size in points. Default 12. */
  fontSize?: number;
  /** Page size. Default `letter`. */
  pageSize?: 'letter' | 'a4';
}

/** Exports documents as a `.docx` file. */
export async function exportDocx(
  input: ExportInput,
  docxOptions: DocxOptions = {},
): Promise<Uint8Array> {
  const doc = buildDocxDocument(buildExportModel(input), docxOptions);
  return new Uint8Array(await Packer.toArrayBuffer(doc));
}

/** MIME type of a `.docx` file. */
export const DOCX_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const TWIP_PER_INCH = 1440;
const STYLE = {
  quote: 'Quote',
  attribution: 'QuoteAttribution',
  sceneBreak: 'SceneBreak',
  bibliography: 'Bibliography',
  subtitle: 'Subtitle',
  byline: 'Byline',
  tableText: 'TableText',
} as const;

type HeadingStyle = 'Heading1' | 'Heading2' | 'Heading3' | 'Heading4';
const HEADINGS: readonly HeadingStyle[] = ['Heading1', 'Heading2', 'Heading3', 'Heading4'];

const QUOTE_INDENT = TWIP_PER_INCH / 2;

/** Left indent (twips) of list text at a nesting level. */
function listIndent(level: number): number {
  return 360 * (level + 2);
}

function bulletLevels(): ILevelsOptions[] {
  const glyphs = ['•', '◦', '▪'];
  return Array.from({ length: 9 }, (_, level) => ({
    level,
    format: LevelFormat.BULLET,
    text: glyphs[level % glyphs.length] as string,
    alignment: AlignmentType.LEFT,
    style: { paragraph: { indent: { left: listIndent(level), hanging: 360 } } },
  }));
}

function orderedLevels(depth: number, start: number): ILevelsOptions[] {
  return Array.from({ length: 9 }, (_, level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.LEFT,
    start: level === depth ? start : 1,
    style: { paragraph: { indent: { left: listIndent(level), hanging: 360 } } },
  }));
}

/** Builds the `docx` {@link Document} for a model (for callers that want to post-process it). */
export function buildDocxDocument(model: ExportModel, options: DocxOptions = {}): Document {
  const font = options.fontFamily ?? 'Georgia';
  const size = Math.round((options.fontSize ?? 12) * 2);
  const headingOffset = model.showDocumentTitles ? 1 : 0;

  const footnotes: Record<number, { children: Paragraph[] }> = {};
  const numberingConfig: { reference: string; levels: ILevelsOptions[] }[] = [
    { reference: 'bullets', levels: bulletLevels() },
  ];
  let orderedCount = 0;

  const runs = (content: readonly Inline[]): ParagraphChild[] => {
    const out: ParagraphChild[] = [];
    for (const node of content) {
      switch (node.kind) {
        case 'text':
        case 'citation':
          out.push(
            new TextRun({
              text: node.text,
              italics: node.em || undefined,
              bold: node.strong || undefined,
            }),
          );
          break;
        case 'break':
          out.push(new TextRun({ break: 1 }));
          break;
        case 'footnoteRef':
          out.push(new FootnoteReferenceRun(node.number));
          break;
      }
    }
    return out;
  };

  const spanRuns = (spans: readonly TextSpan[]): TextRun[] =>
    spans.map(
      (s) =>
        new TextRun({ text: s.text, italics: s.italic || undefined, bold: s.bold || undefined }),
    );

  interface Ctx {
    /** Paragraph style for body paragraphs here (`Quote` inside quotes). */
    style: string | undefined;
    /** List nesting depth (0 outside lists). */
    depth: number;
    /** Extra left indent in twips (the Quote style's, for lists inside quotes). */
    indent: number;
  }

  const quoteCtx = (ctx: Ctx): Ctx => ({
    ...ctx,
    style: STYLE.quote,
    indent: ctx.indent + QUOTE_INDENT,
  });

  const blocks = (list: readonly Block[], ctx: Ctx): (Paragraph | Table)[] => {
    const out: (Paragraph | Table)[] = [];
    for (const block of list) out.push(...renderBlock(block, ctx));
    return out;
  };

  const renderBlock = (block: Block, ctx: Ctx): (Paragraph | Table)[] => {
    switch (block.kind) {
      case 'paragraph':
        return [new Paragraph({ style: ctx.style, children: runs(block.content) })];
      case 'heading':
        return [
          new Paragraph({
            heading: HEADINGS[Math.min(3, block.level - 1 + headingOffset)] as HeadingStyle,
            children: runs(block.content),
          }),
        ];
      case 'blockquote':
        return blocks(block.children, quoteCtx(ctx));
      case 'quoteBlock': {
        const out = blocks(block.children, quoteCtx(ctx));
        if (block.attribution) {
          out.push(
            new Paragraph({
              style: STYLE.attribution,
              children: [new TextRun({ text: '— ' }), ...spanRuns(block.attribution)],
            }),
          );
        }
        return out;
      }
      case 'sceneBreak':
        return [
          new Paragraph({ style: STYLE.sceneBreak, children: [new TextRun(model.sceneBreak)] }),
        ];
      case 'list': {
        const level = ctx.depth;
        // Each ordered list gets its own definition, so it numbers from its own start.
        let reference = 'bullets';
        if (block.ordered) {
          reference = `ordered-${++orderedCount}`;
          numberingConfig.push({ reference, levels: orderedLevels(level, block.start) });
        }
        const out: (Paragraph | Table)[] = [];
        for (const item of block.items) {
          let first = true;
          for (const child of item) {
            if (child.kind === 'list') {
              out.push(...renderBlock(child, { ...ctx, depth: ctx.depth + 1 }));
              continue;
            }
            if (child.kind !== 'paragraph') {
              out.push(...renderBlock(child, ctx));
              continue;
            }
            if (first) {
              out.push(
                new Paragraph({
                  style: ctx.style,
                  numbering: { reference, level },
                  // Direct indent beats the numbering's, so lists in quotes stay inside the quote.
                  ...(ctx.indent > 0
                    ? { indent: { left: ctx.indent + listIndent(level), hanging: 360 } }
                    : {}),
                  children: runs(child.content),
                }),
              );
              first = false;
            } else {
              // A later paragraph of the same item: indented under the text, unnumbered.
              out.push(
                new Paragraph({
                  style: ctx.style,
                  indent: { left: ctx.indent + listIndent(level) },
                  children: runs(child.content),
                }),
              );
            }
          }
          if (first) {
            out.push(
              new Paragraph({ style: ctx.style, numbering: { reference, level }, children: [] }),
            );
          }
        }
        return out;
      }
    }
  };

  const body: (Paragraph | Table)[] = [];
  if (model.showTitleBlock) {
    body.push(new Paragraph({ heading: 'Title', children: [new TextRun(model.title)] }));
    if (model.subtitle)
      body.push(new Paragraph({ style: STYLE.subtitle, children: [new TextRun(model.subtitle)] }));
    if (model.author)
      body.push(new Paragraph({ style: STYLE.byline, children: [new TextRun(model.author)] }));
    if (model.date)
      body.push(new Paragraph({ style: STYLE.byline, children: [new TextRun(model.date)] }));
  }

  model.documents.forEach((doc, i) => {
    if (model.showDocumentTitles) {
      body.push(
        new Paragraph({
          heading: 'Heading1',
          pageBreakBefore: i > 0 || model.showTitleBlock,
          children: [new TextRun(doc.title)],
        }),
      );
    }
    body.push(...blocks(doc.blocks, { style: undefined, depth: 0, indent: 0 }));
    for (const fn of doc.footnotes) {
      footnotes[fn.number] = {
        children: [new Paragraph({ style: 'FootnoteText', children: runs(fn.content) })],
      };
    }
  });

  if (model.bibliography) {
    body.push(
      new Paragraph({
        heading: 'Heading1',
        pageBreakBefore: true,
        children: [new TextRun(model.bibliography.title)],
      }),
    );
    for (const entry of model.bibliography.entries) {
      body.push(
        new Paragraph({
          style: STYLE.bibliography,
          children: [
            ...(entry.label ? [new TextRun(`${entry.label} `)] : []),
            ...spanRuns(entry.text),
          ],
        }),
      );
    }
  }

  if (model.provenance) body.push(...provenanceAppendix(model.provenance));

  const page =
    options.pageSize === 'a4' ? { width: 11906, height: 16838 } : { width: 12240, height: 15840 };

  return new Document({
    title: model.title,
    creator: model.author ?? undefined,
    description: 'Exported from Longhand',
    styles: {
      default: {
        document: {
          run: { font, size },
          paragraph: { spacing: { after: 160, line: 300 } },
        },
        title: {
          run: { font, size: 56, bold: false, color: '000000' },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 2400, after: 240 } },
        },
        heading1: {
          run: { font, size: 36, bold: false, color: '000000' },
          paragraph: { spacing: { before: 480, after: 240 }, keepNext: true, keepLines: true },
        },
        heading2: {
          run: { font, size: 30, bold: true, color: '000000' },
          paragraph: { spacing: { before: 360, after: 160 }, keepNext: true, keepLines: true },
        },
        heading3: {
          run: { font, size: 26, bold: true, color: '000000' },
          paragraph: { spacing: { before: 280, after: 120 }, keepNext: true, keepLines: true },
        },
        heading4: {
          run: { font, size, bold: true, italics: true, color: '000000' },
          paragraph: { spacing: { before: 240, after: 120 }, keepNext: true, keepLines: true },
        },
      },
      paragraphStyles: [
        {
          id: STYLE.subtitle,
          name: 'Subtitle',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          run: { size: 32, italics: true },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 480 } },
        },
        {
          id: STYLE.byline,
          name: 'Byline',
          basedOn: 'Normal',
          next: 'Normal',
          run: { size: 26 },
          paragraph: { alignment: AlignmentType.CENTER, spacing: { after: 120 } },
        },
        {
          id: STYLE.quote,
          name: 'Quote',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          paragraph: {
            indent: { left: QUOTE_INDENT, right: QUOTE_INDENT },
            spacing: { after: 120 },
          },
        },
        {
          id: STYLE.attribution,
          name: 'Quote Attribution',
          basedOn: STYLE.quote,
          next: 'Normal',
          paragraph: { alignment: AlignmentType.RIGHT, spacing: { after: 240 } },
        },
        {
          id: STYLE.sceneBreak,
          name: 'Scene Break',
          basedOn: 'Normal',
          next: 'Normal',
          quickFormat: true,
          paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 240, after: 240 } },
        },
        {
          id: STYLE.bibliography,
          name: 'Bibliography',
          basedOn: 'Normal',
          next: STYLE.bibliography,
          paragraph: { indent: { left: TWIP_PER_INCH / 2, hanging: TWIP_PER_INCH / 2 } },
        },
        {
          id: STYLE.tableText,
          name: 'Table Text',
          basedOn: 'Normal',
          run: { size: Math.max(16, size - 4) },
          paragraph: { spacing: { before: 40, after: 40, line: 240 } },
        },
      ],
    },
    numbering: { config: numberingConfig },
    footnotes,
    sections: [
      {
        properties: {
          page: {
            size: page,
            margin: {
              top: TWIP_PER_INCH,
              bottom: TWIP_PER_INCH,
              left: TWIP_PER_INCH * 1.25,
              right: TWIP_PER_INCH * 1.25,
            },
          },
          titlePage: model.showTitleBlock,
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ children: [PageNumber.CURRENT] })],
              }),
            ],
          }),
          first: new Footer({ children: [new Paragraph({ children: [] })] }),
        },
        children: body,
      },
    ],
  });
}

function cell(text: string, opts: { bold?: boolean; right?: boolean } = {}): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        style: STYLE.tableText,
        alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [new TextRun({ text, bold: opts.bold || undefined })],
      }),
    ],
  });
}

const RULE = { style: BorderStyle.SINGLE, size: 4, color: '999999' };
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const TABLE_BORDERS = {
  top: RULE,
  bottom: RULE,
  left: NONE,
  right: NONE,
  insideHorizontal: RULE,
  insideVertical: NONE,
};

function provenanceAppendix(p: NonNullable<ExportModel['provenance']>): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [
    new Paragraph({ heading: 'Heading1', pageBreakBefore: true, children: [new TextRun(p.title)] }),
  ];
  if (p.disclosure.trim())
    out.push(new Paragraph({ children: [new TextRun(p.disclosure.trim())] }));
  out.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: TABLE_BORDERS,
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            cell('Words by origin', { bold: true }),
            cell('Words', { bold: true, right: true }),
            cell('Share', { bold: true, right: true }),
          ],
        }),
        ...p.rows.map(
          (r) =>
            new TableRow({
              children: [
                cell(r.label),
                cell(groupThousands(r.words), { right: true }),
                cell(r.share, { right: true }),
              ],
            }),
        ),
        new TableRow({
          children: [
            cell('Total', { bold: true }),
            cell(groupThousands(p.totalWords), { bold: true, right: true }),
            cell(p.totalWords > 0 ? '100.0%' : '0.0%', { bold: true, right: true }),
          ],
        }),
      ],
    }),
  );
  const rows = Math.max(p.proves.length, p.doesNotProve.length);
  if (rows > 0) {
    out.push(new Paragraph({ children: [] }));
    out.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: TABLE_BORDERS,
        rows: [
          new TableRow({
            tableHeader: true,
            children: [
              cell('The record proves', { bold: true }),
              cell('It does not prove', { bold: true }),
            ],
          }),
          ...Array.from(
            { length: rows },
            (_, i) =>
              new TableRow({ children: [cell(p.proves[i] ?? ''), cell(p.doesNotProve[i] ?? '')] }),
          ),
        ],
      }),
    );
  }
  if (p.verificationNote) {
    const lines = p.verificationNote.trim().split(/\r?\n/);
    out.push(
      new Paragraph({
        spacing: { before: 240 },
        children: lines.map(
          (l, i) => new TextRun({ text: l.trim(), ...(i > 0 ? { break: 1 } : {}) }),
        ),
      }),
    );
  }
  return out;
}
