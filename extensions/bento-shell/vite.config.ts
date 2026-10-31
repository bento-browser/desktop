// Bento Browser shell — Vite config
//
// Outputs to dist/ with stable (non-hash) asset names because the chrome
// XHTML <browser src="chrome://bento-shell/content/index.html"> will load
// these by URL — hashes would break the chrome.manifest registration.
//
// The pinned npm @muxui/react release is consumed from its public
// output. The aliases below keep every entrypoint on Bento's pinned React Aria
// substrate so providers and consumers share one module identity, and
// moduleIdentityGuard fails the build if that identity ever splits. With
// MUXUI_LOCAL set (local Mux development only), muxui-local.mjs swaps the npm
// package for a local Mux checkout and the build stamps dist/muxui-source.json.

import { defineConfig, mergeConfig, searchForWorkspaceRoot, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { copyFile, mkdir } from 'node:fs/promises';
import { stripContrastMore } from './contrast-more.mjs';
import { moduleIdentityGuard } from './module-identity-guard';
import { pruneMuxCss } from './mux-css-prune';
import { muxLocalViteConfig, muxSourcePlugin, resolveMuxLocal } from './muxui-local.mjs';
import { panelNewtabCss } from './panel-newtab-css';
import { woff2Fonts } from './woff2-fonts';

const muxLocal = resolveMuxLocal();

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

function copyChromeBridgeExperiment(): Plugin {
  return {
    name: 'bento-copy-chrome-bridge-experiment',
    async closeBundle() {
      const sourceRoot = resolve(__dirname, 'src/experiments/chrome-bridge');
      const outputRoot = resolve(__dirname, 'experiments/chrome-bridge');
      await mkdir(outputRoot, { recursive: true });
      await Promise.all(
        ['api.js', 'schema.json'].map((file) =>
          copyFile(resolve(sourceRoot, file), resolve(outputRoot, file)),
        ),
      );
    },
  };
}

// Matches gecko.strict_min_version in manifest.json.
const BUILD_TARGET = 'firefox150';

const shellConfig = defineConfig(({ mode }) => ({
  plugins: [
    react({ jsxRuntime: 'automatic' }),
    stripCrossOrigin(),
    copyChromeBridgeExperiment(),
    woff2Fonts(),
    pruneMuxCss(),
    panelNewtabCss(BUILD_TARGET),
    moduleIdentityGuard(),
    muxSourcePlugin(muxLocal, resolve(__dirname, '../../node_modules/@muxui/react/package.json')),
  ],

  ...(process.env.BENTO_RELEASE === '1'
    ? { esbuild: { drop: ['console', 'debugger'] as const } }
    : {}),

  resolve: {
    alias: [
      { find: '@shared', replacement: resolve(__dirname, '../_shared') },
      { find: '@bento', replacement: resolve(__dirname, 'src') },
      // Force `react-aria-components` (and the helper umbrellas) to
      // resolve from bento-browser's node_modules, never a package's nested
      // dependency paths. If one entrypoint bundled a second copy of
      // react-aria-components while ChromeMenu's Mux `Menu.Submenu` consumer
      // resolved to Bento's copy, the two copies' module-level
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
      // moduleIdentityGuard fails the build if a second copy still slips in.
      {
        find: 'react-aria-components',
        replacement: resolve(__dirname, '../../node_modules/react-aria-components'),
      },
      { find: 'react-aria', replacement: resolve(__dirname, '../../node_modules/react-aria') },
      {
        find: 'react-stately',
        replacement: resolve(__dirname, '../../node_modules/react-stately'),
      },
      {
        find: '@react-types/shared',
        replacement: resolve(__dirname, '../../node_modules/@react-types/shared'),
      },
    ],
  },

  // Relative-path emission (./) so the bundle works when index.html is loaded
  // at moz-extension://<uuid>/dist/index.html. Without this, Vite emits
  // /assets/shell.js which resolves to moz-extension://<uuid>/assets/shell.js
  // (missing the dist/ prefix the extension uses).
  base: './',

  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: BUILD_TARGET,
    // Firefox loads modulepreload natively, so skip Vite's polyfill chunk.
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    sourcemap: mode !== 'production',
    rollupOptions: {
      // background.ts is built separately by esbuild as IIFE — see
      // package.json `build:background` script. Vite emits ES modules
      // (correct for the index.html entry that loads via type=module)
      // but MV2 background.scripts requires classic-script format.
      // Multi-entry: shell is the chrome-mounted sidebar; palette, confirm,
      // and edit-workspace are chrome-mounted overlay <browser> elements
      // covering the whole window.
      input: {
        shell: resolve(__dirname, 'index.html'),
        palette: resolve(__dirname, 'palette.html'),
        'workspace-palette': resolve(__dirname, 'workspace-palette.html'),
        'merge-palette': resolve(__dirname, 'merge-palette.html'),
        'settings-palette': resolve(__dirname, 'settings-palette.html'),
        'address-bar': resolve(__dirname, 'address-bar.html'),
        confirm: resolve(__dirname, 'confirm.html'),
        'edit-workspace': resolve(__dirname, 'edit-workspace.html'),
        'workspace-switcher': resolve(__dirname, 'workspace-switcher.html'),
        welcome: resolve(__dirname, 'welcome.html'),
        menu: resolve(__dirname, 'menu.html'),
        'panel-trailer': resolve(__dirname, 'panel-trailer.html'),
        'panel-navigator-tooltip': resolve(__dirname, 'panel-navigator-tooltip.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
        format: 'es',
      },
    },
  },

  // Contrast is fixed to 'standard', so drop the unreachable contrast='more'
  // rules (Mux base blocks and its theme presets) from the shipped sheet.
  css: { postcss: { plugins: [stripContrastMore] } },

  define: {
    'process.env.NODE_ENV': JSON.stringify(mode === 'production' ? 'production' : 'development'),
  },

  server: {
    port: 5179,
    strictPort: true,
  },
}));

// Local Mux mode adds its aliases (including @internationalized from Bento's
// install), React dedupe, and fs.allow on top of the base config; with
// MUXUI_LOCAL unset the fragment is empty.
export default defineConfig((env) =>
  mergeConfig(shellConfig(env), muxLocalViteConfig(muxLocal, searchForWorkspaceRoot(__dirname))),
);
