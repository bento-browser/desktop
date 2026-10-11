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
