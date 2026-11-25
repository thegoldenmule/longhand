/**
 * Markdown export (CommonMark plus GFM tables and footnotes).
 *
 * Isomorphic: pure string building, no Node APIs.
 */
import { buildExportModel, type Block, type ExportModel, type Inline } from './model';
import { groupThousands } from './format';
import type { ExportInput, TextSpan } from './types';

/** MIME type of the Markdown export. */
export const MARKDOWN_MIME_TYPE = 'text/markdown; charset=utf-8';

/** Exports documents as one Markdown string (ends with a newline). */
export function exportMarkdown(input: ExportInput): string {
  return renderMarkdown(buildExportModel(input));
}

// ---------------------------------------------------------------------------
// Escaping

/** Escapes writer text so it renders literally inside a paragraph. */
function escapeText(s: string): string {
  return s
    .replace(/[\\`*_~[\]]/g, (c) => `\\${c}`)
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&');
}

/**
 * Escapes generated text (citations, bibliography entries) more lightly, so
 * `[3]` stays readable: brackets are escaped only where they could start a link
 * or a footnote reference.
 */
function escapeGenerated(s: string, next: string): string {
  const out = s
    .replace(/[\\`*_~]/g, (c) => `\\${c}`)
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, '\\&')
    .replace(/\[(?=\^)/g, '\\[')
    .replace(/\](?=[([:])/g, '\\]');
  return /\]$/.test(out) && /^[([:]/.test(next) ? `${out.slice(0, -1)}\\]` : out;
}

/** Escapes what would be block syntax at the start of a line. `text` is already inline-escaped. */
function escapeLineStart(text: string): string {
  if (/^[#>]/.test(text)) return `\\${text}`;
  // List markers, and lines that would turn the line above into a setext heading.
  if (/^[+-](?=\s|$)/.test(text) || /^[-=]+\s*$/.test(text)) return `\\${text}`;
  const ordered = /^(\d{1,9})([.)])(?=\s|$)/.exec(text);
  if (ordered) return `${ordered[1]}\\${text.slice((ordered[1] as string).length)}`;
  return text;
}

function escapeTableCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

// ---------------------------------------------------------------------------
// Inline rendering

type MarkName = 'strong' | 'em';
const DELIM: Record<MarkName, string> = { strong: '**', em: '*' };

interface InlineOptions {
  /** How to render hard breaks: a Markdown hard break, or a space (headings). */
  breaks: 'hard' | 'space';
  /** Escape every `#` (headings, where a trailing `#` run would be eaten). */
  escapeHash?: boolean;
}

function nextText(content: readonly Inline[], i: number): string {
  const n = content[i + 1];
  if (!n) return '';
  if (n.kind === 'text' || n.kind === 'citation') return n.text;
  if (n.kind === 'footnoteRef') return '[';
  return '';
}

/**
 * Renders inline content. Emphasis delimiters never touch whitespace on the
 * inside (`*foo *` would not parse), so leading and trailing whitespace of a
 * marked run is moved outside its delimiters.
 */
function renderInlines(content: readonly Inline[], opts: InlineOptions): string {
  let out = '';
  const stack: MarkName[] = [];
  let pending = '';
  let atLineStart = true;

  const transition = (want: ReadonlySet<MarkName>): void => {
    let keep = 0;
    while (keep < stack.length && want.has(stack[keep] as MarkName)) keep++;
    while (stack.length > keep) out += DELIM[stack.pop() as MarkName];
    out += pending;
    pending = '';
    for (const m of ['strong', 'em'] as const) {
      if (want.has(m) && !stack.includes(m)) {
        stack.push(m);
        out += DELIM[m];
      }
    }
  };

  content.forEach((node, i) => {
    switch (node.kind) {
      case 'text':
      case 'citation': {
        const raw = node.text;
        const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw) as RegExpExecArray;
        let lead = m[1] as string;
        const core = m[2] as string;
        const trail = m[3] as string;
        if (core === '') {
          if (!atLineStart) pending += raw;
          return;
        }
        if (atLineStart) lead = '';
        let text =
          node.kind === 'text'
            ? escapeText(core)
            : escapeGenerated(core, trail ? ' ' : nextText(content, i));
        if (opts.escapeHash) text = text.replace(/#/g, '\\#');
        if (atLineStart) text = escapeLineStart(text);
        const want = new Set<MarkName>();
        if (node.strong) want.add('strong');
        if (node.em) want.add('em');
        // Whitespace before the run goes outside any delimiters that change here.
        pending += lead;
        transition(want);
        out += text;
        pending = trail;
        atLineStart = false;
        return;
      }
      case 'footnoteRef':
        out += pending;
        pending = '';
        out += `[^${node.number}]`;
        atLineStart = false;
        return;
      case 'break':
        pending = '';
        transition(new Set());
        pending = '';
        if (opts.breaks === 'space') {
          if (!atLineStart) pending = ' ';
        } else if (!atLineStart) {
          out += '\\\n';
          atLineStart = true;
        }
        return;
    }
  });
  pending = '';
  transition(new Set());
  return out;
}

function spansToInlines(spans: readonly TextSpan[]): Inline[] {
  return spans.map((s) => ({
    kind: 'citation' as const,
    text: s.text,
    sourceId: '',
    locator: null,
    em: !!s.italic,
    strong: !!s.bold,
  }));
}

// ---------------------------------------------------------------------------
// Block rendering

interface BlockContext {
  /** Number of `#` for a document heading of level 1. */
  headingBase: number;
  sceneBreak: string;
}

const THEMATIC_BREAK = /^ {0,3}([-*_])( *\1){2,} *$/;

function renderBlocks(blocks: readonly Block[], ctx: BlockContext): string[] {
  const out: string[] = [];
  blocks.forEach((block, i) => {
    if (i > 0) {
      out.push('');
      const prev = blocks[i - 1] as Block;
      // Two adjacent lists of the same kind would merge into one; separate them.
      if (prev.kind === 'list' && block.kind === 'list' && prev.ordered === block.ordered) {
        out.push('<!-- -->', '');
      }
    }
    out.push(...renderBlock(block, ctx));
  });
  return out;
}

function renderBlock(block: Block, ctx: BlockContext): string[] {
  switch (block.kind) {
    case 'paragraph':
      return renderInlines(block.content, { breaks: 'hard' }).split('\n');
    case 'heading': {
      const hashes = '#'.repeat(Math.min(6, ctx.headingBase + block.level - 1));
      const text = renderInlines(block.content, { breaks: 'space', escapeHash: true });
      return [`${hashes} ${text}`];
    }
    case 'blockquote':
      return renderBlocks(block.children, ctx).map((l) => (l === '' ? '>' : `> ${l}`));
    case 'list':
      return renderList(block, ctx);
    case 'sceneBreak':
      return [
        THEMATIC_BREAK.test(ctx.sceneBreak)
          ? ctx.sceneBreak.trim()
          : escapeLineStart(escapeText(ctx.sceneBreak)),
      ];
    case 'quoteBlock': {
      const lines = renderBlocks(block.children, ctx);
      if (block.attribution) {
        const attr = renderInlines(spansToInlines(block.attribution), { breaks: 'space' });
        if (lines.length > 0) lines.push('');
        lines.push(`— ${attr}`);
      }
      return lines.map((l) => (l === '' ? '>' : `> ${l}`));
    }
  }
}

function renderList(block: Extract<Block, { kind: 'list' }>, ctx: BlockContext): string[] {
  // Tight unless an item holds two non-list blocks, or a nested ordered list not starting at 1
  // (CommonMark only lets a list interrupt a paragraph if it is a bullet list or starts at 1).
  const tight = block.items.every(
    (item) =>
      item.filter((b) => b.kind !== 'list').length <= 1 &&
      item.every((b, j) => j === 0 || b.kind !== 'list' || !b.ordered || b.start === 1),
  );
  const out: string[] = [];
  block.items.forEach((item, i) => {
    if (i > 0 && !tight) out.push('');
    const marker = block.ordered ? `${block.start + i}. ` : '- ';
    const indent = ' '.repeat(marker.length);
    const lines: string[] = [];
    item.forEach((child, j) => {
      if (j > 0 && !(tight && child.kind === 'list')) lines.push('');
      lines.push(...renderBlock(child, ctx));
    });
    if (lines.length === 0) {
      out.push(marker.trimEnd());
      return;
    }
    lines.forEach((l, j) => {
      if (j === 0) out.push(`${marker}${l}`);
      else out.push(l === '' ? '' : `${indent}${l}`);
    });
  });
  return out;
}

function renderSpansParagraph(spans: readonly TextSpan[]): string {
  return escapeLineStart(renderInlines(spansToInlines(spans), { breaks: 'space' }));
}

// ---------------------------------------------------------------------------
// Document

/** Renders a built {@link ExportModel} as Markdown. */
export function renderMarkdown(model: ExportModel): string {
  const sections: string[][] = [];
  const titleOffset = model.showTitleBlock ? 1 : 0;
  const sectionHashes = '#'.repeat(1 + titleOffset);
  const ctx: BlockContext = {
    headingBase: 1 + titleOffset + (model.showDocumentTitles ? 1 : 0),
    sceneBreak: model.sceneBreak,
  };

  if (model.showTitleBlock) {
    const block = [`# ${escapeText(model.title).replace(/#/g, '\\#')}`];
    if (model.subtitle) block.push('', `*${escapeText(model.subtitle.trim())}*`);
    if (model.author) block.push('', escapeLineStart(escapeText(model.author)));
    if (model.date) block.push('', escapeLineStart(escapeText(model.date)));
    sections.push(block);
  }

  for (const doc of model.documents) {
    const lines: string[] = [];
    if (model.showDocumentTitles) {
      lines.push(`${sectionHashes} ${escapeText(doc.title).replace(/#/g, '\\#')}`);
    }
    const body = renderBlocks(doc.blocks, ctx);
    if (body.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(...body);
    }
    for (const fn of doc.footnotes) {
      const text = renderInlines(fn.content, { breaks: 'hard' }).split('\n');
      if (lines.length > 0) lines.push('');
      lines.push(`[^${fn.number}]: ${text[0] ?? ''}`.trimEnd());
      for (const l of text.slice(1)) lines.push(`    ${l}`);
    }
    if (lines.length > 0) sections.push(lines);
  }

  if (model.bibliography) {
    const lines = [`${sectionHashes} ${escapeText(model.bibliography.title)}`];
    for (const entry of model.bibliography.entries) {
      const label = entry.label ? `${escapeGenerated(entry.label, ' ')} ` : '';
      lines.push('', `${label}${renderSpansParagraph(entry.text)}`);
    }
    sections.push(lines);
  }

  if (model.provenance) {
    const p = model.provenance;
    const lines = [`${sectionHashes} ${escapeText(p.title)}`];
    if (p.disclosure.trim()) lines.push('', escapeLineStart(escapeText(p.disclosure.trim())));
    lines.push('', '| Words by origin | Words | Share |', '| --- | ---: | ---: |');
    for (const r of p.rows) {
      lines.push(`| ${escapeTableCell(r.label)} | ${groupThousands(r.words)} | ${r.share} |`);
    }
    lines.push(
      `| **Total** | **${groupThousands(p.totalWords)}** | **${p.totalWords > 0 ? '100.0%' : '0.0%'}** |`,
    );
    const rows = Math.max(p.proves.length, p.doesNotProve.length);
    if (rows > 0) {
      lines.push('', '| The record proves | It does not prove |', '| --- | --- |');
      for (let i = 0; i < rows; i++) {
        lines.push(
          `| ${escapeTableCell(escapeText(p.proves[i] ?? ''))} | ${escapeTableCell(escapeText(p.doesNotProve[i] ?? ''))} |`,
        );
      }
    }
    if (p.verificationNote) {
      const noteLines = p.verificationNote.trim().split(/\r?\n/);
      lines.push(
        '',
        ...noteLines.map(
          (l, i) => escapeLineStart(escapeText(l.trim())) + (i < noteLines.length - 1 ? '\\' : ''),
        ),
      );
    }
    sections.push(lines);
  }

  return sections.map((s) => s.join('\n')).join('\n\n') + '\n';
}
