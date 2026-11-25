/**
 * PDF export with `pdfkit`, in pure Node (no headless browser).
 *
 * pdfkit only draws; this module does its own layout so that footnotes can be
 * true footnotes. Each paragraph is broken into lines greedily (justified, no
 * hyphenation), and every body line is placed together with the footnotes it
 * references: a line goes on the page only if its footnotes fit at the bottom
 * of the same page (a long footnote may continue on the next page, as in
 * Chicago style). Other typography: a title page, chapter openings on a new page
 * set lower on the page, book-style first-line indents (none after headings,
 * scene breaks and block elements), centered scene breaks, centered page
 * numbers (none on the title page), PDF bookmarks for documents, and simple
 * orphan control.
 *
 * Node-only: pdfkit's Node build and (by default) fonts read from disk.
 */
import PDFDocument from 'pdfkit';
import { defaultPdfFonts, type PdfFontSet } from './pdf-fonts';
import { groupThousands } from './format';
import { buildExportModel, type Block, type ExportModel, type Inline } from './model';
import type { ExportInput, TextSpan } from './types';

export type { PdfFontSet, PdfFontSource } from './pdf-fonts';

/** PDF-only options. */
export interface PdfOptions {
  /** Page size. `trade` is 6 × 9 in. Default `letter`. */
  pageSize?: 'letter' | 'a4' | 'a5' | 'trade';
  /** Body font size in points. Default 12 (letter, A4) or 10.5 (A5, trade). */
  fontSize?: number;
  /** Fonts to embed. Default EB Garamond ({@link defaultPdfFonts}). */
  fonts?: PdfFontSet;
  /** PDF creation date (metadata). Pass a fixed date for reproducible output. Default: now. */
  creationDate?: Date;
}

/** MIME type of a PDF. */
export const PDF_MIME_TYPE = 'application/pdf';

/** Exports documents as a PDF. */
export async function exportPdf(
  input: ExportInput,
  pdfOptions: PdfOptions = {},
): Promise<Uint8Array> {
  return renderPdf(buildExportModel(input), pdfOptions);
}

// ---------------------------------------------------------------------------
// Geometry and styles

type FontKey = 'regular' | 'italic' | 'bold' | 'boldItalic';

const PAGE_SIZES = {
  letter: [612, 792],
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  trade: [432, 648],
} as const;

interface Geometry {
  width: number;
  height: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function geometryFor(size: keyof typeof PAGE_SIZES): Geometry {
  const [width, height] = PAGE_SIZES[size];
  const small = size === 'a5' || size === 'trade';
  const m = small ? { top: 54, bottom: 62, side: 54 } : { top: 72, bottom: 80, side: 108 };
  return {
    width,
    height,
    top: m.top,
    bottom: height - m.bottom,
    left: m.side,
    right: width - m.side,
  };
}

/** A run of text in one font. */
interface Piece {
  text: string;
  font: FontKey;
  size: number;
  /** Baseline shift upwards (superscripts). */
  rise: number;
  width: number;
}

/** An unbreakable word, possibly in several fonts, plus the space after it. */
interface Token {
  pieces: Piece[];
  width: number;
  /** The following space, drawn (for text extraction) but not counted at line ends. */
  space: Piece | null;
  /** A hard break follows. */
  breakAfter: boolean;
  /** Footnotes referenced in this token. */
  footnotes: number[];
}

interface Line {
  tokens: Token[];
  /** Natural width, without the trailing space. */
  width: number;
  /** Last line of the paragraph or before a hard break (never justified). */
  last: boolean;
  first: boolean;
  footnotes: number[];
}

interface ParaStyle {
  size: number;
  leading: number;
  italic: boolean;
  bold: boolean;
  align: 'justify' | 'left' | 'center' | 'right';
  indentLeft: number;
  indentRight: number;
  firstIndent: number;
  /** Drawn in the left indent of the first line, right-aligned against the text (list markers). */
  marker: string | null;
}

interface FnLine {
  line: Line;
  style: ParaStyle;
}

function fontKey(italic: boolean, bold: boolean): FontKey {
  return bold ? (italic ? 'boldItalic' : 'bold') : italic ? 'italic' : 'regular';
}

/** Removes characters that fonts can't draw and pdfkit mishandles (controls, tabs). */
function cleanText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\t/g, ' ').replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

