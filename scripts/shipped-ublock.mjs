import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The uBlock Origin XPI inside a staged or collected application. The packaging wildcard
 * (`distribution/extensions/*`) matches any file, so the release checks name the exact path and
 * compare its bytes with the SHA-256 the README records, which `pnpm run security:check` ties to
 * the committed XPI.
 */

export const UBLOCK_XPI = 'uBlock0@raymondhill.net.xpi';
const README = 'extensions/ublock-origin/README.md';

export const sha256Of = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The SHA-256 the README records for the shipped XPI. */
export function recordedUblockSha256(repoRoot) {
  const text = fs.readFileSync(path.join(repoRoot, README), 'utf8');
  const recorded = /SHA-256: `([a-f0-9]{64})`/.exec(text)?.[1];
  if (!recorded) throw new Error(`${README} records no SHA-256 for the uBlock Origin XPI`);
  return recorded;
}

/** Where an application keeps it: the bundle's Resources on macOS, the application folder elsewhere. */
export function shippedUblockPath(application) {
  const resources = path.basename(application).endsWith('.app')
    ? path.join(application, 'Contents', 'Resources')
    : application;
  return path.join(resources, 'distribution', 'extensions', UBLOCK_XPI);
}

/** What is wrong with the XPI at `file` (a missing file, or other bytes than recorded), or undefined. */
export function shippedUblockProblem(file, recordedSha256, bytes) {
  if (bytes === undefined) return `${file} is missing: the app must ship the uBlock Origin XPI at exactly this path`;
  const actual = sha256Of(bytes);
  if (actual !== recordedSha256) {
    return `${file} has SHA-256 ${actual}, but the recorded uBlock Origin XPI is ${recordedSha256}`;
  }
  return undefined;
}

/** shippedUblockProblem for the XPI inside an application folder or mounted bundle. */
export function shippedUblockProblemIn(application, recordedSha256) {
  const file = shippedUblockPath(application);
  // statSync follows a symlink: the packager copies what it points at.
  const bytes = fs.statSync(file, { throwIfNoEntry: false })?.isFile() ? fs.readFileSync(file) : undefined;
  return shippedUblockProblem(file, recordedSha256, bytes);
}
