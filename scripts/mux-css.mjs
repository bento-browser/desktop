/* global console, process */
/**
 * The one place that reads the shape of the public @muxui/react CSS and theme data.
 *
 * scripts/sync-theme-presets.mjs and scripts/generate-chrome-tokens.mjs both consume
 * styles.css, themes.css and the @muxui/react/themes export. Everything they need to know
 * about how Mux writes those files lives here, so a Mux release that reshapes them fails in
 * one place with one message instead of drifting between two copies. Only the public package
 * surface is read; nothing from Mux's private token compiler or schema is imported.
 *
 * Every function throws MuxSourceError when the input is not the shape Bento understands.
 * The generators wrap their calls in exitOnMuxSourceError to print it and stop the build.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { dropContrastMoreSelectors } from '../extensions/bento-shell/contrast-more.mjs';
import { splitTopLevelBlocks, themeIdsInSelector } from '../extensions/bento-shell/css-blocks.mjs';

const STYLES = '@muxui/react/styles.css';
const THEMES_CSS = '@muxui/react/themes.css';
const THEMES_MODULE = '@muxui/react/themes';

// Contrast is fixed to 'standard', so the public contrast='more' block is not
// projected (see extensions/bento-shell/contrast-more.mjs).
export const PUBLIC_MODE_SELECTORS = [
  "[data-muxui-color-scheme='light']",
  "[data-muxui-color-scheme='dark']",
  "[data-muxui-contrast='standard']",
];
export const PUBLIC_CLOSURE_SELECTOR = `:root,
[data-muxui-color-scheme],
[data-muxui-contrast],
[data-muxui-motion],
[data-muxui-density],
[data-muxui-direction]`;

/** Theme collections the picker and the legacy-id aliases know how to group. */
const THEME_COLLECTIONS = new Set(['standard', 'monochrome']);

export class MuxSourceError extends Error {
  name = 'MuxSourceError';
}

function exitWith(prefix, error) {
  if (!(error instanceof MuxSourceError)) throw error;
  console.error(`${prefix}: ${error.message}`);
  process.exit(1);
}

/**
 * Run `fn` (sync or async); print a MuxSourceError as `<prefix>: <message>` and exit 1.
 * Other errors rethrow.
 */
export function exitOnMuxSourceError(prefix, fn) {
  try {
    const result = fn();
    return result instanceof Promise ? result.catch((error) => exitWith(prefix, error)) : result;
  } catch (error) {
    return exitWith(prefix, error);
  }
}

const squash = (text) => text.replace(/\s+/g, ' ').trim();

/** splitTopLevelBlocks, reporting a malformed file as a MuxSourceError naming `source`. */
function topLevelBlocks(css, source) {
  try {
    return splitTopLevelBlocks(css);
  } catch (error) {
    throw new MuxSourceError(`${source} could not be read: ${error.message}`);
  }
}

/** Keep RC4's public layers separate so component roots cannot enter the token bridge. */
function publicLayerCss(css, source) {
  const blocks = topLevelBlocks(css, source);
  const order = '@layer muxui.tokens, muxui.components, muxui.utilities;';
  const layers = new Map();
  for (const [index, block] of blocks.entries()) {
    let prelude = squash(block.prelude);
    if (index === 0) {
      if (!prelude.startsWith(`${order} `)) {
        throw new MuxSourceError(`${source} changed the public layer order`);
      }
      prelude = prelude.slice(order.length).trim();
    }
    const name = /^@layer muxui\.(tokens|components|utilities)$/.exec(prelude)?.[1];
    if (!name || layers.has(name)) {
      throw new MuxSourceError(`${source} has an unexpected or duplicate public layer: ${prelude}`);
    }
    layers.set(name, block.body);
    if (name !== 'tokens' && source === THEMES_CSS && block.body.trim()) {
      throw new MuxSourceError(`${source} has rules outside the public token layer`);
    }
  }
  if (!layers.get('tokens'))
    throw new MuxSourceError(`${source} is missing the public token layer`);
  return layers;
}

/**
 * Body of the flat top-level rule whose selector list is exactly `selector`. Matching the
 * whole selector list (not a substring) keeps `:root` from landing on the compatibility
 * closure rule, which also starts with `:root,`.
 */
export function extractPublicBlock(css, selector, source = STYLES) {
  const wanted = squash(selector);
  const matches = topLevelBlocks(css, source).filter(({ prelude }) => squash(prelude) === wanted);
  if (matches.length === 0)
    throw new MuxSourceError(`${source} is missing the public block ${wanted}`);
  if (matches.length > 1) {
    throw new MuxSourceError(`${source} has ${matches.length} blocks for ${wanted}, expected one`);
  }
  const body = matches[0].body.trim();
  if (!body || body.includes('{')) {
    throw new MuxSourceError(`${source} changed the flat declaration shape for ${wanted}`);
  }
  return body;
}