// ---------------------------------------------------------------------------
// The writer

class PdfWriter {
  readonly doc: PDFKit.PDFDocument;
  readonly geo: Geometry;
  readonly base: number;
  readonly fnSize: number;
  private readonly widthCache = new Map<string, number>();
  private readonly ascender = new Map<FontKey, number>();
  private readonly descender = new Map<FontKey, number>();
  private readonly footnoteContent = new Map<number, Inline[]>();

  private page = 0;
  private y = 0;
  private bodyEmpty = true;
  private fnLines: FnLine[] = [];
  private fnHeight = 0;
  private carry: FnLine[] = [];
  private folio = true;
  private readonly folioOffset: number;

  constructor(
    readonly model: ExportModel,
    options: PdfOptions,
  ) {
    const size = options.pageSize ?? 'letter';
    this.geo = geometryFor(size);
    this.base = options.fontSize ?? (size === 'a5' || size === 'trade' ? 10.5 : 12);
    this.fnSize = Math.round(this.base * 0.82 * 10) / 10;
    this.folioOffset = model.showTitleBlock ? 1 : 0;
    const fonts = options.fonts ?? defaultPdfFonts();
    this.doc = new PDFDocument({
      autoFirstPage: false,
      size: [this.geo.width, this.geo.height],
      margin: 0,
      lang: model.language,
      displayTitle: true,
      pdfVersion: '1.7',
      info: {
        Title: model.title,
        ...(model.author ? { Author: model.author } : {}),
        ...(model.subtitle ? { Subject: model.subtitle } : {}),
        Creator: 'Longhand',
        Producer: 'Longhand (pdfkit)',
        CreationDate: options.creationDate ?? new Date(),
      },
    });
    for (const key of ['regular', 'italic', 'bold', 'boldItalic'] as const) {
      this.doc.registerFont(key, fonts[key] as PDFKit.Mixins.PDFFontSource);
      this.doc.font(key);
      const f = (this.doc as unknown as { _font: { ascender: number; descender: number } })._font;
      this.ascender.set(key, f.ascender / 1000);
      this.descender.set(key, f.descender / 1000);
    }
    for (const d of model.documents)
      for (const fn of d.footnotes) this.footnoteContent.set(fn.number, fn.content);
  }

  get textWidth(): number {
    return this.geo.right - this.geo.left;
  }

  get bodyHeight(): number {
    return this.geo.bottom - this.geo.top;
  }

  measure(text: string, font: FontKey, size: number): number {
    const key = `${font}\u0000${size}\u0000${text}`;
    let w = this.widthCache.get(key);
    if (w === undefined) {
      w = this.doc.font(font).fontSize(size).widthOfString(text);
      this.widthCache.set(key, w);
    }
    return w;
  }

  // -- styles --------------------------------------------------------------

  body(overrides: Partial<ParaStyle> = {}): ParaStyle {
    return {
      size: this.base,
      leading: this.base * 1.42,
      italic: false,
      bold: false,
      align: 'justify',
      indentLeft: 0,
      indentRight: 0,
      firstIndent: 0,
      marker: null,
      ...overrides,
    };
  }

  // -- tokens and lines ----------------------------------------------------

  piece(text: string, font: FontKey, size: number, rise = 0): Piece {
    return { text, font, size, rise, width: this.measure(text, font, size) };
  }

