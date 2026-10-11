// CSS scanning helpers shared by the theme generators (scripts/sync-theme-presets.mjs and
// scripts/generate-chrome-tokens.mjs) and the Vite plugins that rewrite the built stylesheet.
// They work on text rather than a parsed tree so none of those need a PostCSS dependency, and
// they only understand what the generated Mux and Bento CSS contains: comments, quoted
// strings, and nested braces.

/** Index of the `}` that closes the block opened at `openIndex`, or -1. */
export function findClosingBrace(css, openIndex) {
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

/**
 * Split CSS into its top-level blocks. Each entry has the prelude text (selector list or
 * at-rule header, comments removed and trimmed) and the raw body between the braces. A
 * top-level statement without a block (such as `@layer a, b;`) is not a block and is skipped.
 */
export function splitTopLevelBlocks(css) {
  const blocks = [];
  let cursor = 0;
  while (cursor < css.length) {
    const openIndex = css.indexOf('{', cursor);
    if (openIndex < 0) break;
    const closeIndex = findClosingBrace(css, openIndex);
    if (closeIndex < 0) throw new Error('CSS has an unterminated block');
    const prelude = css
      .slice(cursor, openIndex)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim();
    blocks.push({ prelude, body: css.slice(openIndex + 1, closeIndex) });
    cursor = closeIndex + 1;
  }
  return blocks;
}

/**
 * Replace each top-level `@layer <name> { ... }` block with its contents. Native chrome
 * stylesheets are unlayered, so layer wrappers that exist for the shell must come off.
 */
export function unwrapTopLevelLayers(css) {
  let output = '';
  let cursor = 0;
  while (cursor < css.length) {
    const openIndex = css.indexOf('{', cursor);
    if (openIndex < 0) return output + css.slice(cursor);
    const closeIndex = findClosingBrace(css, openIndex);
    if (closeIndex < 0) throw new Error('CSS has an unterminated block');
    const prelude = css.slice(cursor, openIndex);
    const stripped = prelude.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const body = css.slice(openIndex + 1, closeIndex);
    output += /^@layer\s+[\w.-]+$/.test(stripped) ? body : `${prelude}{${body}}`;
    cursor = closeIndex + 1;
  }
  return output;
}

const THEME_ATTRIBUTE =
  /\[\s*data-(?:muxui|bento)-theme\s*=\s*(?:'([^']*)'|"([^"]*)"|([\w-]+))\s*\]/g;

/** Theme ids named by `[data-muxui-theme=x]` or `[data-bento-theme=x]` tests in a selector. */
export function themeIdsInSelector(selector) {
  return [...selector.matchAll(THEME_ATTRIBUTE)].map((match) => match[1] ?? match[2] ?? match[3]);
}
