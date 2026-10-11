// bento-shell-mount.css is loaded with windowUtils.loadSheetUsingURIString, which makes it an
// "additional author sheet": Gecko sorts those after every document sheet, so the sheet follows
// the per-theme link (bento-chrome-themes/<id>.css) that the mount script appends later. Before,
// as an inline <style>, it preceded that link. These tests keep the move free of effect: the
// two sheets must not set the same property, and neither may change the cascade layer order.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = join(REPO_ROOT, 'src/browser/base/content');
const GENERATOR = join(REPO_ROOT, 'scripts/generate-chrome-tokens.mjs');
const MOUNT_SHEET_URI = 'chrome://browser/content/bento-shell-mount.css';

/**
 * Declarations and cascade layers of a stylesheet, read as text. It understands comments, quoted
 * strings, parentheses (a `;` inside `url(...)` does not end a declaration), and nested blocks,
 * which is all the Bento chrome sheets use.
 */
function scan(cssText) {
  const css = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const declarations = [];
  const layers = []; // full layer names in order of appearance (statements and blocks)
  const open = []; // preludes of the blocks around the current position
  const layerPath = () =>
    open
      .filter((prelude) => /^@layer\b/.test(prelude))
      .map((prelude) => prelude.replace(/^@layer\s*/, '').trim());
  let buffer = '';
  let parens = 0;
  let quote = null;

  const flush = () => {
    const text = buffer.trim();
    buffer = '';
    if (!text) return;
    if (open.length === 0) {
      const statement = /^@layer\s+(.+)$/.exec(text);
      if (statement) layers.push(...statement[1].split(',').map((name) => name.trim()));
      return;
    }
    const colon = text.indexOf(':');
    const property = colon < 0 ? '' : text.slice(0, colon).trim();
    if (/^(--)?[a-zA-Z_-][\w-]*$/.test(property)) {
      declarations.push({ property, important: /!\s*important\s*$/i.test(text) });
    }
  };

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index];
    if (quote) {
      buffer += character;
      if (character === '\\') buffer += css[(index += 1)] ?? '';
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(') parens += 1;
    else if (character === ')') parens -= 1;
    if (quote || parens > 0 || (character !== '{' && character !== ';' && character !== '}')) {
      buffer += character;
      continue;
    }
    if (character === '{') {
      open.push(buffer.trim().replace(/\s+/g, ' '));
      buffer = '';
      if (/^@layer\b/.test(open.at(-1))) layers.push(layerPath().join('.'));
    } else {
      flush();
      if (character === '}') open.pop();
    }
  }
  flush();
  return { declarations, layers };
}

/** Layer names in cascade order: first appearance across `sheets`, parents before children. */
function layerOrder(sheets) {
  const order = [];
  for (const { layers } of sheets) {
    for (const name of layers) {
      const parts = name.split('.');
      for (let length = 1; length <= parts.length; length += 1) {
        const path = parts.slice(0, length).join('.');
        if (path && !order.includes(path)) order.push(path);
      }
    }
  }
  return order;
}

const read = (file) => readFileSync(file, 'utf8');

// The generated sheets are gitignored, so build them the way the theme-sheets test does.
const generated = mkdtempSync(join(tmpdir(), 'bento-mount-order-'));
execFileSync(process.execPath, [GENERATOR, '--output', join(generated, 'bento-chrome-tokens.css')], {
  env: { ...process.env, BENTO_RELEASE_VARIANT: '' },
  stdio: 'pipe',
});
const themesDirectory = join(generated, 'bento-chrome-themes');

const tokens = scan(read(join(generated, 'bento-chrome-tokens.css')));
const chromeTheme = scan(read(join(CONTENT, 'bento-chrome-theme.css')));
const mount = scan(read(join(CONTENT, 'bento-shell-mount.css')));
const themeSheets = readdirSync(themesDirectory)
  .filter((name) => name.endsWith('.css'))
  .sort()
  .map((name) => ({ name, ...scan(read(join(themesDirectory, name))) }));

test('the order test sees the generated theme sheets and the mount rules', () => {
  assert.ok(themeSheets.length >= 15, `found ${themeSheets.length} theme sheets`);
  assert.ok(mount.declarations.length > 1000, 'mount sheet declarations were not read');
});

test('per-theme sheets set only custom properties the mount sheet never sets', () => {
  const mountProperties = new Set(mount.declarations.map(({ property }) => property));
  for (const { name, declarations } of themeSheets) {
    const nonCustom = declarations.filter(({ property }) => !property.startsWith('--'));
    assert.deepEqual(
      nonCustom.map(({ property }) => property),
      [],
      `${name} sets properties other than custom properties, so a shorthand or longhand overlap with the mount sheet is possible`,
    );
    const shared = [
      ...new Set(declarations.map(({ property }) => property).filter((p) => mountProperties.has(p))),
    ];
    assert.deepEqual(
      shared,
      [],
      `${name} and bento-shell-mount.css both set ${shared.join(', ')}; the mount sheet now loads after the theme sheets, so the theme value used to win`,
    );
  }
});

test('moving the mount sheet after the theme sheets keeps the cascade layer order', () => {
  const before = layerOrder([tokens, chromeTheme, mount, ...themeSheets]);
  const after = layerOrder([tokens, chromeTheme, ...themeSheets, mount]);
  assert.deepEqual(after, before);
  assert.ok(before.includes('bento.chrome-theme'), 'expected the bento.chrome-theme layer');
});

test('the mount script loads the sheet as an author sheet, not as a link', () => {
  const source = read(join(CONTENT, 'bento-shell-mount.js'));
  const call = new RegExp(
    `loadSheetUsingURIString\\(\\s*'${MOUNT_SHEET_URI.replace(/[.]/g, '\\.')}',\\s*window\\.windowUtils\\.AUTHOR_SHEET`,
  );
  assert.match(source, call);
  assert.equal(
    source.includes(`href = '${MOUNT_SHEET_URI}'`),
    false,
    'a link to the mount sheet would change its place in the cascade; update this test and the order analysis together',
  );
});
