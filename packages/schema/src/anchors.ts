/**
 * Segmenter and anchors: how everyone (the agent, the fold, the UI) points at text.
 *
 * ## Ids
 * - Every **textblock** (paragraph or heading, at any depth — inside blockquotes,
 *   list items and quote blocks too) gets a block id `p1`, `p2`, … in document
 *   order. Empty textblocks are numbered too, so numbering is purely positional.
 * - Every **footnote** gets a block id `fn1`, `fn2`, … in document order. Footnote
 *   content is segmented as its own unit and is *excluded* from the host
 *   paragraph's text.
 * - Sentences are `p3.s2` / `fn1.s1`: 1-based sentence number within the block.
 *   (The numeric fields `blockIndex` and `sentenceIndex` are 0-based; use
 *   {@link sentenceId} / {@link parseSentenceId} instead of hand-rolling the conversion.)
 * - Ids are only meaningful for one document version. Anything that must survive
 *   edits stores ProseMirror positions and maps them through steps.
 *
 * ## Inline text
 * The "inline text" of a block is what anchors quote against: text nodes verbatim,
 * `hard_break` as `"\n"`, `citation` and `footnote` nodes as nothing (they still
 * occupy positions, so a range may contain them). Every character maps to exactly
 * one ProseMirror position.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { z } from 'zod';
import { splitSentences } from './text';
import { IdSchema } from './ids';

/** Matches a block id: `p<n>` or `fn<n>` (1-based). */
export const BLOCK_ID_RE = /^(p|fn)[1-9]\d*$/;
/** Matches a sentence id: `p<n>.s<m>` or `fn<n>.s<m>` (1-based). */
export const SENTENCE_ID_RE = /^(p|fn)[1-9]\d*\.s[1-9]\d*$/;

/** Zod schema for a block id. */
export const BlockIdSchema = z.string().regex(BLOCK_ID_RE, 'block id like "p3" or "fn1"');
/** Zod schema for a sentence id. */
export const SentenceIdSchema = z.string().regex(SENTENCE_ID_RE, 'sentence id like "p3.s2"');

/** One sentence of a segmented document. */
export interface Sentence {
  /** `p3.s2` — see module docs. */
  id: string;
  /** Id of the containing block (`p3` or `fn1`). */
  blockId: string;
  /** 0-based index of the block among blocks of its kind (textblocks, or footnotes). */
  blockIndex: number;
  /** 0-based index of the sentence within its block. */
  sentenceIndex: number;
  /** The sentence's inline text (trimmed). */
  text: string;
  /** ProseMirror position of the first character. */
  from: number;
  /** ProseMirror position just after the last character. */
  to: number;
  /** Offset of the first character within the block's inline text. */
  start: number;
  /** Offset just after the last character within the block's inline text. */
  end: number;
}

/** One segmented block: a textblock (`p<n>`) or a footnote (`fn<n>`). */
export interface Block {
  id: string;
  kind: 'textblock' | 'footnote';
  /** 0-based index among blocks of the same kind. */
  index: number;
  nodeType: 'paragraph' | 'heading' | 'footnote';
  /** Heading level for headings, otherwise null. */
  headingLevel: 1 | 2 | 3 | null;
  /** Position directly before the node. */
  pos: number;
  /** Position directly after the node (`pos + node.nodeSize`). */
  end: number;
  /** First content position (`pos + 1`). */
  contentFrom: number;
  /** Last content position (`end - 1`). */
  contentTo: number;
  /** Number of ancestors excluding `doc` (0 = direct child of doc). */
  depth: number;
  /** Type name of the parent node (`doc`, `blockquote`, `list_item`, `quote_block`, `paragraph`/`heading` for footnotes). */
  parentType: string;
  /** Index among the doc's direct children of the top-level node containing this block. */
  topLevelIndex: number;
  /** Inline text (see module docs). */
  text: string;
  /** Position of each character of `text` (same length as `text`). */
  charPos: readonly number[];
  sentences: Sentence[];
}

