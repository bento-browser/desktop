import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LAYER_ORDER_FILE,
  declaredProperties,
  findLayerProblems,
  findUndefinedReads,
  readLayers,
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

test('readLayers qualifies nested layers and ignores comments and strings', () => {
  const css = `
    @layer muxui, bento;
    @layer bento.tokens, bento.app;
    @import url('x.css') layer(muxui);
    @layer bento.components { .a { color: red; } }
    @layer bento { @layer inner { @media (min-width: 1px) { @layer deep { .b {} } } } .c {} }
    @layer bento { @layer a, b; }
    @media print { @layer bento.app { .d {} } }
    /* @layer bento.commented { } */
    .e { content: "@layer bento.quoted { }"; }
  `;
  const { names, ordered, unsupported } = readLayers(css);
  assert.deepEqual(names, [
    'muxui',
    'bento',
    'bento.tokens',
    'bento.app',
    'bento.components',
    'bento',
    'bento.inner',
    'bento.inner.deep',
    'bento',
    'bento.a',
    'bento.b',
    'bento.app',
  ]);
  assert.deepEqual(ordered, ['muxui', 'bento', 'bento.tokens', 'bento.app']);
  assert.deepEqual(unsupported, []);
});

test('findLayerProblems reports a bento layer missing from the order statement', () => {
  const orderCss = '@layer muxui, bento; @layer bento.tokens, bento.components, bento.app;';
  const problems = findLayerProblems({
    [LAYER_ORDER_FILE]: orderCss,
    'ok.css': '@layer bento.components { .a {} } @layer bento.app { .b {} } .c {}',
    'new.css': '@layer bento.overlay { .d {} } @layer bento.overlay { .e {} }',
    'nested.css': '@layer bento.components { @layer extra { .f {} } }',
    'other.css': '@layer muxui { .g {} } @layer unrelated { .h {} }',
  });
  assert.deepEqual(problems, {
    unsupported: [],
    undeclared: [
      `new.css: layer bento.overlay is missing from the order statement in ${LAYER_ORDER_FILE}`,
      `nested.css: layer bento.components.extra is missing from the order statement in ${LAYER_ORDER_FILE}`,
    ],
  });
});

test('findLayerProblems fails without a bento.* order statement', () => {
  const { unsupported, undeclared } = findLayerProblems({
    [LAYER_ORDER_FILE]: '@layer muxui, bento;',
    'a.css': '@layer bento.app { .a {} }',
  });
  assert.match(unsupported.join('\n'), /no top-level '@layer bento\.<name>/);
  assert.deepEqual(undeclared, []);
});

test('only a top-level @layer statement in the order file orders layers', () => {
  // Inside @media (even a condition that never applies) the statement may not take effect, and
  // `!important` makes the statement invalid. Neither lists bento.extra or counts as the order.
  const { unsupported, undeclared } = findLayerProblems({
    [LAYER_ORDER_FILE]: `
      @layer muxui, bento;
      @layer bento.app, !important;
      @media not all { @layer bento.extra; }
    `,
    'a.css': '@layer bento.extra { .a {} }',
  });
  assert.match(unsupported.join('\n'), /no top-level '@layer bento\.<name>/);
  assert.match(unsupported.join('\n'), new RegExp(`${LAYER_ORDER_FILE}: layer name '!important'`));
  assert.deepEqual(undeclared, []);

  const withOrder = findLayerProblems({
    [LAYER_ORDER_FILE]:
      '@layer muxui, bento; @layer bento.app; @media not all { @layer bento.extra; }',
    'a.css': '@layer bento.extra { .a {} }',
  });
  assert.deepEqual(withOrder.unsupported, []);
  assert.deepEqual(
    withOrder.undeclared.map((line) => line.split(':')[0]),
    [LAYER_ORDER_FILE, 'a.css'],
  );
});

test('an @import into a bento layer is rejected, other layered imports are not', () => {
  const css = `
    @import url('a.css') layer(muxui);
    @import 'b.css' layer(bento.x) supports(display: grid);
    @import url(c.css) layer( bento );
    @import url(d.css) layer(bento.y)
  `;
  assert.deepEqual(readLayers(css).unsupported, [
    '@import into layer bento.x is not read: its own layers would nest under it',
    '@import into layer bento is not read: its own layers would nest under it',
    '@import into layer bento.y is not read: its own layers would nest under it',
  ]);
});

test('an anonymous @layer block is rejected anywhere, not flattened into its parent', () => {
  const { names, unsupported } = readLayers(
    '@layer bento.app { @layer { @layer inner { .a {} } } } @layer { .b {} }',
  );
  assert.deepEqual(unsupported, ['anonymous @layer is not read: name the layer']);
  assert.deepEqual(names, ['bento.app', 'bento.app.inner']);
});

test('@layer, @import and layer() match in any case, layer names stay case-sensitive', () => {
  const { names, unsupported } = readLayers(`
    @LAYER bento.upper { .a {} }
    @Layer Bento.mixed { .b {} }
    @IMPORT url(x.css) LAYER(bento.x);
  `);
  assert.deepEqual(names, ['bento.upper', 'Bento.mixed']);
  assert.deepEqual(unsupported, [
    '@import into layer bento.x is not read: its own layers would nest under it',
  ]);
});

test('layer names with escapes or other tokens are rejected', () => {
  const css = String.raw`
    @layer \62 ento.extra { .a {} }
    @layer bento.ok, bento\.escaped;
    @import url(x.css) layer(\62 ento);
  `;
  const { names, unsupported } = readLayers(css);
  assert.deepEqual(names, []);
  assert.deepEqual(
    unsupported.map((reason) => reason.split(' is not')[0]),
    ["layer name '\\62 ento.extra'", "layer name 'bento\\.escaped'", "layer name '\\62 ento'"],
  );
});

test('an @layer rule that never ends is rejected, such as one hidden by an escaped quote', () => {
  // The escaped quote starts a string in masked text and swallows the block that follows.
  const hidden = String.raw`@layer bento.\"x { .a { content: "y" } }`;
  assert.deepEqual(readLayers(hidden).unsupported, ["@layer with no ';' or block"]);
  assert.deepEqual(readLayers('.a {} @layer bento.app').unsupported, [
    "@layer with no ';' or block",
  ]);
});

test('custom property values are not read as layers, in the order file or elsewhere', () => {
  const css = `
    .a { --x: { @layer bento.y { .b {} } } --z: 1; color: red }
    .c { --y: @layer bento.q; }
    :root { --order: @layer bento.z, bento.w; }
    @layer bento.real { .d {} }
  `;
  assert.deepEqual(readLayers(css), { names: ['bento.real'], ordered: [], unsupported: [] });
});

test('the shell stylesheets only use bento layers that muxui.css orders', () => {
  const result = spawnSync(process.execPath, [resolve(SCRIPT_DIR, 'check-undefined-tokens.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OK bento layers/);

  const orderCss = readFileSync(resolve(SCRIPT_DIR, '..', LAYER_ORDER_FILE), 'utf8');
  assert.ok(
    readLayers(orderCss).ordered.some((name) => name.startsWith('bento.')),
    `${LAYER_ORDER_FILE} lost its top-level @layer bento.* order statement`,
  );
});
