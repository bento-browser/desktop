#!/usr/bin/env node
/**
 * Regenerate Bento's workspace-theme CSS and metadata registry.
 *
 * Shipped standard and monochrome themes come from @tale-ui/themes. Repo-local
 * CSS files in extensions/bento-shell/src/theme/presets remain supported for
 * Bento-specific and custom themes. The generated CSS rewrites Tale UI's
 * collection-specific selectors to Bento's single persisted data-bento-theme
 * attribute so the same stable theme id works in the shell and Firefox chrome.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHELL_DIR = resolve(REPO_ROOT, 'extensions/bento-shell');
const PRESETS_DIR = resolve(SHELL_DIR, 'src/theme/presets');
const INDEX_CSS_PATH = resolve(PRESETS_DIR, 'index.css');
const INDEX_TS_PATH = resolve(PRESETS_DIR, 'index.ts');

const DEFAULT_THEME_ID = 'default';
const DEFAULT_NEUTRAL_20 = '#d3d6e0';

function usageError(message) {
  console.error('sync-theme-presets: ' + message);
  process.exit(1);
}

function displayNameFromId(id) {
  return id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function extractToken(css, token) {
  return css.match(new RegExp(`${token}\\s*:\\s*(#[0-9a-fA-F]{3,8})`))?.[1].toLowerCase();
}

function extractPresetName(css, id) {
  return css.match(/^\s*\/\*\s*\n\s*\*\s*(.+?)\s+—/m)?.[1].trim() ?? displayNameFromId(id);
}

function paletteColor(palette, shade, themeId, paletteName) {
  const color = palette.find((entry) => entry.shade === shade)?.hex;
  if (!color) {
    usageError(`@tale-ui/themes ${themeId} has no ${paletteName}-${shade} color`);
  }
  return color.toLowerCase();
}

function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, 'utf-8') === content) {
    return false;
  }
  writeFileSync(path, content);
  return true;
}

function compilePresetCss(id, css) {
  let compiled = css;

  compiled = compiled.replace(
    /:where\(html:not\(\[data-color-mode=['"]dark['"]\]\)\)\s+\.tale-ui\s*,\s*\.light\s+\.tale-ui/g,
    `html[data-bento-theme='${id}']:not([data-color-mode='dark']).tale-ui`,
  );

  compiled = compiled.replace(
    /:where\(html:not\(\[data-color-mode=['"]dark['"]\]\)\)\s+\.tale-ui(?!\s*,)/g,
    `html[data-bento-theme='${id}']:not([data-color-mode='dark']).tale-ui`,
  );

  compiled = compiled.replace(
    /html\[data-color-mode=['"]dark['"]\]\s+\.tale-ui\s*,\s*\.dark\s+\.tale-ui/g,
    `html[data-bento-theme='${id}'][data-color-mode='dark'].tale-ui`,
  );

  compiled = compiled.replace(
    /html\[data-color-mode=['"]dark['"]\]\s+\.tale-ui(?!\s*,)/g,
    `html[data-bento-theme='${id}'][data-color-mode='dark'].tale-ui`,
  );

  compiled = compiled.replace(
    /:where\(html:not\(\[data-color-mode=['"]light['"]\]\)\)\s+\.tale-ui/g,
    `html[data-bento-theme='${id}']:not([data-color-mode='light']).tale-ui`,
  );

  compiled = compiled.replace(/^(\s*):root(\s*\{)/gm, `$1[data-bento-theme='${id}']$2`);

  return compiled.trimEnd();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function bentoSelector(ids) {
  const selectors = ids.map((id) => `[data-bento-theme='${id}']`);
  return selectors.length === 1 ? selectors[0] : `:is(${selectors.join(', ')})`;
}

function replaceThemeSelectors(css, className, attributeSelector, replacement) {
  const classPattern = escapeRegex(`.${className}`);
  const attributePattern = escapeRegex(attributeSelector);
  const combinedPattern = new RegExp(
    `:is\\(\\s*${classPattern}\\s*,\\s*${attributePattern}\\s*\\)`,
    'g',
  );
  const selectorListPattern = new RegExp(`${classPattern}\\s*,\\s*${attributePattern}`, 'g');

  return css
    .replace(combinedPattern, replacement)
    .replace(selectorListPattern, replacement)
    .replace(new RegExp(classPattern, 'g'), replacement)
    .replace(new RegExp(attributePattern, 'g'), replacement);
}

function compilePackageCss(css, standardThemes, monochromeThemes) {
  let compiled = css;

  for (const theme of standardThemes) {
    const canonicalId = `standard-${theme.id}`;
    compiled = replaceThemeSelectors(
      compiled,
      `standard-theme-${theme.id}`,
      `[data-tale-theme='${theme.id}']`,
      bentoSelector([canonicalId]),
    );
  }

  for (const theme of monochromeThemes) {
    const canonicalId = `monochrome-${theme.id}`;
    compiled = replaceThemeSelectors(
      compiled,
      `monochrome-theme-${theme.id}`,
      `[data-tale-monochrome-theme='${theme.id}']`,
      bentoSelector([canonicalId, theme.id]),
    );
  }

  // Bento always resolves Auto to an explicit data-color-mode value before
  // React mounts. The package's prefers-color-scheme fallback and .light class
  // compatibility blocks can never win here; omit those duplicate declarations
  // from the extension-wide stylesheet while retaining base light values and
  // explicit html[data-color-mode='dark'] rules.
  compiled = compiled.replace(/\n@media \(prefers-color-scheme: dark\) \{\n[\s\S]*?\n\}\n/g, '\n');
  compiled = compiled.replace(/\n\.light[^\{]+\{[^{}]*\}\n/g, '\n');

  return compiled.trimEnd();
}

const requireFromShell = createRequire(resolve(SHELL_DIR, 'package.json'));
let themesEntryPath;
let themesCssPath;
try {
  themesEntryPath = requireFromShell.resolve('@tale-ui/themes');
  themesCssPath = requireFromShell.resolve('@tale-ui/themes/themes.css');
} catch (error) {
  usageError(`cannot resolve @tale-ui/themes from @bento/shell (${error.message})`);
}

const themesPackage = await import(pathToFileURL(themesEntryPath).href);
const { STANDARD_THEMES, MONOCHROME_THEMES } = themesPackage;
if (!Array.isArray(STANDARD_THEMES) || !Array.isArray(MONOCHROME_THEMES)) {
  usageError('@tale-ui/themes does not export STANDARD_THEMES and MONOCHROME_THEMES arrays');
}

const entries = readdirSync(PRESETS_DIR, { withFileTypes: true });
const localIds = entries
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)
  .filter((name) => name.endsWith('.css') && name !== 'index.css')
  .map((name) => name.slice(0, -'.css'.length))
  .sort((a, b) => {
    if (a === DEFAULT_THEME_ID) return -1;
    if (b === DEFAULT_THEME_ID) return 1;
    return a.localeCompare(b);
  });

if (!localIds.includes(DEFAULT_THEME_ID)) {
  usageError('expected a default.css Bento preset');
}

const reservedIds = new Set([
  ...STANDARD_THEMES.map((theme) => `standard-${theme.id}`),
  ...MONOCHROME_THEMES.flatMap((theme) => [`monochrome-${theme.id}`, theme.id]),
]);

for (const id of localIds) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    usageError(`preset filename must be lowercase kebab-case: ${id}.css`);
  }
  if (id !== DEFAULT_THEME_ID && reservedIds.has(id)) {
    usageError(`repo-local preset id conflicts with @tale-ui/themes: ${id}`);
  }
}

const localThemes = localIds.map((id) => {
  const css = readFileSync(resolve(PRESETS_DIR, `${id}.css`), 'utf-8');
  const name = extractPresetName(css, id);
  const brand60 = extractToken(css, '--brand-60');
  if (!brand60) {
    usageError(`${id}.css has no --brand-60 declaration`);
  }

  return {
    id,
    name,
    description:
      id === DEFAULT_THEME_ID ? 'Bento’s default workspace palette.' : `${name} workspace theme.`,
    collection: 'bento',
    brand60,
    neutral20: extractToken(css, '--neutral-default-20') ?? DEFAULT_NEUTRAL_20,
    css: compilePresetCss(id, css),
  };
});

const standardThemes = STANDARD_THEMES.map((theme) => ({
  id: `standard-${theme.id}`,
  name: theme.name,
  description: theme.description,
  collection: 'standard',
  brand60: paletteColor(theme.brandPalette, 60, theme.id, 'brand'),
  neutral20: paletteColor(theme.neutralPalette, 20, theme.id, 'neutral'),
}));

const monochromeThemes = MONOCHROME_THEMES.map((theme) => ({
  id: `monochrome-${theme.id}`,
  name: theme.name,
  description: theme.description,
  collection: 'monochrome',
  brand60: paletteColor(theme.brandPalette, 60, theme.id, 'brand'),
  neutral20: paletteColor(theme.neutralPalette, 20, theme.id, 'neutral'),
}));

const themes = [...localThemes, ...standardThemes, ...monochromeThemes];
const packageCss = compilePackageCss(
  readFileSync(themesCssPath, 'utf-8'),
  STANDARD_THEMES,
  MONOCHROME_THEMES,
);

const indexCss = `/*
 * AUTO-GENERATED by scripts/sync-theme-presets.mjs.
 *
 * @tale-ui/themes is the source for shipped standard and monochrome palettes.
 * Repo-local sibling CSS files supply Bento-specific themes. All selectors are
 * adapted to data-bento-theme so shell documents and Firefox chrome share one
 * persisted theme id. Do not edit this file by hand.
 */

