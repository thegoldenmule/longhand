import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Every selector in a stylesheet (comments stripped). */
function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/([^{}]+)\{/g)]
    .map((m) => (m[1] as string).trim())
    .filter((s) => !s.startsWith('@'))
    .flatMap((s) => s.split(',').map((x) => x.trim()));
}

describe('styles.css', () => {
  it('scopes the shared .lh-card class names to the annotation layer', () => {
    // The binder's corkboard also uses .lh-card, .lh-card-head, .lh-card-title and
    // .lh-card-meta; unscoped rules would restyle each other's cards in the app.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
    const loose = selectors(css).filter(
      (s) =>
        /\.lh-card\b/.test(s) &&
        !s.includes(':where(.lh-ann)') &&
        !/^(\.lh-margin|\.is-stale|\.is-resolved)\b/.test(s),
    );
    expect(loose).toEqual([]);
  });
});
