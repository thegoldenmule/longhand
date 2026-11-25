import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@longhand/report',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
