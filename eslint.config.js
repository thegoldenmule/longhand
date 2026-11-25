// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.claude/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '.dev/**',
      'playwright-report/**',
      'test-results/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'apps/web/public/verify/**',
      'apps/web/.next-e2e/**',
      'apps/web/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // packages/schema is isomorphic: it must run identically in Node and browsers.
    files: ['packages/schema/src/**/*.ts'],
    ignores: ['packages/schema/src/**/*.test.ts'],
    languageOptions: { globals: { ...globals['shared-node-browser'] } },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'fs', 'path', 'crypto', 'buffer', 'os'],
              message: 'packages/schema must stay isomorphic (no Node-only APIs).',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'Buffer', message: 'Use Uint8Array (packages/schema is isomorphic).' },
        { name: 'process', message: 'packages/schema is isomorphic.' },
        { name: 'require', message: 'ESM only.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'Date',
          property: 'now',
          message: 'Contracts and the fold must be deterministic.',
        },
        {
          object: 'Math',
          property: 'random',
          message: 'Contracts and the fold must be deterministic.',
        },
      ],
    },
  },
  prettier,
);
