// Contrast is fixed to 'standard' (themeScope.ts, useFirefoxTheme.ts, public/boot.js),
// so any rule that requires data-muxui-contrast='more' can never match. Mux keeps
// those rules upstream; Bento drops them from its shipped CSS until a contrast
// setting exists. Shared by the Vite PostCSS step and scripts/generate-chrome-tokens.mjs.
//
// Only a positive attribute test at the top level of a selector counts. Tests
// inside :not(), :is(), :where() or :has() are kept, because dropping them
// could change what the rule matches for 'standard'.

const CONTRAST_MORE_ATTRIBUTE =
  /^\s*data-muxui-contrast\s*=\s*(?:'more'|"more"|more)\s*(?:[is]\s*)?$/;

/** Index of the quote that closes the string opened at `open`. */
function stringEnd(text, open) {
  for (let index = open + 1; index < text.length; index += 1) {
    if (text[index] === '\\') index += 1;
    else if (text[index] === text[open]) return index;
  }
  return text.length;
}

/** Index of the `]` that closes the attribute selector opened at `open`. */
function attributeEnd(selector, open) {
  for (let index = open + 1; index < selector.length; index += 1) {
    const character = selector[index];
    if (character === '"' || character === "'") index = stringEnd(selector, index);
    else if (character === ']') return index;
  }
  return selector.length;
}

/** Split a selector list at its top-level commas. */
function splitSelectorList(list) {
  const selectors = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const character = list[index];
    if (character === '\\') index += 1;
    else if (character === '"' || character === "'") index = stringEnd(list, index);
    else if (character === '[') index = attributeEnd(list, index);
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ',' && depth === 0) {
      selectors.push(list.slice(start, index));
      start = index + 1;
    }
  }
  selectors.push(list.slice(start));
  return selectors;
}

/** True when a single complex selector matches only under contrast='more'. */
export function selectorRequiresContrastMore(selector) {
  let depth = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const character = selector[index];
    if (character === '\\') index += 1;
    else if (character === '"' || character === "'") index = stringEnd(selector, index);
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === '[') {
      const end = attributeEnd(selector, index);
      if (depth === 0 && CONTRAST_MORE_ATTRIBUTE.test(selector.slice(index + 1, end))) return true;
      index = end;
    }
  }
  return false;
}

/**
 * Remove the contrast='more' alternatives from a selector list. Returns the
 * input untouched when nothing matches and an empty string when nothing is left.
 */
export function dropContrastMoreSelectors(selectorList) {
  const selectors = splitSelectorList(selectorList);
  const kept = selectors.filter((selector) => !selectorRequiresContrastMore(selector));
  return kept.length === selectors.length ? selectorList : kept.join(',').trim();
}

/** True when any rule is nested somewhere inside `node`. */
function containsRule(node) {
  return node.nodes?.some((child) => child.type === 'rule' || containsRule(child)) ?? false;
}

/**
 * PostCSS plugin form, passed to Vite as `css.postcss.plugins`.
 *
 * It stays conservative in two cases that change the cascade for 'standard':
 * - A rule with nested rules is never removed or rewritten. A nested ':not(&)'
 *   still matches elements that are not contrast='more', and '&' takes its
 *   specificity from the whole parent selector list.
 * - A '@layer name { ... }' block this pass empties becomes '@layer name;', so
 *   the layer keeps its place in the layer order.
 */
export const stripContrastMore = {
  postcssPlugin: 'bento-strip-contrast-more',
  Once(root, { AtRule }) {
    root.walkRules((rule) => {
      if (containsRule(rule)) return;
      const kept = dropContrastMoreSelectors(rule.selector);
      if (kept === rule.selector) return;
      if (kept) {
        rule.selector = kept;
        return;
      }
      // Also drop any at-rule (@media, @scope) this removal leaves empty.
      let parent = rule.parent;
      rule.remove();
      while (parent && parent.type === 'atrule' && parent.nodes?.length === 0) {
        if (parent.name === 'layer' && parent.params) {
          parent.replaceWith(new AtRule({ name: 'layer', params: parent.params }));
          break;
        }
        const next = parent.parent;
        parent.remove();
        parent = next;
      }
    });
  },
};
