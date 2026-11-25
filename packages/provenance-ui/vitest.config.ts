import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@longhand/provenance-ui',
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
