/**
 * Browser-runtime determinism: bundle `computeReport` for the browser with
 * esbuild (which fails on any Node-only import), run it in a fresh V8 context
 * with only browser-style globals, compute every fixture's reports there, and
 * compare the canonical JSON byte for byte with Node's. This is what a verifier
 * in a browser does.
 */
import { FIXTURE_NAMES, loadFixture } from '@longhand/ledger/fixtures';
import { canonicalize } from '@longhand/schema';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { computeReport } from './compute';

const ENTRY = `
import { canonicalize } from '@longhand/schema';
import { computeReport } from './compute';
export function run(json) {
  return JSON.parse(json).map(({ commits, witnesses, scopes }) =>
    scopes.map((scope) => canonicalize(computeReport(commits, { scope, witnesses }))),
  );
}
`;

describe('browser runtime', () => {
  it('computes byte-identical reports for every fixture', async () => {
    const out = await build({
      stdin: {
        contents: ENTRY,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
        loader: 'ts',
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      globalName: '__report',
      write: false,
      logLevel: 'silent',
    });
    const code = out.outputFiles[0]!.text;
    expect(code).not.toMatch(/require\(["']node:/);
    const context = vm.createContext({ TextEncoder, TextDecoder, console, globalThis: undefined });
    vm.runInContext('globalThis = this;', context);
    vm.runInContext(code, context);
    const inputs = FIXTURE_NAMES.map((n) => {
      const f = loadFixture(n);
      const scopes = [
        { kind: 'project' },
        ...Object.keys(f.expected.state.documents)
          .sort()
          .map((documentId) => ({ kind: 'document', documentId })),
      ];
      return { commits: f.commits, witnesses: f.witnesses, scopes };
    });
    // Pass JSON text so every object is created inside the browser-like realm.
    const browser = (context as { __report: { run: (json: string) => string[][] } }).__report.run(
      JSON.stringify(inputs),
    );
    const node = inputs.map(({ commits, witnesses, scopes }) =>
      scopes.map((scope) =>
        canonicalize(computeReport(commits, { scope: scope as { kind: 'project' }, witnesses })),
      ),
    );
    expect(browser).toHaveLength(node.length);
    browser.forEach((b, i) => expect(b, FIXTURE_NAMES[i]).toEqual(node[i]));
  }, 60_000);
});
