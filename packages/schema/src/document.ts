/**
 * The ProseMirror document schema shared by the fold, the editor, export and the agent.
 *
 * Contract decisions:
 * - **No stable block `id` attrs.** Blocks are identified positionally (`p3`, `p3.s2`)
 *   by the segmenter for a given document version, and durable references are
 *   ProseMirror positions mapped forward through steps. Id attrs would have to be
 *   generated deterministically by the fold for split/merge proposals and
 *   de-duplicated after every split or paste, which is a determinism hazard for
 *   little gain.
 * - Inline content of every textblock is `inline*`; `footnote` content is restricted
 *   to `(text | hard_break | citation)*` so footnotes never nest.
 * - `citation` and `quote_block` carry only references (`sourceId`, `clippingId`,
 *   `locator`); the words of a quote block are ordinary text children whose
 *   provenance is derived by the fold, never from attrs.
 * - There is no link mark and no code mark in v1.
 */
import {
  Schema,
  type DOMOutputSpec,
  type Mark,
  type MarkSpec,
  type Node as PMNode,
  type NodeSpec,
} from 'prosemirror-model';
import { z } from 'zod';

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },

  paragraph: {
    content: 'inline*',
    group: 'block',
    parseDOM: [{ tag: 'p' }],
    toDOM: (): DOMOutputSpec => ['p', 0],
  },

  heading: {
    attrs: { level: { default: 1, validate: (v: unknown) => checkHeadingLevel(v) } },
    content: 'inline*',
    group: 'block',
    defining: true,
    parseDOM: [
      { tag: 'h1', attrs: { level: 1 } },
      { tag: 'h2', attrs: { level: 2 } },
      { tag: 'h3', attrs: { level: 3 } },
    ],
    toDOM: (node): DOMOutputSpec => [`h${node.attrs.level as number}`, 0],
  },

  blockquote: {
    content: '(paragraph | bullet_list | ordered_list)+',
    group: 'block',
    defining: true,
    parseDOM: [{ tag: 'blockquote:not([data-quote-block])' }],
    toDOM: (): DOMOutputSpec => ['blockquote', 0],
  },

  bullet_list: {
    content: 'list_item+',
    group: 'block',
    parseDOM: [{ tag: 'ul' }],
    toDOM: (): DOMOutputSpec => ['ul', 0],
  },

  ordered_list: {
    attrs: { order: { default: 1, validate: 'number' } },
    content: 'list_item+',
    group: 'block',
    parseDOM: [
      {
        tag: 'ol',
        getAttrs: (dom: HTMLElement) => ({
          order: dom.hasAttribute('start') ? Number(dom.getAttribute('start')) : 1,
        }),
      },
    ],
    toDOM: (node): DOMOutputSpec =>
      node.attrs.order === 1 ? ['ol', 0] : ['ol', { start: node.attrs.order as number }, 0],
  },

  list_item: {
    content: 'paragraph (paragraph | bullet_list | ordered_list)*',
    defining: true,
    parseDOM: [{ tag: 'li' }],
    toDOM: (): DOMOutputSpec => ['li', 0],
  },

  scene_break: {
    group: 'block',
    atom: true,
    selectable: true,
    parseDOM: [{ tag: 'hr' }],
    toDOM: (): DOMOutputSpec => ['hr', { 'data-scene-break': '' }],
  },

  /** A clipping placed in the manuscript. Its text is quoted, never typed. */
  quote_block: {
    attrs: {
      sourceId: { validate: 'string' },
      clippingId: { default: null, validate: 'string|null' },
      locator: { default: null, validate: 'string|null' },
    },
    content: 'paragraph+',
    group: 'block',
    defining: true,
    parseDOM: [
      {
        tag: 'blockquote[data-quote-block]',
        getAttrs: (dom: HTMLElement) => ({
          sourceId: dom.getAttribute('data-source-id') ?? '',
          clippingId: dom.getAttribute('data-clipping-id'),
          locator: dom.getAttribute('data-locator'),
        }),
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      'blockquote',
      {
        'data-quote-block': '',
        'data-source-id': node.attrs.sourceId as string,
        ...(node.attrs.clippingId ? { 'data-clipping-id': node.attrs.clippingId as string } : {}),
        ...(node.attrs.locator ? { 'data-locator': node.attrs.locator as string } : {}),
      },
      0,
    ],
  },

  text: { group: 'inline' },

  hard_break: {
    inline: true,
    group: 'inline',
    selectable: false,
    leafText: () => '\n',
    parseDOM: [{ tag: 'br' }],
    toDOM: (): DOMOutputSpec => ['br'],
  },

  /** An inline footnote whose content is edited in place (atom: the editor uses a node view). */
  footnote: {
    inline: true,
    group: 'inline',
    content: '(text | hard_break | citation)*',
    atom: true,
    parseDOM: [{ tag: 'span[data-footnote]' }],
    toDOM: (): DOMOutputSpec => ['span', { 'data-footnote': '' }, 0],
  },

  /** A structured citation: a reference to a library source plus a locator, never text. */
  citation: {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: {
      sourceId: { validate: 'string' },
      locator: { default: null, validate: 'string|null' },
    },
    leafText: () => '',
    parseDOM: [
      {
        tag: 'span[data-citation]',
        getAttrs: (dom: HTMLElement) => ({
          sourceId: dom.getAttribute('data-source-id') ?? '',
          locator: dom.getAttribute('data-locator'),
        }),
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      'span',
      {
        'data-citation': '',
        'data-source-id': node.attrs.sourceId as string,
        ...(node.attrs.locator ? { 'data-locator': node.attrs.locator as string } : {}),
      },
    ],
  },
};

function checkHeadingLevel(v: unknown): void {
  if (v !== 1 && v !== 2 && v !== 3)
    throw new RangeError(`heading level must be 1, 2 or 3, got ${String(v)}`);
}

const marks: Record<string, MarkSpec> = {
  em: {
    parseDOM: [{ tag: 'i' }, { tag: 'em' }, { style: 'font-style=italic' }],
    toDOM: (): DOMOutputSpec => ['em', 0],
  },
  strong: {
    parseDOM: [
      { tag: 'strong' },
      { tag: 'b', getAttrs: (node: HTMLElement) => node.style.fontWeight !== 'normal' && null },
      {
        style: 'font-weight',
        getAttrs: (value: string) => /^(bold(er)?|[5-9]\d{2,})$/.test(value) && null,
      },
    ],
    toDOM: (): DOMOutputSpec => ['strong', 0],
  },
};

/** The Longhand ProseMirror schema. The single source of truth for document structure. */
export const schema = new Schema({ nodes, marks });

/** Node type names in {@link schema}. */
export type NodeTypeName =
  | 'doc'
  | 'paragraph'
  | 'heading'
  | 'blockquote'
  | 'bullet_list'
  | 'ordered_list'
  | 'list_item'
  | 'scene_break'
  | 'quote_block'
  | 'text'
  | 'hard_break'
  | 'footnote'
  | 'citation';

/** Mark type names in {@link schema}. */
export type MarkTypeName = 'em' | 'strong';

/** Allowed heading levels. */
export const HEADING_LEVELS = [1, 2, 3] as const;

/** ProseMirror node JSON (`Node#toJSON()` output). Structural only; use {@link docFromJSON} to validate against the schema. */
export interface PMNodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNodeJSON[];
  marks?: PMMarkJSON[];
  text?: string;
}

