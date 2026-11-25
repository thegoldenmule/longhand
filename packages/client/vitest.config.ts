import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'client',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['../../apps/server/test/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
