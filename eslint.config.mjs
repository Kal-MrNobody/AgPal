// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const PAYPAL_SDK = '@paypal/paypal-server-sdk';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/drizzle/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // Invariant 1: nothing outside packages/policy may reach the PayPal adapter,
      // and nothing outside packages/paypal may touch the PayPal SDK.
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: PAYPAL_SDK,
              message: 'Invariant 1: only packages/paypal may import the PayPal SDK.',
            },
            {
              name: '@agpal/paypal',
              message: 'Invariant 1: money actions go through @agpal/policy (the gate).',
            },
          ],
          patterns: [
            {
              group: [`${PAYPAL_SDK}/*`, '@agpal/paypal/*'],
              message: 'Invariant 1: go through the gate.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/paypal/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: '@agpal/policy', message: 'paypal must not depend on policy.' }] },
      ],
    },
  },
  {
    files: ['packages/policy/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: PAYPAL_SDK,
              message: 'Invariant 1: only packages/paypal may import the PayPal SDK.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.config.{js,mjs,ts}', 'eslint.config.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);
