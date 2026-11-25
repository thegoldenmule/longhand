// Builds the standalone verifier page (packages/verifier/web) into public/verify,
// served at /verify. Fully client-side: the bundle never leaves the browser.
// `--if-missing` skips the build when public/verify/index.html already exists.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../public/verify');
if (process.argv.includes('--if-missing') && existsSync(resolve(out, 'index.html')))
  process.exit(0);
const r = spawnSync(
  'pnpm',
  [
    '--filter',
    '@longhand/verifier',
    'exec',
    'vite',
    'build',
    '--config',
    'web/vite.config.ts',
    '--base',
    '/verify/',
    '--outDir',
    out,
    '--emptyOutDir',
    '--logLevel',
    'warn',
  ],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