/** A whole-document segmentation. Build once per document version with {@link segmentDoc} and reuse. */
export interface Segmentation {
  doc: PMNode;
  /** Textblocks in document order (`p1`…). */
  blocks: Block[];
  /** Footnotes in document order (`fn1`…). */
  footnotes: Block[];
  /** All sentences: textblock sentences in order, then footnote sentences in order. */
  sentences: Sentence[];
  blockById: ReadonlyMap<string, Block>;
  sentenceById: ReadonlyMap<string, Sentence>;
}

/** Builds a sentence id from 0-based indexes: `sentenceId('p', 2, 1) === 'p3.s2'`. */
export function sentenceId(prefix: 'p' | 'fn', blockIndex: number, sentenceIndex: number): string {
  return `${prefix}${blockIndex + 1}.s${sentenceIndex + 1}`;
}

/** Builds a block id from a 0-based index: `blockId('p', 2) === 'p3'`. */
export function blockId(prefix: 'p' | 'fn', blockIndex: number): string {
  return `${prefix}${blockIndex + 1}`;
}

/** Parses `p3.s2` into `{ prefix: 'p', blockId: 'p3', blockIndex: 2, sentenceIndex: 1 }`, or null. */
export function parseSentenceId(
  id: string,
): { prefix: 'p' | 'fn'; blockId: string; blockIndex: number; sentenceIndex: number } | null {
  const m = /^(p|fn)([1-9]\d*)\.s([1-9]\d*)$/.exec(id);
  if (!m) return null;
  const prefix = m[1] as 'p' | 'fn';
  return {
    prefix,
    blockId: `${prefix}${m[2]}`,
    blockIndex: Number(m[2]) - 1,
    sentenceIndex: Number(m[3]) - 1,
  };
}

function inlineTextOf(
  node: PMNode,
  contentFrom: number,
  footnotes: Array<{ node: PMNode; pos: number }> | null,
) {
  let text = '';
  const charPos: number[] = [];
  node.forEach((child, offset) => {
    const pos = contentFrom + offset;
    if (child.isText) {
      const t = child.text as string;
      text += t;
      for (let i = 0; i < t.length; i++) charPos.push(pos + i);
    } else if (child.type.name === 'hard_break') {
      text += '\n';
      charPos.push(pos);
    } else if (child.type.name === 'footnote') {
      footnotes?.push({ node: child, pos });
    }
    // citation (and any other inline atom): occupies a position, contributes no text.
  });
  return { text, charPos };
}

function sentencesOf(
  prefix: 'p' | 'fn',
  index: number,
  text: string,
  charPos: readonly number[],
): Sentence[] {
  const id = blockId(prefix, index);
  return splitSentences(text).map((r, si) => ({
    id: sentenceId(prefix, index, si),
    blockId: id,
    blockIndex: index,
    sentenceIndex: si,
    text: text.slice(r.start, r.end),
    from: charPos[r.start] as number,
    to: (charPos[r.end - 1] as number) + 1,
    start: r.start,
    end: r.end,
  }));
}

