/**
 * Plain-text renderings the model reads: segmented documents (`[p3.s2] text…`),
 * the binder outline and notes. Shared by the context builder and the read tools,
 * so the ids the model sees in its prompt are the ids the tools resolve.
 */
import { countWords, type Block, type Segmentation } from '@longhand/schema';
import type { LoadedDocument, OutlineEntry } from './snapshot';

/** Marks a hard line break inside a sentence. Never part of a quote. */
export const LINE_BREAK_MARK = '↵';

/** How one block is shown. */
export type BlockMode = 'full' | 'context' | 'skip';

/** Options for {@link renderSegmented}. */
export interface RenderOptions {
  /** Decide per block (default: every block in full). */
  mode?: (block: Block) => BlockMode;
  /** Stop after roughly this many characters and say so (default: unlimited). */
  maxChars?: number;
}

function parentLabel(parentType: string): string | null {
  switch (parentType) {
    case 'doc':
      return null;
    case 'blockquote':
      return 'in blockquote';
    case 'list_item':
      return 'in list item';
    case 'quote_block':
      return 'in quote block (quoted from a source, not the writer’s prose)';
    default:
      return `in ${parentType.replace(/_/g, ' ')}`;
  }
}

function blockLabel(b: Block, seg: Segmentation): string {
  const parts: string[] = [b.id];
  if (b.kind === 'footnote') {
    const host = seg.blocks.find((h) => h.pos < b.pos && b.pos < h.end);
    parts.push(host ? `footnote in ${host.id}` : 'footnote');
  } else {
    if (b.nodeType === 'heading') parts.push(`heading ${b.headingLevel ?? 1}`);
    const p = parentLabel(b.parentType);
    if (p) parts.push(p);
  }
  return `[${parts.join(' · ')}]`;
}

/** One block as text: its label, then each sentence prefixed by its id. */
export function renderBlock(b: Block, seg: Segmentation): string {
  const label = blockLabel(b, seg);
  if (b.sentences.length === 0) return `${label} (empty)`;
  const body = b.sentences
    .map((s) => `[${s.id}] ${s.text.replace(/\n/g, ` ${LINE_BREAK_MARK} `)}`)
    .join(' ');
  return `${label} ${body}`;
}

/** Word count of a segmented document (textblocks and footnotes). */
export function docWordCount(seg: Segmentation): number {
  return [...seg.blocks, ...seg.footnotes].reduce((n, b) => n + countWords(b.text), 0);
}

/**
 * Renders a document segmented into sentences, one block per line, in a
 * `<document>` wrapper. Scene breaks show as `[scene break]`. Footnotes follow the
 * body.
 */
export function renderSegmented(doc: LoadedDocument, options: RenderOptions = {}): string {
  const { seg } = doc;
  const mode = options.mode ?? (() => 'full' as const);
  const lines: string[] = [];
  let chars = 0;
  let truncated = false;
  const push = (line: string) => {
    if (options.maxChars !== undefined && chars + line.length > options.maxChars) {
      truncated = true;
      return false;
    }
    lines.push(line);
    chars += line.length + 1;
    return true;
  };
  let skipping = false;
  const emit = (b: Block): boolean => {
    const m = mode(b);
    if (m === 'skip') {
      if (!skipping) lines.push('[…]');
      skipping = true;
      return true;
    }
    skipping = false;
    const text = renderBlock(b, seg);
    return push(m === 'context' ? `(context) ${text}` : text);
  };
  outer: for (let top = 0; top < doc.node.childCount; top++) {
    const node = doc.node.child(top);
    if (node.type.name === 'scene_break') {
      if (!skipping && !push('[scene break]')) break;
      continue;
    }
    for (const b of seg.blocks) {
      if (b.topLevelIndex !== top) continue;
      if (!emit(b)) break outer;
    }
  }
  if (!truncated) {
    for (const f of seg.footnotes) if (!emit(f)) break;
  }
  if (truncated) lines.push('[… truncated; call read_document for the full text]');
  const attrs = `id="${doc.id}" title=${JSON.stringify(doc.title)} version="${doc.version}" words="${docWordCount(seg)}"`;
  return `<document ${attrs}>\n${lines.join('\n')}\n</document>`;
}

/** Renders a document as plain paragraphs (notes; not annotatable). */
export function renderPlain(doc: LoadedDocument): string {
  const body = [...doc.seg.blocks, ...doc.seg.footnotes]
    .map((b) => (b.nodeType === 'heading' ? `# ${b.text}` : b.text))
    .filter((t) => t.trim().length > 0)
    .join('\n\n');
  return `<note id="${doc.id}" title=${JSON.stringify(doc.title)}>\n${body}\n</note>`;
}

/** Renders the binder outline with ids, word counts and synopses. */
export function renderOutline(
  entries: readonly OutlineEntry[],
  words?: (documentId: string) => number | null,
  synopsisMaxChars = 400,
): string {
  const lines: string[] = [];
  for (const area of ['manuscript', 'notes'] as const) {
    const items = entries.filter((e) => e.area === area);
    lines.push(area === 'manuscript' ? 'Manuscript:' : 'Notes:');
    if (items.length === 0) lines.push('  (none)');
    for (const e of items) {
      const indent = '  '.repeat(e.depth + 1);
      if (e.kind === 'folder') {
        lines.push(`${indent}▸ ${e.title}`);
        continue;
      }
      const n = words?.(e.id);
      const meta = [`id ${e.id}`, n == null ? null : `${n} words`].filter(Boolean).join(', ');
      lines.push(`${indent}• ${e.title} (${meta})`);
      const syn = (e.synopsis ?? '').trim();
      if (syn) lines.push(`${indent}  Synopsis: ${clip(syn, synopsisMaxChars)}`);
    }
  }
  return lines.join('\n');
}

/** Clips text to `max` characters with an ellipsis, collapsing whitespace. */
export function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
