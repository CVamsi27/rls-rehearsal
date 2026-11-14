import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'cli/dist/**', '.rls-rehearsal/**', 'test-results/**', 'playwright-report/**'] },
  ...tseslint.configs.recommended.map(config => ({
    ...config,
    files: ['src/**/*.ts', 'web/**/*.ts', 'cli/src/**/*.ts'],
  })),
];
