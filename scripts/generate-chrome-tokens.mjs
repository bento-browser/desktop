#!/usr/bin/env node
/* global Buffer, console, process */
/**
 * Generate the native chrome token stylesheets from the public Mux CSS surface.
 *
 * Chrome and the bento-shell extension have separate document trees, so the
 * native stylesheet receives the public Mux token blocks plus Bento's
 * generated legacy-token bridge. `--output` is intentionally supported for
 * isolated packaging and proof runs; the default remains the source-tree path
 * used by the import workflow.
 *
 * Two outputs, so a window loads only the theme it shows:
 *   - bento-chrome-tokens.css: shared tokens plus the Default theme. Several
 *     native documents link it statically.
 *   - bento-chrome-themes/<id>.css: one sheet per other theme, derived from the
 *     shell's theme sheets (extensions/bento-shell/public/themes). The mount
 *     script attaches the active one. jar.mn registers the directory by wildcard.
 *
 * `--monolithic` (also on for the rollback-final-r2 variant) folds every theme
 * into the base sheet instead. The archived rollback mount script links only
 * the base sheet, so it needs them there.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unwrapTopLevelLayers } from '../extensions/bento-shell/css-blocks.mjs';
import { exitOnMuxSourceError, loadMuxPublicCss, PUBLIC_CLOSURE_SELECTOR } from './mux-css.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHELL_DIR = resolve(REPO_ROOT, 'extensions/bento-shell');
const DEFAULT_OUT_PATH = resolve(REPO_ROOT, 'src/browser/base/content/bento-chrome-tokens.css');
const THEME_SHEETS_DIR = resolve(SHELL_DIR, 'public/themes');
const THEMES_DIR_NAME = 'bento-chrome-themes';
const MUX_REQUIRE = createRequire(resolve(SHELL_DIR, 'package.json'));

// The rollback-final-r2 build swaps in the archived mount script, which loads only
// the base sheet (see scripts/build-rollback-variant.mjs and scripts/rollback-variants.mjs).
const MONOLITHIC_VARIANT = 'rollback-final-r2';

function usageError(message) {
  console.error(`generate-chrome-tokens: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let outputPath = DEFAULT_OUT_PATH;
  let themesDir;
  let monolithic = process.env.BENTO_RELEASE_VARIANT === MONOLITHIC_VARIANT;
  const pathValue = (flag, value) => {
    if (!value || value.startsWith('--')) usageError(`${flag} needs a path`);
    return resolve(process.cwd(), value);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      console.log(
        'Usage: node scripts/generate-chrome-tokens.mjs [--output <isolated-path>] ' +
          '[--themes-dir <path>] [--monolithic]',
      );
      process.exit(0);
    }
    if (argument === '--monolithic') {
      monolithic = true;
    } else if (argument === '--output' || argument === '--themes-dir') {
      const value = pathValue(argument, argv[index + 1]);
      if (argument === '--output') outputPath = value;
      else themesDir = value;
      index += 1;
    } else if (argument.startsWith('--output=')) {
      outputPath = pathValue('--output', argument.slice('--output='.length));
    } else if (argument.startsWith('--themes-dir=')) {
      themesDir = pathValue('--themes-dir', argument.slice('--themes-dir='.length));
    } else {
      usageError(`unknown option ${argument}`);
    }
  }
  // Theme sheets sit beside the base sheet, as jar.mn registers them.
  return {
    outputPath,
    themesDir: themesDir ?? resolve(dirname(outputPath), THEMES_DIR_NAME),
    monolithic,
  };
}

function stripFontFaces(css) {
  return css.replace(/@font-face\s*\{[\s\S]*?\}\s*/g, '');
}

function adaptSelectors(css) {
  return css
    .replace(/data-muxui-theme/g, 'data-bento-theme')
    .replace(/data-muxui-color-scheme/g, 'data-color-mode')
    .replace(/data-muxui-contrast/g, 'data-bento-contrast')
    .replace(/data-muxui-motion/g, 'data-bento-motion')
    .replace(/data-muxui-density/g, 'data-bento-density')
    .replace(/data-muxui-direction/g, 'data-bento-direction');
}

