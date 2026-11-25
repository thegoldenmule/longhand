import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function selectors(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...text.matchAll(/([^{}]+)\{/g)]
    .map((m) => (m[1] as string).trim())
    .filter((s) => !s.startsWith('@'))
    .flatMap((s) => s.split(',').map((x) => x.trim()));
}

describe('styles.css', () => {
  it('scopes the corkboard card class names to the corkboard', () => {
    // The annotation layer also uses .lh-card, .lh-card-head, .lh-card-title and
    // .lh-card-meta; unscoped rules would restyle each other's cards in the app.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
    const loose = selectors(css).filter(
      (s) => /\.lh-card\b/.test(s) && !s.includes(':where(.lh-cork)'),
    );
    expect(loose).toEqual([]);
  });
});
