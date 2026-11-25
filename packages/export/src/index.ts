/**
 * @longhand/export — Markdown, DOCX and PDF export (F9) with an optional
 * provenance appendix.
 *
 * Every exporter takes an {@link ExportInput}. The root entry point includes the
 * PDF exporter, which is Node-only; browser code should import the isomorphic
 * subpaths `@longhand/export/markdown` and `@longhand/export/docx`.
 */
import { DOCX_MIME_TYPE, exportDocx, type DocxOptions } from './docx';
import { MARKDOWN_MIME_TYPE, exportMarkdown } from './markdown';
import { fileSlug } from './model';
import { PDF_MIME_TYPE, exportPdf, type PdfOptions } from './pdf';
import type { ExportInput } from './types';

export * from './types';
export {
  buildExportModel,
  ExportError,
  HANDLED_MARK_TYPES,
  HANDLED_NODE_TYPES,
  fileSlug,
  type Block,
  type BibliographyEntry,
  type ExportModel,
  type Inline,
  type ModelDocument,
  type ModelFootnote,
  type ProvenanceAppendix,
  type ProvenanceRow,
} from './model';
export {
  MISSING_SOURCE_TEXT,
  authorDateCitation,
  defaultBibliographyEntry,
  defaultQuoteAttribution,
  formatLocator,
  numberedCitation,
} from './citations';
export { MARKDOWN_MIME_TYPE, exportMarkdown, renderMarkdown } from './markdown';
export { DOCX_MIME_TYPE, buildDocxDocument, exportDocx, type DocxOptions } from './docx';
export { PDF_MIME_TYPE, exportPdf, renderPdf, type PdfOptions } from './pdf';
export { defaultPdfFonts, type PdfFontSet, type PdfFontSource } from './pdf-fonts';

/** An export format. */
export type ExportFormat = 'markdown' | 'docx' | 'pdf';

/** A finished export file. */
export interface ExportFile {
  bytes: Uint8Array;
  mimeType: string;
  /** A suggested file name from the project title, e.g. `the-salt-road.docx`. */
  filename: string;
}

/** Exports in any format and returns the bytes with a MIME type and file name (for download routes). */
export async function exportFile(
  format: ExportFormat,
  input: ExportInput,
  formatOptions: { docx?: DocxOptions; pdf?: PdfOptions } = {},
): Promise<ExportFile> {
  const base = fileSlug(input.project.title);
  switch (format) {
    case 'markdown':
      return {
        bytes: new TextEncoder().encode(exportMarkdown(input)),
        mimeType: MARKDOWN_MIME_TYPE,
        filename: `${base}.md`,
      };
    case 'docx':
      return {
        bytes: await exportDocx(input, formatOptions.docx),
        mimeType: DOCX_MIME_TYPE,
        filename: `${base}.docx`,
      };
    case 'pdf':
      return {
        bytes: await exportPdf(input, formatOptions.pdf),
        mimeType: PDF_MIME_TYPE,
        filename: `${base}.pdf`,
      };
  }
}
