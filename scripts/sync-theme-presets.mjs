#!/usr/bin/env node
/* global console, process */
/**
 * Regenerate Bento's workspace-theme CSS and metadata registry.
 *
 * Canonical standard and monochrome metadata comes from @muxui/react/themes.
 * Repo-local CSS files in extensions/bento-shell/src/theme/presets remain
 * supported for Bento-specific and custom themes. The generated CSS rewrites
 * collection-specific selectors to Bento's data-bento-theme attribute,
 * projects the public Mux base stylesheet for default/custom compatibility,
 * and emits the legacy token bridge consumed by existing Bento CSS. Do not
 * import Mux's private token compiler or schema here.
 *
 * Output is split so a document loads only the theme it shows:
 *   - presets/index.css: the Default theme and the shared token bridge, imported
 *     by every entry.
 *   - public/themes/<id>.css: one sheet per other theme, loaded on demand by
 *     src/theme/themeSheets.ts. Canonical sheets carry that theme's rules from
 *     the public @muxui/react/themes.css export inside the `muxui` layer.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import prettier from 'prettier';

import { findClosingBrace } from '../extensions/bento-shell/css-blocks.mjs';
import {
  exitOnMuxSourceError,
  loadMuxPublicCss,
  loadMuxThemePresets,
  parseDeclarations,
  readReferenceShades,
  splitCanonicalThemeRules,
} from './mux-css.mjs';
import { rewriteThemeSelectors } from './theme-selector.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SHELL_DIR = resolve(REPO_ROOT, 'extensions/bento-shell');
const PRESETS_DIR = resolve(SHELL_DIR, 'src/theme/presets');
const INDEX_CSS_PATH = resolve(PRESETS_DIR, 'index.css');
const INDEX_TS_PATH = resolve(PRESETS_DIR, 'index.ts');
// Vite copies public/ into dist/, so the sheets keep stable URLs (./themes/<id>.css)
// in every build, including the archived rollback configs.
const SHEETS_DIR = resolve(SHELL_DIR, 'public/themes');

const DEFAULT_THEME_ID = 'default';
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

function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, 'utf-8') === content) {
    return false;
  }
  writeFileSync(path, content);
  return true;
}

function compilePresetCss(id, css) {
  return rewriteThemeSelectors(css, id, { attributeQuote: "'" }).trimEnd();
}

function scanCssRules(css, atRules = [], rules = []) {
  let cursor = 0;
  while (cursor < css.length) {
    const openIndex = css.indexOf('{', cursor);
    if (openIndex < 0) break;
    const closeIndex = findClosingBrace(css, openIndex);
    if (closeIndex < 0) usageError('Bento preset CSS has an unterminated block');
    const prelude = css
      .slice(cursor, openIndex)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    const body = css.slice(openIndex + 1, closeIndex);
    if (prelude.startsWith('@')) {
      scanCssRules(body, [...atRules, prelude], rules);
    } else if (prelude) {
      rules.push({ atRules, selector: prelude, body });
    }
    cursor = closeIndex + 1;
  }
  return rules;
}

function mapMuxForegroundReference(value) {
  return value
    .replace(/--color-(\d+)-fg/g, '--muxui-semantic-color-color-$1-fg')
    .replace(/--neutral-default-(\d+)-fg/g, '--muxui-semantic-color-neutral-$1-fg')
    .replace(/--neutral-(\d+)-fg/g, '--muxui-semantic-color-neutral-$1-fg')
    .replace(/--color-(\d+)(?!-fg)/g, '--muxui-semantic-color-color-$1')
    .replace(/--neutral-default-(\d+)(?!-fg)/g, '--muxui-semantic-color-neutral-default-$1')
    .replace(/--neutral-(\d+)(?!-fg)/g, '--muxui-semantic-color-neutral-$1');
}

function mapMuxForegroundToken(token) {
  const match = token.match(/^--(?:color|neutral(?:-default)?)-(\d+)-fg$/);
  if (!match) return null;
  const family = token.startsWith('--color-') ? 'color' : 'neutral';
  return `--muxui-semantic-color-${family}-${match[1]}-fg`;
}

function extractForegroundOverrides(css) {
  const overrides = {
    root: new Map(),
    light: new Map(),
    dark: new Map(),
  };
  for (const { atRules, selector, body } of scanCssRules(css)) {
    const context = `${atRules.join(' ')} ${selector}`;
    const notDark = /not\(\s*\[data-color-mode\s*=\s*['"]dark['"]\s*\]\s*\)/.test(context);
    const notLight = /not\(\s*\[data-color-mode\s*=\s*['"]light['"]\s*\]\s*\)/.test(context);
    const explicitContext = context.replace(
      /not\(\s*\[data-color-mode\s*=\s*['"][^)]*\]\s*\)/g,
      '',
    );
    const mode =
      /prefers-color-scheme:\s*dark/.test(explicitContext) ||
      /data-color-mode\s*=\s*['"]dark['"]|\.dark(?:\s|\.|#|$)/.test(explicitContext) ||
      notLight
        ? 'dark'
        : /data-color-mode\s*=\s*['"]light['"]|\.light(?:\s|\.|#|$)/.test(explicitContext) ||
            notDark
          ? 'light'
          : selector.includes(':root')
            ? 'root'
            : null;
    if (!mode) continue;
    for (const match of body.matchAll(
      /(--(?:color|neutral(?:-default)?)-\d+-fg)\s*:\s*([^;]+);/g,
    )) {
      const mappedToken = mapMuxForegroundToken(match[1]);
      if (mappedToken) overrides[mode].set(mappedToken, mapMuxForegroundReference(match[2].trim()));
    }
  }
  return overrides;
}

function formatForegroundOverrides(overrides) {
  return [...overrides.entries()].map(([token, value]) => `  ${token}: ${value};`).join('\n');
}

function legacyAliasForMuxToken(token) {
  let match = token.match(/^--muxui-reference-color-(.+)-(\d+)$/);
  if (match) {
    const [, family, shade] = match;
    // `neutral-*` is the public raw neutral ramp, while Bento's
    // `--neutral-*` names are semantic aliases. Keep the raw families that
    // Bento CSS may still reference and let the semantic mapping below own
    // the unqualified neutral ramp.
    if (family === 'neutral') return null;
    return { name: `--${family}-${shade}`, scoped: false };
  }

  match = token.match(
    /^--muxui-reference-dimension-(space|section-space|text|radius|font-size)-(.+)$/,
  );
  if (match) {
    return { name: `--${match[1]}-${match[2]}`, scoped: true };
  }

  match = token.match(/^--muxui-reference-dimension-(scale)$/);
  if (match) return { name: `--${match[1]}`, scoped: true };

  match = token.match(/^--muxui-reference-effect-shadow-(.+)$/);
  if (match) return { name: `--shadow-${match[1]}`, scoped: true };

  match = token.match(/^--muxui-reference-typography-(body|display|expressive|mono)-font$/);
  if (match) return { name: `--${match[1]}-font`, scoped: true };

  match = token.match(/^--muxui-semantic-color-(color|neutral|neutral-default)-(\d+)(-fg)?$/);
  if (match) {
    return {
      name: `--${match[1]}-${match[2]}${match[3] ?? ''}`,
      scoped: true,
    };
  }
  match = token.match(/^--muxui-semantic-color-(neutral-default)(-fg)?$/);
  if (match) return { name: `--${match[1]}${match[2] ?? ''}`, scoped: true };

  match = token.match(/^--muxui-semantic-(elevation|effect|focus|action)-(.+)$/);
  if (match) {
    const prefix = match[1] === 'action' ? '' : `${match[1]}-`;
    const name = match[2];
    if (match[1] === 'effect' && name === 'scrim') return { name: '--scrim', scoped: true };
    if (match[1] === 'action' && name === 'background') return { name: '--primary', scoped: true };
    return { name: `--${prefix}${name}`, scoped: true };
  }

  match = token.match(/^--muxui-semantic-typography-(.+)$/);
  if (match) {
    const name = match[1];
    return { name: `--${name}`, scoped: true };
  }

  match = token.match(
    /^--muxui-(field|popup|item|group-label|modal|progress|control|focus-ring)-(.+)$/,
  );
  if (match) return { name: `--${match[1]}-${match[2]}`, scoped: true };

  return null;
}

function addLegacyBridgeDeclaration(target, name, value) {
  if (!target.has(name)) target.set(name, value);
}

function buildLegacyAliasBridges(rootBody, closureBody) {
  const rootDeclarations = parseDeclarations(rootBody);
  const closureDeclarations = parseDeclarations(closureBody);
  const root = new Map();
  const scoped = new Map();

  for (const [token] of [...rootDeclarations, ...closureDeclarations]) {
    const alias = legacyAliasForMuxToken(token);
    if (!alias) continue;
    const declaration = `var(${token})`;
    addLegacyBridgeDeclaration(alias.scoped ? scoped : root, alias.name, declaration);
    // Raw Mux ramps also need a local scope for canonical themes. Local
    // Default/custom projections follow this bridge and reassert their raw
    // ladders afterward, which keeps their compatibility values acyclic.
    if (!alias.scoped) addLegacyBridgeDeclaration(scoped, alias.name, declaration);
  }

  // The old chrome layer exposes these short names in addition to the
  // category-token families. Keep the aliases derived from public Mux roles,
  // with no private catalog/schema dependency.
  const addRootAndScoped = (name, value) => {
    addLegacyBridgeDeclaration(root, name, value);
    addLegacyBridgeDeclaration(scoped, name, value);
  };
  addRootAndScoped('--font-size-root', '16px');
  addRootAndScoped('--font-size-small', 'var(--text-xs)');
  addRootAndScoped('--font-s', 'var(--text-s)');
  addRootAndScoped('--primary-hover', 'var(--color-50)');
  addRootAndScoped('--primary-active', 'var(--color-40)');
  addRootAndScoped('--primary-fg', 'var(--color-60-fg)');
  addRootAndScoped(
    '--scrim-subtle',
    'color-mix(in srgb, var(--neutral-default-100) 24%, transparent)',
  );
  addRootAndScoped(
    '--scrim-strong',
    'color-mix(in srgb, var(--neutral-default-100) 72%, transparent)',
  );
  addRootAndScoped('--space-large', 'var(--space-2xs)');
  addRootAndScoped('--space-medium', 'var(--space-2xs)');
  addRootAndScoped('--space-small', 'var(--space-3xs)');
  addRootAndScoped('--space-xsmall', 'var(--space-4xs)');
  addRootAndScoped('--space-xxsmall', 'var(--space-4xs)');

  return {
    root: [...root].map(([name, value]) => `  ${name}: ${value};`).join('\n'),
    scoped: [...scoped].map(([name, value]) => `  ${name}: ${value};`).join('\n'),
  };
}

function formatLegacyBridgeCss(rootBody, closureBody) {
  const bridges = buildLegacyAliasBridges(rootBody, closureBody);
  return `/* Bento-owned legacy token bridge derived from public @muxui/react/styles.css. */
