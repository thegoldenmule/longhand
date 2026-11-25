import { defineProject } from 'vitest/config';

// Component tests opt into jsdom with a `// @vitest-environment jsdom` docblock.
export default defineProject({
  test: {
    name: 'research',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