  tokens(content: readonly Inline[], style: ParaStyle): Token[] {
    const out: Token[] = [];
    let cur: Token | null = null;
    const open = (): Token => {
      if (!cur) {
        cur = { pieces: [], width: 0, space: null, breakAfter: false, footnotes: [] };
        out.push(cur);
      }
      return cur;
    };
    const addPiece = (p: Piece): void => {
      const t = open();
      const last = t.pieces[t.pieces.length - 1];
      if (last && last.font === p.font && last.size === p.size && last.rise === p.rise) {
        last.text += p.text;
        last.width = this.measure(last.text, last.font, last.size);
      } else {
        t.pieces.push(p);
      }
      t.width = t.pieces.reduce((s, x) => s + x.width, 0);
    };
    for (const node of content) {
      switch (node.kind) {
        case 'text':
        case 'citation': {
          const font = fontKey(style.italic !== node.em, style.bold || node.strong);
          for (const part of cleanText(node.text).split(/(\s+)/)) {
            if (part === '') continue;
            if (/^\s+$/.test(part)) {
              if (cur && !(cur as Token).space)
                (cur as Token).space = this.piece(' ', font, style.size);
              cur = null;
            } else {
              addPiece(this.piece(part, font, style.size));
            }
          }
          break;
        }
        case 'footnoteRef': {
          const t = open();
          addPiece(
            this.piece(String(node.number), 'regular', style.size * 0.62, style.size * 0.36),
          );
          t.footnotes.push(node.number);
          break;
        }
        case 'break': {
          open().breakAfter = true;
          cur = null;
          break;
        }
      }
    }
    return out;
  }

  /** Splits a token wider than `width` into pieces that fit, character by character. */
  private splitToken(tok: Token, width: number): Token[] {
    const out: Token[] = [];
    let cur: Token = { pieces: [], width: 0, space: null, breakAfter: false, footnotes: [] };
    for (const p of tok.pieces) {
      let buf = '';
      for (const ch of Array.from(p.text)) {
        const w = this.measure(buf + ch, p.font, p.size);
        if (cur.width + w > width && (buf !== '' || cur.pieces.length > 0)) {
          if (buf) cur.pieces.push(this.piece(buf, p.font, p.size, p.rise));
          cur.width = cur.pieces.reduce((s, x) => s + x.width, 0);
          out.push(cur);
          cur = { pieces: [], width: 0, space: null, breakAfter: false, footnotes: [] };
          buf = ch;
        } else {
          buf += ch;
        }
      }
      if (buf) {
        cur.pieces.push(this.piece(buf, p.font, p.size, p.rise));
        cur.width = cur.pieces.reduce((s, x) => s + x.width, 0);
      }
    }
    cur.space = tok.space;
    cur.breakAfter = tok.breakAfter;
    cur.footnotes = tok.footnotes;
    out.push(cur);
    return out;
  }

  lines(tokens: readonly Token[], style: ParaStyle, width = this.textWidth): Line[] {
    const avail = (first: boolean): number =>
      width - style.indentLeft - style.indentRight - (first ? style.firstIndent : 0);
    const out: Line[] = [];
    let cur: Token[] = [];
    let w = 0;
    const flush = (last: boolean): void => {
      const first = out.length === 0;
      out.push({
        tokens: cur,
        width: w,
        last,
        first,
        footnotes: cur.flatMap((t) => t.footnotes),
      });
      cur = [];
      w = 0;
    };
    const queue = [...tokens];
    while (queue.length > 0) {
      const tok = queue.shift() as Token;
      const a = avail(out.length === 0);
      if (cur.length === 0 && tok.width > a) {
        const parts = this.splitToken(tok, a);
        if (parts.length > 1) {
          queue.unshift(...parts);
          continue;
        }
      }
      const prev = cur[cur.length - 1];
      const gap = prev?.space?.width ?? 0;
      if (cur.length > 0 && w + gap + tok.width > a) {
        flush(false);
        queue.unshift(tok);
        continue;
      }
      w += (cur.length > 0 ? gap : 0) + tok.width;
      cur.push(tok);
      if (tok.breakAfter) flush(true);
    }
    if (cur.length > 0) flush(true);
    if (out.length > 0) (out[out.length - 1] as Line).last = true;
    return out;
  }

