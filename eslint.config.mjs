// Bento Browser — flat ESLint config
//
// Two enforcement layers on top of standard JS/TS rules:
//
//   1. Bundle discipline: forbid private Mux generated imports and the
//      lucide-react barrel — keeps shell.js bundle boundaries explicit (§6.2).
//
//   2. Layered design system: inside extensions/bento-shell/src/components/
//      and extensions/bento-shell/src/features/, forbid direct imports of
//      react-aria-components and bare HTML element styling — composite
//      components must build only on the public Mux API and Bento primitives
//      (§3.1).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const noBarrels = {
  paths: [
    {
      name: 'lucide-react',
      message:
        'Use per-icon imports: `import GearIcon from "lucide-react/dist/esm/icons/settings"`. The barrel is ~600 KB (§6.2).',
    },
  ],
};

const noPrivateMux = {
  patterns: ['@muxui/react/generated/*', '@muxui/react/internal/*'],
  message:
    'Use the public @muxui/react root export or documented public subpath; generated implementation files are not a consumer API.',
};

const noRACDirect = {
  paths: [
    {
      name: 'react-aria-components',
      message:
        'Composite components (layer 2) must import the public @muxui/react API or a Bento primitive, never react-aria-components directly (§3.1).',
    },
  ],
  patterns: ['react-aria-components/*'],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/.ladle/**',
      'engine/**',
      'node_modules/**',
      '.bento/**',
      'branding/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Browser-context files (extension public/, react sources, etc.) get
  // browser globals so ESLint stops complaining about localStorage/document.
  {
    files: ['extensions/**/*.{ts,tsx,js,jsx,mjs}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },

  // Bundle discipline — applies to all extension source
  {
    files: ['extensions/**/*.{ts,tsx,js,jsx,mjs}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: noBarrels.paths,
          patterns: noPrivateMux.patterns,
        },
      ],
    },
  },

  // Layered design system — composites and features only
  {
    files: [
      'extensions/bento-shell/src/components/**/*.{ts,tsx}',
      'extensions/bento-shell/src/features/**/*.{ts,tsx}',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...noBarrels.paths, ...noRACDirect.paths],
          patterns: [...noRACDirect.patterns, ...noPrivateMux.patterns],
        },
      ],
    },
  },
);