/** ProseMirror mark JSON. */
export interface PMMarkJSON {
  type: string;
  attrs?: Record<string, unknown>;
}

/** Zod schema for {@link PMMarkJSON}. */
export const PMMarkJSONSchema: z.ZodType<PMMarkJSON> = z.object({
  type: z.string().min(1),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

/** Zod schema for {@link PMNodeJSON} (shape only). */
export const PMNodeJSONSchema: z.ZodType<PMNodeJSON> = z.lazy(() =>
  z.object({
    type: z.string().min(1),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(PMNodeJSONSchema).optional(),
    marks: z.array(PMMarkJSONSchema).optional(),
    text: z.string().optional(),
  }),
);

/**
 * Zod schema for a full document JSON: shape-checked, then parsed and `check()`ed
 * against {@link schema}.
 */
export const DocJSONSchema: z.ZodType<PMNodeJSON> = PMNodeJSONSchema.refine(
  (json) => {
    try {
      docFromJSON(json);
      return true;
    } catch {
      return false;
    }
  },
  { message: 'not a valid Longhand document' },
);

/** Parses document JSON into a ProseMirror node and validates it against the schema. Throws on invalid input. */
export function docFromJSON(json: unknown): PMNode {
  const node = schema.nodeFromJSON(json);
  if (node.type !== schema.nodes.doc)
    throw new RangeError(`expected a doc node, got ${node.type.name}`);
  node.check();
  return node;
}

/** The content of a freshly created document: one empty paragraph. */
export const EMPTY_DOC_JSON: Readonly<PMNodeJSON> = Object.freeze({
  type: 'doc',
  content: Object.freeze([Object.freeze({ type: 'paragraph' })]) as PMNodeJSON[],
});

/** Creates a new empty document node. */
export function emptyDoc(): PMNode {
  return docFromJSON(EMPTY_DOC_JSON);
}

/** Re-exported ProseMirror types for consumers that only need types. */
export type { PMNode, Mark as PMMark };
