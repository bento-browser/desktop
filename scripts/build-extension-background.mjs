import path from 'node:path';

import { build } from 'esbuild';

import { isReleaseBuild } from './build-mode.mjs';

const repoRoot = path.resolve(process.env.BENTO_REPO_ROOT || path.join(import.meta.dirname, '..'));
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
  // (see scripts/dev-reload.mjs). Release is decided as the build driver does
  // (scripts/build-mode.mjs), so bento.json's build.mode counts.
  define: { __BENTO_DEV_RELOAD__: String(!isReleaseBuild(repoRoot)) },
});
