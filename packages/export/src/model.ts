/**
 * The export model: a format-neutral tree built once from an {@link ExportInput}
 * and rendered by each exporter.
 *
 * Building the model does everything that is the same for every format: it
 * validates each document against the Longhand schema, handles every node and
 * mark type (throwing {@link ExportError} on anything else), numbers footnotes
 * continuously across the export, numbers sources in first-citation order,
 * formats citations and quote attributions, and assembles the bibliography and
 * the provenance appendix.
 */
import {
  PROVENANCE_CLASSES,
  PROVENANCE_CLASS_INFO,
  docFromJSON,
  type CslItem,
  type MarkTypeName,
  type NodeTypeName,
  type PMNodeJSON,
  type ProvenanceClass,
} from '@longhand/schema';
import {
  authorDateCitation,
  bibliographySortKey,
  defaultBibliographyEntry,
  defaultQuoteAttribution,
  numberedCitation,
} from './citations';
import type { ExportInput, ExportWarning, RichText, TextSpan } from './types';

/** Thrown for input the exporters cannot render (invalid documents, unknown node or mark types). */
export class ExportError extends Error {
  override name = 'ExportError';
}

/** Inline content. Adjacent text with equal marks is merged. */
export type Inline =
  | { kind: 'text'; text: string; em: boolean; strong: boolean }
  | { kind: 'break' }
  | { kind: 'footnoteRef'; number: number }
  | {
      kind: 'citation';
      text: string;
      sourceId: string;
      locator: string | null;
      em: boolean;
      strong: boolean;
    };

/** Block content. Empty paragraphs are dropped. */
export type Block =
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; content: Inline[] }
  | { kind: 'blockquote'; children: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'sceneBreak' }
  | {
      kind: 'quoteBlock';
      children: Block[];
      sourceId: string;
      clippingId: string | null;
      locator: string | null;
      /** Attribution line without the leading dash, or null for none. */
      attribution: TextSpan[] | null;
    };

/** A footnote, numbered continuously across the export (1-based). */
export interface ModelFootnote {
  number: number;
  content: Inline[];
}

export interface ModelDocument {
  id: string | undefined;
  title: string;
  blocks: Block[];
  /** This document's footnotes, in reference order. */
  footnotes: ModelFootnote[];
}

export interface BibliographyEntry {
  sourceId: string;
  /** `[n]` style label for numbered bibliographies, else null. */
  label: string | null;
  text: TextSpan[];
}

export interface ProvenanceRow {
  class: ProvenanceClass;
  label: string;
  words: number;
  /** Share of all words, formatted to one decimal place, e.g. `"97.8%"`. */
  share: string;
}

export interface ProvenanceAppendix {
  title: string;
  disclosure: string;
  rows: ProvenanceRow[];
  totalWords: number;
  proves: string[];
  doesNotProve: string[];
  verificationNote: string | null;
}

export interface ExportModel {
  title: string;
  subtitle: string | null;
  author: string | null;
  date: string | null;
  language: string;
  showTitleBlock: boolean;
  showDocumentTitles: boolean;
  sceneBreak: string;
  documents: ModelDocument[];
  bibliography: { title: string; entries: BibliographyEntry[] } | null;
  provenance: ProvenanceAppendix | null;
}

/** Every node type the model builder handles. Must equal the schema's node types. */
export const HANDLED_NODE_TYPES: readonly NodeTypeName[] = [
  'doc',
  'paragraph',
  'heading',
  'blockquote',
  'bullet_list',
  'ordered_list',
  'list_item',
  'scene_break',
  'quote_block',
  'text',
  'hard_break',
  'footnote',
  'citation',
];

/** Every mark type the model builder handles. Must equal the schema's mark types. */
export const HANDLED_MARK_TYPES: readonly MarkTypeName[] = ['em', 'strong'];

/** Normalizes {@link RichText} to spans. */
export function toSpans(rich: RichText): TextSpan[] {
  return typeof rich === 'string' ? (rich ? [{ text: rich }] : []) : rich.map((s) => ({ ...s }));
}

