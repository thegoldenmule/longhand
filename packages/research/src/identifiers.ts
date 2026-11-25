/**
 * Parsing and normalizing the identifiers a writer can add a source by: DOI, ISBN
 * and URL.
 */

const DOI_RE = /^10\.\d{4,9}\/\S+$/;
const DOI_PREFIX_RE = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i;

/**
 * Normalizes a DOI. Accepts bare DOIs, `doi:` prefixes and `doi.org` URLs.
 * Returns `null` if the input is not a DOI. Case is preserved (DOIs compare
 * case-insensitively; use {@link doiKey} for comparison).
 */
export function normalizeDoi(input: string): string | null {
  let s = input.trim().replace(DOI_PREFIX_RE, '');
  try {
    if (s.includes('%')) s = decodeURIComponent(s);
  } catch {
    // keep the raw string
  }
  s = s.replace(/[.,;]+$/, '');
  return DOI_RE.test(s) ? s : null;
}

/** Case-insensitive comparison key for a DOI. */
export function doiKey(doi: string): string {
  return (normalizeDoi(doi) ?? doi).toLowerCase();
}

function isbn10Valid(d: string): boolean {
  if (!/^\d{9}[\dX]$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = d[i]!;
    sum += (c === 'X' ? 10 : Number(c)) * (10 - i);
  }
  return sum % 11 === 0;
}

function isbn13Valid(d: string): boolean {
  if (!/^97[89]\d{10}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < 13; i++) sum += Number(d[i]) * (i % 2 === 0 ? 1 : 3);
  return sum % 10 === 0;
}

/** Converts a valid ISBN-10 to ISBN-13. */
export function isbn10to13(isbn10: string): string {
  const core = `978${isbn10.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  return core + String((10 - (sum % 10)) % 10);
}

/**
 * Normalizes an ISBN-10 or ISBN-13 (hyphens, spaces and an `ISBN` prefix allowed)
 * and checks its check digit. Returns the ISBN-13 digits, or `null` if invalid.
 */
export function normalizeIsbn(input: string): string | null {
  const d = input
    .trim()
    .replace(/^isbn(?:-1[03])?:?\s*/i, '')
    .replace(/[\s-]/g, '')
    .toUpperCase();
  if (d.length === 10) return isbn10Valid(d) ? isbn10to13(d) : null;
  if (d.length === 13) return isbn13Valid(d) ? d : null;
  return null;
}

/** Normalizes an http(s) URL; a bare `example.com/path` gets `https://`. Returns `null` otherwise. */
export function normalizeUrl(input: string): string | null {
  const s = input.trim();
  if (s === '' || /\s/.test(s)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** What an identifier the writer typed turned out to be. */
export type Identifier =
  { kind: 'doi'; value: string } | { kind: 'isbn'; value: string } | { kind: 'url'; value: string };

/**
 * Classifies free input from the "add source" box. DOIs win (a `doi.org` URL is a
 * DOI), then ISBNs, then URLs. Returns `null` if it is none of them.
 */
export function classifyIdentifier(input: string): Identifier | null {
  const doi = normalizeDoi(input);
  if (doi) return { kind: 'doi', value: doi };
  const isbn = normalizeIsbn(input);
  if (isbn) return { kind: 'isbn', value: isbn };
  const url = normalizeUrl(input);
  if (url) return { kind: 'url', value: url };
  return null;
}