// Mux's public blocks target HTML documents. Firefox chrome uses a XUL
// <window> root, so the data attributes must match its documentElement.
function rewriteHtmlToRoot(css) {
  return css.replace(/(^|[\s,(:[])html(?=[\s,.#:[)]|$)/g, (_match, prefix) => prefix + ':root');
}

function normalizeNativeCss(css) {
  return stripFontFaces(rewriteHtmlToRoot(adaptSelectors(css))).trimEnd();
}

// The themes.css rules for contrast 'more' are already absent from the shell theme sheets
// this script reads, and the public 'more' block is not projected (see mux-css.mjs).
function renderPublicMuxCss({ root, modes, closure }) {
  const blocks = [
    { selector: ':root', body: root },
    ...modes,
    { selector: PUBLIC_CLOSURE_SELECTOR, body: closure },
  ];
  return blocks.map(({ selector, body }) => `${selector} {\n${body}\n}`).join('\n\n');
}

function readOptional(path, label) {
  if (!existsSync(path)) {
    console.warn(`generate-chrome-tokens: ${label} unavailable (${path})`);
    return '';
  }
  return readFileSync(path, 'utf-8');
}

// Chrome's root font size is Firefox's UI font (11px on macOS) while the shell's is
// --font-size-root (16px), so a rem token is a different length in the two documents.
// Chrome sizes #bento-shell-host from the collapsed rail width and #bento-add-panel-trailer
// from the trailer's button, gap, padding and select widths, and the shell lays its rail and
// its trailer out inside those hosts, so these tokens are resolved here at the shell's root
// size and pinned in px. The trailer's grid and base widths are not listed: they are px sums
// of the pinned tokens. The panel header URL and panel navigator menu font sizes are listed
// because chrome sets that text itself and wants Mux's text-s at the shell's
// scale, not 11/16 of it. Add a token when chrome sizes shell-laid-out geometry, or sets
// text at a Mux size, from a rem token; px tokens (the sidebar min and max) need nothing.
const SHELL_SIZED_TOKENS = [
  '--bento-tab-strip-width-collapsed',
  '--bento-panel-trailer-button-size',
  '--bento-panel-trailer-grid-gap',
  '--bento-panel-trailer-inline-padding',
  '--bento-panel-trailer-wide-width',
  '--bento-panel-url-font-size',
  '--bento-panel-nav-menu-font-size',
];

// A resolver for the custom properties declared in `css`: each token's value with its
// var() references followed and its rem lengths converted to px at --font-size-root.
// Throws for a token that is missing, declared with different values, or not plain
// (a var() fallback), because the pinned value must equal what the shell computes.
function createShellPxResolver(css) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const declared = (name) => {
    const values = new Set(
      Array.from(bare.matchAll(new RegExp(`(?<![\\w-])${name}\\s*:\\s*([^;{}]+);`, 'g')), (match) =>
        match[1].trim().replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')'),
      ),
    );
    if (values.size !== 1) {
      throw new Error(
        `${name} is ${values.size ? 'declared with different values' : 'not declared'}`,
      );
    }
    return [...values][0];
  };
  const rootPx = Number.parseFloat(declared('--font-size-root'));
  if (!(rootPx > 0)) throw new Error('--font-size-root is not a px length');
  const resolve = (name, trail = []) => {
    if (trail.includes(name)) throw new Error(`${name} refers to itself`);
    const value = declared(name)
      .replace(/var\(\s*(--[\w-]+)\s*\)/g, (_match, ref) => resolve(ref, [...trail, name]))
      .replace(/(\d*\.?\d+)rem\b/g, (_match, rem) => `${Number((rem * rootPx).toFixed(4))}px`);
    if (value.includes('var(')) throw new Error(`${name} has a var() fallback`);
    return value;
  };
  return { rootPx, resolve };
}

const { outputPath, themesDir, monolithic } = parseArgs(process.argv.slice(2));
const {
  stylesDigest: muxStylesDigest,
  themesDigest: muxThemesDigest,
  blocks: muxPublicBlocks,
} = exitOnMuxSourceError('generate-chrome-tokens', () => loadMuxPublicCss(MUX_REQUIRE));

const bentoTokensPath = resolve(REPO_ROOT, 'extensions/bento-shell/src/theme/bento-tokens.css');
const presetsIndexPath = resolve(REPO_ROOT, 'extensions/bento-shell/src/theme/presets/index.css');
const bentoTokensCss = readOptional(bentoTokensPath, 'bento-tokens.css');
const presetsIndexCss = readOptional(presetsIndexPath, 'theme presets');

// One native sheet per non-default theme. The shell sheets already hold only the
// 'standard' contrast rules; native chrome is unlayered, so the `muxui` layer
// wrapper comes off.
function readThemeSheets() {
  if (!existsSync(THEME_SHEETS_DIR)) {
    console.warn(`generate-chrome-tokens: theme sheets unavailable (${THEME_SHEETS_DIR})`);
    return new Map();
  }
  return new Map(
    readdirSync(THEME_SHEETS_DIR)
      .filter((name) => name.endsWith('.css'))
      .sort()
      .map((name) => [
        name.slice(0, -'.css'.length),
        normalizeNativeCss(
          unwrapTopLevelLayers(readFileSync(resolve(THEME_SHEETS_DIR, name), 'utf-8')),
        ),
      ]),
  );
}
const themeSheets = readThemeSheets();

const mplHeader = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

`;

const themeNote = monolithic
  ? 'This is a monolithic build: every other theme follows below\n * because the archived mount script loads only this file.'
  : 'Every other theme is a sheet in bento-chrome-themes/, which\n * bento-shell-mount.js attaches to the windows that show it.';

const header = `${mplHeader}/*
 * AUTO-GENERATED — do not edit.
 * Regenerated by scripts/generate-chrome-tokens.mjs from the public Mux CSS
 * surface and Bento-owned compatibility layers.
 *
 * @muxui/react/styles.css sha256:${muxStylesDigest}
 * @muxui/react/themes.css sha256:${muxThemesDigest}
 * Mux packaged font declarations are omitted because native chrome has no
 * package URL base. The extension bundles the Mux package's self-hosted assets.
 * No remote font or stylesheet import is permitted here.
 *
 * This sheet carries the shared tokens and the Default theme. ${themeNote}
 *
 * Use --output <isolated-path> for packaged proof runs. The default path is
 * the source-tree file consumed by the normal import workflow.
 */

`;

const muxBaseSection = `/* ─── public @muxui/react/styles.css blocks ───────────────────────── */
${normalizeNativeCss(renderPublicMuxCss(muxPublicBlocks))}
`;

const monolithicThemesSection =
  monolithic && themeSheets.size > 0
    ? `/* ─── workspace theme sheets, folded in ──────────────────────────── */
${[...themeSheets.values()].join('\n\n')}
`
    : '';

const bentoSection = bentoTokensCss
  ? `/* ─── Bento token layer ───────────────────────────────────────────── */
${normalizeNativeCss(bentoTokensCss)}
`
  : '';
const presetsSection = presetsIndexCss
  ? `/* ─── Bento generated theme and legacy-token bridge ──────────────── */
${normalizeNativeCss(presetsIndexCss)}
`
  : '';

const tokenSheets =
  header + muxBaseSection + monolithicThemesSection + bentoSection + presetsSection;

// Unlayered, so it wins over the `bento.tokens` layer that declares the rem form. The
// archived rollback mount script keeps the sheet it shipped with.
function renderShellSizedSection(css) {
  if (monolithic) return '';
  const { rootPx, resolve } = createShellPxResolver(css);
  const declarations = SHELL_SIZED_TOKENS.map((name) => `  ${name}: ${resolve(name)};`);
  return `
/* ─── Shell-sized lengths ─────────────────────────────────────────── */
/* Chrome's rem is the system UI font, so these tokens are pinned in px at the
   shell's root font size (${rootPx}px) to match what the shell computes. */
:root {
${declarations.join('\n')}
}
`;
}

const output = tokenSheets + renderShellSizedSection(tokenSheets);

function writeIfChanged(path, content) {
  let previous;
  try {
    previous = readFileSync(path, 'utf-8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (previous === content) return false;
  writeFileSync(path, content);
  return true;
}

mkdirSync(dirname(outputPath), { recursive: true });
const baseChanged = writeIfChanged(outputPath, output);

// A removed theme must not leave its sheet behind in the engine tree.
mkdirSync(themesDir, { recursive: true });
for (const name of readdirSync(themesDir)) {
  if (name.endsWith('.css') && !themeSheets.has(name.slice(0, -'.css'.length))) {
    rmSync(resolve(themesDir, name));
  }
}
let themesChanged = 0;
for (const [id, css] of themeSheets) {
  const sheet = `${mplHeader}/*
 * AUTO-GENERATED — do not edit.
 * Native chrome sheet for workspace theme '${id}', regenerated by
 * scripts/generate-chrome-tokens.mjs from the shell theme sheet
 * (extensions/bento-shell/public/themes/${id}.css). bento-shell-mount.js attaches
 * it to a window while that window shows the theme.
 */

${css}
`;
  if (writeIfChanged(resolve(themesDir, `${id}.css`), sheet)) themesChanged += 1;
}

const sizeKb = (Buffer.byteLength(output) / 1024).toFixed(1);
console.log(
  `generate-chrome-tokens: ${baseChanged ? 'wrote' : 'unchanged'} ${outputPath} (${sizeKb} kB)` +
    `; ${themeSheets.size} theme sheets in ${themesDir} (${themesChanged} changed)` +
    (monolithic ? '; monolithic' : ''),
);
