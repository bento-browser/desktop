import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateEntry,
  formatBaseline,
  parseBaseline,
  refreshBaseline,
  toleranceFor,
} from './size-ratchet.mjs';

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

test('an entry without a ceiling is only ratcheted', () => {
  const steady = evaluateEntry({ size: 500_000, baseline: 500_000 });
  assert.equal(steady.overCeiling, false);
  assert.equal(steady.failed, false);

  const grown = evaluateEntry({ size: 506_000, baseline: 500_000 });
  assert.equal(grown.overCeiling, false);
  assert.equal(grown.verdict, 'grew');
  assert.equal(grown.failed, true);

  assert.equal(evaluateEntry({ size: 1_000, baseline: undefined }).failed, true);
});

test('baseline format round-trips and rejects malformed sizes', () => {
  const sizes = { 'a.js': 1234, 'b.css': 5678 };
  assert.deepEqual(parseBaseline(formatBaseline(sizes)), sizes);

  assert.throws(() => parseBaseline('{}'), /gzipBytes/);
  assert.throws(() => parseBaseline('{"gzipBytes":{"a.js":0}}'), /positive integer/);
  assert.throws(() => parseBaseline('{"gzipBytes":{"a.js":"12"}}'), /positive integer/);
});

test('refresh lowers shrunk entries and adds new ones', () => {
  const result = refreshBaseline({
    previous: { 'a.js': 1000, 'b.js': 2000 },
    measured: { 'a.js': 900, 'b.js': 2000, 'c.js': 300 },
  });
  assert.deepEqual(result.next, { 'a.js': 900, 'b.js': 2000, 'c.js': 300 });
  assert.deepEqual(result.lowered, ['a.js']);
  assert.deepEqual(result.added, ['c.js']);
  assert.deepEqual(result.refused, []);
});

test('refresh refuses to raise an existing entry and keeps its baseline', () => {
  const result = refreshBaseline({
    previous: { 'a.js': 1000, 'b.js': 2000 },
    measured: { 'a.js': 1500, 'b.js': 1800 },
  });
  assert.deepEqual(result.next, { 'a.js': 1000, 'b.js': 1800 });
  assert.deepEqual(result.refused, ['a.js']);
  assert.deepEqual(result.raised, []);
});

test('refresh refuses even tiny growth unless the entry is named', () => {
  const result = refreshBaseline({ previous: { 'a.js': 1000 }, measured: { 'a.js': 1001 } });
  assert.equal(result.next['a.js'], 1000);
  assert.deepEqual(result.refused, ['a.js']);
});

test('refresh raises only the entries named in acceptGrowth', () => {
  const result = refreshBaseline({
    previous: { 'a.js': 1000, 'b.js': 2000 },
    measured: { 'a.js': 1500, 'b.js': 2500 },
    acceptGrowth: ['a.js'],
  });
  assert.deepEqual(result.next, { 'a.js': 1500, 'b.js': 2000 });
  assert.deepEqual(result.raised, ['a.js']);
  assert.deepEqual(result.refused, ['b.js']);
});

test('refresh drops entries that are no longer measured', () => {
  const result = refreshBaseline({
    previous: { 'a.js': 1000, 'gone.js': 500 },
    measured: { 'a.js': 1000 },
  });
  assert.deepEqual(result.next, { 'a.js': 1000 });
  assert.deepEqual(result.removed, ['gone.js']);
});

test('refresh rejects acceptGrowth for an unmeasured entry', () => {
  assert.throws(
    () =>
      refreshBaseline({
        previous: { 'a.js': 1000 },
        measured: { 'a.js': 1000 },
        acceptGrowth: ['typo.js'],
      }),
    /typo\.js/,
  );
});