${localThemes
  .map((theme) => `/* ─── Bento theme: ${theme.id} ───────────────────────────── */\n${theme.css}`)
  .join('\n\n')}

/* ─── from @tale-ui/themes/themes.css ─────────────────────────────── */
${packageCss}
`;

const legacyAliases = Object.fromEntries(
  MONOCHROME_THEMES.map((theme) => [theme.id, `monochrome-${theme.id}`]),
);
const legacyAliasesSource = Object.entries(legacyAliases)
  .map(([legacyId, canonicalId]) => {
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(legacyId) ? legacyId : `'${legacyId}'`;
    return `  ${key}: '${canonicalId}',`;
  })
  .join('\n');

const indexTs = `// AUTO-GENERATED by scripts/sync-theme-presets.mjs.
// Shipped theme metadata comes from @tale-ui/themes; sibling preset CSS files
// supply Bento-specific themes. Do not edit this registry by hand.

export type BentoThemeCollection = 'bento' | 'standard' | 'monochrome';

export interface BentoThemeMeta {
  /** Stable storage id, also the value written to \`data-bento-theme\`. */
  id: string;
  /** Display name shown in the picker. */
  name: string;
  /** Short package-provided description used by search and tooltips. */
  description: string;
  /** Picker group and source collection. */
  collection: BentoThemeCollection;
  /** Hex value for the picker swatch's primary half. */
  brand60: string;
  /** Hex value for the picker swatch's secondary half. */
  neutral20: string;
}

