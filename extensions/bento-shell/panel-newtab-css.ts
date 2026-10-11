// public/panel-newtab.html is a plain page that must not link the shared Mux
// stylesheet. `cssCodeSplit: false` folds every Vite-processed stylesheet into
// that one sheet, so this page's CSS is bundled on its own and emitted beside
// the page. Shared by vite.config.ts and the archived rollback config
// (rollback/legacy-source/extensions/bento-shell/vite.config.ts), which pass
// their own build target.
//
// Font files are left as relative URLs: the page reuses the Inter file the Mux
// stylesheet already makes the build emit into assets/. Because that name is
// derived from the Mux package path, fail the build if it ever stops existing.

import { build as esbuild } from 'esbuild';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

export function panelNewtabCss(target: string): Plugin {
  return {
    name: 'bento-panel-newtab-css',
    apply: 'build',
    async generateBundle(_options, bundle) {
      const { outputFiles } = await esbuild({
        entryPoints: [resolve(__dirname, 'src/panel-newtab/panel-newtab.css')],
        outfile: 'panel-newtab.css',
        bundle: true,
        minify: true,
        target,
        write: false,
        external: ['*.ttf'],
      });
      const source = outputFiles[0]!.text;
      for (const [, file] of source.matchAll(/url\(\s*["']?\.\/([^"')\s]+)["']?\s*\)/g)) {
        if (!(`assets/${file}` in bundle)) {
          this.error(
            `panel-newtab.css references ./${file}, but the build emitted no assets/${file}. ` +
              'Update the @font-face in src/panel-newtab/panel-newtab.css to the current file name.',
          );
        }
      }
      this.emitFile({ type: 'asset', fileName: 'assets/panel-newtab.css', source });
    },
  };
}
