/**
 * The verifier is isomorphic: bundle it for the browser with esbuild (which
 * fails on any Node-only import), run it in a fresh V8 context that has only
 * browser-style globals plus WebCrypto, and check it reaches the same verdicts
 * and the same recomputed reports as Node.
 */
import { canonicalize } from '@longhand/schema';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { clone, fixtureBundle, tamperedBundle } from './test-helpers';
import { verifyBundle } from './verify';

const ENTRY = `
import { canonicalize } from '@longhand/schema';
import { verifyBundle } from './verify';
export async function run(json) {
  const out = [];
  for (const b of JSON.parse(json)) {
    const r = await verifyBundle(b);
    out.push(canonicalize({ ok: r.ok, checks: r.checks, report: r.report }));
  }
  return out;
}
`;

describe('browser runtime', () => {
  it('verifies bundles exactly as Node does', async () => {
    const out = await build({
      stdin: {
        contents: ENTRY,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
        loader: 'ts',
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: '__verifier',
      write: false,
      logLevel: 'silent',
    });
    const code = out.outputFiles[0]!.text;
    expect(code).not.toMatch(/require\(["']node:/);
    const context = vm.createContext({
      TextEncoder,
      TextDecoder,
      console,
      crypto: globalThis.crypto,
      atob,
      btoa,
      globalThis: undefined,
    });
    vm.runInContext('globalThis = this;', context);
    vm.runInContext(code, context);
    const doctored = clone(fixtureBundle('research'));
    doctored.report.activeWritingMs += 1;
    const bundles = [
      fixtureBundle('novel'),
      fixtureBundle('suggestions', { documentId: 'doc-s' }),
      doctored,
      tamperedBundle('tampered-dropped'),
    ];
    const browser = await (
      context as { __verifier: { run: (json: string) => Promise<string[]> } }
    ).__verifier.run(JSON.stringify(bundles));
    const node = await Promise.all(
      bundles.map(async (b) => {
        const r = await verifyBundle(clone(b));
        return canonicalize({ ok: r.ok, checks: r.checks, report: r.report });
      }),
    );
    expect(browser).toEqual(node);
    expect(browser.map((s) => (JSON.parse(s) as { ok: boolean }).ok)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  }, 60_000);
});
