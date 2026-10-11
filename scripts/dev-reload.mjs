// The shell add-on's dev-only reload command (Alt+Shift+R, see
// extensions/bento-shell/src/background.ts) must not ship in release builds.
// Two build steps remove it and this module backs both plus the release check:
//   - scripts/build-extension-background.mjs compiles the handler out of the
//     background bundle.
//   - scripts/install-builtin-addons.mjs drops the command from the manifest it
//     copies into the engine.
// `check-release-security.mjs --built-shell` then fails if either left it behind.

import fs from 'node:fs';
import path from 'node:path';

export const DEV_RELOAD_COMMAND = 'dev-reload';

/**
 * Returns the manifest without the dev-only reload command (and without an empty
 * `commands` block). Returns the same object when there is nothing to remove.
 */
export function releaseManifest(manifest) {
  if (!manifest.commands || !(DEV_RELOAD_COMMAND in manifest.commands)) return manifest;
  const stripped = structuredClone(manifest);
  delete stripped.commands[DEV_RELOAD_COMMAND];
  if (Object.keys(stripped.commands).length === 0) delete stripped.commands;
  return stripped;
}

function* files(target) {
  if (!fs.statSync(target).isDirectory()) {
    yield target;
    return;
  }
  for (const entry of fs.readdirSync(target)) yield* files(path.join(target, entry));
}

/** Files under the given files or directories that still mention the dev-only reload command. */
export function findDevReload(roots) {
  return roots.flatMap((root) =>
    [...files(root)].filter((file) => fs.readFileSync(file).includes(DEV_RELOAD_COMMAND)),
  );
}
