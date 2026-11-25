/**
 * The CLI: exit codes and output, in process and as the esbuild-bundled
 * executable. Also checks the committed example bundles are current.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCli } from '../scripts/build-cli';
import { EXAMPLES_DIR, exampleBundles, exampleText } from '../scripts/make-examples';
import { EXIT, main } from './cli';
import { clone, fixtureBundle, tamperedBundle } from './test-helpers';

const run = promisify(execFile);

let dir: string;
const files: Record<string, string> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'longhand-verify-'));
  const good = fixtureBundle('suggestions');
  const doctored = clone(good);
  doctored.report.suggestions.total += 1;
  const write = async (name: string, text: string) => {
    files[name] = join(dir, name);
    await writeFile(files[name], text);
  };
  await write('good.json', JSON.stringify(good));
  await write('doctored.json', JSON.stringify(doctored));
  await write('tampered.json', JSON.stringify(tamperedBundle('tampered-truncated')));
  await write('not-json.json', '{ nope');
});

function capture() {
  let out = '';
  let err = '';
  return {
    io: {
      out: (s: string) => (out += s),
      err: (s: string) => (err += s),
      readFile: (p: string) => readFile(p, 'utf8'),
    },
    get out() {
      return out;
    },
    get err() {
      return err;
    },
  };
}

describe('longhand-verify (in process)', () => {
  it('exits 0 and prints every check for a good bundle', async () => {
    const c = capture();
    expect(await main([files['good.json']!], c.io)).toBe(EXIT.verified);
    expect(c.out).toContain('PASS  Bundle format');
    expect(c.out).toContain('PASS  Report');
    expect(c.out).toContain('VERIFIED.');
    expect(c.out).toContain('Disclosure:');
  });

  it('exits 1 for a doctored report, naming the difference', async () => {
    const c = capture();
    expect(await main([files['doctored.json']!], c.io)).toBe(EXIT.notVerified);
    expect(c.out).toContain('FAIL  Report');
    expect(c.out).toMatch(/suggestions\.total: bundled \d+, recomputed \d+/);
    expect(c.out).toContain('NOT VERIFIED. Failed: Report.');
  });

  it('exits 1 for a truncated ledger', async () => {
    const c = capture();
    expect(await main([files['tampered.json']!], c.io)).toBe(EXIT.notVerified);
    expect(c.out).toContain('FAIL  Hash chain');
    expect(c.out).toContain('head-mismatch');
    expect(c.out).toContain('SKIP  Re-fold');
  });

  it('prints JSON with --json', async () => {
    const c = capture();
    expect(await main(['--json', files['good.json']!], c.io)).toBe(EXIT.verified);
    const result = JSON.parse(c.out);
    expect(result.ok).toBe(true);
    expect(result.checks.map((x: { id: string }) => x.id)).toEqual([
      'schema',
      'key',
      'chain',
      'witnesses',
      'fold',
      'report',
    ]);
    expect(typeof result.report.disclosure).toBe('string');
  });

  it('checks --key-id', async () => {
    const good = fixtureBundle('suggestions');
    const ok = capture();
    expect(await main([files['good.json']!, '--key-id', good.keyId], ok.io)).toBe(EXIT.verified);
    expect(ok.out).toContain('the key you expected');
    const bad = capture();
    expect(await main([files['good.json']!, '--key-id', 'ab'.repeat(32)], bad.io)).toBe(
      EXIT.notVerified,
    );
    expect(bad.out).toContain('FAIL  Witness key');
    expect(await main([files['good.json']!, '--key-id', 'xyz'], capture().io)).toBe(EXIT.usage);
  });

  it('exits 2 for usage errors and unreadable files', async () => {
    const c = capture();
    expect(await main([], c.io)).toBe(EXIT.usage);
    expect(c.err).toContain('Usage: longhand-verify');
    expect(await main(['a.json', 'b.json'], capture().io)).toBe(EXIT.usage);
    expect(await main(['--frobnicate', 'a.json'], capture().io)).toBe(EXIT.usage);
    const missing = capture();
    expect(await main([join(dir, 'missing.json')], missing.io)).toBe(EXIT.usage);
    expect(missing.err).toContain('cannot read');
    const notJson = capture();
    expect(await main([files['not-json.json']!], notJson.io)).toBe(EXIT.usage);
    expect(notJson.err).toContain('is not JSON');
    const help = capture();
    expect(await main(['--help'], help.io)).toBe(EXIT.verified);
    expect(help.out).toContain('Exit codes');
  });
});

describe('longhand-verify (bundled executable)', () => {
  let exe: string;
  beforeAll(async () => {
    exe = await buildCli(join(dir, 'longhand-verify.mjs'));
  }, 60_000);

  const exitCode = async (args: string[]) => {
    try {
      const r = await run(process.execPath, [exe, ...args]);
      return { code: 0, out: r.stdout };
    } catch (e) {
      const err = e as { code: number; stdout: string };
      return { code: err.code, out: err.stdout };
    }
  };

  it('is one self-contained file', async () => {
    const text = await readFile(exe, 'utf8');
    expect(text.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(text).not.toMatch(/from ["']@longhand\//);
    expect(text).not.toMatch(/from ["'](zod|prosemirror-[a-z]+)["']/);
  });

  it('returns the documented exit codes', async () => {
    expect((await exitCode([files['good.json']!])).code).toBe(0);
    expect((await exitCode([files['doctored.json']!])).code).toBe(1);
    expect((await exitCode([files['tampered.json']!])).code).toBe(1);
    expect((await exitCode([files['not-json.json']!])).code).toBe(2);
    expect((await exitCode([])).code).toBe(2);
    const json = await exitCode(['--json', files['good.json']!]);
    expect(JSON.parse(json.out).ok).toBe(true);
  }, 60_000);
});

describe('example bundles', () => {
  it('are current (run `pnpm --filter @longhand/verifier examples` to refresh)', async () => {
    for (const [name, bundle] of Object.entries(exampleBundles())) {
      const committed = await readFile(join(EXAMPLES_DIR, name), 'utf8');
      expect(committed, name).toBe(await exampleText(name, bundle));
    }
  });
});
