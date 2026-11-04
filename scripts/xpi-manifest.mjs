import { execFileSync } from 'node:child_process';
import path from 'node:path';

// A manifest is a few KB. The cap stops a crafted archive from inflating without bound.
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * Parses `manifest.json` inside an XPI without unpacking it, so the committed file stays byte
 * for byte what addons.mozilla.org signed. `unzip -p` does the reading: it verifies the entry's
 * CRC and exits non-zero on a damaged, truncated or unsupported archive or a missing entry, so
 * this fails closed. Needs `unzip` on PATH (macOS ships it; GitHub's ubuntu runners include it).
 */
export function readXpiManifest(file) {
  let output;
  try {
    output = execFileSync('unzip', ['-p', path.resolve(file), 'manifest.json'], {
      maxBuffer: MAX_MANIFEST_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('reading an XPI needs unzip, which is not on PATH');
    throw new Error(`cannot read manifest.json from ${file}: ${String(error.stderr || error.message).trim()}`);
  }
  return JSON.parse(output.toString('utf8'));
}
