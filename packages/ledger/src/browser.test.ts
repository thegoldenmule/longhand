/**
 * Browser-runtime determinism: bundle the fold for the browser platform with
 * esbuild (which fails on any Node-only import), run the bundle in a fresh V8
 * context that has only browser-style globals (no `process`, `Buffer`, `require`),
 * fold every golden fixture there, and compare the canonical output byte for byte
 * with Node.
 */
import { canonicalize } from '@longhand/schema';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, loadFixture } from '../fixtures/index';
import { foldCommits } from './fold';
import { projectState } from './project';
import { projectWordsByClass } from './words';

const ENTRY = `
import { canonicalize } from '@longhand/schema';
import { foldCommits, projectState, projectWordsByClass, verifyChain } from './index';
export function run(json) {
  return JSON.parse(json).map((commits) => {
    const ps = projectState(foldCommits(commits));
    return canonicalize({ state: ps, words: projectWordsByClass(ps), chain: verifyChain(commits).ok });
  });
}
`;

describe('browser runtime', () => {
  it('folds every fixture to byte-identical output', async () => {
    const out = await build({
      stdin: { contents: ENTRY, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: '__longhand',
      write: false,
      logLevel: 'silent',
    });
    const code = out.outputFiles[0]!.text;
    expect(code).not.toMatch(/require\(["']node:/);
    const context = vm.createContext({ TextEncoder, TextDecoder, console, globalThis: undefined });
    vm.runInContext('globalThis = this;', context);
    vm.runInContext(code, context);
    const ledgers = FIXTURE_NAMES.map((n) => loadFixture(n).commits);
    // Pass JSON text so every object is created inside the browser-like realm.
    const browser = (context as { __longhand: { run: (json: string) => string[] } }).__longhand.run(JSON.stringify(ledgers));
    const node = ledgers.map((commits) => {
      const ps = projectState(foldCommits(commits));
      return canonicalize({ state: ps, words: projectWordsByClass(ps), chain: true });
    });
    expect(browser).toHaveLength(node.length);
    browser.forEach((b, i) => expect(b, FIXTURE_NAMES[i]).toBe(node[i]));
  }, 60_000);
});
