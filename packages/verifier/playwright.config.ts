import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.VERIFIER_PORT ?? 4391);

/** Use installed Google Chrome when present, else Playwright's bundled Chromium. */
function hasChrome(): boolean {
  if (process.env.PW_BUNDLED_CHROMIUM === '1') return false;
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/opt/google/chrome/chrome',
    '/usr/bin/google-chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return paths.some((p) => existsSync(p));
}

// Tests run against the production build (`web:build`) served statically.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1100, height: 900 },
    ...(hasChrome() ? { channel: 'chrome' } : {}),
  },
  webServer: {
    command: 'pnpm web:build && vite preview --config web/vite.config.ts',
    url: `http://localhost:${PORT}`,
    // Never reuse: another lane's dev server on the same port would be tested instead.
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
