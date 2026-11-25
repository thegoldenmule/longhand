/**
 * Built-in, dependency-free citation formatting from CSL-JSON.
 *
 * These are fallbacks, not a CSL processor: the research lane renders real CSL
 * styles (APA, MLA, Chicago) and injects them through `formatCitation` and
 * `formatBibliographyEntry`. The fallbacks aim to be correct and readable for
 * the common item types (books, articles, chapters, web pages).
 */
import type { CslItem } from '@longhand/schema';
import type {
  BibliographyFormatter,
  CitationFormatter,
  QuoteAttributionFormatter,
  TextSpan,
} from './types';

type CslName = NonNullable<CslItem['author']>[number];

/** Text printed for a citation whose source was not supplied. */
export const MISSING_SOURCE_TEXT = '[missing source]';

function familyOf(name: CslName): string {
  if (name.literal) return name.literal;
  const particle = name['non-dropping-particle'];
  const family = name.family ?? name.given ?? '';
  return particle ? `${particle} ${family}` : family;
}

function fullNameOf(name: CslName): string {
  if (name.literal) return name.literal;
  const parts = [
    name.given,
    name['dropping-particle'],
    name['non-dropping-particle'],
    name.family,
  ].filter((p): p is string => !!p);
  const base = parts.join(' ');
  return name.suffix ? `${base}, ${name.suffix}` : base;
}