/** Segments a document into blocks and sentences. Deterministic; positions refer to `doc`. */
export function segmentDoc(doc: PMNode): Segmentation {
  const blocks: Block[] = [];
  const footnoteRefs: Array<{ node: PMNode; pos: number; host: Block }> = [];
  doc.forEach((top, topOffset, topLevelIndex) => {
    const visit = (node: PMNode, pos: number, depth: number, parentType: string): void => {
      if (node.isTextblock) {
        const index = blocks.length;
        const found: Array<{ node: PMNode; pos: number }> = [];
        const { text, charPos } = inlineTextOf(node, pos + 1, found);
        const isHeading = node.type.name === 'heading';
        const block: Block = {
          id: blockId('p', index),
          kind: 'textblock',
          index,
          nodeType: isHeading ? 'heading' : 'paragraph',
          headingLevel: isHeading ? (node.attrs.level as 1 | 2 | 3) : null,
          pos,
          end: pos + node.nodeSize,
          contentFrom: pos + 1,
          contentTo: pos + node.nodeSize - 1,
          depth,
          parentType,
          topLevelIndex,
          text,
          charPos,
          sentences: sentencesOf('p', index, text, charPos),
        };
        blocks.push(block);
        for (const f of found) footnoteRefs.push({ ...f, host: block });
        return;
      }
      node.forEach((child, offset) => visit(child, pos + 1 + offset, depth + 1, node.type.name));
    };
    visit(top, topOffset, 0, 'doc');
  });
  const footnotes: Block[] = footnoteRefs.map(({ node, pos, host }, index) => {
    const { text, charPos } = inlineTextOf(node, pos + 1, null);
    return {
      id: blockId('fn', index),
      kind: 'footnote',
      index,
      nodeType: 'footnote',
      headingLevel: null,
      pos,
      end: pos + node.nodeSize,
      contentFrom: pos + 1,
      contentTo: pos + node.nodeSize - 1,
      depth: host.depth + 1,
      parentType: host.nodeType,
      topLevelIndex: host.topLevelIndex,
      text,
      charPos,
      sentences: sentencesOf('fn', index, text, charPos),
    };
  });
  const sentences = [...blocks, ...footnotes].flatMap((b) => b.sentences);
  return {
    doc,
    blocks,
    footnotes,
    sentences,
    blockById: new Map([...blocks, ...footnotes].map((b) => [b.id, b])),
    sentenceById: new Map(sentences.map((s) => [s.id, s])),
  };
}

/** A document or a segmentation of it (pass the segmentation to avoid re-segmenting). */
export type DocOrSegmentation = PMNode | Segmentation;

function seg(d: DocOrSegmentation): Segmentation {
  return 'blockById' in d ? d : segmentDoc(d);
}

/**
 * Flat list of sentences, `[{ id: 'p3.s2', blockIndex, sentenceIndex, text, from, to, … }]`:
 * textblock sentences in document order, then footnote sentences.
 */
export function segment(doc: DocOrSegmentation): Sentence[] {
  return seg(doc).sentences;
}

/**
 * Inline text between two positions using the anchor rules (text verbatim,
 * hard breaks as `"\n"`, citations as nothing). Footnote content is included only
 * when `from` lies inside that footnote. Textblock boundaries contribute
 * `blockSeparator` (default `"\n"`) between non-empty runs of collected text.
 */
export function inlineTextBetween(
  doc: PMNode,
  from: number,
  to: number,
  blockSeparator = '\n',
): string {
  let out = '';
  let pendingSeparator = false;
  const fromFootnote = (() => {
    const $from = doc.resolve(from);
    for (let d = $from.depth; d > 0; d--)
      if ($from.node(d).type.name === 'footnote') return $from.before(d);
    return -1;
  })();
  doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'footnote' && pos !== fromFootnote) return false;
    if (node.isTextblock) {
      if (out.length > 0) pendingSeparator = true;
      return true;
    }
    let piece = '';
    if (node.isText) {
      const t = node.text as string;
      piece = t.slice(Math.max(0, from - pos), Math.min(t.length, to - pos));
    } else if (node.type.name === 'hard_break') {
      piece = '\n';
    }
    if (piece) {
      if (pendingSeparator) out += blockSeparator;
      pendingSeparator = false;
      out += piece;
    }
    return true;
  });
  return out;
}

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/** Maximum length of an anchor quote in characters. */
export const ANCHOR_QUOTE_MAX_CHARS = 1000;

/**
 * Zod schema for an {@link Anchor}: how the agent points at text. The quote must be
 * an exact substring of the named sentence's inline text. `occurrence` (0-based,
 * counting overlapping matches left to right) disambiguates a repeated quote; when
 * omitted the quote must be unique within the sentence.
 */
export const AnchorSchema = z.object({
  documentId: IdSchema.describe('Id of the document containing the sentence.'),
  sentenceId: SentenceIdSchema.describe('Sentence id from the segmented text, e.g. "p3.s2".'),
  quote: z
    .string()
    .min(1)
    .max(ANCHOR_QUOTE_MAX_CHARS)
    .refine((q) => q.trim().length > 0, 'quote must not be blank')
    .describe('Exact text of the span, copied verbatim from that sentence.'),
  occurrence: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('0-based index of the match if the quote occurs more than once in the sentence.'),
});

