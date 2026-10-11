// The shell add-on's dev-only reload command (Alt+Shift+R, see
// extensions/bento-shell/src/background.ts) must not ship in release builds.
// Two build steps remove it and this module backs both plus the release checks:
//   - scripts/build-extension-background.mjs compiles the handler out of the
//     background bundle.
//   - scripts/install-builtin-addons.mjs drops the command from the manifest it
//     copies into the engine.
// `check-release-security.mjs --built-shell` then fails if either left it behind
// in the staged sources, and the build driver's `package` command fails if the
// files it is about to package (the object directory's) still have it. Which
// builds are release builds is decided by scripts/build-mode.mjs.

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

/** Every file under `target` (or `target` itself), following symlinks to the real files. */
function* files(target, seen = new Set()) {
  // realpath also rejects a dangling link: a link that resolves to nothing is not a file we can clear.
  const real = fs.realpathSync(target);
  if (!fs.statSync(real).isDirectory()) {
    yield target;
    return;
  }
  if (seen.has(real)) return;
  seen.add(real);
  for (const entry of fs.readdirSync(real)) yield* files(path.join(target, entry), seen);
}

/** Files under the given files or directories that still mention the dev-only reload command. */
export function findDevReload(roots) {
  return roots.flatMap((root) =>
    [...files(root)].filter((file) => fs.readFileSync(file).includes(DEV_RELOAD_COMMAND)),
  );
}

const SHELL_ADDON_PATH = ['chrome', 'browser', 'builtin-addons', 'bento-shell'];

/**
 * The shell built-in add-on directories an object directory's `dist` hands to
 * `mach package`: loose files under `bin/browser` (every platform) and inside the
 * macOS app bundle. Only the ones that exist; they can be the same files.
 */
export function packagedShellDirs(objDist, macBundleName) {
  return [
    path.join(objDist, 'bin', 'browser', ...SHELL_ADDON_PATH),
    path.join(objDist, macBundleName, 'Contents', 'Resources', 'browser', ...SHELL_ADDON_PATH),
  ].filter((dir) => fs.existsSync(dir));
}

/**
 * Throws when the shell that `mach package` would ship from `objDist` still has the
 * dev-only reload command. A release build over an object directory left by an earlier
 * dev build can keep that build's files (copies instead of symlinks, or output that was
 * not rebuilt), which the staged sources checked by `--built-shell` do not show.
 */
export function assertNoDevReloadInPackage(objDist, macBundleName) {
  const dirs = packagedShellDirs(objDist, macBundleName);
  if (dirs.length === 0) {
    throw new Error(
      `cannot check the packaged shell for the dev-only reload command: no bento-shell built-in add-on under ${objDist}; run pnpm run build first`,
    );
  }
  const hits = findDevReload(dirs);
  if (hits.length > 0) {
    throw new Error(
      `Release package would ship the dev-only reload command: ${hits.map((file) => path.relative(objDist, file)).join(', ')}. Rebuild the release shell (pnpm run ext:build && pnpm run import) and the native build before packaging.`,
    );
  }
}