  // -- drawing -------------------------------------------------------------

  private baselineOffset(style: ParaStyle): number {
    const asc = this.ascender.get('regular') as number;
    const desc = this.descender.get('regular') as number;
    const glyph = (asc - desc) * style.size;
    return (style.leading - glyph) / 2 + asc * style.size;
  }

  drawLine(
    line: Line,
    style: ParaStyle,
    top: number,
    left = this.geo.left,
    width = this.textWidth,
  ): void {
    const x0 = left + style.indentLeft + (line.first ? style.firstIndent : 0);
    const avail =
      width - style.indentLeft - style.indentRight - (line.first ? style.firstIndent : 0);
    const baseline = top + this.baselineOffset(style);
    let x = x0;
    let extra = 0;
    const gaps = line.tokens.length - 1;
    if (style.align === 'center') x = x0 + (avail - line.width) / 2;
    else if (style.align === 'right') x = x0 + avail - line.width;
    else if (style.align === 'justify' && !line.last && gaps > 0) {
      extra = (avail - line.width) / gaps;
      if (extra > style.size * 0.9) extra = 0;
    }
    if (line.first && style.marker) {
      const mw = this.measure(style.marker, 'regular', style.size);
      this.drawText(style.marker, 'regular', style.size, x0 - mw - style.size * 0.45, baseline);
    }
    line.tokens.forEach((tok, i) => {
      for (const p of tok.pieces) {
        this.drawText(p.text, p.font, p.size, x, baseline - p.rise);
        x += p.width;
      }
      if (tok.space) {
        this.drawText(' ', tok.space.font, tok.space.size, x, baseline);
        if (i < gaps) x += tok.space.width + extra;
      }
    });
  }

  private drawText(text: string, font: FontKey, size: number, x: number, baseline: number): void {
    this.doc.font(font).fontSize(size).fillColor('#000000').text(text, x, baseline, {
      lineBreak: false,
      baseline: 'alphabetic',
    });
  }

  // -- pages ---------------------------------------------------------------

  newPage(opts: { folio?: boolean } = {}): void {
    if (this.page > 0) this.finishPage();
    this.doc.addPage({ size: [this.geo.width, this.geo.height], margin: 0 });
    this.page++;
    this.y = this.geo.top;
    this.bodyEmpty = true;
    this.fnLines = [];
    this.fnHeight = 0;
    this.folio = opts.folio ?? true;
    // Continue footnotes carried from the previous page, using at most half the page.
    const carried = this.carry;
    this.carry = [];
    for (let i = 0; i < carried.length; i++) {
      const l = carried[i] as FnLine;
      const sep = this.fnLines.length === 0 ? this.fnSeparator : 0;
      if (this.fnHeight + sep + l.style.leading > this.bodyHeight / 2 && this.fnLines.length > 0) {
        this.carry = carried.slice(i);
        break;
      }
      this.addFnLine(l);
    }
  }

  private get fnSeparator(): number {
    return this.base * 1.2;
  }

  private addFnLine(l: FnLine): void {
    if (this.fnLines.length === 0) this.fnHeight += this.fnSeparator;
    this.fnLines.push(l);
    this.fnHeight += l.style.leading;
  }

  private finishPage(): void {
    if (this.fnLines.length > 0) {
      let y = this.geo.bottom - this.fnHeight;
      const ruleY = y + this.fnSeparator * 0.45;
      this.doc
        .moveTo(this.geo.left, ruleY)
        .lineTo(this.geo.left + this.textWidth * 0.3, ruleY)
        .lineWidth(0.5)
        .strokeColor('#000000')
        .stroke();
      y += this.fnSeparator;
      for (const l of this.fnLines) {
        this.drawLine(l.line, l.style, y);
        y += l.style.leading;
      }
    }
    const number = this.page - this.folioOffset;
    if (this.folio && number > 0) {
      const text = String(number);
      const size = this.base * 0.9;
      const w = this.measure(text, 'regular', size);
      const baseline = this.geo.bottom + (this.geo.height - this.geo.bottom) * 0.5;
      this.drawText(text, 'regular', size, (this.geo.width - w) / 2, baseline);
    }
  }

