/**
 * Export downloads (F9): builds `@longhand/export`'s `ExportInput` from the folded
 * state, with the research lane's CSL renderer injected as `formatCitation` and
 * `formatBibliographyEntry` (the adapter BUILD_STATUS asked for).
 */
import { manuscriptOrder } from '@longhand/agent';
import {
  exportFile,
  type BibliographyFormatter,
  type CitationFormatter,
  type ExportFile,
  type ExportFormat,
  type ExportInput,
  type TextSpan,
} from '@longhand/export';
import { formatBibliography, formatCitation, resolveStyle } from '@longhand/research';
import type { CslItem, ProjectState, ProvenanceSummary } from '@longhand/schema';

/**
 * CSL-JSON allows numbers for fields such as `volume`, but citeproc-js throws on
 * them (`num.match is not a function`), so numbers become strings before formatting.
 */
export function normalizeCslItem(item: CslItem): CslItem {
  const out: Record<string, unknown> = { ...item };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'number' && k !== 'id') out[k] = String(v);
  }
  return out as CslItem;
}

/** The research lane's CSL formatters, adapted to export's injected-formatter signatures. */
export function cslFormatters(
  rawItems: readonly CslItem[],
  style: string,
): { formatCitation: CitationFormatter; formatBibliographyEntry: BibliographyFormatter } {
  const items = rawItems.map(normalizeCslItem);
  const styleId = resolveStyle(style);
  return {
    formatCitation: (sourceId, locator) => formatCitation(items, sourceId, locator, styleId).text,
    formatBibliographyEntry: (item) => {
      const bib = formatBibliography(items, styleId, [String(item.id)]);
      const entry = bib.entries[0];
      if (!entry) return item.title ? String(item.title) : item.id;
      return htmlToSpans(entry.html);
    },
  };
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#38': '&',
  '#60': '<',
  '#62': '>',
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return ENTITIES[lower] ?? m;
  });
}

/** citeproc HTML → styled spans (italic and bold kept, every other tag dropped). */
export function htmlToSpans(html: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let italic = 0;
  let bold = 0;
  const re = /<\/?([a-z0-9]+)(?:\s[^>]*)?>|[^<]+/gi;
  for (const m of html.matchAll(re)) {
    const tok = m[0];
    if (tok.startsWith('<')) {
      const name = (m[1] ?? '').toLowerCase();
      const closing = tok.startsWith('</');
      const style = /font-style:\s*italic/i.test(tok);
      if (name === 'i' || name === 'em' || (name === 'span' && style)) italic += closing ? -1 : 1;
      else if (name === 'b' || name === 'strong') bold += closing ? -1 : 1;
      continue;
    }
    const text = decode(tok);
    if (!text) continue;
    const span: TextSpan = { text };
    if (italic > 0) span.italic = true;
    if (bold > 0) span.bold = true;
    const last = spans.at(-1);
    if (
      last &&
      Boolean(last.italic) === Boolean(span.italic) &&
      Boolean(last.bold) === Boolean(span.bold)
    ) {
      last.text += span.text;
    } else spans.push(span);
  }
  if (spans.length > 0) {
    const first = spans[0] as TextSpan;
    first.text = first.text.replace(/^\s+/, '');
    const last = spans.at(-1) as TextSpan;
    last.text = last.text.replace(/\s+$/, '');
  }
  return spans.filter((s) => s.text.length > 0);
}

/** What to export. */
export interface ExportRequest {
  format: ExportFormat;
  /** Documents in order (default: the manuscript in binder order). */
  documentIds?: string[];
  /** CSL style (default: the project's `citationStyle`). */
  style?: string;
  author?: string | null;
  /** Provenance appendix, produced by the report lane. */
  provenance?: ProvenanceSummary | null;
}

/** Builds the export input from a folded state. Throws on unknown documents. */
export function exportInputFor(state: ProjectState, req: ExportRequest): ExportInput {
  const ids =
    req.documentIds && req.documentIds.length > 0 ? req.documentIds : manuscriptOrder(state);
  const documents = ids.map((id) => {
    const d = state.documents[id];
    if (!d) throw new Error(`unknown document ${id}`);
    return { id, title: d.title, content: d.content };
  });
  const sources = Object.values(state.sources).map((s) => ({ ...s.csl, id: s.id }) as CslItem);
  const style = req.style ?? state.settings.citationStyle;
  return {
    project: { title: state.settings.title, author: req.author ?? null },
    documents,
    sources,
    provenance: req.provenance ?? null,
    options: { citationStyle: 'author-date', ...cslFormatters(sources, style) },
  };
}

/** Renders an export file. */
export function renderExport(state: ProjectState, req: ExportRequest): Promise<ExportFile> {
  return exportFile(req.format, exportInputFor(state, req));
}
