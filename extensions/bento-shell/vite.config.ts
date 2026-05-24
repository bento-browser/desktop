// Bento Browser shell — Vite config
//
// Outputs to dist/ with stable (non-hash) asset names because the chrome
// XHTML <browser src="chrome://bento-shell/content/index.html"> will load
// these by URL — hashes would break the chrome.manifest registration.
//
// `optimizeDeps.exclude: ['@tale-ui/react']` lets Vite consume Tale UI's
// raw TS sources directly through the pnpm `link:` symlink for fastest
// HMR. CI prod builds should consider switching the link target to Tale UI's
// build/ directory to surface @babel/runtime drift before release (see
// CLAUDE.md Tale UI release-migration callout).

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Strip `crossorigin` from emitted <script> and <link> tags. moz-extension://
// resources don't reliably handle CORS preflight, so the attribute makes
// chained ESM imports (shell.js → Text.styled.js) fail to load — the
// sidebar gets stuck on the static skeleton because shell.js never executes.
// Same-origin within an extension UUID is already enforced by Firefox; we
// don't need CORS semantics on top.
function stripCrossOrigin(): Plugin {
  return {
    name: 'bento-strip-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(="[^"]*")?/g, '');
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react({ jsxRuntime: 'automatic' }), stripCrossOrigin()],

  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../_shared'),
      '@bento': resolve(__dirname, 'src'),
      // Force `react-aria-components` (and the helper umbrellas) to
      // resolve from bento-browser's node_modules, never Tale UI's.
      // Tale UI is consumed as raw TS via a `link:` symlink and
      // brings its OWN pnpm-resolved copies of react-aria-components,
      // react-aria, and react-stately. When Tale UI's `<Menu>` ends
      // up bundled from tale-ui's copy of react-aria-components but
      // ChromeMenu's directly-imported `<SubmenuTrigger>` resolves to
      // bento's copy, the two copies' module-level
      // `SubmenuTriggerContext` constants (`createContext(null)`) are
      // independent React contexts. The parent menu provides one;
      // the child consumes the other; the destructure of `null`
      // throws "e is null" on every kebab open. Aliasing collapses
      // both import paths onto one resolution so the providers and
      // consumers share a single context identity. Same reasoning
      // applies to `react-aria` / `react-stately` (umbrella packages
      // that re-export hooks like useMenuTrigger / useSubmenuTrigger
      // — those carry their own state contexts too) and
      // `@react-types/shared` (shared TypeScript symbol slots that
      // can also produce identity drift across duplicate copies).
      'react-aria-components': resolve(__dirname, '../../node_modules/react-aria-components'),
      'react-aria': resolve(__dirname, '../../node_modules/react-aria'),
      'react-stately': resolve(__dirname, '../../node_modules/react-stately'),
      '@react-types/shared': resolve(__dirname, '../../node_modules/@react-types/shared'),
    },
  },

  optimizeDeps: {
    exclude: ['@tale-ui/react', '@tale-ui/react-styles', '@tale-ui/utils'],
  },

  // Relative-path emission (./) so the bundle works when index.html is loaded
  // at moz-extension://<uuid>/dist/index.html. Without this, Vite emits
  // /assets/shell.js which resolves to moz-extension://<uuid>/assets/shell.js
  // (missing the dist/ prefix the extension uses).
  base: './',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'firefox128',
    cssCodeSplit: false,
    sourcemap: mode !== 'production',
    rollupOptions: {
      // background.ts is built separately by esbuild as IIFE — see
      // package.json `build:background` script. Vite emits ES modules
      // (correct for the index.html entry that loads via type=module)
      // but MV2 background.scripts requires classic-script format.
      // Multi-entry: shell is the chrome-mounted sidebar; settings is a
      // standalone moz-extension://<uuid>/dist/settings.html page; palette,
      // confirm, and edit-workspace are chrome-mounted overlay <browser>
      // elements covering the whole window.
      input: {
        shell: resolve(__dirname, 'index.html'),
        settings: resolve(__dirname, 'settings.html'),
        palette: resolve(__dirname, 'palette.html'),
        confirm: resolve(__dirname, 'confirm.html'),
        'edit-workspace': resolve(__dirname, 'edit-workspace.html'),
        'workspace-switcher': resolve(__dirname, 'workspace-switcher.html'),
        welcome: resolve(__dirname, 'welcome.html'),
        menu: resolve(__dirname, 'menu.html'),
        'panel-trailer': resolve(__dirname, 'panel-trailer.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
        format: 'es',
        // Force react-aria-* into a single shared chunk. Without this,
        // Rollup's default heuristics can inline copies of an internal
        // module (e.g. react-aria-components/dist/private/Menu.mjs) into
        // BOTH a per-entry chunk AND a shared chunk when different entry
        // points consume different exports from the same package. Each
        // copy carries its own module-local React contexts — most
        // visibly `SubmenuTriggerContext`, which is created via
        // `createContext(null)` and read by `SubmenuTrigger`'s render
        // function. When the parent `<Menu>` (loaded via Tale UI's
        // wrapper, ending up in the shared chunk) provides the context
        // but `<SubmenuTrigger>` (imported directly by ChromeMenu.tsx,
        // ending up in menu.js's copy) reads from a DIFFERENT context
        // instance, the read returns null and the destructure throws
        // "Cannot destructure property 'parentMenuRef' of '<null>'" —
        // surfaced in the minified bundle as "t is null" on every kebab
        // menu open. Routing all react-aria-* into one chunk gives every
        // consumer a single SubmenuTriggerContext identity.
        manualChunks: (id) => {
          if (
            id.includes('node_modules/react-aria-components') ||
            id.includes('node_modules/react-aria/') ||
            id.includes('node_modules/react-stately/') ||
            id.includes('node_modules/@react-aria/') ||
            id.includes('node_modules/@react-stately/') ||
            id.includes('node_modules/@react-types/')
          ) {
            return 'react-aria';
          }
          return undefined;
        },
      },
    },
  },

  define: {
    'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
  },

  server: {
    port: 5179,
    strictPort: true,
  },
}));
