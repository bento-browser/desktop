import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { isReleaseBuild } from '../../../../scripts/build-mode.mjs';
import { SOFTCAST_LABELS, SOFTCAST_STATES, type SoftcastState } from './softcast';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

export function softcastDemoEnabled(env = process.env, root = repoRoot): boolean {
  if (env.BENTO_SOFTCAST_DEMO !== '1') return false;
  if (isReleaseBuild(root, env)) {
    throw new Error(
      'BENTO_SOFTCAST_DEMO=1 is forbidden in a release build. Use BENTO_BUILD_MODE=dev.',
    );
  }
  return true;
}

function fixturePage(state: SoftcastState): string {
  const label = SOFTCAST_LABELS[state];
  const simulatedError = ['unavailable', 'certificate-warning', 'blocked', 'crashed'].includes(
    state,
  );
  const detail = simulatedError
    ? 'Simulated appearance only. This page does not indicate an actual detected browser failure.'
    : 'This fixture previews the sidebar icon. It does not change the real tab state.';
  const motionLinks =
    state === 'loading'
      ? '<p>The loading preview starts still. <a href="loading.html?motion=spin">Animate the sidebar icon</a> or <a href="loading.html">keep it still</a>. Reduced motion keeps it still.</p>'
      : '';
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Softcast demo: ${label}</title>
<body><main><h1>Softcast demo: ${label}</h1><p>${detail}</p>${motionLinks}
<p>Use the sidebar to compare all eight icons at the normal tab size.</p>
<nav aria-label="Softcast fixtures"><ul>${SOFTCAST_STATES.map(
    (item) => `<li><a href="${item}.html">${SOFTCAST_LABELS[item]}</a></li>`,
  ).join('')}</ul></nav></main></body></html>`;
}

/** The masters live outside public/, so an ordinary build cannot copy them. */
export function softcastDemoPlugin(): Plugin {
  return {
    name: 'bento-softcast-demo',
    apply: 'build',
    async generateBundle() {
      for (const state of SOFTCAST_STATES) {
        const source = await readFile(resolve(__dirname, 'assets', `${state}.svg`));
        this.emitFile({ type: 'asset', fileName: `dev/softcast/${state}.svg`, source });
        this.emitFile({
          type: 'asset',
          fileName: `dev/softcast/${state}.html`,
          source: fixturePage(state),
        });
      }
    },
  };
}
