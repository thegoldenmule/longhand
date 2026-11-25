/**
 * Bundles the CLI into one executable file, `dist/longhand-verify.mjs`, with
 * every dependency inlined (only Node built-ins stay external).
 *
 *     pnpm --filter @longhand/verifier build
 */
import { build } from 'esbuild';
import { chmod } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Builds the executable at `outfile` (default `dist/longhand-verify.mjs`). */
export async function buildCli(outfile = `${root}dist/longhand-verify.mjs`): Promise<string> {
  await build({
    entryPoints: [`${root}src/bin.ts`],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    banner: { js: '#!/usr/bin/env node' },
    legalComments: 'eof',
    logLevel: 'silent',
  });
  await chmod(outfile, 0o755);
  return outfile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await buildCli();
  process.stdout.write(`built ${out}\n`);
}
