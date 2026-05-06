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
      // Multi-entry: shell is the chrome-mounted sidebar; privacy + settings
      // are standalone moz-extension://<uuid>/dist/<name>.html pages; palette
      // is a chrome-mounted overlay <browser> covering the whole window.
      input: {
        shell: resolve(__dirname, 'index.html'),
        privacy: resolve(__dirname, 'privacy.html'),
        settings: resolve(__dirname, 'settings.html'),
        palette: resolve(__dirname, 'palette.html'),
        confirm: resolve(__dirname, 'confirm.html'),
        'edit-workspace': resolve(__dirname, 'edit-workspace.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
        format: 'es',
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