  /** Finishes the last page (and any pages needed for carried footnotes). Returns the PDF bytes. */
  async end(): Promise<Uint8Array> {
    if (this.page === 0) this.newPage();
    while (this.carry.length > 0) this.newPage();
    this.finishPage();
    const chunks: Uint8Array[] = [];
    const done = new Promise<void>((resolve, reject) => {
      this.doc.on('data', (c: Uint8Array) => chunks.push(c));
      this.doc.on('end', () => resolve());
      this.doc.on('error', (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))));
    });
    this.doc.end();
    await done;
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  // -- flow ----------------------------------------------------------------

  private get limit(): number {
    return this.geo.bottom - this.fnHeight;
  }

  /** Vertical space; dropped at the top of a page. */
  space(h: number): void {
    if (this.bodyEmpty) return;
    this.y = Math.min(this.y + h, this.limit);
  }

  /** Top of the next line on the current page. */
  get currentY(): number {
    return this.y;
  }

  /** Advances past something drawn directly (table rows). */
  advance(h: number): void {
    this.y += h;
    this.bodyEmpty = false;
  }

  /** Moves down to `y` on the current page (chapter drops). */
  dropTo(y: number): void {
    this.y = Math.max(this.y, y);
  }

  /** Whether `h` more points fit on this page. */
  fits(h: number): boolean {
    return this.y + h <= this.limit;
  }

  /** Starts a new page unless `h` fits on this one (or the page is still empty). */
  ensure(h: number): void {
    if (!this.bodyEmpty && !this.fits(h)) this.newPage();
  }

  private footnoteLines(n: number): FnLine[] {
    const content = this.footnoteContent.get(n) ?? [];
    const style = this.body({
      size: this.fnSize,
      leading: this.fnSize * 1.32,
      align: 'left',
      firstIndent: this.fnSize * 1.2,
    });
    const label = this.piece(String(n), 'regular', this.fnSize * 0.7, this.fnSize * 0.35);
    const toks = this.tokens(content, style);
    const first: Token = {
      pieces: [label],
      width: label.width,
      space: this.piece(' ', 'regular', this.fnSize),
      breakAfter: false,
      footnotes: [],
    };
    return this.lines([first, ...toks], style).map((line) => ({ line, style }));
  }

  /** Places one body line with its footnotes. */
  placeLine(line: Line, style: ParaStyle): void {
    const fns = line.footnotes.flatMap((n) => this.footnoteLines(n));
    for (;;) {
      if (fns.length > 0 && this.carry.length > 0) {
        // An earlier footnote is still continuing: keep footnotes in order.
        this.newPage();
        continue;
      }
      const sep = this.fnLines.length === 0 && fns.length > 0 ? this.fnSeparator : 0;
      const fnAll = sep + fns.reduce((s, l) => s + l.style.leading, 0);
      const room = this.limit - this.y - style.leading;
      if (room >= fnAll) {
        this.commitLine(line, style);
        for (const l of fns) this.addFnLine(l);
        return;
      }
      if (fns.length > 0 && room >= 0) {
        let fit = 0;
        let h = sep;
        while (fit < fns.length && h + (fns[fit] as FnLine).style.leading <= room) {
          h += (fns[fit] as FnLine).style.leading;
          fit++;
        }
        if (fit >= Math.min(2, fns.length) || this.bodyEmpty) {
          this.commitLine(line, style);
          for (const l of fns.slice(0, fit)) this.addFnLine(l);
          this.carry.push(...fns.slice(fit));
          return;
        }
      }
      if (this.bodyEmpty) {
        // Nothing else to try: the line is taller than the free page.
        this.commitLine(line, style);
        this.carry.push(...fns);
        return;
      }
      this.newPage();
    }
  }

  private commitLine(line: Line, style: ParaStyle): void {
    this.drawLine(line, style, this.y);
    this.y += style.leading;
    this.bodyEmpty = false;
  }

  /** Lays out and places a paragraph. */
  paragraph(
    content: readonly Inline[],
    style: ParaStyle,
    opts: { keepWithNext?: number } = {},
  ): void {
    const lines = this.lines(this.tokens(content, style), style);
    if (lines.length === 0) return;
    // Orphan control: don't leave a lone first line at the foot of a page.
    const head = Math.min(lines.length, 2) * style.leading + (opts.keepWithNext ?? 0);
    this.ensure(lines.length === 1 ? style.leading + (opts.keepWithNext ?? 0) : head);
    for (const line of lines) this.placeLine(line, style);
  }

  bookmark(title: string): void {
    this.doc.outline.addItem(title);
  }
}

