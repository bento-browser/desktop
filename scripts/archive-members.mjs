import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Completeness check for tar extractions of the Firefox source archive.
 *
 * Git Bash's tar is Cygwin's, and Cygwin treats `X` and `X.exe` as one name, so
 * extracting `X` after `X.exe` replaces the `.exe` file. The 157.0.1 archive
 * lists testing/mozbase/mozfile/tests/files/which/baz.exe before `baz`, which
 * left the Windows tree one file short and failed the base-tree check later.
 */

/**
 * Listed members (`tar -tf` lines) with nothing at their extracted location.
 * `strip` is the `--strip-components` count, which tar applies to the name as
 * listed (a leading `.` counts); members stripped away are skipped.
 */
export function missingArchiveMembers(entries, destination, strip = 0) {
  const missing = [];
  for (const entry of entries) {
    const parts = entry.split('/').filter(Boolean);
    if (parts.length <= strip) continue;
    if (!fs.lstatSync(path.join(destination, ...parts.slice(strip)), { throwIfNoEntry: false })) {
      missing.push(entry);
    }
  }
  return missing;
}

/**
 * Checks an extraction against the archive listing and extracts any missing
 * members once more. `extractMembers(listPath)` must repeat the original tar
 * extraction with `-T listPath` added, run from the archive's directory.
 *
 * The list is a temporary file in the destination's parent: the destination is
 * writable and the archive's directory may not be, and a file inside the
 * destination would survive a killed run in the tree that becomes the base
 * commit. `listPath` is relative to the archive's directory so that Cygwin tar,
 * which misreads Windows drive-letter paths, never sees one; it is absolute
 * only when the two are on different volumes. `fail(message)` must throw.
 */
export function completeArchiveExtraction({ archive, entries, destination, strip = 0, extractMembers, fail }) {
  const missing = missingArchiveMembers(entries, destination, strip);
  if (missing.length === 0) return;

  process.stderr.write(`tar left ${missing.length} archive member(s) out, for example ${missing[0]}; extracting them again\n`);
  const listFile = path.join(path.dirname(path.resolve(destination)), `.bento-missing-members-${crypto.randomUUID()}.txt`);
  const relative = path.relative(path.dirname(path.resolve(archive)), listFile);
  try {
    fs.writeFileSync(listFile, `${missing.join('\n')}\n`);
    extractMembers(path.isAbsolute(relative) ? listFile : relative.replaceAll(path.sep, '/'));
  } finally {
    fs.rmSync(listFile, { force: true });
  }

  const stillMissing = missingArchiveMembers(entries, destination, strip);
  if (stillMissing.length > 0) {
    fail(
      `extracting ${archive} left ${stillMissing.length} member(s) missing after a second attempt: `
      + `${stillMissing.slice(0, 5).join(', ')}${stillMissing.length > 5 ? ', ...' : ''}\n`
      + "Member names that differ only by a '.exe' suffix are a known hazard of Windows tar.",
    );
  }
}
