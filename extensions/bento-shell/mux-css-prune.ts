// Drop Mux component CSS that the shell bundle can never render.
//
// @muxui/react ships one stylesheet for all 79 components, but Bento renders a fraction of
// them. After Vite has built the bundle, this plugin removes the rules that need a class
// from a component family Bento does not use. It consumes only the public styles.css and the
// bundle itself; nothing from the package is copied or imported privately.
//
// Safety rests on two checks, both made against the finished bundle:
//   - A family is pruned only when no JavaScript chunk or HTML page contains its class
//     prefix. Mux writes a component's class names as literals inside the component's own
//     code (`cx('muxui-switch-field', ...)`), and Rollup keeps that code only when Bento
//     can reach the component, so a literal in the bundle means the family is in use and
//     its CSS stays. Bento's own `muxui-*` class names are in the bundle too.
//   - After pruning, every `muxui-*` class the JavaScript names must still be matched by
//     the stylesheet's remaining rules, or the build fails.
//
// MUX_UNUSED_COMPONENT_CLASSES lists only families whose class names Mux writes literally.
// Do not add a family Mux composes only at runtime (`muxui-${name}`, `muxui-text--${v}`:
// grid-list, listbox, menu, text, and others), because the literal check cannot see those.
// Adding a component to Bento needs no change here: its family stops being pruned on its own.

import type { Plugin } from 'vite';
import { findClosingBrace } from './css-blocks.mjs';

/** Class prefixes (no dot). A prefix covers itself and `-part`, `_part`, `--modifier` names. */
export const MUX_UNUSED_COMPONENT_CLASSES: readonly string[] = [
  'muxui-autocomplete',
  'muxui-calendar',
  'muxui-checkbox-field',
  'muxui-color-slider',
  'muxui-color-wheel',
  'muxui-combo-box',
  'muxui-date-input',
  'muxui-date-field',
  'muxui-time-field',
  'muxui-date-dialog',
  'muxui-date-picker',
  'muxui-date-popover',
  'muxui-date-range',
  'muxui-date-trigger',
  'muxui-lightbox',
  'muxui-markdown',
  'muxui-multi-select',
  'muxui-radio',
  'muxui-radio-field',
  'muxui-range-calendar',
  'muxui-resizable',
  'muxui-slider',
  'muxui-switch',
  'muxui-switch-field',
  'muxui-tag-select',
  'muxui-text-editor',
  'muxui-toast',
  'muxui-tree',
];

const inFamily = (token: string, family: string) =>
  token === family || token.startsWith(`${family}-`) || token.startsWith(`${family}_`);

