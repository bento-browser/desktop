#!/usr/bin/env node
/* global console, process */
/**
 * Generate the native chrome token stylesheet from the public Mux CSS surface.
 *
 * Chrome and the bento-shell extension have separate document trees, so the
 * native stylesheet receives the public Mux token blocks plus Bento's
 * generated legacy-token bridge. `--output` is intentionally supported for
 * isolated packaging and proof runs; the default remains the source-tree path
 * used by the import workflow.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHELL_DIR = resolve(REPO_ROOT, 'extensions/bento-shell');
const DEFAULT_OUT_PATH = resolve(
  REPO_ROOT,
  'src/browser/base/content/bento-chrome-tokens.css',
);
const MUX_REQUIRE = createRequire(resolve(SHELL_DIR, 'package.json'));

const PUBLIC_MODE_SELECTORS = [
  "[data-muxui-color-scheme='light']",
  "[data-muxui-color-scheme='dark']",
  "[data-muxui-contrast='standard']",
  "[data-muxui-contrast='more']",
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
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      console.log(
        'Usage: node scripts/generate-chrome-tokens.mjs [--output <isolated-path>]',
      );
      process.exit(0);
    }
    if (argument === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) usageError('--output needs a path');
      outputPath = resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (argument.startsWith('--output=')) {
      const value = argument.slice('--output='.length);
      if (!value) usageError('--output needs a path');
      outputPath = resolve(process.cwd(), value);
      continue;
    }
    usageError(`unknown option ${argument}`);
  }
  return outputPath;
}

function findClosingBrace(css, openIndex) {
  let depth = 0;
  let quote = null;
  let comment = false;
  for (let index = openIndex; index < css.length; index += 1) {
    const character = css[index];
    const nextCharacter = css[index + 1];
    if (comment) {
      if (character === '*' && nextCharacter === '/') {
        comment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      comment = true;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
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

const outputPath = parseArgs(process.argv.slice(2));
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

const header = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
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
 * Use --output <isolated-path> for packaged proof runs. The default path is
 * the source-tree file consumed by the normal import workflow.
 */

`;

const muxBaseSection = `/* ─── public @muxui/react/styles.css blocks ───────────────────────── */
${normalizeNativeCss(renderPublicMuxCss(muxStylesCss))}
`;

const muxThemesSection = `/* ─── public @muxui/react/themes.css presets ─────────────────────── */
${normalizeNativeCss(muxThemesCss)}
`;

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

const output = header + muxBaseSection + muxThemesSection + bentoSection + presetsSection;
mkdirSync(dirname(outputPath), { recursive: true });
const unchanged = existsSync(outputPath) && readFileSync(outputPath, 'utf-8') === output;
if (!unchanged) writeFileSync(outputPath, output);

const sizeKb = (statSync(outputPath).size / 1024).toFixed(1);
console.log(
  `generate-chrome-tokens: ${unchanged ? 'unchanged' : 'wrote'} ${outputPath} (${sizeKb} kB)`,
);
