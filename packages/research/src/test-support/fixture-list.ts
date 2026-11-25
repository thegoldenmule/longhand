// Test support (not exported from the package): the requests recorded by
// `scripts/record-fixtures.ts`, and how a URL maps to its fixture file.

export const FIXTURE_REQUESTS = {
  dois: [
    '10.1038/nature14539', // journal article
    '10.1145/3442188.3445922', // conference paper
    '10.1007/978-3-030-58452-8_13', // book chapter
    '10.5555/longhand-does-not-exist', // 404
  ],
  isbns: [
    '9780262033848', // Introduction to Algorithms
    '9780141439518', // Pride and Prejudice (Penguin Classics)
  ],
  searches: [
    ['deep learning', 5],
    ['the structure of scientific revolutions', 5],
  ] as Array<[string, number]>,
  pages: [
    'https://arxiv.org/abs/1706.03762', // Highwire citation_* tags
    'https://en.wikipedia.org/wiki/Typewriter', // JSON-LD + Open Graph
    'https://example.com/', // <title> only
    'https://www.newyorker.com/magazine/2017/04/03/ai-versus-md', // JSON-LD NewsArticle
  ],
};

/** FNV-1a 32-bit, hex. */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Fixture file name for a URL: a readable slug plus a hash of the full URL. */
export function fixtureFileName(url: string): string {
  const u = new URL(url);
  const slug = `${u.hostname}${u.pathname}`
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${slug}-${fnv(url)}.json`;
}