/** Concatenated plain text of spans. */
export function spansText(spans: readonly TextSpan[]): string {
  return spans.map((s) => s.text).join('');
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Formats a share of a total as `"97.8%"`, without locale APIs. */
export function formatShare(part: number, total: number): string {
  if (total <= 0) return '0.0%';
  const tenths = Math.round((part * 1000) / total);
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

/** Builds the export model. Throws {@link ExportError} on invalid documents or unknown node or mark types. */
export function buildExportModel(input: ExportInput): ExportModel {
  const opts = input.options ?? {};
  const style = opts.citationStyle ?? 'author-date';
  const formatCitation =
    opts.formatCitation ?? (style === 'numbered' ? numberedCitation : authorDateCitation);
  const formatAttribution = opts.formatQuoteAttribution ?? defaultQuoteAttribution;
  const formatEntry = opts.formatBibliographyEntry ?? defaultBibliographyEntry;

  const sources = new Map<string, CslItem>();
  for (const s of input.sources ?? []) if (!sources.has(s.id)) sources.set(s.id, s);

  const citedOrder: string[] = [];
  const citedNumber = new Map<string, number>();
  const cite = (sourceId: string): number => {
    let n = citedNumber.get(sourceId);
    if (n === undefined) {
      n = citedOrder.length + 1;
      citedOrder.push(sourceId);
      citedNumber.set(sourceId, n);
    }
    return n;
  };

  const warned = new Set<string>();
  const warn = (w: ExportWarning): void => {
    const key = `${w.code}\u0000${w.documentIndex}\u0000${w.sourceId}`;
    if (warned.has(key)) return;
    warned.add(key);
    opts.onWarning?.(w);
  };

  let footnoteCounter = 0;

  const documents = input.documents.map((doc, documentIndex): ModelDocument => {
    const where = `document ${documentIndex} ("${doc.title}")`;
    try {
      docFromJSON(doc.content);
    } catch (e) {
      throw new ExportError(`${where}: invalid document JSON: ${(e as Error).message}`, {
        cause: e,
      });
    }
    const footnotes: ModelFootnote[] = [];

    const checkSource = (sourceId: string): CslItem | undefined => {
      const source = sources.get(sourceId);
      if (!source) {
        warn({
          code: 'missing-source',
          message: `${where} cites source "${sourceId}", which was not supplied`,
          documentIndex,
          sourceId,
        });
      }
      return source;
    };

    const marksOf = (node: PMNodeJSON): { em: boolean; strong: boolean } => {
      let em = false;
      let strong = false;
      for (const m of node.marks ?? []) {
        const t = m.type as MarkTypeName;
        switch (t) {
          case 'em':
            em = true;
            break;
          case 'strong':
            strong = true;
            break;
          default:
            throw new ExportError(`${where}: unknown mark type "${m.type as string}"`);
        }
      }
      return { em, strong };
    };

    const inlines = (nodes: readonly PMNodeJSON[] | undefined, inFootnote: boolean): Inline[] => {
      const out: Inline[] = [];
      const pushText = (text: string, em: boolean, strong: boolean): void => {
        if (text === '') return;
        const last = out[out.length - 1];
        if (last && last.kind === 'text' && last.em === em && last.strong === strong) {
          last.text += text;
        } else {
          out.push({ kind: 'text', text, em, strong });
        }
      };
      for (const node of nodes ?? []) {
        const type = node.type as NodeTypeName;
        switch (type) {
          case 'text': {
            const { em, strong } = marksOf(node);
            // Text nodes should not hold line breaks; if one does, treat it as a hard break.
            const parts = (node.text ?? '').split(/\r\n|\r|\n/);
            parts.forEach((part, i) => {
              if (i > 0) out.push({ kind: 'break' });
              pushText(part, em, strong);
            });
            break;
          }
          case 'hard_break':
            marksOf(node);
            out.push({ kind: 'break' });
            break;
          case 'citation': {
            const { em, strong } = marksOf(node);
            const sourceId = str(node.attrs?.sourceId) ?? '';
            const locator = str(node.attrs?.locator);
            const source = checkSource(sourceId);
            const number = cite(sourceId);
            const text = formatCitation(sourceId, locator, {
              source,
              number,
              inFootnote,
              documentIndex,
            });
            out.push({ kind: 'citation', text, sourceId, locator, em, strong });
            break;
          }
          case 'footnote': {
            marksOf(node);
            if (inFootnote) throw new ExportError(`${where}: footnotes cannot nest`);
            const number = ++footnoteCounter;
            out.push({ kind: 'footnoteRef', number });
            // Content is converted after the reference so citations inside count in reading order.
            footnotes.push({ number, content: inlines(node.content, true) });
            break;
          }
          case 'doc':
          case 'paragraph':
          case 'heading':
          case 'blockquote':
          case 'bullet_list':
          case 'ordered_list':
          case 'list_item':
          case 'scene_break':
          case 'quote_block':
            throw new ExportError(`${where}: block node "${type}" in inline content`);
          default:
            throw new ExportError(`${where}: unknown node type "${node.type as string}"`);
        }
      }
      return out;
    };

    const blocks = (nodes: readonly PMNodeJSON[] | undefined): Block[] => {
      const out: Block[] = [];
      for (const node of nodes ?? []) {
        const type = node.type as NodeTypeName;
        switch (type) {
          case 'paragraph': {
            const content = inlines(node.content, false);
            if (content.length > 0) out.push({ kind: 'paragraph', content });
            break;
          }
          case 'heading': {
            const level = node.attrs?.level;
            const content = inlines(node.content, false);
            if (content.length > 0) {
              out.push({
                kind: 'heading',
                level: level === 2 || level === 3 ? level : 1,
                content,
              });
            }
            break;
          }
          case 'blockquote': {
            const children = blocks(node.content);
            if (children.length > 0) out.push({ kind: 'blockquote', children });
            break;
          }
          case 'bullet_list':
          case 'ordered_list': {
            const items = (node.content ?? []).map((item) => {
              if (item.type !== 'list_item') {
                throw new ExportError(`${where}: "${item.type}" inside a list`);
              }
              return blocks(item.content);
            });
            const order = node.attrs?.order;
            out.push({
              kind: 'list',
              ordered: type === 'ordered_list',
              start: typeof order === 'number' && Number.isFinite(order) ? order : 1,
              items,
            });
            break;
          }
          case 'scene_break':
            out.push({ kind: 'sceneBreak' });
            break;
          case 'quote_block': {
            const sourceId = str(node.attrs?.sourceId) ?? '';
            const clippingId = str(node.attrs?.clippingId);
            const locator = str(node.attrs?.locator);
            const source = checkSource(sourceId);
            cite(sourceId);
            const children = blocks(node.content);
            const rich = formatAttribution(sourceId, { source, locator, clippingId });
            const attribution = rich === null ? null : toSpans(rich);
            out.push({
              kind: 'quoteBlock',
              children,
              sourceId,
              clippingId,
              locator,
              attribution: attribution && attribution.length > 0 ? attribution : null,
            });
            break;
          }
          case 'list_item':
            throw new ExportError(`${where}: list_item outside a list`);
          case 'doc':
          case 'text':
          case 'hard_break':
          case 'footnote':
          case 'citation':
            throw new ExportError(`${where}: inline node "${type}" in block content`);
          default:
            throw new ExportError(`${where}: unknown node type "${node.type as string}"`);
        }
      }
      return out;
    };

    return { id: doc.id, title: doc.title, blocks: blocks(doc.content.content), footnotes };
  });

  // Bibliography.
  const bibOpts = opts.bibliography ?? {};
  const include = bibOpts.include ?? 'cited';
  let bibliography: ExportModel['bibliography'] = null;
  if (include !== 'none') {
    const cited = citedOrder
      .filter((id) => sources.has(id))
      .map((id) => sources.get(id) as CslItem);
    let items: CslItem[] = cited;
    if (include === 'all') {
      const rest = [...sources.values()]
        .filter((s) => !citedNumber.has(s.id))
        .sort((a, b) => compare(bibliographySortKey(a), bibliographySortKey(b)));
      items = [...cited, ...rest];
    }
    const order = bibOpts.order ?? (style === 'numbered' ? 'first-cited' : 'alphabetical');
    if (order === 'alphabetical') {
      items = [...items].sort((a, b) => compare(bibliographySortKey(a), bibliographySortKey(b)));
    }
    if (items.length > 0) {
      const numbers = new Map<string, number>();
      // Uncited sources (include: 'all') continue the numbering after the cited ones.
      let next = citedOrder.length + 1;
      for (const it of items) numbers.set(it.id, citedNumber.get(it.id) ?? next++);
      bibliography = {
        title: bibOpts.title ?? (style === 'numbered' ? 'References' : 'Bibliography'),
        entries: items.map((item) => {
          const number = style === 'numbered' ? (numbers.get(item.id) as number) : null;
          return {
            sourceId: item.id,
            label: number === null ? null : `[${number}]`,
            text: toSpans(formatEntry(item, { number })),
          };
        }),
      };
    }
  }

  // Provenance appendix.
  let provenance: ProvenanceAppendix | null = null;
  if (input.provenance) {
    const p = input.provenance;
    const words = (c: ProvenanceClass): number => {
      const n = p.wordsByClass[c] ?? 0;
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };
    const totalWords = PROVENANCE_CLASSES.reduce((sum, c) => sum + words(c), 0);
    provenance = {
      title: opts.provenanceTitle ?? 'Provenance',
      disclosure: p.disclosure,
      // pasted-internal is never a run class (internal pastes inherit), so it is shown only if non-zero.
      rows: PROVENANCE_CLASSES.filter((c) => c !== 'pasted-internal' || words(c) > 0).map((c) => ({
        class: c,
        label: PROVENANCE_CLASS_INFO[c].label,
        words: words(c),
        share: formatShare(words(c), totalWords),
      })),
      totalWords,
      proves: [...p.provesTable.proves],
      doesNotProve: [...p.provesTable.doesNotProve],
      verificationNote: p.verificationNote ? p.verificationNote : null,
    };
  }

  const docTitles = opts.documentTitles ?? 'auto';
  const project = input.project;
  return {
    title: project.title,
    subtitle: project.subtitle || null,
    author: project.author || null,
    date: project.date || null,
    language: project.language || 'en',
    showTitleBlock: opts.titleBlock ?? true,
    showDocumentTitles:
      docTitles === 'always' || (docTitles === 'auto' && input.documents.length > 1),
    sceneBreak: opts.sceneBreak ?? '* * *',
    documents,
    bibliography,
    provenance,
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Plain text of inline content (citations as their formatted text, footnote refs as their number). */
export function inlineText(content: readonly Inline[]): string {
  return content
    .map((i) =>
      i.kind === 'text' || i.kind === 'citation'
        ? i.text
        : i.kind === 'break'
          ? '\n'
          : String(i.number),
    )
    .join('');
}

/** A file-name-safe slug of the project title, for default download names. */
export function fileSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'export';
}
