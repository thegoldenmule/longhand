import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@longhand/verifier',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    testTimeout: 30_000,
  },
});