// ---------------------------------------------------------------------------
// Model → PDF

function spansToInlines(spans: readonly TextSpan[]): Inline[] {
  return spans.map((s) => ({
    kind: 'text' as const,
    text: s.text,
    em: !!s.italic,
    strong: !!s.bold,
  }));
}

function plain(text: string, em = false, strong = false): Inline[] {
  return [{ kind: 'text', text, em, strong }];
}

/** Renders a built {@link ExportModel} as a PDF. */
export async function renderPdf(model: ExportModel, options: PdfOptions = {}): Promise<Uint8Array> {
  const w = new PdfWriter(model, options);
  const b = w.base;
  const lead = b * 1.42;
  const headingOffset = model.showDocumentTitles ? 1 : 0;

  // Title page.
  if (model.showTitleBlock) {
    w.newPage({ folio: false });
    w.dropTo(w.geo.top + w.bodyHeight * 0.28);
    w.paragraph(plain(model.title), w.body({ size: b * 2.4, leading: b * 2.9, align: 'center' }));
    if (model.subtitle) {
      w.space(b * 0.6);
      w.paragraph(
        plain(model.subtitle, true),
        w.body({ size: b * 1.35, leading: b * 1.8, align: 'center' }),
      );
    }
    if (model.author) {
      w.space(b * 2.5);
      w.paragraph(
        plain(model.author),
        w.body({ size: b * 1.2, leading: b * 1.6, align: 'center' }),
      );
    }
    if (model.date) {
      w.space(b * 0.6);
      w.paragraph(plain(model.date), w.body({ align: 'center' }));
    }
  }

  /** A chapter-style opening: new page, dropped title, bookmark. */
  const opening = (title: string): void => {
    w.newPage();
    w.bookmark(title);
    w.dropTo(w.geo.top + w.bodyHeight * 0.12);
    w.paragraph(plain(title), w.body({ size: b * 1.9, leading: b * 2.4, align: 'center' }));
    w.space(lead * 1.6);
  };

  const headingStyle = (outline: number): ParaStyle => {
    switch (outline) {
      case 1:
        return w.body({ size: b * 1.6, leading: b * 2.0, align: 'center' });
      case 2:
        return w.body({ size: b * 1.3, leading: b * 1.7, align: 'left' });
      case 3:
        return w.body({ size: b * 1.1, leading: b * 1.5, align: 'left', bold: true });
      default:
        return w.body({ size: b, leading: lead, align: 'left', italic: true });
    }
  };

  interface Ctx {
    indentLeft: number;
    indentRight: number;
    size: number;
    depth: number;
    /** First-line indent allowed (book paragraphs outside quotes and lists). */
    bookIndent: boolean;
  }
  let indentNext = false;

  const blocks = (list: readonly Block[], ctx: Ctx): void => {
    for (const block of list) renderBlock(block, ctx);
  };

  const renderBlock = (block: Block, ctx: Ctx): void => {
    const leading = ctx.size * 1.42;
    switch (block.kind) {
      case 'paragraph': {
        w.paragraph(
          block.content,
          w.body({
            size: ctx.size,
            leading,
            indentLeft: ctx.indentLeft,
            indentRight: ctx.indentRight,
            firstIndent: ctx.bookIndent && indentNext ? ctx.size * 1.5 : 0,
          }),
        );
        indentNext = true;
        return;
      }
      case 'heading': {
        const style = headingStyle(block.level + headingOffset);
        w.space(lead * 1.1);
        w.paragraph(block.content, style, { keepWithNext: lead * 2 + lead * 0.4 });
        w.space(lead * 0.4);
        indentNext = false;
        return;
      }
      case 'blockquote':
      case 'quoteBlock': {
        const inner: Ctx = {
          ...ctx,
          indentLeft: ctx.indentLeft + b * 2,
          indentRight: ctx.indentRight + b * 2,
          size: Math.round(ctx.size * 0.95 * 10) / 10,
          bookIndent: false,
        };
        w.space(lead * 0.5);
        indentNext = false;
        if (block.kind === 'quoteBlock') {
          // Keep a short quotation (up to a third of a page) on one page.
          const style = w.body({
            size: inner.size,
            leading: inner.size * 1.42,
            indentLeft: inner.indentLeft,
            indentRight: inner.indentRight,
          });
          let h = block.attribution ? style.leading : 0;
          for (const child of block.children) {
            if (child.kind === 'paragraph') {
              h += w.lines(w.tokens(child.content, style), style).length * style.leading;
            }
          }
          if (h <= w.bodyHeight / 3) w.ensure(h);
        }
        blocks(block.children, inner);
        if (block.kind === 'quoteBlock' && block.attribution) {
          w.paragraph(
            [
              { kind: 'text', text: '— ', em: false, strong: false },
              ...spansToInlines(block.attribution),
            ],
            w.body({
              size: inner.size,
              leading: inner.size * 1.42,
              indentLeft: inner.indentLeft,
              indentRight: inner.indentRight,
              align: 'right',
            }),
          );
        }
        w.space(lead * 0.5);
        indentNext = false;
        return;
      }
      case 'sceneBreak': {
        w.space(lead * 0.6);
        w.paragraph(plain(model.sceneBreak), w.body({ align: 'center' }), { keepWithNext: lead });
        w.space(lead * 0.6);
        indentNext = false;
        return;
      }
      case 'list': {
        const top = ctx.depth === 0;
        if (top) w.space(lead * 0.3);
        const step = ctx.size * 1.8;
        block.items.forEach((item, i) => {
          const marker = block.ordered ? `${block.start + i}.` : ctx.depth % 2 === 0 ? '•' : '–';
          let first = true;
          for (const child of item) {
            if (child.kind === 'paragraph') {
              w.paragraph(
                child.content,
                w.body({
                  size: ctx.size,
                  leading,
                  align: 'left',
                  indentLeft: ctx.indentLeft + step,
                  indentRight: ctx.indentRight,
                  marker: first ? marker : null,
                }),
              );
              first = false;
            } else {
              renderBlock(child, {
                ...ctx,
                indentLeft: ctx.indentLeft + step,
                depth: ctx.depth + 1,
                bookIndent: false,
              });
            }
          }
          if (first) {
            // An item with no text: still show its marker.
            w.paragraph(
              plain(' '),
              w.body({ size: ctx.size, leading, indentLeft: ctx.indentLeft + step, marker }),
            );
          }
        });
        if (top) w.space(lead * 0.3);
        indentNext = false;
        return;
      }
    }
  };

  const rootCtx: Ctx = { indentLeft: 0, indentRight: 0, size: b, depth: 0, bookIndent: true };

  model.documents.forEach((doc, i) => {
    if (model.showDocumentTitles) {
      opening(doc.title);
    } else if (i === 0) {
      w.newPage();
      w.bookmark(doc.title);
    } else {
      w.bookmark(doc.title);
      w.space(lead * 1.5);
    }
    indentNext = false;
    blocks(doc.blocks, rootCtx);
  });

  if (model.bibliography) {
    opening(model.bibliography.title);
    for (const entry of model.bibliography.entries) {
      const content = spansToInlines(
        entry.label ? [{ text: `${entry.label} ` }, ...entry.text] : entry.text,
      );
      w.paragraph(content, w.body({ align: 'left', indentLeft: b * 2, firstIndent: -b * 2 }));
      w.space(lead * 0.35);
    }
  }

  if (model.provenance) renderAppendix(w, model.provenance, opening);

  return w.end();
}