function invertedNameOf(name: CslName): string {
  if (name.literal) return name.literal;
  if (!name.family) return fullNameOf(name);
  const family = name['non-dropping-particle']
    ? `${name['non-dropping-particle']} ${name.family}`
    : name.family;
  const given = [name.given, name['dropping-particle']].filter((p): p is string => !!p).join(' ');
  const base = given ? `${family}, ${given}` : family;
  return name.suffix ? `${base}, ${name.suffix}` : base;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** The names that stand for the item: authors, else editors. */
function creatorsOf(item: CslItem): { names: CslName[]; editors: boolean } {
  if (item.author && item.author.length > 0) return { names: item.author, editors: false };
  if (item.editor && item.editor.length > 0) return { names: item.editor, editors: true };
  return { names: [], editors: false };
}

/** Short author label for in-text citations: `Woolf`, `Woolf and Bell`, `Woolf et al.` */
export function shortAuthors(item: CslItem): string | null {
  const { names } = creatorsOf(item);
  if (names.length === 0) return null;
  const fams = names.map(familyOf);
  if (fams.length === 1) return fams[0] as string;
  if (fams.length === 2) return `${fams[0]} and ${fams[1]}`;
  return `${fams[0]} et al.`;
}

/** The year of `issued`, or `null`. Accepts `date-parts`, `literal` and `raw`. */
export function issuedYear(item: CslItem): string | null {
  const issued = item.issued;
  if (!issued) return null;
  const first = issued['date-parts']?.[0]?.[0];
  if (first !== undefined && String(first).trim() !== '') return String(first);
  const text = issued.literal ?? issued.raw;
  if (!text) return null;
  const m = /\d{4}/.exec(text);
  return m ? m[0] : text;
}

/** `12` → `p. 12`, `12-14` → `pp. 12–14`; anything else (`ch. 3`, `p. 3`) as given. */
export function formatLocator(locator: string | null | undefined): string | null {
  if (locator === null || locator === undefined) return null;
  const l = locator.trim();
  if (l === '') return null;
  if (/^\d+$/.test(l)) return `p. ${l}`;
  const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(l);
  if (range) return `pp. ${range[1]}–${range[2]}`;
  return l;
}

/** Whether the item's title is set in italics (a standalone work) rather than quotes (a part of a container). */
function titleIsItalic(item: CslItem): boolean {
  return !item['container-title'];
}

function titleSpans(item: CslItem): TextSpan[] {
  if (!item.title) return [];
  return titleIsItalic(item) ? [{ text: item.title, italic: true }] : [{ text: `“${item.title}”` }];
}

/** Author-date fallback: `(Woolf 1929, p. 12)`. */
export const authorDateCitation: CitationFormatter = (_sourceId, locator, ctx) => {
  const item = ctx.source;
  if (!item) return MISSING_SOURCE_TEXT;
  const who = shortAuthors(item) ?? (item.title ? `“${item.title}”` : item.id);
  const year = issuedYear(item) ?? 'n.d.';
  const loc = formatLocator(locator);
  return `(${who} ${year}${loc ? `, ${loc}` : ''})`;
};

/** Numbered fallback: `[3]`, `[3, p. 12]`. */
export const numberedCitation: CitationFormatter = (_sourceId, locator, ctx) => {
  if (!ctx.source) return MISSING_SOURCE_TEXT;
  const loc = formatLocator(locator);
  return `[${ctx.number}${loc ? `, ${loc}` : ''}]`;
};

function endWithPeriod(s: string): string {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/**
 * Plain bibliography entry, loosely Chicago author-date:
 * `Woolf, Virginia. 1929. *A Room of One's Own*. London: Hogarth Press.`
 */
export const defaultBibliographyEntry: BibliographyFormatter = (item) => {
  const out: TextSpan[] = [];
  const push = (text: string, italic = false): void => {
    if (text) out.push(italic ? { text, italic } : { text });
  };
  const pushTitle = (): void => {
    const title = titleSpans(item);
    if (title.length === 0) return;
    for (const s of title) out.push(s);
    // A quoted title takes its period inside the quotes.
    const last = out[out.length - 1] as TextSpan;
    if (last.italic) push('. ');
    else last.text = last.text.replace(/”$/, '.”') + ' ';
  };
  const year = `${endWithPeriod(issuedYear(item) ?? 'n.d.')} `;
  const { names, editors } = creatorsOf(item);
  if (names.length > 0) {
    const listed = names.map((n, i) => (i === 0 ? invertedNameOf(n) : fullNameOf(n)));
    // The first name is inverted ("Smith, Ada"), so even two names take a serial comma.
    const joined =
      listed.length === 2 && names[0]?.family && !names[0].literal
        ? `${listed[0]}, and ${listed[1]}`
        : joinList(listed);
    const label = editors ? (names.length > 1 ? ', eds' : ', ed') : '';
    push(endWithPeriod(`${joined}${label}`) + ' ');
    push(year);
    pushTitle();
  } else if (item.title) {
    // No creator: the title leads.
    pushTitle();
    push(year);
  } else {
    push(year);
  }
  if (item['container-title']) {
    push(item['container-title'], true);
    const vol = item.volume !== undefined ? String(item.volume) : '';
    const issue = item.issue !== undefined ? `(${String(item.issue)})` : '';
    const page = item.page ? `: ${item.page.replace(/-/g, '–')}` : '';
    push(`${vol || issue ? ' ' : ''}${vol}${issue}${page}. `);
  } else if (item.page) {
    push(`${item.page.replace(/-/g, '–')}. `);
  }
  if (item.edition !== undefined) push(`${String(item.edition)} ed. `);
  const place = item['publisher-place'];
  if (item.publisher) push(`${place ? `${place}: ` : ''}${item.publisher}. `);
  if (item.DOI) push(`https://doi.org/${item.DOI.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')}. `);
  else if (item.URL) push(`${item.URL}. `);
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\s+$/, '');
  return out;
};

/** Quote-block attribution fallback: `Virginia Woolf, *A Room of One's Own*, p. 12`. */
export const defaultQuoteAttribution: QuoteAttributionFormatter = (_sourceId, ctx) => {
  const item = ctx.source;
  const loc = formatLocator(ctx.locator);
  if (!item) return loc ? `${MISSING_SOURCE_TEXT}, ${loc}` : MISSING_SOURCE_TEXT;
  const out: TextSpan[] = [];
  const { names } = creatorsOf(item);
  const who = joinList(names.map(fullNameOf));
  if (who) out.push({ text: who });
  const title = titleSpans(item);
  if (title.length > 0) {
    if (out.length > 0) out.push({ text: ', ' });
    out.push(...title);
  }
  if (out.length === 0) out.push({ text: item.id });
  if (loc) out.push({ text: `, ${loc}` });
  return out;
};

/** Sort key for alphabetical bibliographies: first creator, then year, then title. */
export function bibliographySortKey(item: CslItem): string {
  const { names } = creatorsOf(item);
  const who = names[0] ? invertedNameOf(names[0]) : (item.title ?? item.id);
  return `${who}\u0000${issuedYear(item) ?? ''}\u0000${item.title ?? ''}\u0000${item.id}`.toLowerCase();
}
