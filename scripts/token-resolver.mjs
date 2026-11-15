// Resolves custom properties in the generated chrome token CSS to literal values, the way a
// document root computes them. scripts/generate-chrome-tokens.mjs uses it twice:
//   - createShellPxResolver: the shell-sized lengths, pinned in px at the shell's root font
//     size. Each such token must have one value under every selector.
//   - createTokenResolver: the about: page sheet's literals for one workspace theme and UI
//     mode. Rules apply when their selector matches a root element with the given attributes,
//     in cascade order (importance, unlayered over layered, specificity, source order).
// Both follow var() references. The CSS is the shape the generators emit: style rules,
// @layer blocks and comments. Anything else is skipped as a rule the root cannot match.

import { splitTopLevelBlocks } from '../extensions/bento-shell/css-blocks.mjs';

/** Splits `text` at top-level occurrences of `separator`, outside parentheses and quotes. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const squash = (value) =>
  value.trim().replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')');

/** The custom property declarations of a style rule body, nested blocks ignored. */
function parseCustomDeclarations(body) {
  const flat = splitTopLevelBlocks(body).reduce(
    (text, block) => text.replace(`{${block.body}}`, ';'),
    body.replace(/\/\*[\s\S]*?\*\//g, ''),
  );
  const declarations = [];
  for (const part of splitTopLevel(flat, ';')) {
    const match = part.match(/^\s*(--[\w-]+)\s*:([\s\S]*)$/);
    if (!match) continue;
    const important = /!\s*important\s*$/i.test(match[2]);
    declarations.push({
      name: match[1],
      value: squash(match[2].replace(/!\s*important\s*$/i, '')),
      important,
    });
  }
  return declarations;
}

/**
 * Every style rule in `css` with its custom property declarations, in source order. Rules
 * inside an `@layer` block are marked layered; other at-rules are skipped.
 */
export function collectRules(css, layered = false, rules = []) {
  for (const { prelude, body } of splitTopLevelBlocks(css)) {
    // A block-less statement such as `@layer a, b;` ends up at the start of the next prelude.
    const selector = prelude.replace(/^(?:@[^{};]*;\s*)+/, '').trim();
    if (selector.startsWith('@')) {
      if (/^@layer\b/.test(selector)) collectRules(body, true, rules);
      continue;
    }
    rules.push({
      selector: squash(selector),
      declarations: parseCustomDeclarations(body),
      layered,
    });
  }
  return rules;
}

/**
 * The specificity [ids, classes, types] with which `selector` (a selector list) matches a root
 * element carrying `attributes`, or null. The root has no ancestors or siblings, so a complex
 * selector with a combinator never matches, nor does a pseudo-element.
 */
export function rootSpecificity(selector, attributes) {
  let best = null;
  for (const complex of splitTopLevel(selector, ',')) {
    const parts = compoundParts(complex.trim());
    if (!parts || !parts.every((part) => part.matches(attributes))) continue;
    const specificity = sum(parts.map((part) => part.specificity));
    if (!best || compare(specificity, best) > 0) best = specificity;
  }
  return best;
}

const sum = (list) =>
  list.reduce((total, [a, b, c]) => [total[0] + a, total[1] + b, total[2] + c], [0, 0, 0]);

// The simple selectors of a compound selector, each with its specificity and a match test
// against the root, or null for a selector the root can never match (a combinator, a class,
// a pseudo-element, another element type).
function compoundParts(compound) {
  const parts = [];
  let rest = compound;
  while (rest) {
    let match;
    if ((match = rest.match(/^\*/))) {
      parts.push({ specificity: [0, 0, 0], matches: () => true });
    } else if ((match = rest.match(/^(?:html|:root)(?![\w-])/))) {
      parts.push({ specificity: match[0] === 'html' ? [0, 0, 1] : [0, 1, 0], matches: () => true });
    } else if (
      (match = rest.match(/^\[\s*([\w-]+)\s*(?:=\s*(?:'([^']*)'|"([^"]*)"|([\w-]+))\s*)?\]/))
    ) {
      const [, name, single, double, bare] = match;
      const expected = single ?? double ?? bare;
      parts.push({
        specificity: [0, 1, 0],
        matches: (attributes) =>
          Object.hasOwn(attributes, name) &&
          (expected === undefined || attributes[name] === expected),
      });
    } else if ((match = rest.match(/^:(not|is|where)\(/))) {
      const close = matchingParen(rest, match[0].length - 1);
      const list = splitTopLevel(rest.slice(match[0].length, close), ',').map((complex) =>
        compoundParts(complex.trim()),
      );
      const kind = match[1];
      // :is() and :not() take the specificity of their most specific argument; :where() none.
      let specificity = [0, 0, 0];
      if (kind !== 'where') {
        for (const parts of list) {
          // An argument the root cannot match still counts towards the specificity, but
          // only its parts this parser understands: such an argument is never in the inputs.
          const own = parts ? sum(parts.map((part) => part.specificity)) : [0, 0, 0];
          if (compare(own, specificity) > 0) specificity = own;
        }
      }
      const any = (attributes) =>
        list.some((parts) => parts && parts.every((part) => part.matches(attributes)));
      parts.push({
        specificity,
        matches: kind === 'not' ? (attributes) => !any(attributes) : any,
      });
      rest = rest.slice(close + 1);
      continue;
    } else {
      return null;
    }
    rest = rest.slice(match[0].length);
  }
  return parts;
}

function matchingParen(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')' && --depth === 0) return index;
  }
  throw new Error(`unbalanced selector: ${text}`);
}

function compare(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

/**
 * Replaces each var() in `value` with `lookup(name)`, or with its fallback when `lookup`
 * returns undefined. `onFallback` runs for every var() that has one.
 */
function substituteVars(value, lookup, onFallback) {
  let output = '';
  let cursor = 0;
  for (;;) {
    const start = value.indexOf('var(', cursor);
    if (start < 0) return output + value.slice(cursor);
    const close = matchingParen(value, start + 3);
    const [name, ...fallback] = splitTopLevel(value.slice(start + 4, close), ',');
    const token = name.trim();
    if (fallback.length) onFallback(token);
    let replacement = lookup(token);
    if (replacement === undefined) {
      if (!fallback.length) throw new Error(`${token} is not declared`);
      replacement = substituteVars(fallback.join(',').trim(), lookup, onFallback);
    }
    output += value.slice(cursor, start) + replacement;
    cursor = close + 1;
  }
}

/**
 * A resolver for the custom properties in `css` as a root element with `attributes` computes
 * them: `resolve(name)` follows var() references (fallbacks included) and throws for a token
 * that is not declared for that root or refers to itself.
 */
export function createTokenResolver(css, { attributes = {} } = {}) {
  const winners = new Map();
  collectRules(css).forEach((rule, order) => {
    const specificity = rootSpecificity(rule.selector, attributes);
    if (!specificity) return;
    for (const { name, value, important } of rule.declarations) {
      const rank = [important ? 1 : 0, rule.layered ? 0 : 1, ...specificity, order];
      const current = winners.get(name);
      if (!current || compare(rank, current.rank) >= 0) winners.set(name, { value, rank });
    }
  });
  const cache = new Map();
  const resolve = (name, trail = []) => {
    if (trail.includes(name)) throw new Error(`${name} refers to itself`);
    if (cache.has(name)) return cache.get(name);
    const declared = winners.get(name);
    if (!declared) throw new Error(`${name} is not declared`);
    const value = substituteVars(
      declared.value,
      (ref) => (winners.has(ref) ? resolve(ref, [...trail, name]) : undefined),
      () => {},
    );
    cache.set(name, value);
    return value;
  };
  return { resolve };
}

// A resolver for the custom properties declared in `css`: each token's value with its
// var() references followed and its rem lengths converted to px at --font-size-root.
// Throws for a token that is missing, declared with different values, or not plain
// (a var() fallback), because the pinned value must equal what the shell computes.
export function createShellPxResolver(css) {
  const values = new Map();
  for (const rule of collectRules(css)) {
    for (const { name, value } of rule.declarations) {
      if (!values.has(name)) values.set(name, new Set());
      values.get(name).add(value);
    }
  }
  const declared = (name) => {
    const set = values.get(name);
    if (!set || set.size !== 1) {
      throw new Error(`${name} is ${set ? 'declared with different values' : 'not declared'}`);
    }
    return [...set][0];
  };
  const rootPx = Number.parseFloat(declared('--font-size-root'));
  if (!(rootPx > 0)) throw new Error('--font-size-root is not a px length');
  const resolve = (name, trail = []) => {
    if (trail.includes(name)) throw new Error(`${name} refers to itself`);
    return substituteVars(
      declared(name),
      (ref) => resolve(ref, [...trail, name]),
      () => {
        throw new Error(`${name} has a var() fallback`);
      },
    ).replace(/(\d*\.?\d+)rem\b/g, (_match, rem) => `${Number((rem * rootPx).toFixed(4))}px`);
  };
  return { rootPx, resolve };
}
