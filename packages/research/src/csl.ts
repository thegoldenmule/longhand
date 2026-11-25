/**
 * CSL-JSON helpers shared by the fetchers and the manual entry form: name and date
 * parsing, text cleanup and compaction.
 */
import type { CslItem } from '@longhand/schema';

/** A CSL-JSON name (`CslItem['author']` element). */
export type CslName = NonNullable<CslItem['author']>[number];
/** A CSL-JSON date. */
export type CslDate = NonNullable<CslItem['issued']>;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
};

/** Decodes HTML character references (named subset, decimal and hex). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ref: string) => {
    if (ref[0] === '#') {
      const code =
        ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ref.toLowerCase()] ?? m;
  });
}

/** Strips markup (Crossref titles carry `<i>`, abstracts carry JATS), decodes entities and collapses whitespace. */
export function cleanText(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

const PARTICLES = new Set([
  'van',
  'von',
  'der',
  'den',
  'de',
  'del',
  'della',
  'di',
  'da',
  'du',
  'la',
  'le',
]);
const SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv']);

/**
 * Parses a personal name as written: `Family, Given`, `Given Family`, or a single
 * word. Names that look like organizations (contain digits, `&`, or common
 * corporate words) become `{ literal }`.
 */
export function parseName(raw: string): CslName | null {
  const s = cleanText(raw).replace(/^by\s+/i, '');
  if (s === '') return null;
  if (
    /[\d&@]|\b(?:inc|ltd|llc|university|institute|association|society|foundation|press|team|staff|editors|news|agency|organization|organisation)\b/i.test(
      s,
    )
  ) {
    return { literal: s };
  }
  if (s.includes(',')) {
    const [family, given, suffix] = s.split(',').map((p) => p.trim());
    const name: CslName = { family: family! };
    if (given) name.given = given;
    if (suffix) name.suffix = suffix;
    return name;
  }
  const parts = s.split(' ').filter(Boolean);
  if (parts.length === 1) return { literal: parts[0]! };
  let suffix: string | undefined;
  if (SUFFIXES.has(parts[parts.length - 1]!.toLowerCase())) suffix = parts.pop();
  // Family name starts at the first lowercase particle after the first word, else it is the last word.
  let i = parts.findIndex((p, idx) => idx > 0 && PARTICLES.has(p.toLowerCase()));
  if (i === -1) i = parts.length - 1;
  const name: CslName = { family: parts.slice(i).join(' '), given: parts.slice(0, i).join(' ') };
  if (suffix) name.suffix = suffix;
  return name;
}

/** Parses a list of names separated by `;`, ` and ` or newlines. */
export function parseNames(raw: string): CslName[] {
  return raw
    .split(/\s*(?:;|\n|\band\b|&)\s*/i)
    .map(parseName)
    .filter((n): n is CslName => n !== null);
}

/** Formats a CSL name for display and for editing (`Family, Given`). */
export function formatName(n: CslName): string {
  if (n.literal) return n.literal;
  const family = [n['non-dropping-particle'], n.family].filter(Boolean).join(' ');
  const given = [n.given, n['dropping-particle']].filter(Boolean).join(' ');
  return [family, given, n.suffix].filter(Boolean).join(', ');
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Parses a date as found in metadata: ISO (`2015-05-27`, `2015-05`, `2015`,
 * `2015-05-27T…`), `2015/05/27`, `May 27, 2015`, `27 May 2015`, `May 2015`, or a
 * string containing a year. Returns `null` if no year is found.
 */
export function parseDate(raw: string | number | null | undefined): CslDate | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  let m = /^(\d{4})(?:[-/](\d{1,2})(?:[-/](\d{1,2}))?)?(?:[T\s].*)?$/.exec(s);
  if (m) return datePartsOf(m[1]!, m[2], m[3]);
  m = /^([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s);
  if (m && monthOf(m[1]!)) return datePartsOf(m[3]!, String(monthOf(m[1]!)), m[2]);
  m = /^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{4})$/i.exec(s);
  if (m && monthOf(m[2]!)) return datePartsOf(m[3]!, String(monthOf(m[2]!)), m[1]);
  m = /^([a-z]+)\.?,?\s+(\d{4})$/i.exec(s);
  if (m && monthOf(m[1]!)) return datePartsOf(m[2]!, String(monthOf(m[1]!)), undefined);
  m = /\b(1[5-9]\d\d|20\d\d)\b/.exec(s);
  if (m) return { 'date-parts': [[Number(m[1])]] };
  return null;
}

function monthOf(name: string): number | null {
  const i = MONTHS.indexOf(name.slice(0, 3).toLowerCase());
  return i === -1 ? null : i + 1;
}

function datePartsOf(y: string, mo: string | undefined, d: string | undefined): CslDate {
  const parts: number[] = [Number(y)];
  const month = mo === undefined ? NaN : Number(mo);
  if (month >= 1 && month <= 12) {
    parts.push(month);
    const day = d === undefined ? NaN : Number(d);
    if (day >= 1 && day <= 31) parts.push(day);
  }
  return { 'date-parts': [parts] };
}

/** The year of a CSL date, if it has one. */
export function yearOf(date: CslDate | undefined): number | null {
  const y = date?.['date-parts']?.[0]?.[0];
  if (typeof y === 'number') return y;
  if (typeof y === 'string' && /^\d{4}$/.test(y)) return Number(y);
  if (date?.literal || date?.raw) {
    const m = /\b(\d{4})\b/.exec(date.literal ?? date.raw ?? '');
    if (m) return Number(m[1]);
  }
  return null;
}

/** Formats a CSL date as `YYYY`, `YYYY-MM` or `YYYY-MM-DD` (for editing). */
export function formatDate(date: CslDate | undefined): string {
  const parts = date?.['date-parts']?.[0];
  if (!parts) return date?.literal ?? date?.raw ?? '';
  return parts.map((p, i) => (i === 0 ? String(p) : String(p).padStart(2, '0'))).join('-');
}

/** Drops `undefined`, `null`, empty strings and empty arrays, recursively for plain objects. */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as T;
}

/** A short human label for a source: `Author (Year). Title` style, for lists and pickers. */
export function sourceLabel(csl: CslItem): { title: string; byline: string } {
  const names = csl.author ?? csl.editor ?? [];
  const first = names[0];
  const who = first ? (first.family ?? first.literal ?? first.given ?? '') : '';
  const author =
    names.length > 2
      ? `${who} et al.`
      : names.length === 2
        ? `${who} and ${names[1]!.family ?? names[1]!.literal ?? ''}`
        : who;
  const year = yearOf(csl.issued);
  const byline = [
    author,
    year === null ? null : String(year),
    csl['container-title'] ?? csl.publisher,
  ]
    .filter((x) => x !== null && x !== undefined && x !== '')
    .join(' · ');
  return { title: csl.title ?? csl.URL ?? '(untitled)', byline };
}
