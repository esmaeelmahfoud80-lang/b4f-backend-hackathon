import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['src/generated/prisma/**'] },
  {
    ...js.configs.recommended,
    files: ['test/**/*.cjs'],
    languageOptions: {
      globals: { fetch: 'readonly', process: 'readonly' },
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['src/**/*.ts'],
  })),
];
