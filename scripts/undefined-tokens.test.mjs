import assert from 'node:assert/strict';
import test from 'node:test';

import {
  declaredProperties,
  findUndefinedReads,
  unguardedReads,
} from './check-undefined-tokens.mjs';

test('declaredProperties finds declarations and @property, not reads or comments', () => {
  const css = `
    :root { --a: 1px; --b-c : red }
    @property --registered { syntax: '<length>'; inherits: true; initial-value: 0px; }
    .x { color: var(--read); } /* --commented: 1 */
  `;
  assert.deepEqual([...declaredProperties(css)].sort(), ['--a', '--b-c', '--registered']);
});

test('unguardedReads skips fallbacks and comments and lists each name once', () => {
  const css = `
    .a { color: var(--x); background: var( --x ) var(--y, red); }
    .b { gap: calc(var(--z) + var(--w, 1px)); }
    /* var(--commented) */
  `;
  assert.deepEqual(unguardedReads(css), ['--x', '--z']);
});

test('findUndefinedReads reports only reads that no stylesheet declares', () => {
  const missing = findUndefinedReads({
    scanned: {
      'a.css': '.a { color: var(--known); border-radius: var(--radius-2xs); }',
      'b.css': '.b { color: var(--known); gap: var(--gap, 4px); }',
    },
    declaredIn: [':root { --known: red; }', '.c { --other: 1; }'],
  });
  assert.deepEqual(missing, { 'a.css': ['--radius-2xs'] });
});
