/**
 * The link href policy, shared by the schema (the `link` mark's `href` validator
 * and its DOM parser), the editor, import and export.
 *
 * - Only `http:`, `https:` and `mailto:` links. Anything else (`javascript:`,
 *   `data:`, `file:`, relative paths) is rejected.
 * - A bare domain (`example.com/path`, `www.example.com`) becomes `https://…`, a
 *   protocol-relative `//example.com` becomes `https://example.com`, and a bare
 *   address (`ada@example.com`) becomes `mailto:…`.
 * - Whitespace, control characters and backslashes are rejected. `"`, `<`, `>`
 *   and `` ` `` are percent-encoded so an href is always safe in an HTML
 *   attribute and a Markdown destination.
 * - `http(s)` links need a host and may not carry userinfo
 *   (`https://bank.example@evil.example` is how phishing links hide their host).
 * - The scheme is lowercased; nothing else is changed.
 *
 * A stored href is always its own normalization (`normalizeHref(href) === href`),
 * which is what the mark validates. Pure string rules: no `URL` parser (its IDNA
 * handling differs across runtimes, and the fold must be deterministic).
 */

/** Schemes a link may use. */
export const LINK_SCHEMES = ['http', 'https', 'mailto'] as const;

/** Longest href a link may carry, in UTF-16 code units. */
export const LINK_HREF_MAX_CHARS = 2048;

// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\s\u0000-\u001F\u007F-\u009F\\\u2028\u2029\uFEFF]/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;
const HOST_PORT = /^[^:/?#]+:\d{1,5}(?:[/?#]|$)/;
const BARE_EMAIL = /^[^@/?#:]+@[^@/?#:.]+(?:\.[^@/?#:.]+)+$/;
/** A dotted host whose last label starts with a letter and has at least two characters. */
const BARE_HOST = /^(?:[^.:@/?#]+\.)+[A-Za-zÀ-￿][A-Za-z0-9À-￿-]+\.?(?::\d{1,5})?$/;

function encodeUnsafe(s: string): string {
  return s.replace(/["<>`]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function httpHref(scheme: 'http' | 'https', rest: string): string | null {
  if (!rest.startsWith('//')) return null;
  const end = rest.slice(2).search(/[/?#]/);
  const authority = end < 0 ? rest.slice(2) : rest.slice(2, 2 + end);
  if (authority.includes('@')) return null;
  const host = authority.replace(/:\d{0,5}$/, '');
  if (host === '' || host.startsWith('.')) return null;
  return `${scheme}:${rest}`;
}

/**
 * Normalizes what a writer typed or pasted as a link destination, or returns
 * null when it is not an allowed link. Idempotent.
 */
export function normalizeHref(input: string): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  if (s === '' || FORBIDDEN.test(s)) return null;
  s = encodeUnsafe(s);
  if (s.length > LINK_HREF_MAX_CHARS) return null;
  const scheme = SCHEME.exec(s);
  if (scheme) {
    const name = (scheme[1] as string).toLowerCase();
    const rest = s.slice(scheme[0].length);
    if (name === 'http' || name === 'https') return httpHref(name, rest);
    if (name === 'mailto')
      return rest.length > 0 && !rest.startsWith('/') ? `mailto:${rest}` : null;
    // `example.com:8080/x` and `example.com:443` are hosts with ports, not schemes.
    if (!name.includes('.') && !HOST_PORT.test(s)) return null;
  }
  if (s.startsWith('//')) return httpHref('https', s);
  if (s.startsWith('/') || s.startsWith('.') || s.startsWith('#') || s.startsWith('?')) return null;
  if (BARE_EMAIL.test(s)) return `mailto:${s}`;
  const end = s.search(/[/?#]/);
  const host = end < 0 ? s : s.slice(0, end);
  if (!BARE_HOST.test(host)) return null;
  const out = `https://${s}`;
  return out.length > LINK_HREF_MAX_CHARS ? null : out;
}

/** True if `href` is an allowed, already normalized link destination. */
export function isAllowedHref(href: unknown): href is string {
  return typeof href === 'string' && normalizeHref(href) === href;
}

/**
 * True when pasted text is plainly a link (an explicit `http(s)://` or `mailto:`
 * URL, or a `www.` address) and nothing else. Pasting it over a selection makes
 * the selection a link. Stricter than {@link normalizeHref}, so "Mr.Smith" is
 * never taken for a domain.
 */
export function pastedLinkHref(text: string): string | null {
  const t = text.trim();
  if (!/^(?:https?:\/\/|mailto:|www\.)/i.test(t)) return null;
  return normalizeHref(t);
}
