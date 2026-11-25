/**
 * Web page metadata: fetch a URL and read Highwire `citation_*` tags, JSON-LD,
 * Dublin Core, Open Graph / Twitter tags and `<title>`, in that order of trust,
 * into CSL-JSON.
 *
 * The HTML scanner is a small tag tokenizer rather than a DOM parser, so it runs
 * identically in Node and browsers. In a browser, cross-origin pages need a proxy:
 * pass a `fetch` that routes through the app server.
 */
import type { CslItem } from '@longhand/schema';
import {
  cleanText,
  compact,
  decodeEntities,
  parseDate,
  parseName,
  type CslDate,
  type CslName,
} from './csl';
import { getText, MetadataError, type HttpOptions } from './http';
import { normalizeDoi, normalizeIsbn, normalizeUrl } from './identifiers';

/** Everything the scanner extracted from a page, before mapping to CSL. */
export interface PageMetadata {
  /** Lowercased `name` / `property` / `itemprop` → values in document order. */
  meta: Map<string, string[]>;
  title: string | null;
  canonical: string | null;
  lang: string | null;
  jsonLd: Record<string, unknown>[];
}

const ATTR_RE = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function attrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(ATTR_RE)) {
    const key = m[1]!.toLowerCase();
    if (!(key in out)) out[key] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

/** Scans HTML for metadata. Never throws. */
export function scanHtml(html: string): PageMetadata {
  // Drop comments so commented-out tags are ignored.
  const doc = html.replace(/<!--[\s\S]*?-->/g, '');
  const headEnd = doc.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? doc : doc.slice(0, headEnd);

  const meta = new Map<string, string[]>();
  for (const m of doc.matchAll(/<meta\b([^>]*)>/gi)) {
    const a = attrs(m[1]!);
    const key = (a.name ?? a.property ?? a.itemprop ?? '').toLowerCase().trim();
    const content = a.content;
    if (!key || content === undefined || content.trim() === '') continue;
    const list = meta.get(key) ?? [];
    list.push(content.trim());
    meta.set(key, list);
  }

  let canonical: string | null = null;
  for (const m of head.matchAll(/<link\b([^>]*)>/gi)) {
    const a = attrs(m[1]!);
    if ((a.rel ?? '').toLowerCase().split(/\s+/).includes('canonical') && a.href) {
      canonical = a.href;
      break;
    }
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  const title = titleMatch ? cleanText(titleMatch[1]!) || null : null;

  const htmlTag = /<html\b([^>]*)>/i.exec(doc);
  const lang = htmlTag ? (attrs(htmlTag[1]!).lang ?? null) : null;

  const jsonLd: Record<string, unknown>[] = [];
  for (const m of doc.matchAll(
    /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    try {
      collectJsonLd(JSON.parse(m[1]!.trim()) as unknown, jsonLd);
    } catch {
      // ignore malformed JSON-LD
    }
  }

  return { meta, title, canonical, lang, jsonLd };
}

function collectJsonLd(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectJsonLd(n, out);
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj['@graph'])) collectJsonLd(obj['@graph'], out);
    if (obj['@type'] !== undefined) out.push(obj);
  }
}

const LD_TYPES: Record<string, string> = {
  scholarlyarticle: 'article-journal',
  newsarticle: 'article-newspaper',
  reportagenewsarticle: 'article-newspaper',
  analysisnewsarticle: 'article-newspaper',
  opinionnewsarticle: 'article-newspaper',
  blogposting: 'post-weblog',
  socialmediaposting: 'post',
  article: 'article',
  techarticle: 'article',
  book: 'book',
  chapter: 'chapter',
  report: 'report',
  thesis: 'thesis',
  dataset: 'dataset',
  videoobject: 'motion_picture',
  movie: 'motion_picture',
  podcastepisode: 'song',
  webpage: 'webpage',
  aboutpage: 'webpage',
  faqpage: 'webpage',
  collectionpage: 'webpage',
};

function ldTypes(obj: Record<string, unknown>): string[] {
  const t = obj['@type'];
  const list = Array.isArray(t) ? t : [t];
  return list.filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
}

/** The most specific creative-work JSON-LD object on the page, if any. */
function primaryLd(jsonLd: Record<string, unknown>[]): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  let bestRank = Infinity;
  for (const obj of jsonLd) {
    for (const t of ldTypes(obj)) {
      if (!(t in LD_TYPES)) continue;
      const rank = t === 'webpage' || t.endsWith('page') ? 1 : 0;
      if (rank < bestRank) {
        best = obj;
        bestRank = rank;
      }
    }
  }
  return best;
}

