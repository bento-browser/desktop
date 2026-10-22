import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
