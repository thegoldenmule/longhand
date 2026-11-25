import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'binder',
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
