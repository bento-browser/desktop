import fs from 'node:fs';
import path from 'node:path';

/**
 * Distribution add-ons: an `extensions/<name>/` folder with no manifest.json that holds one
 * signed `<id>.xpi`. The build ships the file unchanged in the app's `distribution/extensions/`
 * folder, where Firefox installs it into the profile at startup, so unlike a built-in add-on the
 * user can remove it. Firefox requires the file name to be the add-on id plus `.xpi`.
 */

/** A regular file's bytes, or undefined when there is none at `file`. A symlink is followed. */
export function readFileIfPresent(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return undefined;
    throw error;
  }
}

// Ids are `name@domain` or `{GUID}`. The name goes into generated moz.build text, so keep it plain.
const XPI_NAME = /^[A-Za-z0-9._@{}-]+\.xpi$/;

/** The XPI file name in an extension folder, or undefined when it is not a distribution add-on. */
export function distributionAddonXpi(extensionDir) {
  if (fs.existsSync(path.join(extensionDir, 'manifest.json'))) return undefined;
  const xpis = fs.readdirSync(extensionDir).filter((file) => file.endsWith('.xpi'));
  if (xpis.length === 0) return undefined;
  if (xpis.length > 1 || !XPI_NAME.test(xpis[0])) {
    throw new Error(
      `${extensionDir} must hold one XPI named after its add-on id, found: ${xpis.join(', ')}`,
    );
  }
  return xpis[0];
}

/**
 * The moz.build of the engine folder that carries the XPI. `DIST_SUBDIR = ""` (as in
 * browser/app/distribution/moz.build) puts it in the app's own `distribution/`, which is
 * where Firefox looks (XRE_APP_DISTRIBUTION_DIR), not in the `browser/` subfolder.
 */
export function distributionAddonMozBuild(name, xpi) {
  return `# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Bento distribution add-on: ${name} (${xpi})
DIST_SUBDIR = ""

FINAL_TARGET_FILES.distribution.extensions += ["${xpi}"]
`;
}