/** The id used when a workspace has no \`themeId\` set. */
export const DEFAULT_THEME_ID = '${DEFAULT_THEME_ID}';

export const BENTO_THEMES: BentoThemeMeta[] = [
${themes
  .map(
    (theme) => `  {
    id: '${theme.id}',
    name: '${theme.name.replace(/'/g, "\\'")}',
    description: '${theme.description.replace(/'/g, "\\'")}',
    collection: '${theme.collection}',
    brand60: '${theme.brand60}',
    neutral20: '${theme.neutral20}',
  },`,
  )
  .join('\n')}
];

const LEGACY_THEME_ALIASES: Readonly<Record<string, string>> = {
${legacyAliasesSource}
};

export function getThemeMeta(id: string | undefined | null): BentoThemeMeta {
  const requestedId = id ?? DEFAULT_THEME_ID;
  const canonicalId = LEGACY_THEME_ALIASES[requestedId] ?? requestedId;
  return BENTO_THEMES.find((theme) => theme.id === canonicalId) ?? BENTO_THEMES[0]!;
}
`;

const cssChanged = writeIfChanged(INDEX_CSS_PATH, indexCss);
const tsChanged = writeIfChanged(INDEX_TS_PATH, indexTs);

console.log(
  `sync-theme-presets: ${cssChanged || tsChanged ? 'wrote' : 'unchanged'} ` +
    `${themes.length} themes (${localThemes.length} Bento, ` +
    `${standardThemes.length} standard, ${monochromeThemes.length} monochrome)`,
);
