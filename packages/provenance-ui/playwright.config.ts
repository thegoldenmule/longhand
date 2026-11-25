import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const PORT = Number(process.env.DEMO_PORT ?? 4318);

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

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 860 },
    ...(hasChrome() ? { channel: 'chrome' } : {}),
  },
  webServer: {
    command: 'pnpm demo',
    url: `http://localhost:${PORT}`,
    // `pnpm e2e` (LONGHAND_E2E_STRICT=1) never reuses a server already on the port.
    reuseExistingServer: !process.env.CI && !process.env.LONGHAND_E2E_STRICT,
    timeout: 30_000,
  },
});
