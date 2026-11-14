import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { defaultThemeSourceErrors, extractToken } from './default-theme.mjs';
import {
  loadMuxPublicCss,
  loadMuxThemePresets,
  readReferenceShades,
  splitCanonicalThemeRules,
  themeSchemeDeclarations,
} from './mux-css.mjs';

// The same inputs scripts/sync-theme-presets.mjs passes: the installed Mux package's Harbour
// rules and reference shades, and the tracked default.css.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shellRequire = createRequire(resolve(REPO_ROOT, 'extensions/bento-shell/package.json'));
const mux = loadMuxPublicCss(shellRequire);
const presets = await loadMuxThemePresets(shellRequire);
const harbour = themeSchemeDeclarations(
  splitCanonicalThemeRules(
    mux.themesCss,
    presets.map((theme) => theme.id),
  ).get('standard-harbour'),
);
const shades = readReferenceShades(mux.blocks.root);
const source = readFileSync(
  resolve(REPO_ROOT, 'extensions/bento-shell/src/theme/presets/default.css'),
  'utf8',
);
const errors = (css) => defaultThemeSourceErrors(css, harbour, shades);
const brand60 = harbour.light.get('--muxui-reference-color-brand-60');

test('the tracked default.css is valid', () => {
  assert.deepEqual(errors(source), []);
});

test('rejects every bypass of the Harbour ladders and text colours', () => {
  const bypasses = [
    // A ladder shade overridden in dark mode only.
    [`@media (prefers-color-scheme: dark) { :root { --brand-60: #ff0000; } }`, /at-rule/],
    [`:root[data-color-mode='dark'] { --brand-60: #ff0000; }`, /--brand-60 #ff0000 \(Harbour/],
    // A Mux text colour in dark mode, plain and with the html[...] selectors that outrank the
    // generated rules.
    [
      `[data-muxui-color-scheme='dark'] { --muxui-semantic-color-color-60-fg: #000000; }`,
      /--muxui-semantic-color-color-60-fg sets a text colour/,
    ],
    [
      `html[data-bento-theme='default'][data-color-mode='dark'] { --muxui-semantic-color-color-60-fg: #000000; }`,
      /html\[data-bento-theme='default'\]\[data-color-mode='dark'\]: --muxui-semantic-color-color-60-fg sets a text colour/,
    ],
    [
      `html[data-bento-theme='default']:not([data-color-mode='dark']) { --brand-60: #ff0000; }`,
      /html\[.*--brand-60 #ff0000/,
    ],
    // Legacy text colour names the token bridge maps to the same roles.
    [
      `html[data-bento-theme='default'] { --color-50-fg: var(--color-5); }`,
      /--color-50-fg sets a text colour/,
    ],
    [`:root { --neutral-60-fg: #000000; }`, /--neutral-60-fg sets a text colour/],
    [`:root { --neutral-default-60-fg: #000000; }`, /--neutral-default-60-fg sets a text colour/],
    // Any other role, alias or property, which is not a ladder token.
    [
      `:root { --muxui-semantic-action-foreground: #000000; }`,
      /not one of Harbour's ladder tokens/,
    ],
    [`:root { --text-color: #000000; }`, /--text-color is not one of Harbour's ladder tokens/],
    [`html { color: #000000; }`, /color is not one of Harbour's ladder tokens/],
  ];
  for (const [extra, expected] of bypasses) {
    const found = errors(`${source}\n${extra}\n`);
    assert.ok(
      found.some((message) => expected.test(message)),
      `${extra}\n  -> ${found.join('\n  -> ') || 'accepted'}`,
    );
  }
});

test('rejects a ladder shade that differs from Harbour or is missing', () => {
  assert.notEqual(brand60, undefined);
  const changed = source.replace(/--brand-60:\s*#[0-9a-f]+/i, '--brand-60: #ff0000');
  assert.ok(errors(changed).some((message) => /--brand-60 #ff0000/.test(message)));
  const missing = source.replace(/^\s*--brand-60:[^\n]*\n/m, '');
  assert.ok(errors(missing).some((message) => /--brand-60 is missing/.test(message)));
});

test('the sync reads no token value from a comment', () => {
  const css =
    '/* Old --brand-60: #ff0000; */\n:root { --brand-60: #025768; --neutral-default-90: #e6e2df; }\n/* --neutral-default-90: #000000; */';
  assert.equal(extractToken(css, '--brand-60'), '#025768');
  assert.equal(extractToken(css, '--neutral-default-90'), '#e6e2df');
});