function requireDeclaration(body, token, label) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(?:^|\\n)\\s*${escaped}\\s*:`).test(body)) {
    throw new MuxSourceError(`${STYLES} ${label} is missing ${token}`);
  }
}

/** Custom-property declarations of a flat block body, in source order. */
export function parseDeclarations(body) {
  return new Map(
    [...body.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gim)].map((match) => [
      match[1],
      match[2].trim(),
    ]),
  );
}

/**
 * The public blocks both generators project: the root block, the color-scheme and contrast
 * blocks Bento keeps, and the compatibility closure. Also checks the tokens Bento's legacy
 * bridge and chrome sheet depend on are still declared.
 *
 * @returns {{ root: string, modes: { selector: string, body: string }[], closure: string }}
 */
export function readPublicBlocks(stylesCss) {
  const layers = publicLayerCss(stylesCss, STYLES);
  const tokenCss = layers.get('tokens');
  const root = extractPublicBlock(tokenCss, ':root');
  const modes = PUBLIC_MODE_SELECTORS.map((selector) => ({
    selector,
    body: extractPublicBlock(tokenCss, selector),
  }));
  const closure = extractPublicBlock(layers.get('components') ?? '', PUBLIC_CLOSURE_SELECTOR);

  for (const token of [
    '--muxui-reference-color-brand-60',
    '--muxui-reference-color-neutral-20',
    '--muxui-reference-color-neutral-cool-20',
    '--muxui-reference-effect-shadow-s',
    '--muxui-semantic-effect-scrim',
  ]) {
    requireDeclaration(root, token, 'root block');
  }
  requireDeclaration(closure, '--muxui-popup-bg', 'compatibility closure');
  for (const { selector, body } of modes.slice(0, 2)) {
    requireDeclaration(body, '--muxui-semantic-color-neutral-5', selector);
  }
  return { root, modes, closure };
}

/** Sorted shade numbers of the public brand and neutral reference ladders. */
export function readReferenceShades(rootBody) {
  const shades = (family) =>
    [...rootBody.matchAll(new RegExp(`--muxui-reference-color-${family}-(\\d+)\\s*:`, 'g'))]
      .map((match) => Number(match[1]))
      .sort((left, right) => left - right);
  const brand = shades('brand');
  const neutral = shades('neutral');
  if (brand.length === 0 || neutral.length === 0) {
    throw new MuxSourceError('public Mux reference brand/neutral ladders are empty');
  }
  return { brand, neutral };
}

const DARK_NEGATED = /:not\(\s*\[data-muxui-color-scheme\s*=\s*(['"])dark\1\s*\]\s*\)/;
const DARK_POSITIVE = /\[data-muxui-color-scheme\s*=\s*(['"])dark\1\s*\]/;

/** 'light' for `:not([...='dark'])` selectors, 'dark' for `[...='dark']`, else null. */
function colorSchemeOfThemeRule(selector) {
  const negated = DARK_NEGATED.test(selector);
  const positive = DARK_POSITIVE.test(selector.replaceAll(new RegExp(DARK_NEGATED, 'g'), ''));
  if (negated && !positive) return 'light';
  if (positive && !negated) return 'dark';
  return null;
}

/**
 * Group the public themes.css rules by theme id, dropping contrast='more' rules (see
 * extensions/bento-shell/contrast-more.mjs). Fails on any rule shape this does not
 * understand, so a Mux change cannot silently leak rules into the wrong sheet, and on a
 * theme that lacks a rule for either color scheme.
 *
 * @returns {Map<string, string[]>} theme id to its rules, in source order
 */
export function splitCanonicalThemeRules(themesCss, themeIds) {
  const rulesById = new Map(themeIds.map((id) => [id, []]));
  const schemesById = new Map(themeIds.map((id) => [id, new Set()]));
  for (const { prelude, body } of topLevelBlocks(
    publicLayerCss(themesCss, THEMES_CSS).get('tokens'),
    THEMES_CSS,
  )) {
    if (prelude.startsWith('@')) {
      throw new MuxSourceError(`${THEMES_CSS} has an unexpected at-rule: ${prelude}`);
    }
    const selector = dropContrastMoreSelectors(prelude);
    if (!selector) continue;
    const ids = new Set(themeIdsInSelector(selector));
    const [id] = ids;
    if (ids.size !== 1 || !rulesById.has(id)) {
      throw new MuxSourceError(`${THEMES_CSS} has a rule outside the canonical themes: ${prelude}`);
    }
    const scheme = colorSchemeOfThemeRule(selector);
    if (!scheme) {
      throw new MuxSourceError(
        `${THEMES_CSS} has a theme rule with an unknown color scheme: ${prelude}`,
      );
    }
    schemesById.get(id).add(scheme);
    rulesById.get(id).push(`${selector} {${body}}`);
  }
  for (const [id, rules] of rulesById) {
    if (rules.length === 0) throw new MuxSourceError(`${THEMES_CSS} has no rules for theme ${id}`);
    for (const scheme of ['light', 'dark']) {
      if (!schemesById.get(id).has(scheme)) {
        throw new MuxSourceError(
          `${THEMES_CSS} has no ${scheme} color scheme rule for theme ${id}`,
        );
      }
    }
  }
  return rulesById;
}

/**
 * Check the MUXUI_THEME_PRESETS record list. The count is whatever the package ships: the
 * checks are that it is non-empty, every record is well formed, ids are unique, legacy
 * monochrome preset ids are unique (they become the alias table), and Mux's own default
 * theme is one of them.
 */
export function validateThemePresets(presets, defaultPresetId) {
  if (!Array.isArray(presets) || presets.length === 0) {
    throw new MuxSourceError(`${THEMES_MODULE} must export a non-empty MUXUI_THEME_PRESETS array`);
  }
  const ids = new Set();
  const monochromePresetIds = new Set();
  for (const theme of presets) {
    if (
      !theme ||
      typeof theme.id !== 'string' ||
      typeof theme.presetId !== 'string' ||
      !THEME_COLLECTIONS.has(theme.collection) ||
      typeof theme.name !== 'string' ||
      typeof theme.description !== 'string' ||
      typeof theme.swatch?.primary !== 'string' ||
      typeof theme.swatch?.secondary !== 'string'
    ) {
      throw new MuxSourceError(
        `${THEMES_MODULE} contains an invalid canonical preset record: ${JSON.stringify(theme)}`,
      );
    }
    if (!/^[a-z][a-z0-9-]*$/.test(theme.id)) {
      throw new MuxSourceError(
        `${THEMES_MODULE} theme id must be lowercase kebab-case: ${theme.id}`,
      );
    }
    if (ids.has(theme.id))
      throw new MuxSourceError(`${THEMES_MODULE} repeats theme id ${theme.id}`);
    ids.add(theme.id);
    if (theme.collection === 'monochrome') {
      if (monochromePresetIds.has(theme.presetId)) {
        throw new MuxSourceError(`${THEMES_MODULE} repeats monochrome preset id ${theme.presetId}`);
      }
      monochromePresetIds.add(theme.presetId);
    }
  }
  if (defaultPresetId !== undefined && !ids.has(defaultPresetId)) {
    throw new MuxSourceError(
      `${THEMES_MODULE} default theme ${defaultPresetId} is not in MUXUI_THEME_PRESETS`,
    );
  }
  return presets;
}

/**
 * Read styles.css and themes.css through `requireFn` (a require rooted at the shell
 * package) with their sha256 digests and the parsed public blocks.
 */
export function loadMuxPublicCss(requireFn) {
  let stylesPath;
  let themesPath;
  try {
    stylesPath = requireFn.resolve(STYLES);
    themesPath = requireFn.resolve(THEMES_CSS);
  } catch (error) {
    throw new MuxSourceError(`cannot resolve public Mux CSS from @bento/shell (${error.message})`);
  }
  const stylesCss = readFileSync(stylesPath, 'utf-8');
  const themesCss = readFileSync(themesPath, 'utf-8');
  const digest = (css) => createHash('sha256').update(css).digest('hex');
  return {
    stylesCss,
    themesCss,
    stylesDigest: digest(stylesCss),
    themesDigest: digest(themesCss),
    blocks: readPublicBlocks(stylesCss),
  };
}

/** Import and validate the public @muxui/react/themes preset list. */
export async function loadMuxThemePresets(requireFn) {
  let entryPath;
  try {
    entryPath = requireFn.resolve(THEMES_MODULE);
  } catch (error) {
    throw new MuxSourceError(
      `cannot resolve ${THEMES_MODULE} from @bento/shell (${error.message})`,
    );
  }
  const themesModule = await import(pathToFileURL(entryPath).href);
  return validateThemePresets(
    themesModule.MUXUI_THEME_PRESETS,
    themesModule.MUXUI_DEFAULT_THEME_PRESET_ID,
  );
}