/** Split a selector list at its top-level commas. */
function selectorAlternatives(list: string): string[] {
  const alternatives: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < list.length; index += 1) {
    const character = list[index];
    if (character === '\\') index += 1;
    else if (character === '(' || character === '[') depth += 1;
    else if (character === ')' || character === ']') depth -= 1;
    else if (character === ',' && depth === 0) {
      alternatives.push(list.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(list.slice(start));
  return alternatives;
}

/**
 * `muxui-*` classes a selector needs to match: the positive ones outside :not(), :is(),
 * :where(), :has() and attribute tests, where a class could be one of several or a negation.
 */
function requiredClasses(selector: string): string[] {
  let stripped = selector.replace(/\[(?:[^\]"']|"[^"]*"|'[^']*')*\]/g, '');
  for (let previous = ''; previous !== stripped; ) {
    previous = stripped;
    stripped = stripped.replace(/:(?:not|is|where|has)\((?:[^()]|\([^()]*\))*\)/g, '');
  }
  return [...stripped.matchAll(/\.(muxui-[\w-]+)/g)].map((match) => match[1]!);
}

/** Index of the last `;` that is not inside parentheses or a string, or -1. */
function lastStatementEnd(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  let end = -1;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '(') depth += 1;
    else if (character === ')') depth -= 1;
    else if (character === ';' && depth === 0) end = index;
  }
  return end;
}

const GROUPING_AT_RULES = /^@(?:layer|media|supports|scope|container)\b/;

/** Remove the rules that need a class from one of `families`. */
export function pruneCssFamilies(css: string, families: readonly string[]): string {
  if (families.length === 0) return css;
  const pruned = (token: string) => families.some((family) => inFamily(token, family));

  let output = '';
  let cursor = 0;
  while (cursor < css.length) {
    const openIndex = css.indexOf('{', cursor);
    if (openIndex < 0) return output + css.slice(cursor);
    const closeIndex = findClosingBrace(css, openIndex);
    if (closeIndex < 0) throw new Error('mux-css-prune: unterminated CSS block');

    // Block-less statements (`@layer a,b;`) can precede a rule in minified CSS.
    const head = css.slice(cursor, openIndex);
    const statementEnd = lastStatementEnd(head);
    output += head.slice(0, statementEnd + 1);
    const prelude = head.slice(statementEnd + 1);
    const body = css.slice(openIndex + 1, closeIndex);
    cursor = closeIndex + 1;

    const trimmed = prelude.trim();
    if (trimmed.startsWith('@')) {
      if (!GROUPING_AT_RULES.test(trimmed)) {
        output += `${prelude}{${body}}`;
        continue;
      }
      const inner = pruneCssFamilies(body, families);
      if (inner.trim() !== '') output += `${prelude}{${inner}}`;
      else if (/^@layer\s+[\w.-]+$/.test(trimmed)) output += `${trimmed};`;
      continue;
    }
    // A rule with nested rules keeps its whole selector list.
    if (body.includes('{')) {
      output += `${prelude}{${body}}`;
      continue;
    }
    const alternatives = selectorAlternatives(prelude);
    const kept = alternatives.filter((alternative) => !requiredClasses(alternative).some(pruned));
    if (kept.length === alternatives.length) output += `${prelude}{${body}}`;
    else if (kept.length > 0) output += `${kept.join(',').trim()}{${body}}`;
  }
  return output;
}

/** Every `muxui-*` token in JavaScript or HTML. A trailing dash marks a prefix of a built name. */
function classTokens(text: string): Set<string> {
  return new Set([...text.matchAll(/muxui-[\w-]*/g)].map((match) => match[0]));
}

interface OutputFile {
  type: string;
  fileName: string;
  code?: string;
  source?: string | Uint8Array;
}

/**
 * Prune `bundle`'s stylesheets against the JavaScript and HTML in it. Returns the families
 * removed. Throws if a class the scripts name lost its rules.
 */
export function pruneMuxCssInBundle(
  bundle: Record<string, OutputFile>,
  families: readonly string[] = MUX_UNUSED_COMPONENT_CLASSES,
): string[] {
  const files = Object.values(bundle);
  const evidence = files
    .filter((file) => file.type === 'chunk' || file.fileName.endsWith('.html'))
    .map((file) => file.code ?? String(file.source ?? ''))
    .join('\n');

  const unused = families.filter((family) => !evidence.includes(family));
  for (const file of files) {
    if (
      file.type !== 'asset' ||
      !file.fileName.endsWith('.css') ||
      typeof file.source !== 'string'
    ) {
      continue;
    }
    const before = file.source;
    const after = pruneCssFamilies(before, unused);
    if (after === before) continue;

    const remaining = new Set([...after.matchAll(/\.(muxui-[\w-]+)/g)].map((match) => match[1]!));
    const original = new Set([...before.matchAll(/\.(muxui-[\w-]+)/g)].map((match) => match[1]!));
    for (const token of classTokens(evidence)) {
      const prefix = token.endsWith('-') || token.endsWith('_');
      const matches = (candidate: string) =>
        prefix ? candidate.startsWith(token) : candidate === token;
      if ([...original].some(matches) && ![...remaining].some(matches)) {
        throw new Error(
          `mux-css-prune: the bundle uses '${token}' but ${file.fileName} lost every rule for it. ` +
            'Remove its family from MUX_UNUSED_COMPONENT_CLASSES in mux-css-prune.ts.',
        );
      }
    }
    file.source = after;
  }
  return unused;
}

export function pruneMuxCss(): Plugin {
  return {
    name: 'bento-prune-mux-css',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      pruneMuxCssInBundle(bundle);
    },
  };
}
