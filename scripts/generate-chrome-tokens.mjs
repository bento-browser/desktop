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
 * After writing the default path it refreshes the built app's real-file copy of
 * the base sheet (sync-builtin-addon-symlinks.sh --content-files), which a dev
 * build cannot link because about:logins reads it in a content process. A
 * checkout that borrows another checkout's engine/ skips that copy with a notice.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unwrapTopLevelLayers } from '../extensions/bento-shell/css-blocks.mjs';
import {
  exitOnMuxSourceError,
  loadMuxPublicCss,
  MUX_THEMES_CSS,
  PUBLIC_CLOSURE_SELECTOR,
} from './mux-css.mjs';
import {
  documentConditions,
  FIREFOX_TOKEN_MAP,
  PAGE_RULES,
  referencedTokens,
  ROOT_DECLARATIONS,
} from './about-page-themes.mjs';
import { createShellPxResolver, createTokenResolver } from './token-resolver.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHELL_DIR = resolve(REPO_ROOT, 'extensions/bento-shell');
const DEFAULT_OUT_PATH = resolve(REPO_ROOT, 'src/browser/base/content/bento-chrome-tokens.css');
const THEME_SHEETS_DIR = resolve(SHELL_DIR, 'public/themes');
const THEMES_DIR_NAME = 'bento-chrome-themes';
const ABOUT_THEMES_NAME = 'bento-about-themes.css';
const DEFAULT_THEME_ID = 'default';
const MUX_REQUIRE = createRequire(resolve(SHELL_DIR, 'package.json'));

