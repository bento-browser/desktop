/**
 * The check on Bento's Default theme source, extensions/bento-shell/src/theme/presets/default.css.
 *
 * Default is Mux's Harbour preset under Bento's id. scripts/sync-theme-presets.mjs copies
 * Harbour's text colours into Default's generated rules, so the source may hold nothing but
 * Harbour's raw ladders: every declaration, under any selector, must be a ladder token that
 * Harbour declares, with Harbour's value. Anything else (a text colour, a semantic role, a
 * standard property, an at-rule) could override the derived values and is rejected.
 */

import { findClosingBrace } from '../extensions/bento-shell/css-blocks.mjs';

/** Mux's contrast-chosen text colours. Every other foreground role is a var() alias of one. */
/** CSS with its comments removed, so a value written inside a comment is never read. */
export function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The first hex value `css` declares for `token`, ignoring comments; the validator and the sync read the same text. */
export function extractToken(css, token) {
  return stripCssComments(css)
    .match(new RegExp(`${token}\\s*:\\s*(#[0-9a-fA-F]{3,8})`))?.[1]
    .toLowerCase();
}

export const TEXT_COLOUR_TOKEN = /^--muxui-semantic-color-[a-z-]+-\d+-fg$/;

/** Harbour's text colour declarations per color scheme: what the sync copies into Default. */
export function harbourTextColours(harbourSchemes) {
  const pick = (declarations) =>
    new Map([...declarations].filter(([token]) => TEXT_COLOUR_TOKEN.test(token)));
  return { light: pick(harbourSchemes.light), dark: pick(harbourSchemes.dark) };
}

/** Harbour's raw ladders under the names default.css uses: --brand-N and --neutral-default-N. */
function harbourLadder(harbourDeclarations) {
  const ladder = new Map();
  for (const [token, value] of harbourDeclarations) {
    const match = token.match(/^--muxui-reference-color-(brand|neutral)-(\d+)$/);
    if (!match) continue;
    const name = match[1] === 'brand' ? `--brand-${match[2]}` : `--neutral-default-${match[2]}`;
    ladder.set(name, value.trim().toLowerCase());
  }
  return ladder;
}

/**
 * The text colours the Harbour derivation emits, under their Mux names and the legacy names
 * Bento's token bridge gives them (--color-N-fg, --neutral-N-fg, --neutral-default-N-fg).
 */
function harbourTextColourNames(textColourTokens) {
  const names = new Set();
  for (const token of textColourTokens) {
    names.add(token);
    const match = token.match(/^--muxui-semantic-color-(color|neutral)-(\d+)-fg$/);
    if (!match) continue;
    names.add(`--${match[1]}-${match[2]}-fg`);
    if (match[1] === 'neutral') names.add(`--neutral-default-${match[2]}-fg`);
  }
  return names;
}

/** Every declaration in `css` with the selector (and enclosing at-rules) it sits under. */
function declarations(css, errors) {
  const found = [];
  const walk = (text, context) => {
    let cursor = 0;
    while (cursor < text.length) {
      const open = text.indexOf('{', cursor);
      if (open < 0) {
        if (text.slice(cursor).trim())
          errors.push(`stray text outside a rule: ${text.slice(cursor).trim()}`);
        break;
      }
      const close = findClosingBrace(text, open);
      if (close < 0) {
        errors.push('an unterminated block');
        break;
      }
      const prelude = text.slice(cursor, open).trim();
      const body = text.slice(open + 1, close);
      if (prelude.startsWith('@') || prelude.includes(';')) {
        errors.push(`an at-rule or statement, which Default does not need: ${prelude}`);
      } else if (body.includes('{')) {
        errors.push(`a nested rule under ${prelude}`);
      } else {
        const where = context ? `${context} ${prelude}` : prelude;
        for (const part of body.split(';')) {
          if (!part.trim()) continue;
          const colon = part.indexOf(':');
          if (colon < 0) {
            errors.push(`${where}: unreadable declaration ${part.trim()}`);
            continue;
          }
          found.push({
            where,
            property: part.slice(0, colon).trim(),
            value: part.slice(colon + 1).trim(),
          });
        }
      }
      cursor = close + 1;
    }
  };
  walk(stripCssComments(css), '');
  return found;
}

/**
 * Why `css` is not a valid Default source, as messages (empty when it is valid).
 *
 * @param {string} css default.css
 * @param {{ light: Map<string, string>, dark: Map<string, string> }} harbourSchemes Harbour's
 *   contrast 'standard' declarations per color scheme (themeSchemeDeclarations in mux-css.mjs)
 * @param {{ brand: number[], neutral: number[] }} shades the ladder shades the generated
 *   projection needs (readReferenceShades in mux-css.mjs)
 */
export function defaultThemeSourceErrors(css, harbourSchemes, shades) {
  const ladder = harbourLadder(harbourSchemes.light);
  const foregrounds = harbourTextColours(harbourSchemes);
  const textColours = harbourTextColourNames([
    ...foregrounds.light.keys(),
    ...foregrounds.dark.keys(),
  ]);
  const required = [
    ...shades.brand.map((shade) => `--brand-${shade}`),
    ...shades.neutral.map((shade) => `--neutral-default-${shade}`),
  ];
  const errors = [];
  const declared = new Set();
  for (const { where, property, value } of declarations(css, errors)) {
    if (textColours.has(property)) {
      errors.push(`${where}: ${property} sets a text colour; Default takes Harbour's`);
    } else if (!ladder.has(property)) {
      errors.push(`${where}: ${property} is not one of Harbour's ladder tokens`);
    } else if (value.toLowerCase() !== ladder.get(property)) {
      errors.push(`${where}: ${property} ${value} (Harbour ${ladder.get(property)})`);
    } else {
      declared.add(property);
    }
  }
  for (const token of required) {
    if (!declared.has(token)) errors.push(`${token} is missing (Harbour ${ladder.get(token)})`);
  }
  return errors;
}
