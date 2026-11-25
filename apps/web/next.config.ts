import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import type { NextConfig } from 'next';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

// The repo-root .env is shared with the ledger service; values already in the
// environment win.
const rootEnv = resolve(repoRoot, '.env');
if (existsSync(rootEnv)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(rootEnv, 'utf8')))) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: [
    '@longhand/annotations',
    '@longhand/binder',
    '@longhand/client',
    '@longhand/editor',
    '@longhand/ledger',
    '@longhand/provenance-ui',
    '@longhand/report',
    '@longhand/research',
    '@longhand/schema',
  ],
  // e2e builds into their own directory so they never clobber `pnpm dev`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
  async rewrites() {
    // The standalone verifier page (packages/verifier/web), built into public/verify.
    return { beforeFiles: [{ source: '/verify', destination: '/verify/index.html' }] };
  },
};

export default nextConfig;
