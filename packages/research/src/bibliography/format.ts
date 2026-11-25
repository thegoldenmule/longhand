/**
 * Citations and bibliographies with citeproc-js and the bundled CSL styles (APA 7,
 * MLA 9, Chicago author-date 18) and en-US locale. Output comes in plain text and
 * HTML.
 *
 * Engines are expensive to build (they parse the style XML), so one engine per
 * style and output format is cached and re-pointed at the current items on each
 * call. Calls are synchronous, so this is safe.
 */
import type { CslItem, SourceState } from '@longhand/schema';
import CSL, { type CiteprocCitationItem, type Engine } from './citeproc-shim.js';
import { LOCALE_EN_US, STYLE_XML } from './styles.generated';

/** Bundled CSL style ids (the values `ProjectSettings.citationStyle` takes). */
export type StyleId = keyof typeof STYLE_XML;

/** The bundled styles with display labels, in menu order. */
export const STYLES: ReadonlyArray<{ id: StyleId; label: string; short: string }> = [
  { id: 'apa', label: 'APA (7th edition)', short: 'APA' },
  { id: 'modern-language-association', label: 'MLA (9th edition)', short: 'MLA' },
  { id: 'chicago-author-date', label: 'Chicago (author-date, 18th edition)', short: 'Chicago' },
];

/** Default style (matches `DEFAULT_PROJECT_SETTINGS.citationStyle`). */
export const DEFAULT_STYLE: StyleId = 'apa';

const ALIASES: Record<string, StyleId> = {
  apa: 'apa',
  mla: 'modern-language-association',
  'modern-language-association': 'modern-language-association',
  chicago: 'chicago-author-date',
  'chicago-author-date': 'chicago-author-date',
};

/** Maps a stored style id (or `mla` / `chicago`) to a bundled style, falling back to APA. */
export function resolveStyle(id: string | null | undefined): StyleId {
  return ALIASES[(id ?? '').toLowerCase()] ?? DEFAULT_STYLE;
}

/** Text and HTML renderings of the same output. */
export interface Formatted {
  text: string;
  html: string;
}

/** Items to format: CSL items (keyed by `id`), or library sources (keyed by source id). */
export type ItemsInput =
  readonly CslItem[] | readonly SourceState[] | Readonly<Record<string, CslItem | SourceState>>;

function isSource(x: CslItem | SourceState): x is SourceState {
  return 'csl' in x && typeof (x as SourceState).csl === 'object';
}

