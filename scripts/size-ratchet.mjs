// Size ratchet: compare a measured gzip size against its committed baseline.
// Pure functions only, so scripts/size-ratchet.test.mjs can cover them without a build.

const KB = 1000;
const TOLERANCE_FRACTION = 0.01;
const TOLERANCE_FLOOR_BYTES = KB;

/** The build mode the baseline is measured against; CI builds with the same variable. */
export const BASELINE_BUILD = 'BENTO_RELEASE=1 pnpm run ext:build';

/** Growth (or shrinkage) smaller than this is noise: max(1% of baseline, 1 KB). */
export function toleranceFor(baseline) {
  return Math.max(baseline * TOLERANCE_FRACTION, TOLERANCE_FLOOR_BYTES);
}

/**
 * Classify one entry. Growth beyond tolerance ('grew') and an absent baseline ('missing')
 * fail the ratchet. Being over the ceiling alone never fails; it is reported as a target.
 * Shrinking beyond tolerance ('shrank') passes with a hint to refresh the baseline.
 *
 * @param {{ size: number; baseline: number | undefined; ceiling: number }} entry
 */
export function evaluateEntry({ size, baseline, ceiling }) {
  const overCeiling = size > ceiling;
  if (baseline === undefined) {
    return { verdict: 'missing', failed: true, overCeiling, delta: 0, tolerance: 0 };
  }

  const tolerance = toleranceFor(baseline);
  const delta = size - baseline;
  const verdict = delta > tolerance ? 'grew' : -delta > tolerance ? 'shrank' : 'ok';
  return { verdict, failed: verdict === 'grew', overCeiling, delta, tolerance };
}

/** Validate baseline JSON text and return its `{ key: gzipBytes }` map. */
export function parseBaseline(text) {
  const parsed = JSON.parse(text);
  const sizes = parsed?.gzipBytes;
  if (typeof sizes !== 'object' || sizes === null || Array.isArray(sizes)) {
    throw new Error('Size baseline must contain a "gzipBytes" object');
  }
  for (const [key, bytes] of Object.entries(sizes)) {
    if (!Number.isInteger(bytes) || bytes <= 0) {
      throw new Error(`Size baseline entry ${key} must be a positive integer, got ${bytes}`);
    }
  }
  return sizes;
}

/** Serialize measured sizes in the committed baseline format. */
export function formatBaseline(gzipBytes) {
  return `${JSON.stringify({ build: BASELINE_BUILD, gzipBytes }, null, 2)}\n`;
}
