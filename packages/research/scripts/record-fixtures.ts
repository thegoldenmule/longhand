/**
 * Records real Crossref, Open Library and web page responses into
 * `src/__fixtures__/http/` so the test suite never touches the network.
 *
 *   pnpm --filter @longhand/research record-fixtures
 *
 * Each fixture is `{ url, status, contentType, body, recordedAt, trimmed? }`. HTML
 * bodies are trimmed to the `<head>` plus any JSON-LD scripts in the body, which is
 * everything the page scanner reads.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crossrefSearchUrl, crossrefWorkUrl } from '../src/crossref';
import { USER_AGENT } from '../src/http';
import { openLibraryIsbnUrl, openLibrarySearchUrl } from '../src/openlibrary';
import { FIXTURE_REQUESTS, fixtureFileName } from '../src/test-support/fixture-list';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'src', '__fixtures__', 'http');

function trimHtml(html: string): string {
  const headEnd = html.search(/<\/head\s*>/i);
  if (headEnd === -1) return html;
  // Inline styles and non-JSON-LD scripts carry no metadata; drop their contents.
  const head = html
    .slice(0, headEnd + '</head>'.length)
    .replace(/(<style\b[^>]*>)[\s\S]*?(<\/style\s*>)/gi, '$1$2')
    .replace(/(<script\b(?![^>]*ld\+json)[^>]*>)[\s\S]*?(<\/script\s*>)/gi, '$1$2');
  const ld = [
    ...html
      .slice(headEnd)
      .matchAll(/<script\b[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script\s*>/gi),
  ].map((m) => m[0]);
  return `${head}\n<body>\n${ld.join('\n')}\n</body></html>\n`;
}

async function fetchWithRetry(url: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      if (attempt >= 4) throw err;
      console.warn(`retrying ${url} (${String(err)})`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const urls = [
    ...FIXTURE_REQUESTS.dois.map((d) => crossrefWorkUrl(d)),
    ...FIXTURE_REQUESTS.isbns.map((i) => openLibraryIsbnUrl(i)),
    ...FIXTURE_REQUESTS.searches.flatMap(([q, n]) => [
      crossrefSearchUrl(q, n),
      openLibrarySearchUrl(q, n),
    ]),
    ...FIXTURE_REQUESTS.pages,
  ];
  const force = process.argv.includes('--force');
  for (const url of urls) {
    const file = join(outDir, fixtureFileName(url));
    if (!force && existsSync(file)) continue;
    const res = await fetchWithRetry(url);
    const contentType = res.headers.get('content-type');
    let body = await res.text();
    let trimmed = false;
    if (contentType?.includes('html')) {
      const t = trimHtml(body);
      trimmed = t.length < body.length;
      body = t;
    } else if (contentType?.includes('json')) {
      try {
        body = JSON.stringify(JSON.parse(body), null, 1);
      } catch {
        // keep as is
      }
    }
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          url,
          status: res.status,
          contentType,
          recordedAt: new Date().toISOString(),
          trimmed,
          body,
        },
        null,
        2,
      )}\n`,
    );
    console.log(res.status, url, '→', fixtureFileName(url), `${body.length} chars`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

await main();
