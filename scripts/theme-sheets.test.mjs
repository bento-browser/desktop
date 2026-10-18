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

function generate(extraArgs = [], env = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'bento-chrome-tokens-'));
  const output = join(directory, 'bento-chrome-tokens.css');
  execFileSync(process.execPath, [GENERATOR, '--output', output, ...extraArgs], {
    env: { ...process.env, BENTO_RELEASE_VARIANT: '', ...env },
    stdio: 'pipe',
  });
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

// Chrome's rem is the system UI font (11px on macOS) but the shell's is --font-size-root,
// and chrome sizes the shell's host from the collapsed rail token. The base sheet must pin
// that token in px, equal to the rem sum the shell computes.
test('chrome pins the collapsed rail width at the shell root font size', () => {
  const { directory, base } = generate();
  try {
    const rootPx = Number.parseFloat(base.match(/--font-size-root:\s*([\d.]+)px/)[1]);
    const rem = (name) => Number.parseFloat(base.match(new RegExp(`${name}:\\s*([\\d.]+)rem`))[1]);
    const pinned = base.match(/\n:root \{\s*--bento-tab-strip-width-collapsed: ([^;]+);\s*\}/)[1];
    assert.doesNotMatch(pinned, /rem|var\(/);
    const pinnedPx = [...pinned.matchAll(/([\d.]+)px/g)].reduce(
      (sum, [, px]) => sum + Number(px),
      0,
    );
    // The control is one tab row tall and the rail pads both sides by --space-2xs.
    const shellRems =
      rem('--bento-tab-row-height') + 2 * rem('--muxui-reference-dimension-space-2xs');
    assert.ok(Math.abs(pinnedPx - shellRems * rootPx) < 1e-6, `${pinned} vs ${shellRems}rem`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the archived rollback sheet keeps the rem form of the rail width', () => {
  const { directory, base } = generate(['--monolithic']);
  try {
    assert.doesNotMatch(base, /Shell-sized geometry/);
    assert.match(
      base,
      /--bento-tab-strip-width-collapsed: calc\(\s*var\(--bento-sidebar-collapsed-control-size\)/,
    );
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

test('monolithic builds fold every theme into the base sheet (archived rollback mount)', () => {
  for (const [args, env] of [
    [['--monolithic'], {}],
    [[], { BENTO_RELEASE_VARIANT: 'rollback-final-r2' }],
  ]) {
    const { directory, base } = generate(args, env);
    try {
      for (const id of shellThemeIds) {
        assert.ok(base.includes(`data-bento-theme='${id}'`), `monolithic base must carry ${id}`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