/** Normalizes items to a map from source id to a CSL item whose `id` is that source id. */
export function itemMap(items: ItemsInput): Map<string, CslItem> {
  const list = Array.isArray(items) ? items : Object.values(items);
  const map = new Map<string, CslItem>();
  for (const x of list as Array<CslItem | SourceState>) {
    if (isSource(x)) map.set(x.id, { ...x.csl, id: x.id });
    else map.set(x.id, x);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

// Whole words come before abbreviations so `volume 2` is not read as `vol` + `ume 2`.
const LOCATOR_LABELS: Array<[RegExp, string]> = [
  [/^(?:pages?|pp?\.?)\s*/i, 'page'],
  [/^(?:chapters?|chap\.?|ch\.?)\s*/i, 'chapter'],
  [/^(?:sections?|secs?\.?|§§?)\s*/i, 'section'],
  [/^(?:paragraphs?|paras?\.?|¶¶?)\s*/i, 'paragraph'],
  [/^(?:figures?|figs?\.?)\s*/i, 'figure'],
  [/^(?:volumes?|vols?\.?)\s*/i, 'volume'],
  [/^(?:lines?|ll?\.)\s*/i, 'line'],
  [/^(?:notes?|nn?\.)\s*/i, 'note'],
  [/^(?:verses?|vv?\.)\s*/i, 'verse'],
  [/^(?:columns?|cols?\.?)\s*/i, 'column'],
  [/^(?:folios?|fols?\.?)\s*/i, 'folio'],
  [/^(?:numbers?|nos?\.)\s*/i, 'number'],
  [/^(?:parts?|pts?\.?)\s*/i, 'part'],
  [/^(?:books?|bks?\.?)\s*/i, 'book'],
  [/^(?:tables?|tbls?\.?)\s*/i, 'table'],
  [/^(?:appendix|appendices|apps?\.?)\s*/i, 'appendix'],
];

/**
 * Splits a Longhand locator string (`p. 12`, `pp. 4–7`, `ch. 3`, `§ 2`,
 * `00:14:05`, `12`) into a CSL label and locator. A bare number or range is a page;
 * a time is a timestamp; anything else is kept whole with no label.
 */
export function parseLocator(
  raw: string | null | undefined,
): { label?: string; locator: string } | null {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  for (const [re, label] of LOCATOR_LABELS) {
    const m = re.exec(s);
    if (
      m &&
      m[0].length > 0 &&
      m[0].length < s.length &&
      /[\divxlcdm]/i.test(s.slice(m[0].length, m[0].length + 1))
    ) {
      return { label, locator: s.slice(m[0].length).trim() };
    }
  }
  if (/^\d{1,2}(?::\d{2}){1,2}$/.test(s)) return { label: 'timestamp', locator: s };
  if (/^[\divxlcdm]+(?:\s*[-–—,]\s*[\divxlcdm]+)*$/i.test(s)) return { label: 'page', locator: s };
  return { locator: s };
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

let current = new Map<string, CslItem>();

const sys = {
  retrieveLocale: (): string => LOCALE_EN_US,
  retrieveItem: (id: string): unknown => {
    const item = current.get(id);
    // citeproc mutates items it is given; hand it a copy.
    return item ? (JSON.parse(JSON.stringify(item)) as unknown) : undefined;
  },
};

const engines = new Map<string, Engine>();

function engine(style: StyleId, format: 'html' | 'text'): Engine {
  const key = `${style}|${format}`;
  let e = engines.get(key);
  if (!e) {
    e = new CSL.Engine(sys, STYLE_XML[style], 'en-US', true);
    e.setOutputFormat(format);
    engines.set(key, e);
  }
  return e;
}

function withItems<T>(items: Map<string, CslItem>, fn: () => T): T {
  const prev = current;
  current = items;
  try {
    return fn();
  } finally {
    current = prev;
  }
}

/** One cited source and its locator, as in a `citation` node. */
export interface CiteRef {
  sourceId: string;
  locator?: string | null;
}

const MISSING: Formatted = {
  text: '(missing source)',
  html: '<span class="lh-citation-missing">(missing source)</span>',
};

function toCiteItems(cites: readonly CiteRef[]): CiteprocCitationItem[] {
  return cites.map((c) => {
    const loc = parseLocator(c.locator);
    const item: CiteprocCitationItem = { id: c.sourceId };
    if (loc) {
      item.locator = loc.locator;
      if (loc.label) item.label = loc.label;
    }
    return item;
  });
}

/**
 * Formats one in-text citation cluster (one or more sources). Sources missing from
 * `items` are dropped; if none remain the result is `(missing source)`.
 */
export function formatCitations(
  items: ItemsInput,
  cites: readonly CiteRef[],
  style: string = DEFAULT_STYLE,
): Formatted & { missing: string[] } {
  const map = itemMap(items);
  const present = cites.filter((c) => map.has(c.sourceId));
  const missing = cites.filter((c) => !map.has(c.sourceId)).map((c) => c.sourceId);
  if (present.length === 0) return { ...MISSING, missing };
  const s = resolveStyle(style);
  return withItems(map, () => {
    const ids = [...new Set(present.map((c) => c.sourceId))];
    const out = (format: 'html' | 'text'): string => {
      const e = engine(s, format);
      e.updateItems(ids);
      return e.makeCitationCluster(toCiteItems(present));
    };
    return { text: out('text'), html: out('html'), missing };
  });
}

/** Formats a single in-text citation, e.g. `(LeCun et al., 2015, p. 437)` in APA. */
export function formatCitation(
  items: ItemsInput,
  sourceId: string,
  locator: string | null | undefined,
  style: string = DEFAULT_STYLE,
): Formatted {
  const { text, html } = formatCitations(items, [{ sourceId, locator }], style);
  return { text, html };
}

/** One bibliography entry. */
export interface BibliographyEntry extends Formatted {
  id: string;
}

/** A formatted bibliography: entries in the style's order, plus the whole list. */
export interface FormattedBibliography extends Formatted {
  entries: BibliographyEntry[];
  /** Hanging indent and spacing hints from the style. */
  layout: { hangingIndent: boolean; lineSpacing: number; entrySpacing: number };
}

/**
 * Formats a bibliography of `items` (all of them, or only `ids` when given, e.g.
 * the sources cited in a document). Text entries are separated by newlines.
 */
export function formatBibliography(
  items: ItemsInput,
  style: string = DEFAULT_STYLE,
  ids?: readonly string[],
): FormattedBibliography {
  const map = itemMap(items);
  const wanted = (ids ?? [...map.keys()]).filter((id, i, a) => map.has(id) && a.indexOf(id) === i);
  const s = resolveStyle(style);
  if (wanted.length === 0) {
    return {
      text: '',
      html: '<div class="csl-bib-body"></div>',
      entries: [],
      layout: { hangingIndent: false, lineSpacing: 1, entrySpacing: 1 },
    };
  }
  return withItems(map, () => {
    const run = (format: 'html' | 'text') => {
      const e = engine(s, format);
      e.updateItems([...wanted]);
      const result = e.makeBibliography();
      if (!result) throw new Error(`style ${s} has no bibliography`);
      return result;
    };
    const [params, html] = run('html');
    const [, text] = run('text');
    const order = params.entry_ids.map((x) => x[0]!);
    const entries = order.map((id, i) => ({
      id,
      html: html[i]!.trim(),
      text: text[i]!.trim(),
    }));
    return {
      text: entries.map((e) => e.text).join('\n'),
      html: `${params.bibstart}${html.join('')}${params.bibend}`,
      entries,
      layout: {
        hangingIndent: Boolean(params.hangingindent),
        lineSpacing: params.linespacing ?? 1,
        entrySpacing: params.entryspacing ?? 1,
      },
    };
  });
}

/**
 * The source ids a document refers to, in first-appearance order, from its JSON:
 * `citation` nodes (including those in footnotes) and `quote_block`s.
 */
export function referencedSourceIds(doc: DocLike): string[] {
  const out: string[] = [];
  const walk = (n: DocLike): void => {
    const id = n.attrs?.sourceId;
    if (
      (n.type === 'citation' || n.type === 'quote_block') &&
      typeof id === 'string' &&
      !out.includes(id)
    ) {
      out.push(id);
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

/** The shape of ProseMirror node JSON that {@link referencedSourceIds} reads. */
export interface DocLike {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocLike[];
}
