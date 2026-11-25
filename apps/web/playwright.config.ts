import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { E2E } from './e2e/ports';

/** Use installed Google Chrome when present, else Playwright's bundled Chromium. */
function hasChrome(): boolean {
  if (process.env.PW_BUNDLED_CHROMIUM === '1') return false;
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].some((p) => existsSync(p));
}

const live = process.env.LONGHAND_LIVE_CLAUDE === '1';

// The full stack: real Postgres (a fresh database per run), real Durable Streams,
// the real ledger service (mock reviewer, or the claude CLI for the live test) and
// a production build of the web app. Servers are never reused: a stale server from
// elsewhere on these ports fails the run instead of being tested.
export default defineConfig({
  testDir: './e2e',
  testMatch: live ? /live\.spec\.ts$/ : /\.spec\.ts$/,
  timeout: live ? 600_000 : 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  outputDir: './test-results',
  use: {
    baseURL: E2E.webOrigin,
    viewport: { width: 1440, height: 900 },
    permissions: ['clipboard-read', 'clipboard-write'],
    acceptDownloads: true,
    trace: 'retain-on-failure',
    ...(hasChrome() ? { channel: 'chrome' } : {}),
  },
  webServer: [
    {
      command: 'tsx e2e/stack.ts',
      url: `${E2E.ledgerUrl}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
      stdout: 'pipe',
    },
    {
      command: `node scripts/build-verifier.mjs && next build && next start --port ${E2E.webPort}`,
      url: E2E.webOrigin,
      reuseExistingServer: false,
      timeout: 300_000,
      env: {
        NEXT_DIST_DIR: '.next-e2e',
        LEDGER_URL: E2E.ledgerUrl,
        AUTH_MODE: 'dev',
        WEB_PORT: String(E2E.webPort),
        NEXT_TELEMETRY_DISABLED: '1',
      },
    },
  ],
});
