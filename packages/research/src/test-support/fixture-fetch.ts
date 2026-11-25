// Test support (not exported from the package): a `fetch` that replays the
// responses recorded by `scripts/record-fixtures.ts`. Unknown URLs fail the test.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../http';

interface Fixture {
  url: string;
  status: number;
  contentType: string | null;
  body: string;
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'http');

let cache: Map<string, Fixture> | null = null;

/** Every recorded response, keyed by URL. */
export function fixtures(): Map<string, Fixture> {
  if (!cache) {
    cache = new Map();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const fx = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixture;
      cache.set(fx.url, fx);
    }
  }
  return cache;
}

/** A recorded response body. */
export function fixtureBody(url: string): string {
  const fx = fixtures().get(url);
  if (!fx) throw new Error(`no fixture for ${url}`);
  return fx.body;
}

/** A canned response. */
export function response(status: number, body: string, contentType = 'application/json') {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null) },
    text: () => Promise.resolve(body),
  };
}

/** Requests made through a {@link fixtureFetch}. */
export interface FetchLog {
  url: string;
  headers: Record<string, string>;
}

/**
 * A fetch that serves recorded fixtures, plus optional `extra` canned responses.
 * Every call is appended to `log`.
 */
export function fixtureFetch(
  extra: Record<string, ReturnType<typeof response>> = {},
  log: FetchLog[] = [],
): FetchLike & { log: FetchLog[] } {
  const fn = (async (url: string, init?: { headers?: Record<string, string> }) => {
    log.push({ url, headers: init?.headers ?? {} });
    if (extra[url]) return extra[url];
    const fx = fixtures().get(url);
    if (!fx) throw new Error(`no fixture for ${url} (tests never touch the network)`);
    return response(fx.status, fx.body, fx.contentType ?? 'text/plain');
  }) as FetchLike & { log: FetchLog[] };
  fn.log = log;
  return fn;
}
