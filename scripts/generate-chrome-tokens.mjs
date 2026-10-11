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

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findClosingBrace, unwrapTopLevelLayers } from '../extensions/bento-shell/css-blocks.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHELL_DIR = resolve(REPO_ROOT, 'extensions/bento-shell');
const DEFAULT_OUT_PATH = resolve(
  REPO_ROOT,
  'src/browser/base/content/bento-chrome-tokens.css',
);
const THEME_SHEETS_DIR = resolve(SHELL_DIR, 'public/themes');
const THEMES_DIR_NAME = 'bento-chrome-themes';
const MUX_REQUIRE = createRequire(resolve(SHELL_DIR, 'package.json'));

// The rollback-final-r2 build swaps in the archived mount script, which loads only
// the base sheet (see scripts/build-rollback-variant.mjs and scripts/rollback-variants.mjs).
const MONOLITHIC_VARIANT = 'rollback-final-r2';

// Contrast is fixed to 'standard', so the public contrast='more' block is not
// projected (see extensions/bento-shell/contrast-more.mjs). The themes.css rules
// for 'more' are already absent from the shell theme sheets this script reads.
const PUBLIC_MODE_SELECTORS = [
  "[data-muxui-color-scheme='light']",
  "[data-muxui-color-scheme='dark']",
  "[data-muxui-contrast='standard']",
];
const PUBLIC_CLOSURE_SELECTOR = `:root,
[data-muxui-color-scheme],
[data-muxui-contrast],
[data-muxui-motion],
[data-muxui-density],
[data-muxui-direction]`;

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

function extractFlatBlock(css, selector) {
  const selectorIndex = css.indexOf(selector);
  if (selectorIndex < 0) {
    usageError(`@muxui/react/styles.css is missing ${selector}`);
  }
  const openIndex = css.indexOf('{', selectorIndex + selector.length);
  if (openIndex < 0) usageError(`@muxui/react/styles.css has no body for ${selector}`);
  const closeIndex = findClosingBrace(css, openIndex);
  if (closeIndex < 0) usageError(`@muxui/react/styles.css has an unterminated ${selector} block`);
  const body = css.slice(openIndex + 1, closeIndex).trim();
  if (!body || body.includes('{')) {
    usageError(`@muxui/react/styles.css changed the flat declaration shape for ${selector}`);
  }
  return body;
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
  return css.replace(
    /(^|[\s,(:[])html(?=[\s,.#:[)]|$)/g,
    (_match, prefix) => prefix + ':root',
  );
}

function normalizeNativeCss(css) {
  return stripFontFaces(rewriteHtmlToRoot(adaptSelectors(css))).trimEnd();
}

function renderPublicMuxCss(stylesCss) {
  const blocks = [
    { selector: ':root', body: extractFlatBlock(stylesCss, ':root') },
    ...PUBLIC_MODE_SELECTORS.map((selector) => ({
      selector,
      body: extractFlatBlock(stylesCss, selector),
    })),
    {
      selector: PUBLIC_CLOSURE_SELECTOR,
      body: extractFlatBlock(stylesCss, PUBLIC_CLOSURE_SELECTOR),
    },
  ];
  return blocks
    .map(({ selector, body }) => `${selector} {\n${body}\n}`)
    .join('\n\n');
}

function readOptional(path, label) {
  if (!existsSync(path)) {
    console.warn(`generate-chrome-tokens: ${label} unavailable (${path})`);
    return '';
  }
  return readFileSync(path, 'utf-8');
}

const { outputPath, themesDir, monolithic } = parseArgs(process.argv.slice(2));
let muxStylesPath;
let muxThemesPath;
try {
  muxStylesPath = MUX_REQUIRE.resolve('@muxui/react/styles.css');
  muxThemesPath = MUX_REQUIRE.resolve('@muxui/react/themes.css');
} catch (error) {
  usageError(`cannot resolve public Mux CSS from @bento/shell (${error.message})`);
}

const muxStylesCss = readFileSync(muxStylesPath, 'utf-8');
const muxThemesCss = readFileSync(muxThemesPath, 'utf-8');
const muxStylesDigest = createHash('sha256').update(muxStylesCss).digest('hex');
const muxThemesDigest = createHash('sha256').update(muxThemesCss).digest('hex');

const bentoTokensPath = resolve(
  REPO_ROOT,
  'extensions/bento-shell/src/theme/bento-tokens.css',
);
const presetsIndexPath = resolve(
  REPO_ROOT,
  'extensions/bento-shell/src/theme/presets/index.css',
);
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
${normalizeNativeCss(renderPublicMuxCss(muxStylesCss))}
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

const output =
  header + muxBaseSection + monolithicThemesSection + bentoSection + presetsSection;

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
