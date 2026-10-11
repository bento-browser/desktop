import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateEntry, formatBaseline, parseBaseline, toleranceFor } from './size-ratchet.mjs';

const CEILING = 200_000;

test('tolerance is max(1%, 1 KB)', () => {
  assert.equal(toleranceFor(50_000), 1_000);
  assert.equal(toleranceFor(300_000), 3_000);
});

test('growth within tolerance passes', () => {
  const small = evaluateEntry({ size: 50_900, baseline: 50_000, ceiling: CEILING });
  assert.equal(small.verdict, 'ok');
  assert.equal(small.failed, false);

  // Exactly at the tolerance is still allowed; the limit is "more than".
  const large = evaluateEntry({ size: 303_000, baseline: 300_000, ceiling: CEILING });
  assert.equal(large.failed, false);
});

test('growth beyond tolerance fails', () => {
  const small = evaluateEntry({ size: 51_001, baseline: 50_000, ceiling: CEILING });
  assert.equal(small.verdict, 'grew');
  assert.equal(small.failed, true);

  const large = evaluateEntry({ size: 303_001, baseline: 300_000, ceiling: CEILING });
  assert.equal(large.failed, true);
});

test('shrinking passes and reports a baseline refresh', () => {
  const result = evaluateEntry({ size: 280_000, baseline: 300_000, ceiling: CEILING });
  assert.equal(result.verdict, 'shrank');
  assert.equal(result.failed, false);
  assert.equal(result.delta, -20_000);
});

test('an entry missing from the baseline fails', () => {
  const result = evaluateEntry({ size: 10_000, baseline: undefined, ceiling: CEILING });
  assert.equal(result.verdict, 'missing');
  assert.equal(result.failed, true);
});

test('over the ceiling fails only when it also grew past its baseline', () => {
  const atBaseline = evaluateEntry({ size: 300_000, baseline: 300_000, ceiling: CEILING });
  assert.equal(atBaseline.overCeiling, true);
  assert.equal(atBaseline.failed, false);

  const grown = evaluateEntry({ size: 310_000, baseline: 300_000, ceiling: CEILING });
  assert.equal(grown.overCeiling, true);
  assert.equal(grown.failed, true);
});

test('growth under the ceiling still fails', () => {
  const result = evaluateEntry({ size: 120_000, baseline: 100_000, ceiling: CEILING });
  assert.equal(result.overCeiling, false);
  assert.equal(result.failed, true);
});

test('baseline format round-trips and rejects malformed sizes', () => {
  const sizes = { 'a.js': 1234, 'b.css': 5678 };
  assert.deepEqual(parseBaseline(formatBaseline(sizes)), sizes);

  assert.throws(() => parseBaseline('{}'), /gzipBytes/);
  assert.throws(() => parseBaseline('{"gzipBytes":{"a.js":0}}'), /positive integer/);
  assert.throws(() => parseBaseline('{"gzipBytes":{"a.js":"12"}}'), /positive integer/);
});
