import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test, { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { splitTopLevelBlocks } from '../extensions/bento-shell/css-blocks.mjs';

import {
  exitOnMuxSourceError,
  extractPublicBlock,
  loadMuxPublicCss,
  loadMuxThemePresets,
  MuxSourceError,
  parseDeclarations,
  PUBLIC_CLOSURE_SELECTOR,
  readPublicBlocks,
  readReferenceShades,
  splitCanonicalThemeRules,
  validateThemePresets,
} from './mux-css.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shellRequire = createRequire(resolve(REPO_ROOT, 'extensions/bento-shell/package.json'));

const shapeError = (pattern) => (error) =>
  error instanceof MuxSourceError && pattern.test(error.message);

// A minimal styles.css with every block and token readPublicBlocks requires.
function stylesFixture({ rootExtra = '', drop = [] } = {}) {
  const root = [
    '--muxui-reference-color-brand-60: #025768;',
    '--muxui-reference-color-brand-20: #aaccdd;',
    '--muxui-reference-color-neutral-20: #e5e1dd;',
    '--muxui-reference-color-neutral-cool-20: #dde3e2;',
    '--muxui-reference-effect-shadow-s: 0 1px 2px black;',
    '--muxui-semantic-effect-scrim: black;',
    rootExtra,
  ]
    .filter((line) => !drop.includes(line.split(':')[0]))
    .join('\n  ');
  return `
/* header { not a block } */
${PUBLIC_CLOSURE_SELECTOR} {
  --muxui-popup-bg: var(--muxui-semantic-surface-raised);
}
:root {
  ${root}
}
[data-muxui-color-scheme='light'] { --muxui-semantic-color-neutral-5: #fff; }
[data-muxui-color-scheme='dark'] { --muxui-semantic-color-neutral-5: #000; }
[data-muxui-contrast='standard'] { --muxui-x: 1; }
[data-muxui-contrast='more'] { --muxui-x: 2; }
`;
}

test('extractPublicBlock matches the whole selector list, not a substring', () => {
  // The closure rule starts with ':root,' and comes first; ':root' must not land on it.
  const css = stylesFixture();
  assert.match(extractPublicBlock(css, ':root'), /^--muxui-reference-color-brand-60:/);
  assert.equal(
    extractPublicBlock(css, PUBLIC_CLOSURE_SELECTOR),
    '--muxui-popup-bg: var(--muxui-semantic-surface-raised);',
  );
});

test('extractPublicBlock ignores braces in comments and strings', () => {
  const css = `a { content: "}"; /* } */ --x: 1; }`;
  assert.equal(extractPublicBlock(css, 'a'), 'content: "}"; /* } */ --x: 1;');
});

test('extractPublicBlock fails loudly on a changed shape', () => {
  assert.throws(
    () => extractPublicBlock('a { --x: 1; }', ':root'),
    shapeError(/missing the public block :root/),
  );
  assert.throws(
    () => extractPublicBlock(':root { --x: 1; } :root { --y: 2; }', ':root'),
    shapeError(/2 blocks for :root/),
  );
  assert.throws(
    () => extractPublicBlock(':root { .nested { --x: 1; } }', ':root'),
    shapeError(/changed the flat declaration shape/),
  );
  assert.throws(
    () => extractPublicBlock(':root { }', ':root'),
    shapeError(/flat declaration shape/),
  );
  assert.throws(
    () => extractPublicBlock(':root { --x: 1;', ':root'),
    shapeError(/could not be read/),
  );
  // A rule moved inside an at-rule is no longer a top-level public block.
  assert.throws(
    () => extractPublicBlock('@layer muxui { :root { --x: 1; } }', ':root'),
    shapeError(/missing the public block/),
  );
});

const publicLayers = (tokens, extra = '') =>
  `@layer muxui.tokens, muxui.components, muxui.utilities;\n@layer muxui.tokens {${tokens}}\n${extra}`;

function stylesLayers(css = stylesFixture(), componentExtra = '') {
  const rules = splitTopLevelBlocks(css);
  const closure = rules.shift();
  return publicLayers(
    rules.map(({ prelude, body }) => `${prelude} {${body}}`).join('\n'),
    `@layer muxui.components {${closure.prelude} {${closure.body}} ${componentExtra}}`,
  );
}

test('readPublicBlocks reads only the public token layer, excluding component root overrides', () => {
  const css = stylesLayers(stylesFixture(), ':root { --component-only: red; }');
  assert.match(readPublicBlocks(css).root, /brand-60/);
  assert.doesNotMatch(readPublicBlocks(css).root, /component-only/);
  assert.throws(
    () => readPublicBlocks(css.replace('muxui.tokens {', 'other.tokens {')),
    shapeError(/layer/),
  );
  assert.throws(
    () => readPublicBlocks(css + '@layer muxui.tokens { :root { --x: 1; } }'),
    shapeError(/layer/),
  );
});

test('readPublicBlocks returns the root, mode and closure blocks and names a missing token', () => {
  const blocks = readPublicBlocks(stylesLayers());
  assert.deepEqual(
    blocks.modes.map(({ selector }) => selector),
    [
      "[data-muxui-color-scheme='light']",
      "[data-muxui-color-scheme='dark']",
      "[data-muxui-contrast='standard']",
    ],
  );
  assert.match(blocks.root, /brand-60/);
  assert.match(blocks.closure, /popup-bg/);

  assert.throws(
    () =>
      readPublicBlocks(stylesLayers(stylesFixture({ drop: ['--muxui-semantic-effect-scrim'] }))),
    shapeError(/root block is missing --muxui-semantic-effect-scrim/),
  );
  assert.throws(
    () =>
      readPublicBlocks(stylesLayers(stylesFixture().replace('--muxui-popup-bg', '--muxui-other'))),
    shapeError(/compatibility closure is missing --muxui-popup-bg/),
  );
});

test('parseDeclarations reads custom properties in order and trims values', () => {
  const declarations = parseDeclarations('  --a: 1;\n  color: red;\n  --b-2:  var(--a) ;');
  assert.deepEqual(
    [...declarations],
    [
      ['--a', '1'],
      ['--b-2', 'var(--a)'],
    ],
  );
});

test('readReferenceShades sorts both ladders and rejects an empty one', () => {
  assert.deepEqual(
    readReferenceShades(
      '--muxui-reference-color-brand-60: x;\n--muxui-reference-color-brand-5: x;\n--muxui-reference-color-neutral-20: x;',
    ),
    { brand: [5, 60], neutral: [20] },
  );
  assert.throws(
    () => readReferenceShades('--muxui-reference-color-brand-60: x;'),
    shapeError(/ladders are empty/),
  );
});

function themeRules(id, { light = true, dark = true, extra = '' } = {}) {
  const theme = `[data-muxui-theme='${id}']`;
  return [
    light &&
      `${theme}:not([data-muxui-color-scheme='dark']):not([data-muxui-contrast='more']) { --a: 1; }`,
    light &&
      `${theme}:not([data-muxui-color-scheme='dark'])[data-muxui-contrast='more'] { --a: 2; }`,
    dark &&
      `${theme}[data-muxui-color-scheme='dark']:not([data-muxui-contrast='more']) { --a: 3; }`,
    dark && `${theme}[data-muxui-color-scheme='dark'][data-muxui-contrast='more'] { --a: 4; }`,
    extra,
  ]
    .filter(Boolean)
    .join('\n');
}

const splitThemeFixture = (css, ids) => splitCanonicalThemeRules(publicLayers(css), ids);

test('splitCanonicalThemeRules groups rules per theme and drops contrast more', () => {
  const rules = splitThemeFixture(`${themeRules('one')}\n${themeRules('two')}`, ['one', 'two']);
  assert.deepEqual([...rules.keys()], ['one', 'two']);
  assert.equal(rules.get('one').length, 2);
  assert.match(rules.get('one')[0], /--a: 1/);
  assert.match(rules.get('one')[1], /--a: 3/);
});

test('splitCanonicalThemeRules fails loudly on an unknown shape', () => {
  assert.throws(
    () => splitThemeFixture(`${themeRules('one')}\n${themeRules('ghost')}`, ['one']),
    shapeError(/outside the canonical themes/),
  );
  assert.throws(
    () => splitThemeFixture(themeRules('one'), ['one', 'two']),
    shapeError(/no rules for theme two/),
  );
  assert.throws(
    () => splitThemeFixture(themeRules('one', { dark: false }), ['one']),
    shapeError(/no dark color scheme rule for theme one/),
  );
  assert.throws(
    () => splitThemeFixture(themeRules('one', { light: false }), ['one']),
    shapeError(/no light color scheme rule for theme one/),
  );
  assert.throws(
    () => splitThemeFixture(themeRules('one', { extra: '@media (x) { a { --a: 1; } }' }), ['one']),
    shapeError(/unexpected at-rule/),
  );
  assert.throws(
    () =>
      splitThemeFixture(themeRules('one', { extra: "[data-muxui-theme='one'] { --a: 1; }" }), [
        'one',
      ]),
    shapeError(/unknown color scheme/),
  );
});

test('theme layers reject component rules, unknown layers and changed public layer order', () => {
  const css = publicLayers(themeRules('one'));
  assert.equal(splitCanonicalThemeRules(css, ['one']).get('one').length, 2);
  for (const extra of [
    '@layer muxui.components { a { color: red; } }',
    '@layer surprise { a { color: red; } }',
    '@layer muxui.tokens { a { color: red; } }',
  ]) {
    assert.throws(() => splitCanonicalThemeRules(css + extra, ['one']), shapeError(/layer/));
  }
  assert.throws(
    () =>
      splitCanonicalThemeRules(
        css.replace('muxui.tokens, muxui.components', 'muxui.components, muxui.tokens'),
        ['one'],
      ),
    shapeError(/layer order/),
  );
});

const preset = (id, collection = 'standard', presetId = id) => ({
  id,
  presetId,
  collection,
  name: id,
  description: `${id} theme`,
  swatch: { primary: '#000000', secondary: '#ffffff' },
});

test('validateThemePresets accepts any non-empty count', () => {
  for (const count of [1, 3, 40]) {
    const presets = Array.from({ length: count }, (_, index) => preset(`standard-t${index}`));
    assert.equal(validateThemePresets(presets, 'standard-t0').length, count);
  }
});

test('validateThemePresets rejects an unusable list', () => {
  assert.throws(() => validateThemePresets(undefined), shapeError(/non-empty/));
  assert.throws(() => validateThemePresets([]), shapeError(/non-empty/));
  assert.throws(
    () => validateThemePresets([{ ...preset('a'), swatch: undefined }]),
    shapeError(/invalid canonical preset record/),
  );
  assert.throws(
    () => validateThemePresets([preset('a', 'vivid')]),
    shapeError(/invalid canonical preset record/),
  );
  assert.throws(() => validateThemePresets([preset('Bad_Id')]), shapeError(/kebab-case/));
  assert.throws(
    () => validateThemePresets([preset('a'), preset('a')]),
    shapeError(/repeats theme id a/),
  );
  assert.throws(
    () => validateThemePresets([preset('a', 'monochrome', 'x'), preset('b', 'monochrome', 'x')]),
    shapeError(/repeats monochrome preset id x/),
  );
  assert.throws(() => validateThemePresets([preset('a')], 'b'), shapeError(/default theme b/));
});

test('validateThemePresets allows the same preset id across collections', () => {
  const presets = [
    preset('standard-terracotta', 'standard', 'terracotta'),
    preset('monochrome-terracotta', 'monochrome', 'terracotta'),
  ];
  assert.equal(validateThemePresets(presets).length, 2);
});

test('exitOnMuxSourceError prints shape errors, exits, and rethrows anything else', async () => {
  const exit = mock.method(process, 'exit', () => {});
  const log = mock.method(console, 'error', () => {});
  try {
    exitOnMuxSourceError('gen', () => {
      throw new MuxSourceError('shape changed');
    });
    await exitOnMuxSourceError('gen', async () => {
      throw new MuxSourceError('async shape changed');
    });
    assert.deepEqual(
      log.mock.calls.map((call) => call.arguments[0]),
      ['gen: shape changed', 'gen: async shape changed'],
    );
    assert.deepEqual(
      exit.mock.calls.map((call) => call.arguments[0]),
      [1, 1],
    );
    assert.equal(
      exitOnMuxSourceError('gen', () => 'ok'),
      'ok',
    );
    assert.throws(
      () =>
        exitOnMuxSourceError('gen', () => {
          throw new TypeError('bug');
        }),
      TypeError,
    );
  } finally {
    exit.mock.restore();
    log.mock.restore();
  }
});

// The installed @muxui/react is the real input of both generators.
test('the installed @muxui/react satisfies every shape check', async () => {
  const css = loadMuxPublicCss(shellRequire);
  assert.equal(css.stylesDigest.length, 64);
  assert.ok(readReferenceShades(css.blocks.root).brand.length > 0);

  const presets = await loadMuxThemePresets(shellRequire);
  const rules = splitCanonicalThemeRules(
    css.themesCss,
    presets.map((theme) => theme.id),
  );
  // Whatever count the package ships, every preset has rules and every rule belongs to one.
  assert.equal(rules.size, presets.length);
  for (const [id, themeRulesOfId] of rules) {
    assert.ok(themeRulesOfId.length >= 2, `${id} has light and dark rules`);
  }
});