function ldString(v: unknown): string | undefined {
  if (typeof v === 'string') return cleanText(v) || undefined;
  if (Array.isArray(v)) return ldString(v[0]);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return ldString(o.name ?? o['@value'] ?? o.headline);
  }
  return undefined;
}

function ldNames(v: unknown): CslName[] {
  const list = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  const out: CslName[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      if (!/^https?:\/\//i.test(item)) {
        const n = parseName(item);
        if (n) out.push(n);
      }
    } else if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>;
      const name = ldString(o.name);
      if (!name) continue;
      if (ldTypes(o).includes('organization') || ldTypes(o).includes('newsmediaorganization')) {
        out.push({ literal: name });
      } else {
        const n = parseName(name);
        if (n) out.push(n);
      }
    }
  }
  return out;
}

function pickFirst(...vals: Array<string | undefined | null>): string | undefined {
  for (const v of vals) if (v !== undefined && v !== null && v.trim() !== '') return v.trim();
  return undefined;
}

/** The site name at the end of a `<title>` like "Article name | Site", if short enough to be one. */
function titleSuffix(title: string | null): string | undefined {
  if (!title) return undefined;
  const m = /\s[|\u2013\u2014-]\s([^|\u2013\u2014]{2,40})$/.exec(title);
  return m ? m[1]!.trim() : undefined;
}

/**
 * The JSON-LD title. `headline` and `name` usually agree; when they differ (Wikipedia
 * puts a description in `headline`), prefer the one the page's visible title contains.
 */
function ldTitle(
  ld: Record<string, unknown> | null,
  visible: Array<string | null | undefined>,
): string | undefined {
  if (!ld) return undefined;
  const headline = ldString(ld.headline);
  const name = ldString(ld.name);
  if (!headline || !name || headline === name) return headline ?? name;
  const shown = visible.filter((v): v is string => !!v).map((v) => v.toLowerCase());
  if (shown.some((v) => v.includes(name.toLowerCase()) && !v.includes(headline.toLowerCase()))) {
    return name;
  }
  return headline;
}

/** Splits a page `<title>` like "Article name | Site" into the article name. */
function stripSiteSuffix(title: string, site: string | undefined): string {
  if (site) {
    for (const sep of [' | ', ' - ', ' — ', ' – ', ' :: ', ' · ']) {
      const suffix = `${sep}${site}`;
      if (title.endsWith(suffix)) return title.slice(0, -suffix.length).trim();
      const prefix = `${site}${sep}`;
      if (title.startsWith(prefix)) return title.slice(prefix.length).trim();
    }
  }
  return title;
}

/** Options for {@link pageMetadataToCsl}. */
export interface PageCslOptions {
  /** CSL item id. Defaults to `url:<url>`. */
  id?: string;
  /** Sets `accessed`. */
  accessed?: Date;
}

