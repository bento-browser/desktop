import assert from 'node:assert/strict';
import test from 'node:test';

import {
  declaredProperties,
  findUndefinedReads,
  unguardedReads,
} from './check-undefined-tokens.mjs';

test('declaredProperties finds declarations, not reads, text or comments', () => {
  const css = `
    :root { --a: 1px; --b-c : red; }
    .x { color: var(--read); content: "--text: x"; background: url("a;--url: 1.png"); }
    .y { .z { --nested: 1 } --after-nested: 2 }
    /* --commented: 1 */
  `;
  assert.deepEqual([...declaredProperties(css)].sort(), [
    '--a',
    '--after-nested',
    '--b-c',
    '--nested',
  ]);
});

test('declaredProperties counts @property only with an initial-value', () => {
  const css = `
    @property --typed { syntax: '<length>'; inherits: true; initial-value: 0px; }
    @property --bare { syntax: '<length>'; inherits: true; }
    @property --any { syntax: '*'; inherits: false; }
  `;
  assert.deepEqual([...declaredProperties(css)], ['--typed']);
});

test('unguardedReads skips fallbacks, comments, strings and url()', () => {
  const css = `
    .a { color: var(--x); background: var( --x ) var(--y, red); }
    .b { gap: calc(var(--z) + var(--w, 1px)); content: "var(--quoted)"; }
    .c { background: url("a)b.png") var(--after-url); }
    /* var(--commented) */
  `;
  assert.deepEqual(unguardedReads(css), ['--x', '--z', '--after-url']);
});

test('unguardedReads consumes escapes inside an unquoted url()', () => {
  // The escaped ")" and quote belong to the URL. Stopping at the escaped ")" would start a
  // string at the escaped quote and swallow the read below it.
  const css = String.raw`.a { background: url(foo\)\"bar.svg); } .b { color: var(--after-escape); content: "x"; }`;
  assert.deepEqual(unguardedReads(css), ['--after-escape']);
});

test('unguardedReads masks url() only as a whole function name', () => {
  const css = `
    .a { width: my-url(var(--hyphenated)); }
    .b { width: myurl(var(--joined)); }
    .c { background: URL(a.png) var(--after-upper); }
    .d { background: url( a.png ) var(--after-spaced); }
  `;
  assert.deepEqual(unguardedReads(css), [
    '--hyphenated',
    '--joined',
    '--after-upper',
    '--after-spaced',
  ]);
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

  // Text that looks like a declaration does not declare, and text that looks like a read is not one.
  assert.deepEqual(
    findUndefinedReads({
      scanned: { 'a.css': '.a { color: var(--missing); content: "var(--quoted)"; }' },
      declaredIn: ['.b { content: "--missing: example"; }'],
    }),
    { 'a.css': ['--missing'] },
  );
});
