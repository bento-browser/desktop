// The one place that decides which build mode Bento is building. The build
// driver (scripts/bento-build.mjs) uses `resolveBuildMode` for engine/mozconfig;
// the shell background build, the built-in add-on installer, the packaging guard,
// and the MUXUI_LOCAL guard use `isReleaseBuild`, so the native build and the
// extension builds always agree on release, however it was asked for.

import fs from 'node:fs';
import path from 'node:path';

export const BUILD_MODES = ['dev', 'debug', 'release'];

/**
 * The mode a build runs in. Precedence:
 *   1. an explicit `mode` argument;
 *   2. BENTO_RELEASE=1, which means release;
 *   3. BENTO_BUILD_MODE;
 *   4. `build.mode` of bento.json (`config` is the parsed file).
 * So BENTO_BUILD_MODE=dev turns a release bento.json into a dev build, but not
 * BENTO_RELEASE=1: that variable plus BENTO_BUILD_MODE=dev (or debug) is
 * contradictory and resolves to release, the mode that ships fewer dev-only
 * affordances. BENTO_BUILD_MODE is still validated when BENTO_RELEASE=1 overrides it.
 */
export function resolveBuildMode(config, mode = undefined, env = process.env) {
  const requested = mode || env.BENTO_BUILD_MODE || config.build?.mode;
  if (!BUILD_MODES.includes(requested)) throw new Error(`unsupported build mode ${requested}`);
  return !mode && env.BENTO_RELEASE === '1' ? 'release' : requested;
}

/** True when the build at `repoRoot` resolves to release (see resolveBuildMode). */
export function isReleaseBuild(repoRoot, env = process.env) {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'bento.json'), 'utf8'));
  return resolveBuildMode(config, undefined, env) === 'release';
}
