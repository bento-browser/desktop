import { build } from 'esbuild';

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
});