:root {
${bridges.root}
}

:is([data-muxui-theme], [data-muxui-color-scheme], [data-muxui-contrast], [data-muxui-motion], [data-muxui-density], [data-muxui-direction]) {
${bridges.scoped}
}`;
}

function buildReferenceOverrides(shades) {
  const { brand: brandShades, neutral: neutralShades } = shades;
  return [
    '  /* Compatibility projection: preserve Bento ladders without rewriting Mux semantic mode aliases. */',
    ...brandShades.map(
      (shade) => `  --muxui-reference-color-brand-${shade}: var(--brand-${shade});`,
    ),
    ...neutralShades.map(
      (shade) => `  --muxui-reference-color-neutral-${shade}: var(--neutral-default-${shade});`,
    ),
  ].join('\n');
}

function buildRawLadderOverrides({ id, css, brandShades, neutralShades, defaultBrandValues }) {
  const brandValues = new Map(
    brandShades.map((shade) => [
      shade,
      extractToken(css, `--brand-${shade}`) ?? defaultBrandValues.get(shade),
    ]),
  );
  if ([...brandValues.values()].some((value) => !value)) {
    usageError(`${id}.css cannot provide a complete Bento brand ladder for Mux compatibility`);
  }

  return [
    '  /* Reset raw Bento ladders before re-linking Mux references on nested scopes. */',
    ...brandShades.map((shade) => `  --brand-${shade}: ${brandValues.get(shade)};`),
    ...neutralShades.map(
      (shade) =>
        `  --neutral-default-${shade}: ${
          extractToken(css, `--neutral-default-${shade}`) ?? `var(--neutral-cool-${shade})`
        };`,
    ),
  ].join('\n');
}

function buildMuxCompatibilityCss(
  { root: rootBody, modes, closure: closureBody },
  shades,
  localThemes,
  defaultBrandValues,
) {
  const blocks = [{ selector: ':root', body: rootBody }, ...modes];
  const referenceOverrides = buildReferenceOverrides(shades);
  return new Map(
    localThemes.map((theme) => {
      const id = theme.id;
      const scope = `[data-muxui-theme='${id}']`;
      const scopedBlocks = blocks.map(({ selector, body }) => {
        const scopedSelector = selector === ':root' ? scope : `${scope}${selector}`;
        const rawOverrides =
          selector === ':root'
            ? buildRawLadderOverrides({
                id,
                css: theme.sourceCss,
                brandShades: theme.brandShades,
                neutralShades: theme.neutralShades,
                defaultBrandValues,
              })
            : '';
        const mode =
          selector === ':root'
            ? 'root'
            : selector.includes("data-muxui-color-scheme='light'")
              ? 'light'
              : selector.includes("data-muxui-color-scheme='dark'")
                ? 'dark'
                : null;
        const foregroundOverrides = mode
          ? formatForegroundOverrides(theme.foregroundOverrides[mode])
          : '';
        const additions = [rawOverrides, referenceOverrides, foregroundOverrides]
          .filter(Boolean)
          .join('\n');
        return `${scopedSelector} {\n${body}\n${additions}\n}`;
      });
      scopedBlocks.push(`${scope} {\n${closureBody}\n}`);
      return [id, scopedBlocks.join('\n\n')];
    }),
  );
}

const requireFromShell = createRequire(resolve(SHELL_DIR, 'package.json'));

// The theme list is whatever the pinned Mux package ships; scripts/mux-css.mjs checks its shape.
const muxThemes = await exitOnMuxSourceError('sync-theme-presets', () =>
  loadMuxThemePresets(requireFromShell),
);
const {
  themesCss: muxThemesCss,
  stylesDigest: muxStylesDigest,
  themesDigest: muxThemesDigest,
  blocks: muxPublicBlocks,
} = exitOnMuxSourceError('sync-theme-presets', () => loadMuxPublicCss(requireFromShell));
const publicShades = exitOnMuxSourceError('sync-theme-presets', () =>
  readReferenceShades(muxPublicBlocks.root),
);

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

if (muxThemes.some((theme) => theme.id === DEFAULT_THEME_ID)) {
  usageError(`a canonical Mux theme uses the reserved Bento id ${DEFAULT_THEME_ID}`);
}

const reservedIds = new Set([
  ...muxThemes.map((theme) => theme.id),
  ...muxThemes.filter((theme) => theme.collection === 'monochrome').map((theme) => theme.presetId),
]);

for (const id of localIds) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    usageError(`preset filename must be lowercase kebab-case: ${id}.css`);
  }
  if (id !== DEFAULT_THEME_ID && reservedIds.has(id)) {
    usageError(`repo-local preset id conflicts with a canonical Mux theme: ${id}`);
  }
}

const localThemeSources = localIds.map((id) => {
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
    sourceCss: css,
    css: compilePresetCss(id, css),
  };
});
const publicBrandShades = publicShades.brand;
const publicNeutralShades = publicShades.neutral;
const defaultSource = localThemeSources.find((theme) => theme.id === DEFAULT_THEME_ID);
if (!defaultSource) usageError('expected a default.css Bento preset');
const defaultBrandValues = new Map(
  publicBrandShades.map((shade) => [
    shade,
    extractToken(defaultSource.sourceCss, `--brand-${shade}`),
  ]),
);
if ([...defaultBrandValues.values()].some((value) => !value)) {
  usageError('default.css must provide the complete Bento brand ladder');
}
const defaultNeutral20 = extractToken(defaultSource.sourceCss, '--neutral-default-20');
if (!defaultNeutral20) {
  usageError('default.css must provide --neutral-default-20');
}
const localThemes = localThemeSources.map((theme) => ({
  ...theme,
  brandShades: publicBrandShades,
  neutralShades: publicNeutralShades,
  neutral20: extractToken(theme.sourceCss, '--neutral-default-20') ?? defaultNeutral20,
  foregroundOverrides: extractForegroundOverrides(theme.sourceCss),
}));

const canonicalThemes = muxThemes.map((theme) => ({
  id: theme.id,
  name: theme.name,
  description: theme.description,
  collection: theme.collection,
  presetId: theme.presetId,
  brand60: theme.swatch.primary.toLowerCase(),
  neutral20: theme.swatch.secondary.toLowerCase(),
}));
const standardThemes = canonicalThemes.filter((theme) => theme.collection === 'standard');
const monochromeThemes = canonicalThemes.filter((theme) => theme.collection === 'monochrome');
const themes = [...localThemes, ...canonicalThemes];
const muxCompatibilityBlocks = buildMuxCompatibilityCss(
  muxPublicBlocks,
  publicShades,
  localThemes,
  defaultBrandValues,
);
const canonicalThemeRules = exitOnMuxSourceError('sync-theme-presets', () =>
  splitCanonicalThemeRules(
    muxThemesCss,
    canonicalThemes.map((theme) => theme.id),
  ),
);
// Default stays in the shared stylesheet: it is the document's first-paint theme and the
// fallback for unknown ids. Every other theme is its own sheet.
const defaultTheme = localThemes.find((theme) => theme.id === DEFAULT_THEME_ID);
const sheetLocalThemes = localThemes.filter((theme) => theme.id !== DEFAULT_THEME_ID);
const legacyAliasCss = formatLegacyBridgeCss(muxPublicBlocks.root, muxPublicBlocks.closure);

const indexCssSource = `/*
 * AUTO-GENERATED by scripts/sync-theme-presets.mjs.
 *
 * Canonical metadata comes from @muxui/react/themes. Repo-local sibling CSS
 * files supply Bento-specific themes. Selectors are adapted to
 * data-bento-theme, and the public Mux base blocks are scoped to
 * data-muxui-theme for default/custom compatibility. This file carries the
 * Default theme only; every other theme is a sheet in public/themes/ that
 * src/theme/themeSheets.ts loads on demand. Do not edit by hand.
 *
 * @muxui/react/styles.css sha256:${muxStylesDigest}
 * @muxui/react/themes.css sha256:${muxThemesDigest}
 */