/** Maps scanned page metadata to CSL-JSON. `url` is the page the HTML came from. */
export function pageMetadataToCsl(
  page: PageMetadata,
  url: string,
  opts: PageCslOptions = {},
): CslItem {
  const m = (k: string): string | undefined => page.meta.get(k)?.[0];
  const all = (k: string): string[] => page.meta.get(k) ?? [];
  const ld = primaryLd(page.jsonLd);

  // Type
  let type = 'webpage';
  if (m('citation_journal_title')) type = 'article-journal';
  else if (m('citation_conference_title')) type = 'paper-conference';
  else if (m('citation_inbook_title')) type = 'chapter';
  else if (m('citation_dissertation_institution')) type = 'thesis';
  else if (m('citation_technical_report_institution')) type = 'report';
  else if (m('citation_arxiv_id') || /(^|\.)arxiv\.org$/i.test(hostOf(url))) type = 'article';
  else if (m('citation_isbn') && !m('citation_doi')) type = 'book';
  else if (ld) {
    const t = ldTypes(ld).find((x) => x in LD_TYPES);
    if (t) type = LD_TYPES[t]!;
  } else if ((m('og:type') ?? '').toLowerCase() === 'article') type = 'article';
  else if ((m('og:type') ?? '').toLowerCase() === 'book') type = 'book';

  // Title
  const site = pickFirst(
    m('og:site_name'),
    m('application-name'),
    titleSuffix(page.title),
    ldString(ld?.publisher),
  );
  const title = pickFirst(
    m('citation_title'),
    ldTitle(ld, [m('og:title'), page.title]),
    m('dc.title'),
    m('og:title'),
    m('twitter:title'),
    page.title ? stripSiteSuffix(page.title, site) : undefined,
  );

  // Authors
  let author: CslName[] = all('citation_author')
    .map((a) => parseName(a))
    .filter((n): n is CslName => n !== null);
  if (author.length === 0 && ld) author = ldNames(ld.author ?? ld.creator);
  if (author.length === 0) {
    author = [...all('dc.creator'), ...all('author'), ...all('article:author')]
      .filter((a) => !/^https?:\/\//i.test(a))
      .map((a) => parseName(a))
      .filter((n): n is CslName => n !== null);
  }

  // Date
  const issued: CslDate | undefined =
    parseDate(
      pickFirst(
        m('citation_publication_date'),
        m('citation_date'),
        m('citation_online_date'),
        ldString(ld?.datePublished),
        m('dc.date'),
        m('article:published_time'),
        m('date'),
        ldString(ld?.dateCreated),
      ),
    ) ?? undefined;

  // Container
  const container = pickFirst(
    m('citation_journal_title'),
    m('citation_conference_title'),
    m('citation_inbook_title'),
    m('citation_book_title'),
    type === 'webpage' ||
      type === 'article' ||
      type === 'post-weblog' ||
      type === 'article-newspaper' ||
      type === 'post'
      ? (ldString(ld?.isPartOf) ?? site)
      : undefined,
  );

  const firstPage = m('citation_firstpage');
  const lastPage = m('citation_lastpage');
  const page_ = firstPage
    ? lastPage && lastPage !== firstPage
      ? `${firstPage}-${lastPage}`
      : firstPage
    : undefined;
  const doi = normalizeDoi(pickFirst(m('citation_doi'), m('dc.identifier'), m('prism.doi')) ?? '');
  const isbn = normalizeIsbn(m('citation_isbn') ?? '');
  const canonical = page.canonical ? resolveUrl(page.canonical, url) : null;
  const abstract = pickFirst(
    m('citation_abstract'),
    m('dc.description'),
    m('description'),
    m('og:description'),
  );

  return compact({
    id: opts.id ?? `url:${canonical ?? url}`,
    type,
    title,
    'container-title': container,
    author,
    issued,
    accessed: opts.accessed
      ? {
          'date-parts': [
            [
              opts.accessed.getUTCFullYear(),
              opts.accessed.getUTCMonth() + 1,
              opts.accessed.getUTCDate(),
            ],
          ],
        }
      : undefined,
    publisher: pickFirst(
      m('citation_publisher'),
      m('dc.publisher'),
      m('citation_dissertation_institution'),
      m('citation_technical_report_institution'),
      type === 'book' || type === 'report' ? ldString(ld?.publisher) : undefined,
    ),
    volume: m('citation_volume'),
    issue: m('citation_issue'),
    page: page_,
    DOI: doi ?? undefined,
    ISBN: isbn ?? undefined,
    ISSN: m('citation_issn'),
    number: m('citation_arxiv_id') ?? m('citation_technical_report_number'),
    URL: canonical ?? url,
    abstract: abstract ? cleanText(abstract) : undefined,
    language: pickFirst(m('citation_language'), m('dc.language'), page.lang),
    source: 'Web',
  } as CslItem);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function resolveUrl(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Options for {@link fetchUrl}. */
export interface FetchUrlOptions extends HttpOptions {
  /** Clock for `accessed`. Defaults to `new Date()`. */
  now?: () => Date;
}

/** Fetches a web page and reads its metadata into CSL-JSON. Throws {@link MetadataError}. */
export async function fetchUrl(input: string, opts: FetchUrlOptions = {}): Promise<CslItem> {
  const url = normalizeUrl(input);
  if (!url) throw new MetadataError('invalid-input', `"${input}" is not a web address.`);
  const { body, contentType } = await getText(url, opts);
  if (contentType && !/html|xml/i.test(contentType)) {
    throw new MetadataError(
      'bad-response',
      `That address is not a web page (${contentType.split(';')[0]}). Enter its details by hand.`,
    );
  }
  const csl = pageMetadataToCsl(scanHtml(body), url, {
    accessed: (opts.now ?? (() => new Date()))(),
  });
  if (!csl.title) {
    throw new MetadataError('bad-response', 'That page has no title. Enter its details by hand.');
  }
  return csl;
}
