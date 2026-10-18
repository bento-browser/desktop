import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LAYER_ORDER_FILE,
  declaredProperties,
  findUndeclaredLayers,
  findUndefinedReads,
  layerUses,
  orderedBentoLayers,
  unguardedReads,
} from './check-undefined-tokens.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

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

test('layerUses reads blocks, statements, imports and nested layers, not comments or strings', () => {
  const css = `
    @layer muxui, bento;
    @layer bento.tokens, bento.app;
    @import url('x.css') layer(muxui);
    @layer bento.components { .a { color: red; } }
    @layer bento { @layer inner { @media (min-width: 1px) { @layer deep { .b {} } } } .c {} }
    @media print { @layer bento.app { .d {} } }
    /* @layer bento.commented { } */
    .e { content: "@layer bento.quoted { }"; }
  `;
  assert.deepEqual(
    layerUses(css).map((use) => `${use.kind} ${use.name}`),
    [
      'statement muxui',
      'statement bento',
      'statement bento.tokens',
      'statement bento.app',
      'import muxui',
      'block bento.components',
      'block bento',
      'block bento.inner',
      'block bento.inner.deep',
      'block bento.app',
    ],
  );
});

test('orderedBentoLayers lists only bento layers named in order statements', () => {
  const css = `
    @layer muxui, bento;
    @layer bento.tokens, bento.app;
    @layer bento.components { .a {} }
  `;
  assert.deepEqual([...orderedBentoLayers(css)], ['bento', 'bento.tokens', 'bento.app']);
  assert.deepEqual([...orderedBentoLayers('@layer bento.x { .a {} }')], []);
});

test('findUndeclaredLayers reports a bento layer missing from the order statement', () => {
  const orderCss = '@layer muxui, bento; @layer bento.tokens, bento.components, bento.app;';
  const undeclared = findUndeclaredLayers({
    scanned: {
      'ok.css': '@layer bento.components { .a {} } @layer bento.app { .b {} } .c {}',
      'new.css': '@layer bento.overlay { .d {} } @layer bento.overlay { .e {} }',
      'nested.css': '@layer bento.components { @layer extra { .f {} } }',
      'other.css': '@layer muxui { .g {} } @layer unrelated { .h {} }',
    },
    orderCss,
  });
  assert.deepEqual(undeclared, {
    'new.css': ['bento.overlay'],
    'nested.css': ['bento.components.extra'],
  });
});

test('the shell stylesheets only use bento layers that muxui.css orders', () => {
  const result = spawnSync(process.execPath, [resolve(SCRIPT_DIR, 'check-undefined-tokens.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OK bento layers/);

  const orderCss = readFileSync(resolve(SCRIPT_DIR, '..', LAYER_ORDER_FILE), 'utf8');
  assert.ok(
    [...orderedBentoLayers(orderCss)].some((name) => name.startsWith('bento.')),
    `${LAYER_ORDER_FILE} lost its @layer bento.* order statement`,
  );
});