/* ─── Bento theme: ${defaultTheme.id} ───────────────────────────── */
${defaultTheme.css}

/* ─── Bento legacy token bridge from public Mux aliases ────────────── */
${legacyAliasCss}

/* ─── Mux public base projection for the Default theme ─────────────── */
${muxCompatibilityBlocks.get(DEFAULT_THEME_ID)}
`;

/** Per-theme sheets: file name (without .css) -> unformatted CSS source. */
function themeSheetSources() {
  const header = (id, source) => `/*
 * AUTO-GENERATED by scripts/sync-theme-presets.mjs. Do not edit by hand.
 *
 * Theme sheet for '${id}'. Source: ${source}.
 * The shared stylesheet carries the Default theme; src/theme/themeSheets.ts
 * attaches this file only in documents that show the theme.
 */
`;
  const sheets = new Map();
  for (const [id, rules] of canonicalThemeRules) {
    sheets.set(
      id,
      `${header(id, 'public @muxui/react/themes.css, contrast standard')}
@layer muxui {
${rules.join('\n\n')}
}
`,
    );
  }
  for (const theme of sheetLocalThemes) {
    sheets.set(
      theme.id,
      `${header(theme.id, 'repo-local Bento theme')}
${theme.css}

${muxCompatibilityBlocks.get(theme.id)}
`,
    );
  }
  return sheets;
}

const legacyAliases = Object.fromEntries(
  monochromeThemes.map((theme) => [theme.presetId, theme.id]),
);
const legacyAliasesSource = Object.entries(legacyAliases)
  .map(([legacyId, canonicalId]) => {
    const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(legacyId) ? legacyId : `'${legacyId}'`;
    return `  ${key}: '${canonicalId}',`;
  })
  .join('\n');

const indexTsSource = `// AUTO-GENERATED by scripts/sync-theme-presets.mjs.
// Canonical shipped theme metadata comes from @muxui/react/themes; sibling
// preset CSS files supply Bento-specific themes. Do not edit this registry.

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

