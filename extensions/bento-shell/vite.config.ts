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

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => ({
  plugins: [react({ jsxRuntime: 'automatic' })],

  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../_shared'),
      '@bento': resolve(__dirname, 'src'),
    },
  },

  optimizeDeps: {
    exclude: ['@tale-ui/react', '@tale-ui/react-styles', '@tale-ui/utils'],
  },

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'firefox128',
    cssCodeSplit: false,
    sourcemap: mode !== 'production',
    rollupOptions: {
      input: {
        shell: resolve(__dirname, 'index.html'),
        background: resolve(__dirname, 'src/background.ts'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
        format: 'es',
        // Background runs in a privileged WebExtension context, not as an
        // ES module — emit it as IIFE-flavored ESM that doesn't import
        // anything else (no top-level await, no dynamic imports).
        inlineDynamicImports: false,
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
