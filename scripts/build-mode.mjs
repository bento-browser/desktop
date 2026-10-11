// The one place that decides which build mode Bento is building. The build
// driver (scripts/bento-build.mjs) writes it into engine/mozconfig; the shell
// background build, the built-in add-on installer, and the packaging guard use
// `isReleaseBuild` so a release is a release in every step, however it was asked for.

import fs from 'node:fs';
import path from 'node:path';

export const BUILD_MODES = ['dev', 'debug', 'release'];

/**
 * The mode the build driver builds: an explicit `mode`, else BENTO_BUILD_MODE, else
 * `build.mode` of bento.json. `config` is the parsed bento.json.
 */
export function resolveBuildMode(config, mode = undefined, env = process.env) {
  const selected = mode || env.BENTO_BUILD_MODE || config.build?.mode;
  if (!BUILD_MODES.includes(selected)) throw new Error(`unsupported build mode ${selected}`);
  return selected;
}

/**
 * True when the build at `repoRoot` is a release build: the driver's mode (see
 * resolveBuildMode, so `build.mode: "release"` in bento.json counts) is release, or
 * BENTO_RELEASE=1, which extension builds and CI set without BENTO_BUILD_MODE.
 * Either signal is enough; neither can downgrade the other.
 */
export function isReleaseBuild(repoRoot, env = process.env) {
  const configPath = path.join(repoRoot, 'bento.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return resolveBuildMode(config, undefined, env) === 'release' || env.BENTO_RELEASE === '1';
}