/** Resolve presentation only; persistence keeps the original workspace id. */
export function resolveThemeId(id: string | undefined | null): string {
  const requestedId = id && id.length > 0 ? id : DEFAULT_THEME_ID;
  const canonicalId = LEGACY_THEME_ALIASES[requestedId] ?? requestedId;
  return BENTO_THEMES.some((theme) => theme.id === canonicalId)
    ? canonicalId
    : DEFAULT_THEME_ID;
}

export function getThemeMeta(id: string | undefined | null): BentoThemeMeta {
  return BENTO_THEMES.find((theme) => theme.id === resolveThemeId(id)) ?? BENTO_THEMES[0]!;
}
`;

const prettierOptions = (await prettier.resolveConfig(INDEX_CSS_PATH)) ?? {};
const indexCss = await prettier.format(indexCssSource, {
  ...prettierOptions,
  filepath: INDEX_CSS_PATH,
});
const indexTs = await prettier.format(indexTsSource, {
  ...prettierOptions,
  filepath: INDEX_TS_PATH,
});

let changed = writeIfChanged(INDEX_CSS_PATH, indexCss);
changed = writeIfChanged(INDEX_TS_PATH, indexTs) || changed;

mkdirSync(SHEETS_DIR, { recursive: true });
const sheets = themeSheetSources();
for (const [id, source] of sheets) {
  const sheetPath = resolve(SHEETS_DIR, `${id}.css`);
  const formatted = await prettier.format(source, { ...prettierOptions, filepath: sheetPath });
  changed = writeIfChanged(sheetPath, formatted) || changed;
}
// A removed theme must not leave its sheet behind in dist.
for (const entry of readdirSync(SHEETS_DIR)) {
  if (entry.endsWith('.css') && !sheets.has(entry.slice(0, -'.css'.length))) {
    rmSync(resolve(SHEETS_DIR, entry));
    changed = true;
  }
}

console.log(
  `sync-theme-presets: ${changed ? 'wrote' : 'unchanged'} ` +
    `${themes.length} themes (${localThemes.length} Bento, ` +
    `${standardThemes.length} standard, ${monochromeThemes.length} monochrome; ` +
    `${sheets.size} theme sheets)`,
);
