import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findClosingBrace,
  splitTopLevelBlocks,
  themeIdsInSelector,
  unwrapTopLevelLayers,
} from '../extensions/bento-shell/css-blocks.mjs';
import { MUX_THEMES_CSS, parseDeclarations } from './mux-css.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = resolve(REPO_ROOT, 'scripts/generate-chrome-tokens.mjs');
const SHELL_SHEETS = resolve(REPO_ROOT, 'extensions/bento-shell/public/themes');

test('findClosingBrace skips braces in comments and strings', () => {
  const css = `a { content: "}"; /* } */ b: c; } d {}`;
  assert.equal(findClosingBrace(css, css.indexOf('{')), css.indexOf('} d'));
});

test('splitTopLevelBlocks returns preludes without comments and skips block-less statements', () => {
  const blocks = splitTopLevelBlocks(`
    /* header */
    @layer muxui, bento;
    [data-x='1'] /* note */ { --a: 1; }
    @media (x) { .y { --b: 2; } }
  `);
  assert.deepEqual(
    blocks.map(({ prelude }) => prelude),
    ["@layer muxui, bento;\n    [data-x='1']", '@media (x)'],
  );
});

test('top-level scanning skips braces in comments between blocks', () => {
  const css = `/* license { text */ .a { --x: 1; } /* } */ @layer m { .b { --y: 2; } }`;
  assert.deepEqual(
    splitTopLevelBlocks(css).map(({ prelude }) => prelude),
    ['.a', '@layer m'],
  );
  assert.equal(
    unwrapTopLevelLayers(css).replace(/\s+/g, ' ').trim(),
    '/* license { text */ .a { --x: 1; } .b { --y: 2; }',
  );
});

test('unwrapTopLevelLayers removes layer wrappers and keeps other blocks', () => {
  const squash = (css) => css.replace(/\s+/g, ' ').trim();
  assert.equal(
    squash(
      unwrapTopLevelLayers('/* c */ @layer muxui { .a { --x: 1; } .b { --y: 2; } } .c { --z: 3; }'),
    ),
    '.a { --x: 1; } .b { --y: 2; } .c { --z: 3; }',
  );
  assert.equal(
    unwrapTopLevelLayers('@media (x) { .a { --x: 1; } }'),
    '@media (x) { .a { --x: 1; } }',
  );
});

test('themeIdsInSelector reads quoted and bare theme attribute tests', () => {
  assert.deepEqual(
    themeIdsInSelector(
      `[data-muxui-theme='standard-harbour']:not([data-muxui-color-scheme='dark']), [data-bento-theme="x"], [data-bento-theme=y]`,
    ),
    ['standard-harbour', 'x', 'y'],
  );
  assert.deepEqual(themeIdsInSelector(':root'), []);
});

function generate() {
  const directory = mkdtempSync(join(tmpdir(), 'bento-chrome-tokens-'));
  const output = join(directory, 'bento-chrome-tokens.css');
  execFileSync(process.execPath, [GENERATOR, '--output', output], { stdio: 'pipe' });
  return {
    directory,
    base: readFileSync(output, 'utf8'),
    themesDir: join(directory, 'bento-chrome-themes'),
  };
}

const shellThemeIds = readdirSync(SHELL_SHEETS)
  .filter((name) => name.endsWith('.css'))
  .map((name) => name.slice(0, -'.css'.length));