/** An anchor as given by the agent (occurrence optional). */
export type AnchorInput = z.infer<typeof AnchorSchema>;

/** A normalized anchor as stored in events (occurrence always present). */
export type Anchor = Required<AnchorInput>;

/** Zod schema for a normalized, stored {@link Anchor}. */
export const StoredAnchorSchema = AnchorSchema.extend({ occurrence: z.number().int().min(0) });

/** Error codes returned by the resolvers. Messages are written for the model to read and fix. */
export type AnchorErrorCode =
  | 'unknown-sentence'
  | 'unknown-block'
  | 'quote-not-found'
  | 'ambiguous-quote'
  | 'occurrence-out-of-range'
  | 'empty'
  | 'too-many-ids'
  | 'wrong-unit'
  | 'not-contiguous'
  | 'not-top-level'
  | 'invalid-destination'
  | 'invalid-split'
  | 'invalid-merge';

/** A resolver failure. */
export interface AnchorError {
  code: AnchorErrorCode;
  message: string;
}

/** Result type of every resolver. */
export type Resolved<T> = ({ ok: true } & T) | { ok: false; error: AnchorError };

function fail(code: AnchorErrorCode, message: string): { ok: false; error: AnchorError } {
  return { ok: false, error: { code, message } };
}

function allIndexes(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/**
 * Resolves an anchor to ProseMirror positions in `doc` (the caller picks the document
 * named by `anchor.documentId`). Returns the normalized anchor alongside the range.
 */
export function resolveAnchor(
  doc: DocOrSegmentation,
  anchor: AnchorInput,
): Resolved<{ from: number; to: number; anchor: Anchor; sentence: Sentence }> {
  const s = seg(doc);
  const sentence = s.sentenceById.get(anchor.sentenceId);
  if (!sentence)
    return fail('unknown-sentence', `No sentence ${anchor.sentenceId} in this document.`);
  if (anchor.quote.trim().length === 0) return fail('empty', 'The quote is empty.');
  const hits = allIndexes(sentence.text, anchor.quote);
  if (hits.length === 0) {
    return fail(
      'quote-not-found',
      `The quote does not occur in ${sentence.id}. Copy it exactly from the sentence text: ${JSON.stringify(sentence.text)}`,
    );
  }
  let occurrence = anchor.occurrence;
  if (occurrence === undefined) {
    if (hits.length > 1) {
      return fail(
        'ambiguous-quote',
        `The quote occurs ${hits.length} times in ${sentence.id}; pass occurrence (0-${hits.length - 1}).`,
      );
    }
    occurrence = 0;
  }
  const start = hits[occurrence];
  if (start === undefined) {
    return fail(
      'occurrence-out-of-range',
      `occurrence ${occurrence} is out of range; the quote occurs ${hits.length} time(s) in ${sentence.id}.`,
    );
  }
  const block = s.blockById.get(sentence.blockId) as Block;
  const i = sentence.start + start;
  const j = i + anchor.quote.length;
  return {
    ok: true,
    from: block.charPos[i] as number,
    to: (block.charPos[j - 1] as number) + 1,
    anchor: {
      documentId: anchor.documentId,
      sentenceId: anchor.sentenceId,
      quote: anchor.quote,
      occurrence,
    },
    sentence,
  };
}

/** Granularity of a structural span. */
export const SpanUnitSchema = z.enum(['sentence', 'paragraph', 'section']);
/** Granularity of a structural span. */
export type SpanUnit = z.infer<typeof SpanUnitSchema>;

/** Maximum ids in one span. */
export const SPAN_MAX_IDS = 50;

/**
 * Zod schema for a {@link SpanRef}: a contiguous run of whole units.
 * - `sentence`: consecutive sentence ids of one block (`["p3.s2", "p3.s3"]`).
 * - `paragraph`: block ids of consecutive top-level textblocks (direct children of the doc).
 * - `section`: block ids of top-level headings; a section runs from its heading to
 *   the next top-level heading of the same or higher level. Several sections must be adjacent.
 */
export const SpanRefSchema = z.object({
  documentId: IdSchema,
  unit: SpanUnitSchema,
  ids: z.array(z.string()).min(1).max(SPAN_MAX_IDS),
});

/** A contiguous run of whole sentences, paragraphs or sections. */
export type SpanRef = z.infer<typeof SpanRefSchema>;

/** Range of the section headed by top-level heading `block`. */
function sectionRange(s: Segmentation, block: Block): { from: number; to: number } {
  const level = block.headingLevel as number;
  let to = s.doc.content.size;
  for (const b of s.blocks) {
    if (b.pos <= block.pos || b.depth !== 0 || b.nodeType !== 'heading') continue;
    if ((b.headingLevel as number) <= level) {
      to = b.pos;
      break;
    }
  }
  return { from: block.pos, to };
}

/**
 * Resolves a span to a position range. Sentence spans cover text (`from` of the
 * first sentence to `to` of the last); paragraph and section spans cover whole nodes
 * (position before the first node to position after the last).
 */
export function resolveSpan(
  doc: DocOrSegmentation,
  span: Pick<SpanRef, 'unit' | 'ids'>,
): Resolved<{ from: number; to: number }> {
  const s = seg(doc);
  if (span.ids.length === 0) return fail('empty', 'A span needs at least one id.');
  if (span.ids.length > SPAN_MAX_IDS)
    return fail('too-many-ids', `At most ${SPAN_MAX_IDS} ids per span.`);
  if (span.unit === 'sentence') {
    const sents: Sentence[] = [];
    for (const id of span.ids) {
      if (!SENTENCE_ID_RE.test(id)) return fail('wrong-unit', `${id} is not a sentence id.`);
      const sentence = s.sentenceById.get(id);
      if (!sentence) return fail('unknown-sentence', `No sentence ${id} in this document.`);
      sents.push(sentence);
    }
    for (let k = 1; k < sents.length; k++) {
      const a = sents[k - 1] as Sentence;
      const b = sents[k] as Sentence;
      if (a.blockId !== b.blockId || b.sentenceIndex !== a.sentenceIndex + 1) {
        return fail(
          'not-contiguous',
          `${a.id} and ${b.id} are not consecutive sentences of one paragraph.`,
        );
      }
    }
    return {
      ok: true,
      from: (sents[0] as Sentence).from,
      to: (sents[sents.length - 1] as Sentence).to,
    };
  }
  const blocks: Block[] = [];
  for (const id of span.ids) {
    const block = s.blockById.get(id);
    if (!BLOCK_ID_RE.test(id)) return fail('wrong-unit', `${id} is not a paragraph id.`);
    if (!block) return fail('unknown-block', `No block ${id} in this document.`);
    if (block.kind !== 'textblock' || block.depth !== 0) {
      return fail('not-top-level', `${id} is not a top-level paragraph or heading.`);
    }
    if (span.unit === 'section' && block.nodeType !== 'heading') {
      return fail('wrong-unit', `${id} is not a heading, so it does not start a section.`);
    }
    blocks.push(block);
  }
  if (span.unit === 'paragraph') {
    for (let k = 1; k < blocks.length; k++) {
      const a = blocks[k - 1] as Block;
      const b = blocks[k] as Block;
      if (b.topLevelIndex !== a.topLevelIndex + 1) {
        return fail('not-contiguous', `${a.id} and ${b.id} are not adjacent paragraphs.`);
      }
    }
    return {
      ok: true,
      from: (blocks[0] as Block).pos,
      to: (blocks[blocks.length - 1] as Block).end,
    };
  }
  const ranges = blocks.map((b) => sectionRange(s, b));
  for (let k = 1; k < ranges.length; k++) {
    if ((ranges[k] as { from: number }).from !== (ranges[k - 1] as { to: number }).to) {
      return fail(
        'not-contiguous',
        `Sections ${blocks[k - 1]?.id} and ${blocks[k]?.id} are not adjacent.`,
      );
    }
  }
  return {
    ok: true,
    from: (ranges[0] as { from: number }).from,
    to: (ranges[ranges.length - 1] as { to: number }).to,
  };
}

/** Before or after a reference. */
export const RelativePositionSchema = z.enum(['before', 'after']);
/** Before or after a reference. */
export type RelativePosition = z.infer<typeof RelativePositionSchema>;

/** Resolves an insertion point before or after a sentence (the sentence's `from` or `to`). */
export function resolveInsertionPoint(
  doc: DocOrSegmentation,
  position: RelativePosition,
  sentenceIdRef: string,
): Resolved<{ pos: number; sentence: Sentence }> {
  const sentence = seg(doc).sentenceById.get(sentenceIdRef);
  if (!sentence) return fail('unknown-sentence', `No sentence ${sentenceIdRef} in this document.`);
  return { ok: true, pos: position === 'before' ? sentence.from : sentence.to, sentence };
}

/**
 * Resolves a move: the source span plus a destination before/after a unit of the
 * same kind (a sentence id for sentence moves, a top-level paragraph id for
 * paragraph moves, a top-level heading id for section moves — "after" a section
 * means after its whole range). The destination must lie outside the source and
 * must actually move it.
 */
export function resolveMove(
  doc: DocOrSegmentation,
  span: Pick<SpanRef, 'unit' | 'ids'>,
  destination: { position: RelativePosition; id: string },
): Resolved<{ from: number; to: number; insertAt: number }> {
  const s = seg(doc);
  const src = resolveSpan(s, span);
  if (!src.ok) return src;
  const dst = resolveSpan(s, { unit: span.unit, ids: [destination.id] });
  if (!dst.ok) return fail('invalid-destination', `Destination: ${dst.error.message}`);
  const insertAt = destination.position === 'before' ? dst.from : dst.to;
  if (insertAt >= src.from && insertAt <= src.to) {
    return fail(
      'invalid-destination',
      'The destination is inside or at the edge of the span, so nothing would move.',
    );
  }
  return { ok: true, from: src.from, to: src.to, insertAt };
}

/** Resolves a split of a paragraph before one of its sentences (not the first). Returns the split position. */
export function resolveSplit(
  doc: DocOrSegmentation,
  paragraphId: string,
  sentenceIdRef: string,
): Resolved<{ pos: number; block: Block }> {
  const s = seg(doc);
  const block = s.blockById.get(paragraphId);
  if (!block) return fail('unknown-block', `No block ${paragraphId} in this document.`);
  if (block.nodeType !== 'paragraph')
    return fail('invalid-split', `${paragraphId} is not a paragraph.`);
  const sentence = s.sentenceById.get(sentenceIdRef);
  if (!sentence || sentence.blockId !== block.id) {
    return fail('invalid-split', `${sentenceIdRef} is not a sentence of ${paragraphId}.`);
  }
  if (sentence.sentenceIndex === 0) {
    return fail(
      'invalid-split',
      `${sentenceIdRef} is the first sentence; split before a later one.`,
    );
  }
  return { ok: true, pos: sentence.from, block };
}

/**
 * Resolves a merge of two adjacent sibling paragraphs (the second directly follows
 * the first under the same parent). Returns the join position (`first.end === second.pos`).
 */
export function resolveMerge(
  doc: DocOrSegmentation,
  firstParagraphId: string,
  secondParagraphId: string,
): Resolved<{ joinPos: number; first: Block; second: Block }> {
  const s = seg(doc);
  const first = s.blockById.get(firstParagraphId);
  const second = s.blockById.get(secondParagraphId);
  if (!first) return fail('unknown-block', `No block ${firstParagraphId} in this document.`);
  if (!second) return fail('unknown-block', `No block ${secondParagraphId} in this document.`);
  if (first.nodeType !== 'paragraph' || second.nodeType !== 'paragraph') {
    return fail('invalid-merge', 'Both blocks must be paragraphs.');
  }
  if (first.end !== second.pos) {
    return fail(
      'invalid-merge',
      `${secondParagraphId} does not directly follow ${firstParagraphId}.`,
    );
  }
  return { ok: true, joinPos: first.end, first, second };
}
