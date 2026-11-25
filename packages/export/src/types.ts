/**
 * Public input types of `@longhand/export`.
 *
 * Every exporter takes one {@link ExportInput}: an ordered list of documents, the
 * project's metadata, optional sources for citations and the bibliography, and an
 * optional `ProvenanceSummary` (from `@longhand/schema`) to append. The summary is
 * data computed elsewhere (the report lane); this package never folds the ledger or attributes
 * words itself.
 */
import type { CslItem, PMNodeJSON, ProvenanceSummary } from '@longhand/schema';

/** Re-exported from `@longhand/schema`, where the report lane produces it. */
export { provenanceSummaryFromReport, type ProvenanceSummary } from '@longhand/schema';

/** One document to export, in reading order. */
export interface ExportDocument {
  /** The binder document id, if known. Used only in warnings. */
  id?: string;
  /** Shown as the document's heading when document titles are on. */
  title: string;
  /** ProseMirror document JSON in the Longhand schema (`DocumentState.content`). */
  content: PMNodeJSON;
}

/** Project metadata for the title block and file metadata. */
export interface ExportProjectMeta {
  title: string;
  subtitle?: string | null;
  author?: string | null;
  /** A display date, printed as given (e.g. `"November 2026"`). Exporters never read the clock for it. */
  date?: string | null;
  /** BCP 47 language tag for file metadata, e.g. `en-GB`. Defaults to `en`. */
  language?: string | null;
}

/** A styled span of text, for bibliography entries and attributions. */
export interface TextSpan {
  text: string;
  italic?: boolean;
  bold?: boolean;
}

/** Plain text, or styled spans. */
export type RichText = string | readonly TextSpan[];

/** What a citation formatter knows about a citation. */
export interface CitationContext {
  /** The source, or `undefined` if no source with this id was supplied. */
  source: CslItem | undefined;
  /**
   * 1-based number of the source in first-citation order across the whole export
   * (quote blocks count as citing their source). Numbered styles use it.
   */
  number: number;
  /** Whether the citation sits inside a footnote. */
  inFootnote: boolean;
  /** 0-based index of the document the citation is in. */
  documentIndex: number;
}

/**
 * Formats one citation node as inline text, e.g. `"(Woolf 1929, p. 12)"` or `"[3]"`.
 * The research lane injects its CSL renderer here. The result is inserted verbatim
 * (escaped as needed for the output format).
 */
export type CitationFormatter = (
  sourceId: string,
  locator: string | null,
  ctx: CitationContext,
) => string;

/** What a bibliography formatter knows about an entry. */
export interface BibliographyContext {
  /** The entry's number in numbered styles (first-citation order), else `null`. */
  number: number | null;
}

/** Formats one bibliography entry. Return spans to get italic titles. */
export type BibliographyFormatter = (item: CslItem, ctx: BibliographyContext) => RichText;

/** What a quote-attribution formatter knows. */
export interface QuoteAttributionContext {
  source: CslItem | undefined;
  /** The quote block's `locator` attr. */
  locator: string | null;
  /** The quote block's `clippingId` attr. */
  clippingId: string | null;
}

/**
 * Formats the attribution line printed under a quote block (without the leading
 * dash, which renderers add). Return `null` to print no attribution.
 */
export type QuoteAttributionFormatter = (
  sourceId: string,
  ctx: QuoteAttributionContext,
) => RichText | null;

/** A non-fatal problem found while exporting. */
export interface ExportWarning {
  code: 'missing-source';
  message: string;
  documentIndex: number;
  sourceId: string;
}

/** Bibliography options. */
export interface BibliographyOptions {
  /**
   * Which sources to list: those cited (by citation nodes or quote blocks, the
   * default), every supplied source, or none.
   */
  include?: 'cited' | 'all' | 'none';
  /** Section heading. Default `"Bibliography"` (author-date) or `"References"` (numbered). */
  title?: string;
  /** Entry order. Default `alphabetical` for author-date and `first-cited` for numbered. */
  order?: 'alphabetical' | 'first-cited';
}

/** Options shared by every exporter. All optional. */
export interface ExportOptions {
  /**
   * Built-in citation style used when {@link formatCitation} is not given:
   * `author-date` (default) renders `(Woolf 1929, p. 12)`, `numbered` renders `[1, p. 12]`.
   * It also picks the default bibliography title and order, and numbered
   * bibliographies print `[n]` labels.
   */
  citationStyle?: 'author-date' | 'numbered';
  /** Custom citation formatter (e.g. the research lane's CSL renderer). */
  formatCitation?: CitationFormatter;
  /** Custom bibliography entry formatter. */
  formatBibliographyEntry?: BibliographyFormatter;
  /** Custom quote-block attribution formatter. */
  formatQuoteAttribution?: QuoteAttributionFormatter;
  bibliography?: BibliographyOptions;
  /** Print the project title block (title, subtitle, author, date). Default true. */
  titleBlock?: boolean;
  /**
   * Print each document's title as a heading. `auto` (default) prints them when
   * there is more than one document. When titles print, the documents' own
   * headings move down one outline level.
   */
  documentTitles?: 'auto' | 'always' | 'never';
  /** Text of a scene break. Default `"* * *"`. */
  sceneBreak?: string;
  /** Heading of the provenance appendix. Default `"Provenance"`. */
  provenanceTitle?: string;
  /** Called for every non-fatal problem (e.g. a citation whose source wasn't supplied). */
  onWarning?: (warning: ExportWarning) => void;
}

/** Everything an exporter needs. */
export interface ExportInput {
  project: ExportProjectMeta;
  /** Documents in reading order. */
  documents: readonly ExportDocument[];
  /** CSL-JSON items (`SourceState.csl`), keyed by `id` = source id. */
  sources?: readonly CslItem[];
  /** Optional provenance appendix. */
  provenance?: ProvenanceSummary | null;
  options?: ExportOptions;
}
