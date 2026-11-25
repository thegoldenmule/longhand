/**
 * Inline text with positions, following the anchor rules (text verbatim,
 * `hard_break` as `\n`, citations and footnote tokens contribute nothing; footnote
 * content belongs to the footnote, not its host block).
 */
import type { PMNode } from '@longhand/schema';
import type { PositionedText } from './matcher';

/**
 * Inline text of `[from, to)` with each character's position. Textblock boundaries
 * add a `\n` separator (position -1) between non-empty pieces. Footnote content is
 * included only when `from` lies inside that footnote.
 */
export function textBetween(doc: PMNode, from: number, to: number): PositionedText {
  let text = '';
  const pos: number[] = [];
  let pendingSep = false;
  let fromFootnote = -1;
  if (from <= doc.content.size) {
    const $from = doc.resolve(from);
    for (let d = $from.depth; d > 0; d--) {
      if ($from.node(d).type.name === 'footnote') {
        fromFootnote = $from.before(d);
        break;
      }
    }
  }
  if (to <= from) return { text, pos };
  doc.nodesBetween(from, to, (node, p) => {
    if (node.type.name === 'footnote' && p !== fromFootnote) return false;
    if (node.isTextblock) {
      if (text.length > 0) pendingSep = true;
      return true;
    }
    let piece = '';
    let base = p;
    if (node.isText) {
      const t = node.text as string;
      const s = Math.max(0, from - p);
      piece = t.slice(s, Math.min(t.length, to - p));
      base = p + s;
    } else if (node.type.name === 'hard_break' && p >= from) {
      piece = '\n';
    }
    if (piece) {
      if (pendingSep) {
        text += '\n';
        pos.push(-1);
        pendingSep = false;
      }
      for (let i = 0; i < piece.length; i++) {
        text += piece[i] as string;
        pos.push(base + i);
      }
    }
    return true;
  });
  return { text, pos };
}

/** The textblock (or footnote) containing `pos`, with its content range. */
export interface BlockAt {
  node: PMNode;
  /** First content position. */
  from: number;
  /** Last content position. */
  to: number;
}

/** The innermost textblock or footnote containing `pos`, or null. */
export function blockAt(doc: PMNode, pos: number): BlockAt | null {
  if (pos < 0 || pos > doc.content.size) return null;
  const $p = doc.resolve(pos);
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (n.isTextblock || n.type.name === 'footnote') {
      const from = $p.start(d);
      return { node: n, from, to: from + n.content.size };
    }
  }
  return null;
}

/** Inline text of a block's own content (footnotes inside a textblock are skipped). */
export function blockText(block: BlockAt): PositionedText {
  let text = '';
  const pos: number[] = [];
  block.node.forEach((child, offset) => {
    const p = block.from + offset;
    if (child.isText) {
      const t = child.text as string;
      for (let i = 0; i < t.length; i++) {
        text += t[i] as string;
        pos.push(p + i);
      }
    } else if (child.type.name === 'hard_break') {
      text += '\n';
      pos.push(p);
    }
  });
  return { text, pos };
}

/** A quote block's text: its paragraphs' inline text joined by `\n` (empty paragraphs included). */
export function quoteBlockText(node: PMNode): string {
  const parts: string[] = [];
  node.forEach((para) => {
    let t = '';
    para.forEach((child) => {
      if (child.isText) t += child.text as string;
      else if (child.type.name === 'hard_break') t += '\n';
    });
    parts.push(t);
  });
  return parts.join('\n');
}
