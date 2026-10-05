// Bento Browser — flat ESLint config
//
// Two enforcement layers on top of standard JS/TS rules:
//
//   1. Bundle discipline: forbid private Mux generated imports and the
//      lucide-react barrel — keeps shell.js bundle boundaries explicit (§6.2).
//
//   2. Public design-system boundary: shell source, Ladle, and rollback UI
//      cannot import React Aria directly. Structural HTML and product-specific
//      row/drag hosts remain allowed; generic controls use public Mux parts.
//      This config checks imports, not intrinsic JSX or CSS values (§3.1).

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
    files: [
      'extensions/**/*.{ts,tsx,js,jsx,mjs}',
      'rollback/legacy-source/extensions/**/*.{ts,tsx,js,jsx,mjs}',
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },

  // Bundle discipline — applies to all extension source
  {
    files: [
      'extensions/**/*.{ts,tsx,js,jsx,mjs}',
      'rollback/legacy-source/extensions/**/*.{ts,tsx,js,jsx,mjs}',
    ],
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

  // Public Mux boundary — every shell entry, story, and rollback source
  {
    files: [
      'extensions/bento-shell/**/*.{ts,tsx,js,jsx,mjs}',
      'rollback/legacy-source/extensions/bento-shell/**/*.{ts,tsx,js,jsx,mjs}',
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
