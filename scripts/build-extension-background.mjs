import { build } from 'esbuild';

import { isReleaseBuild } from '../extensions/bento-shell/muxui-local.mjs';

const [entryPoint, outfile] = process.argv.slice(2);

if (!entryPoint || !outfile) {
  throw new Error('Usage: node scripts/build-extension-background.mjs <entry> <outfile>');
}

await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  format: 'iife',
  target: 'firefox128',
  minify: true,
  drop: process.env.BENTO_RELEASE === '1' ? ['console', 'debugger'] : ['debugger'],
  // Release bundles compile out the shell's dev-only Alt+Shift+R reload handler
  // (see scripts/dev-reload.mjs).
  define: { __BENTO_DEV_RELOAD__: String(!isReleaseBuild()) },
});