test('chrome base sheet carries the shared tokens and the Default theme only', () => {
  const { directory, base } = generate();
  try {
    assert.match(base, /--shadow-l:/);
    assert.match(base, /--font-size-root:/);
    assert.match(base, /\[data-bento-theme='default'\]/);
    for (const id of shellThemeIds) {
      assert.ok(!base.includes(`data-bento-theme='${id}'`), `base sheet must not carry ${id}`);
    }
    // bento-tokens.css brings its own `bento.tokens` layer; no Mux layer or import.
    assert.doesNotMatch(base, /data-muxui-|@import|@layer muxui/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Chrome's rem is the system UI font (11px on macOS) but the shell's is --font-size-root.
// Chrome sizes #bento-shell-host (collapsed rail) and #bento-add-panel-trailer from these
// tokens while the shell lays itself out inside them, and sets the panel header URL text and
// the panel navigator menu at Mux's text-s, so each must be the same length in
// both documents: the shell reads the rem form at its root size, chrome reads the pinned px.
const CHROME_ROOT_PX = 11;
const SHELL_LAID_OUT_TOKENS = [
  '--bento-tab-strip-width-collapsed',
  '--bento-panel-trailer-button-size',
  '--bento-panel-trailer-grid-gap',
  '--bento-panel-trailer-inline-padding',
  '--bento-panel-trailer-grid-width',
  '--bento-panel-trailer-wide-width',
  '--bento-panel-trailer-base-width',
  '--bento-panel-url-font-size',
  '--bento-panel-nav-menu-font-size',
];

// Evaluates a token the way a document with this root font size would: var() followed,
// rem at `rootPx`, calc() and max() reduced to a number. `pinned` overrides declarations.
function createLengthEvaluator(css, rootPx, pinned = new Map()) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const evaluate = (name) => {
    const declared =
      pinned.get(name) ?? bare.match(new RegExp(`(?<![\\w-])${name}:\\s*([^;{}]+);`))?.[1];
    assert.ok(declared, `${name} is declared`);
    const expression = declared
      .replace(/var\(\s*(--[\w-]+)\s*\)/g, (_match, ref) => `(${evaluate(ref)})`)
      .replace(/(\d*\.?\d+)rem\b/g, (_match, rem) => rem * rootPx)
      .replace(/(\d*\.?\d+)px\b/g, '$1')
      .replace(/calc\(/g, '(')
      .replace(/max\(/g, 'Math.max(');
    assert.match(
      expression,
      /^[\d.\s()+*/,-]*(Math\.max[\d.\s()+*/,-]*)*$/,
      `${name}: ${declared}`,
    );
    return Function(`return (${expression});`)();
  };
  return evaluate;
}

test('chrome reads shell-sized lengths at the shell root font size', () => {
  const { directory, base } = generate();
  try {
    const marker = base.indexOf('Shell-sized lengths');
    assert.ok(marker > 0, 'the base sheet carries the pinned block');
    const pinned = new Map(
      Array.from(base.slice(marker).matchAll(/^\s+(--[\w-]+): ([^;]+);/gm), (m) => [m[1], m[2]]),
    );
    for (const [name, value] of pinned) assert.doesNotMatch(value, /rem|var\(/, name);
    const rootPx = Number.parseFloat(base.match(/--font-size-root:\s*([\d.]+)px/)[1]);
    const shell = createLengthEvaluator(base, rootPx);
    const chrome = createLengthEvaluator(base, CHROME_ROOT_PX, pinned);
    for (const name of SHELL_LAID_OUT_TOKENS) {
      assert.ok(
        Math.abs(chrome(name) - shell(name)) < 1e-6,
        `${name}: chrome ${chrome(name)}px, shell ${shell(name)}px`,
      );
    }
    // Unpinned, chrome's rem makes the trailer's select width shorter, so this fails if the
    // comparison above goes vacuous.
    const unpinned = createLengthEvaluator(base, CHROME_ROOT_PX);
    assert.ok(
      unpinned('--bento-panel-trailer-wide-width') < shell('--bento-panel-trailer-wide-width'),
    );
    // Mux's text-s is 0.83125rem: 13.3px in the shell, so the URL text is 13.3px in chrome too.
    assert.ok(Math.abs(chrome('--bento-panel-url-font-size') - 13.3) < 1e-6);
    assert.ok(unpinned('--bento-panel-url-font-size') < 13.3);
    // Mux's text-s is 0.83125rem: 13.3px in the shell, 9.1px from chrome's own rem.
    assert.ok(Math.abs(chrome('--bento-panel-nav-menu-font-size') - 13.3) < 1e-6);
    assert.ok(unpinned('--bento-panel-nav-menu-font-size') < 13.3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('chrome theme sheets are native, unlayered, and scoped to one theme each', () => {
  const { directory, themesDir } = generate();
  try {
    const files = readdirSync(themesDir).sort();
    assert.deepEqual(files, shellThemeIds.map((id) => `${id}.css`).sort());
    assert.ok(files.length >= 15);
    for (const id of shellThemeIds) {
      const sheet = readFileSync(join(themesDir, `${id}.css`), 'utf8');
      assert.match(
        sheet,
        /^\/\* This Source Code Form is subject to the terms of the Mozilla Public/,
      );
      assert.doesNotMatch(sheet, /data-muxui-|@layer|@import|html\[/);
      const ids = new Set(themeIdsInSelector(sheet.replace(/\/\*[\s\S]*?\*\//g, '')));
      assert.deepEqual([...ids], [id]);
      assert.match(sheet, /--muxui-/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('regenerating prunes sheets for removed themes', () => {
  const { directory, themesDir } = generate();
  try {
    writeFileSync(join(themesDir, 'removed-theme.css'), '/* stale */');
    writeFileSync(join(themesDir, 'notes.txt'), 'kept');
    execFileSync(
      process.execPath,
      [GENERATOR, '--output', join(directory, 'bento-chrome-tokens.css')],
      {
        stdio: 'pipe',
      },
    );
    const files = readdirSync(themesDir);
    assert.ok(!files.includes('removed-theme.css'));
    assert.ok(files.includes('notes.txt'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('--themes-dir overrides the sibling directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'bento-chrome-tokens-'));
  try {
    const themesDir = join(directory, 'elsewhere');
    mkdirSync(directory, { recursive: true });
    execFileSync(
      process.execPath,
      [GENERATOR, '--output', join(directory, 'tokens.css'), '--themes-dir', themesDir],
      { stdio: 'pipe' },
    );
    assert.ok(readdirSync(themesDir).includes('standard-harbour.css'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Bento projects Mux's APCA preset stylesheet. These pairs are where it chooses a different text
// colour from the WCAG 2 themes.css, so each must reach the shell sheet and the chrome sheet as
// Mux wrote it.
const muxRequire = createRequire(resolve(REPO_ROOT, 'extensions/bento-shell/package.json'));
const readMux = (name) => readFileSync(muxRequire.resolve(name), 'utf8');
const APCA_SAMPLES = [
  ['standard-harbour', 'light', '--muxui-semantic-color-color-40-fg'],
  ['standard-harbour', 'dark', '--muxui-semantic-action-foreground'],
  ['standard-lagoon', 'dark', '--muxui-semantic-color-color-60-fg'],
  ['standard-violet-dusk', 'light', '--muxui-semantic-color-neutral-50-fg'],
  ['monochrome-teal', 'dark', '--muxui-semantic-color-color-50-fg'],
];
const CHROME_ATTRIBUTES = {
  theme: 'data-bento-theme',
  scheme: 'data-color-mode',
  contrast: 'data-bento-contrast',
};
const MUX_ATTRIBUTES = {
  theme: 'data-muxui-theme',
  scheme: 'data-muxui-color-scheme',
  contrast: 'data-muxui-contrast',
};

// The selector Mux writes for one theme's contrast 'standard' rule in one color scheme.
function standardSelector(id, scheme, { theme, scheme: mode, contrast } = MUX_ATTRIBUTES) {
  const dark = `[${mode}='dark']`;
  return `[${theme}='${id}']${scheme === 'dark' ? dark : `:not(${dark})`}:not([${contrast}='more'])`;
}

const squashSelector = (selector) =>
  selector.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();

// Top-level rules of a sheet with its layer statement and wrappers removed, selectors
// whitespace-normalised.
const sheetRules = (css) =>
  splitTopLevelBlocks(unwrapTopLevelLayers(css.replace(/@layer[^{};]*;/g, ''))).map(
    ({ prelude, body }) => ({
      selector: squashSelector(prelude),
      declarations: parseDeclarations(body),
    }),
  );

function declaredValue(css, selector, token) {
  const rules = sheetRules(css).filter((rule) => rule.selector === selector);
  assert.equal(rules.length, 1, `one rule for ${selector}`);
  const value = rules[0].declarations.get(token);
  assert.ok(value, `${selector} declares ${token}`);
  return value.replace(/\s+/g, ' ');
}

// A selector that matches only under contrast 'more': a positive test outside :not().
const requiresContrastMore = (selector) =>
  /contrast='more'\]/.test(selector.replace(/:not\([^()]*\)/g, ''));

test('the APCA preset stylesheet is the source the generated headers name', () => {
  assert.equal(MUX_THEMES_CSS, '@muxui/react/themes-apca.css');
  const digest = createHash('sha256').update(readMux(MUX_THEMES_CSS)).digest('hex');
  const presetsIndex = readFileSync(
    resolve(REPO_ROOT, 'extensions/bento-shell/src/theme/presets/index.css'),
    'utf8',
  );
  assert.ok(presetsIndex.includes(`${MUX_THEMES_CSS} sha256:${digest}`), 'presets index header');
  const { directory, base } = generate();
  try {
    assert.ok(base.includes(`${MUX_THEMES_CSS} sha256:${digest}`), 'chrome base header');
    for (const sheet of [presetsIndex, base]) {
      assert.doesNotMatch(sheet, /@muxui\/react\/themes\.css/);
    }
    for (const [id] of APCA_SAMPLES) {
      const shell = readFileSync(join(SHELL_SHEETS, `${id}.css`), 'utf8');
      assert.ok(shell.includes(`Source: public ${MUX_THEMES_CSS}, contrast standard.`), id);
      assert.doesNotMatch(shell, /@muxui\/react\/themes\.css/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('APCA text colours survive shell splitting and chrome conversion', () => {
  const apca = readMux(MUX_THEMES_CSS);
  const wcag = readMux('@muxui/react/themes.css');
  const { directory, themesDir } = generate();
  try {
    for (const [id, scheme, token] of APCA_SAMPLES) {
      const label = `${id} ${scheme} ${token}`;
      const muxSelector = standardSelector(id, scheme);
      const expected = declaredValue(apca, muxSelector, token);
      // Fails if the two Mux files agree here, which would make this sample prove nothing.
      assert.notEqual(declaredValue(wcag, muxSelector, token), expected, `${label} differs`);
      const shell = readFileSync(join(SHELL_SHEETS, `${id}.css`), 'utf8');
      assert.equal(declaredValue(shell, muxSelector, token), expected, `shell ${label}`);
      const chrome = readFileSync(join(themesDir, `${id}.css`), 'utf8');
      const chromeSelector = standardSelector(id, scheme, CHROME_ATTRIBUTES);
      assert.equal(declaredValue(chrome, chromeSelector, token), expected, `chrome ${label}`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('contrast more rules stay absent from shell and chrome theme sheets', () => {
  // Mux ships them, so an absent rule below is Bento's projection, not the input.
  assert.ok(
    sheetRules(readMux(MUX_THEMES_CSS)).some((rule) => requiresContrastMore(rule.selector)),
  );
  const { directory, themesDir } = generate();
  try {
    for (const id of shellThemeIds) {
      for (const sheet of [join(SHELL_SHEETS, `${id}.css`), join(themesDir, `${id}.css`)]) {
        const rules = sheetRules(readFileSync(sheet, 'utf8'));
        assert.ok(rules.length > 0, sheet);
        for (const { selector } of rules) {
          assert.ok(!requiresContrastMore(selector), `${sheet}: ${selector}`);
        }
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