function usageError(message) {
  console.error(`generate-chrome-tokens: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let outputPath = DEFAULT_OUT_PATH;
  let themesDir;
  const pathValue = (flag, value) => {
    if (!value || value.startsWith('--')) usageError(`${flag} needs a path`);
    return resolve(process.cwd(), value);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      console.log(
        'Usage: node scripts/generate-chrome-tokens.mjs [--output <isolated-path>] ' +
          '[--themes-dir <path>]',
      );
      process.exit(0);
    }
    if (argument === '--output' || argument === '--themes-dir') {
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

// The preset stylesheet's rules for contrast 'more' are already absent from the shell theme sheets
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
  '--bento-sidebar-top-inset',
];

const { outputPath, themesDir } = parseArgs(process.argv.slice(2));
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

const themeNote =
  'Every other theme is a sheet in bento-chrome-themes/, which\n * bento-shell-mount.js attaches to the windows that show it.';

const header = `${mplHeader}/*
 * AUTO-GENERATED — do not edit.
 * Regenerated by scripts/generate-chrome-tokens.mjs from the public Mux CSS
 * surface and Bento-owned compatibility layers.
 *
 * @muxui/react/styles.css sha256:${muxStylesDigest}
 * ${MUX_THEMES_CSS} sha256:${muxThemesDigest}
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

const tokenSheets = header + muxBaseSection + bentoSection + presetsSection;

// Unlayered, so it wins over the `bento.tokens` layer that declares the rem form.
function renderShellSizedSection(css) {
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

// ─── About: page sheet ────────────────────────────────────────────────
// One USER sheet for every in-scope about: page and every theme and UI mode. Each theme and
// mode block holds the literal value of each Mux token the map references, under a private
// --bento-about-* name; the map block then points Firefox's tokens at those names. Literals
// come from resolving this run's chrome sheets for a root carrying that theme and mode,
// which is what a chrome window showing it computes.
const ABOUT_ROOT = ':root[data-bento-theme][data-color-mode]';
const ABOUT_MODES = ['light', 'dark'];
const aboutAlias = (token) => `--bento-about-${token.slice(2)}`;
const toAliases = (value) => value.replace(/var\(\s*--([\w-]+)/g, 'var(--bento-about-$1');

function aboutRule(selector, declarations, important = true) {
  const lines = Object.entries(declarations).map(
    ([name, value]) => `  ${name}: ${toAliases(value)}${important ? ' !important' : ''};`,
  );
  return `${selector} {\n${lines.join('\n')}\n}`;
}

// `html` in a page rule is the root itself; anything else is below it.
const underRoot = (root, selector) =>
  selector
    .split(',')
    .map((part) => (part.trim() === 'html' ? root : `${root} ${part.trim()}`))
    .join(',\n');

function documentBlock(conditions, rules) {
  return `@-moz-document ${conditions.join(',\n  ')} {\n@media not (forced-colors) {\n\n${rules.join('\n\n')}\n\n}\n}`;
}

function renderAboutThemesSheet(baseCss) {
  const tokens = referencedTokens();
  const themes = [
    [DEFAULT_THEME_ID, baseCss],
    ...[...themeSheets].map(([id, css]) => [id, `${baseCss}\n${css}`]),
  ];
  // Default comes first and selects any theme id, so a theme without a block of its own
  // shows Default; every later block is as specific and wins by order.
  const themeBlocks = themes.flatMap(([id, css]) =>
    ABOUT_MODES.map((mode) => {
      const { resolve } = createTokenResolver(css, {
        attributes: { 'data-bento-theme': id, 'data-color-mode': mode },
      });
      const lines = tokens.map((token) => {
        let value;
        try {
          value = resolve(token);
        } catch (error) {
          throw new Error(`about: page sheet, theme ${id} ${mode}: ${error.message}`);
        }
        return `  ${aboutAlias(token)}: ${value};`;
      });
      const theme = id === DEFAULT_THEME_ID ? '' : `='${id}'`;
      return `:root[data-bento-theme${theme}][data-color-mode='${mode}'] {\n${lines.join('\n')}\n}`;
    }),
  );
  const modeBlocks = ABOUT_MODES.map(
    (mode) =>
      `:root[data-bento-theme][data-color-mode='${mode}'] {\n  color-scheme: ${mode} !important;\n}`,
  );
  const mapBlocks = [
    aboutRule(ABOUT_ROOT, {
      ...Object.assign({}, ...FIREFOX_TOKEN_MAP.map((group) => group.tokens)),
      ...ROOT_DECLARATIONS,
    }),
    ...FIREFOX_TOKEN_MAP.filter((group) => group.hosts).map((group) =>
      aboutRule(underRoot(ABOUT_ROOT, group.hosts.join(', ')), group.tokens),
    ),
  ];
  // Page rules, grouped by the documents they apply to.
  const pageGroups = new Map();
  for (const rule of PAGE_RULES) {
    const conditions = documentConditions(rule.pages === 'all' ? undefined : rule.pages);
    const key = conditions.join(',');
    if (!pageGroups.has(key)) pageGroups.set(key, { conditions, rules: [] });
    const { rules } = pageGroups.get(key);
    if (rule.declarations)
      rules.push(aboutRule(underRoot(ABOUT_ROOT, rule.selector), rule.declarations));
    for (const mode of ABOUT_MODES) {
      if (!rule[mode]) continue;
      const root = `:root[data-bento-theme][data-color-mode='${mode}']`;
      rules.push(aboutRule(underRoot(root, rule.selector), rule[mode]));
    }
  }
  const [everything, ...pages] = [...pageGroups.values()];
  const allConditions = documentConditions();
  if (everything.conditions.join(',') !== allConditions.join(',')) {
    throw new Error('about: page sheet: the first page rule must apply to every page');
  }
  return `${mplHeader}/*
 * AUTO-GENERATED — do not edit.
 * Regenerated by scripts/generate-chrome-tokens.mjs from scripts/about-page-themes.mjs
 * (the page list and the Firefox-token map) and this run's chrome token sheets.
 *
 * @muxui/react/styles.css sha256:${muxStylesDigest}
 * ${MUX_THEMES_CSS} sha256:${muxThemesDigest}
 *
 * bento-shell-mount.js registers it once per process as a USER sheet, so it reaches the
 * pages' shadow trees, and its declarations are !important to win over the pages' own
 * tokens. A page is themed once its root carries data-bento-theme and data-color-mode,
 * which the BentoAboutTheme actor (and, for the Passwords sidebar, the mount script) sets
 * from the window's workspace theme and UI mode.
 */

${documentBlock(allConditions, [...themeBlocks, ...modeBlocks, ...mapBlocks, ...everything.rules])}

${pages.map(({ conditions, rules }) => documentBlock(conditions, rules)).join('\n\n')}
`;
}

const aboutThemesOutput = renderAboutThemesSheet(output);

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
// The about: page sheet sits beside the base sheet, as jar.mn registers it.
const aboutThemesPath = resolve(dirname(outputPath), ABOUT_THEMES_NAME);
const aboutChanged = writeIfChanged(aboutThemesPath, aboutThemesOutput);

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
    `; ${aboutChanged ? 'wrote' : 'unchanged'} ${aboutThemesPath}` +
    ` (${(Buffer.byteLength(aboutThemesOutput) / 1024).toFixed(1)} kB)`,
);

// Refreshes the built app's copy of the sheet. A checkout whose engine/ or .bento/ is
// borrowed from another checkout must not write there, so the copy is skipped (the sheet
// above is still written); a failed copy into this checkout's own objdir is an error.
function refreshContentCopy() {
  const preflight = spawnSync(
    process.execPath,
    [resolve(REPO_ROOT, 'scripts/bento-build.mjs'), 'preflight'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  if (preflight.status !== 0) {
    if (!/build outputs must stay inside checkout/.test(preflight.stderr)) {
      console.error(`generate-chrome-tokens: preflight failed\n${preflight.stderr.trim()}`);
      process.exit(preflight.status ?? 1);
    }
    // The preflight lists each borrowed path as an indented 'requested -> resolved' line.
    const borrowed = preflight.stderr.match(/^ {2}\S.* -> .*$/gm) ?? [];
    console.log(
      `generate-chrome-tokens: content copy skipped: build outputs are borrowed (${borrowed.map((line) => line.trim()).join(', ')})`,
    );
    return;
  }
  const sync = spawnSync(
    'bash',
    [resolve(REPO_ROOT, 'scripts/sync-builtin-addon-symlinks.sh'), '--content-files'],
    { cwd: REPO_ROOT, stdio: 'inherit' },
  );
  if (sync.status !== 0) {
    console.error('generate-chrome-tokens: refreshing the built app copy failed');
    process.exit(sync.status ?? 1);
  }
}

// An --output run is isolated and leaves the built app alone.
if (outputPath === DEFAULT_OUT_PATH) refreshContentCopy();
