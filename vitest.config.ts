import { defineConfig } from 'vitest/config';

// One Vitest project per workspace package, so `pnpm test` at the root runs every package.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    passWithNoTests: true,
  },
});
