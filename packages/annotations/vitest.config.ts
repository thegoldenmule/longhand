import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@longhand/annotations',
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test-support/**/*.test.ts'],
  },
});
