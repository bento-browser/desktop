const THEME_SCOPE_CLASS = String.raw`(?<scope>\.[-_A-Za-z][-_A-Za-z0-9]*)(?![\w-])`;

const LIGHT_SCOPE_SELECTOR = new RegExp(
  String.raw`^:where\(\s*html\s*:\s*not\(\s*\[data-color-mode\s*=\s*(?<quote>["'])dark\k<quote>\s*\]\s*\)\s*\)\s+${THEME_SCOPE_CLASS}(?:\s*,\s*\.light\s+\k<scope>(?![\w-]))?$`,
);

const DARK_SCOPE_SELECTOR = new RegExp(
  String.raw`^html\s*\[data-color-mode\s*=\s*(?<quote>["'])dark\k<quote>\s*\]\s+${THEME_SCOPE_CLASS}(?:\s*,\s*\.dark\s+\k<scope>(?![\w-]))?$`,
);

const MEDIA_DARK_SCOPE_SELECTOR = new RegExp(
  String.raw`^:where\(\s*html\s*:\s*not\(\s*\[data-color-mode\s*=\s*(?<quote>["'])light\k<quote>\s*\]\s*\)\s*\)\s+${THEME_SCOPE_CLASS}$`,
);

const ROOT_SELECTOR = /^:root$/;
const LEADING_TRIVIA = /^(?:(?:\s|\/\*[\s\S]*?\*\/)*)(?:)/u;

function scopedRoot(id, quote, mode) {
  const scope = `[data-bento-theme=${quote}${id}${quote}]`;
  if (mode === 'light') return `html${scope}:not([data-color-mode=${quote}dark${quote}])`;
  if (mode === 'dark') return `html${scope}[data-color-mode=${quote}dark${quote}]`;
  return `html${scope}:not([data-color-mode=${quote}light${quote}])`;
}

function selectorParts(prelude) {
  const leading = prelude.match(LEADING_TRIVIA)?.[0] ?? '';
  const remainder = prelude.slice(leading.length);
  const trailing = remainder.match(/\s*$/u)?.[0] ?? '';
  return {
    leading,
    selector: remainder.slice(0, remainder.length - trailing.length),
    trailing,
  };
}

function rewriteSelector(prelude, id, attributeQuote) {
  const { leading, selector, trailing } = selectorParts(prelude);
  const candidates = [
    [LIGHT_SCOPE_SELECTOR, 'light'],
    [DARK_SCOPE_SELECTOR, 'dark'],
    [MEDIA_DARK_SCOPE_SELECTOR, 'media-dark'],
  ];

  for (const [pattern, mode] of candidates) {
    const match = pattern.exec(selector);
    if (match) {
      return `${leading}${scopedRoot(id, match.groups.quote, mode)}${trailing}`;
    }
  }

  if (ROOT_SELECTOR.test(selector)) {
    return `${leading}[data-bento-theme=${attributeQuote}${id}${attributeQuote}]${trailing}`;
  }
  return prelude;
}

function rewriteRulePreludes(css, id, attributeQuote) {
  const edits = [];
  let preludeStart = 0;
  let comment = false;
  let quote = null;
  let escaped = false;

  for (let index = 0; index < css.length; index += 1) {
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
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
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
    if (character === '{') {
      const prelude = css.slice(preludeStart, index);
      const rewrittenPrelude = rewriteSelector(prelude, id, attributeQuote);
      if (rewrittenPrelude !== prelude) edits.push([preludeStart, index, rewrittenPrelude]);
      preludeStart = index + 1;
    } else if (character === '}') {
      preludeStart = index + 1;
    }
  }

  let rewritten = css;
  for (const [start, end, replacement] of edits.reverse()) {
    rewritten = `${rewritten.slice(0, start)}${replacement}${rewritten.slice(end)}`;
  }
  return rewritten;
}

/**
 * Rewrite the documented Scale page-root selectors for a Bento theme.
 *
 * The page-root class is captured as a complete class token. A legacy
 * `.light`/`.dark` sibling is accepted only when it repeats the same captured
 * class, so unrelated selector lists remain unchanged.
 */
export function rewriteThemeSelectors(css, id, { attributeQuote = '"' } = {}) {
  if (typeof css !== 'string' || typeof id !== 'string') {
    throw new TypeError('rewriteThemeSelectors expects CSS and theme id strings');
  }
  if (!/^['"]$/.test(attributeQuote)) {
    throw new TypeError('rewriteThemeSelectors attributeQuote must be a quote character');
  }

  return rewriteRulePreludes(css, id, attributeQuote);
}