function renderAppendix(
  w: PdfWriter,
  p: NonNullable<ExportModel['provenance']>,
  opening: (title: string) => void,
): void {
  const b = w.base;
  const lead = b * 1.42;
  opening(p.title);
  if (p.disclosure.trim()) {
    w.paragraph(plain(p.disclosure.trim()), w.body());
    w.space(lead);
  }
  const doc = w.doc;
  const left = w.geo.left;
  const width = w.textWidth;
  const rule = (y: number, weight = 0.5): void => {
    doc
      .moveTo(left, y)
      .lineTo(left + width, y)
      .lineWidth(weight)
      .strokeColor('#555555')
      .stroke();
  };
  const small = Math.round(b * 0.92 * 10) / 10;
  const rowStyle = (align: ParaStyle['align'], bold = false): ParaStyle =>
    w.body({ size: small, leading: small * 1.5, align, bold });

  // Words by origin.
  const cols = [
    { x: 0, w: width * 0.6, align: 'left' as const },
    { x: width * 0.6, w: width * 0.2, align: 'right' as const },
    { x: width * 0.8, w: width * 0.2, align: 'right' as const },
  ];
  const row = (cells: string[], bold: boolean, ruleAbove: boolean): void => {
    const laid = cells.map((text, i) => {
      const style = rowStyle(cols[i]?.align ?? 'left', bold);
      return {
        style,
        lines: w.lines(w.tokens(plain(text), style), style, cols[i]?.w ?? width),
        col: cols[i],
      };
    });
    const h = Math.max(...laid.map((c) => c.lines.length * c.style.leading)) + small * 0.5;
    w.ensure(h);
    const top = w.currentY;
    if (ruleAbove) rule(top, bold ? 0.8 : 0.4);
    for (const c of laid) {
      let y = top + small * 0.25;
      for (const line of c.lines) {
        w.drawLine(line, c.style, y, left + (c.col?.x ?? 0), c.col?.w ?? width);
        y += c.style.leading;
      }
    }
    w.advance(h);
  };
  row(['Words by origin', 'Words', 'Share'], true, true);
  p.rows.forEach((r) => row([r.label, groupThousands(r.words), r.share], false, true));
  row(['Total', groupThousands(p.totalWords), p.totalWords > 0 ? '100.0%' : '0.0%'], true, true);
  rule(w.currentY, 0.8);

  // Proves / does not prove.
  const rows = Math.max(p.proves.length, p.doesNotProve.length);
  if (rows > 0) {
    w.space(lead * 1.2);
    cols.splice(
      0,
      cols.length,
      { x: 0, w: width * 0.48, align: 'left' },
      { x: width * 0.52, w: width * 0.48, align: 'left' },
    );
    row(['The record proves', 'It does not prove'], true, true);
    for (let i = 0; i < rows; i++) row([p.proves[i] ?? '', p.doesNotProve[i] ?? ''], false, true);
    rule(w.currentY, 0.8);
  }

  if (p.verificationNote) {
    w.space(lead * 1.2);
    const lines = p.verificationNote.trim().split(/\r?\n/);
    const content: Inline[] = [];
    lines.forEach((l, i) => {
      if (i > 0) content.push({ kind: 'break' });
      content.push({ kind: 'text', text: l.trim(), em: false, strong: false });
    });
    w.paragraph(content, w.body({ align: 'left' }));
  }
}
