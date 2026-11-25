/**
 * The small HTTP layer every fetcher goes through. Isomorphic: it only uses the
 * WHATWG `fetch` API, and the `fetch` itself is injectable so tests replay recorded
 * responses and the web app can route page fetches through its own proxy.
 */

/** The subset of `fetch` the fetchers use. `globalThis.fetch` satisfies it. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** Generic client identifier sent with every request. No personal contact details. */
export const USER_AGENT = 'Longhand/0.1';

/** Options shared by every network-backed function in this package. */
export interface HttpOptions {
  /** The fetch to use. Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /**
   * The `User-Agent` header to send, or `null` to send none (browsers ignore or
   * reject it, so the web app may pass `null`). Defaults to {@link USER_AGENT}.
   */
  userAgent?: string | null;
}

/** What went wrong when fetching metadata. */
export type MetadataErrorCode =
  'invalid-input' | 'not-found' | 'http-error' | 'network-error' | 'bad-response';

/** An error from a metadata fetcher, with a message fit to show the writer. */
export class MetadataError extends Error {
  readonly code: MetadataErrorCode;
  readonly status: number | null;

  constructor(code: MetadataErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'MetadataError';
    this.code = code;
    this.status = status;
  }
}

function resolveFetch(opts: HttpOptions): FetchLike {
  if (opts.fetch) return opts.fetch;
  if (typeof globalThis.fetch !== 'function') {
    throw new MetadataError('network-error', 'No fetch implementation is available.');
  }
  return globalThis.fetch.bind(globalThis) as unknown as FetchLike;
}

function headersFor(opts: HttpOptions, accept: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept };
  const ua = opts.userAgent === undefined ? USER_AGENT : opts.userAgent;
  if (ua !== null) headers['User-Agent'] = ua;
  return headers;
}

/** Fetches `url` and returns its body as text. Throws {@link MetadataError}. */
export async function getText(
  url: string,
  opts: HttpOptions = {},
  accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
): Promise<{ body: string; contentType: string | null }> {
  const fetch = resolveFetch(opts);
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetch(url, { headers: headersFor(opts, accept) });
  } catch (err) {
    throw new MetadataError(
      'network-error',
      `Could not reach ${hostOf(url)}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (res.status === 404) {
    throw new MetadataError('not-found', `Nothing found at ${hostOf(url)}.`, 404);
  }
  if (!res.ok) {
    throw new MetadataError(
      'http-error',
      `${hostOf(url)} answered with HTTP ${res.status}.`,
      res.status,
    );
  }
  return { body: await res.text(), contentType: res.headers.get('content-type') };
}

/** Fetches `url` and parses its body as JSON. Throws {@link MetadataError}. */
export async function getJson(url: string, opts: HttpOptions = {}): Promise<unknown> {
  const { body } = await getText(url, opts, 'application/json');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new MetadataError('bad-response', `${hostOf(url)} did not return JSON.`);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
