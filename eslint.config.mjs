// Bento Browser — flat ESLint config
//
// Two enforcement layers on top of standard JS/TS rules:
//
//   1. Bundle discipline: forbid barrel imports from @tale-ui/*, lucide-react,
//      and @tale-ui/react-styles — keeps shell.js bundle within budget (§6.2).
//
//   2. Layered design system: inside extensions/bento-shell/src/components/
//      and extensions/bento-shell/src/features/, forbid direct imports of
//      react-aria-components and bare HTML element styling — composite
//      components must build only on @tale-ui/react primitives (§3.1).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const noBarrels = {
  paths: [
    {
      name: '@tale-ui/react',
      message:
        'Use per-component imports: `import { Button } from "@tale-ui/react/button"`. The barrel inflates the bundle (§6.2).',
    },
    {
      name: '@tale-ui/react-styles',
      message:
        'Use per-component CSS imports: `import "@tale-ui/react-styles/button"`. The barrel ships ~120 components of CSS (§6.2).',
    },
    {
      name: 'lucide-react',
      message:
        'Use per-icon imports: `import GearIcon from "lucide-react/dist/esm/icons/settings"`. The barrel is ~600 KB (§6.2).',
    },
  ],
};

const noRACDirect = {
  paths: [
    {
      name: 'react-aria-components',
      message:
        'Composite components (layer 2) must import only from @tale-ui/react/* primitives, never react-aria-components directly (§3.1).',
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
      '.surfer/**',
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
      'no-restricted-imports': ['error', noBarrels],
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
          patterns: noRACDirect.patterns,
        },
      ],
    },
  },
);
