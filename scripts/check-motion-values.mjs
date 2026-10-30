/* global console, process */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Fails when a Bento stylesheet or inline style sets a transition or animation from a raw
// time or a raw easing instead of a Mux motion token. Bento's only motion vocabulary is the
// --muxui-semantic-motion-* tokens (docs/mux-ui-component-customisations.md, "Motion"), so
// the durations and curves live in one place and the Mux theme controls them.
//
// A value of `transition`, `animation` or their duration, delay and timing-function
// longhands may hold only: none and the CSS-wide keywords (initial, inherit, unset, revert,
// revert-layer), var(--muxui-semantic-motion-*) with no fallback, and calc() over those and
// plain numbers. Property names, animation names and keywords such as infinite or both pass in
// the shorthands. Raw times (200ms, 0.2s, 0s), easing keywords (ease, linear), easing
// functions (cubic-bezier(), steps(), linear()), other var() references and any other
// function fail. The one exception is var(--bento-mode-fade-delay), the registered <time> that
// holds a prepared mode flip's transitions until its time: it passes as `transition-delay` and
// as the delay of a `transition` item that already has its Mux duration (a --muxui-semantic-
// motion-*-transition or -transition-duration token before it), and nowhere else.
//
// Scanned:
//   - shell CSS (extensions/bento-shell/src, minus the generated theme/presets);
//   - hand-written chrome CSS (src/browser/base/content, minus the generated
//     bento-chrome-tokens.css and bento-chrome-themes/);
//   - inline CSS in scripts: bento-shell-mount.js and the shell's .ts/.tsx (tests
//     excluded). A string literal fails when it holds a declaration of the properties above that breaks the
//     rule (cssText and other CSS-like strings), an easing function, a retired
//     --bento-duration-*, --bento-easing-* token, or a raw time next to a
//     --muxui-semantic-motion-* token, and so does the value of a transition or animation
//     property (shorthand or longhand) that a script assigns (style.transition = ...),
//     sets under a transition/animation key (quoted or not) or passes to
//     style.setProperty('transition-duration', ...), also when it is one branch of a
//     conditional or logical expression.
//
// Not covered: public/themes (generated), a raw time or bare easing keyword in a script
// string that is not part of a declaration, a style assignment or a string naming a motion
// token, and values built from variables (only the literal pieces of a string are read).
// Text that merely reads like a time, such as UI copy saying "Retry in 30s", passes.
//
//   node scripts/check-motion-values.mjs          scan the repository
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const VALUE_PROPERTIES = new Set([
  'transition',
  'animation',
  'transition-duration',
  'transition-delay',
  'transition-timing-function',
  'animation-duration',
  'animation-delay',
  'animation-timing-function',
]);
const SHORTHANDS = new Set(['transition', 'animation']);

const CSS_WIDE = /^(?:initial|inherit|unset|revert|revert-layer|none)$/i;
const MOTION_VAR = /^var\(\s*--muxui-semantic-motion-[\w-]+\s*\)$/;
// The mode flip fade's one delay carrier: modeFade.ts and the mount script set it (in ms, as a
// registered <time>) to hold the fade until the flip's time. It is a delay, not a duration.
const MODE_FADE_DELAY_VAR = /^var\(\s*--bento-mode-fade-delay\s*\)$/;
// The mode flip fade's shared colour list (one custom property holding the catch-all's entries,
// each with the Mux state pair and the delay carrier): a merged twin repeats it after a rule's own
// non-colour entries (scripts/fade-twins.mjs). It stands for whole transition items, never a time.
const MODE_FADE_COLOURS_VAR = /^var\(\s*--bento-mode-fade-colours(?:-inherited)?\s*\)$/;
// A Mux token that carries a duration: the composite pair or a duration longhand.
const DURATION_VAR =
  /^var\(\s*--muxui-semantic-motion-[\w-]+-transition(?:-spring)?(?:-duration)?\s*\)$/;
const MOTION_VAR_GLOBAL = /var\(\s*--muxui-semantic-motion-[\w-]+\s*\)/g;
const RAW_TIME = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:ms|s)$/i;
const EASING_KEYWORD = /^(?:ease|ease-in|ease-out|ease-in-out|linear|step-start|step-end)$/i;

// ─── CSS ─────────────────────────────────────────────────────────────────────

// Comments, quoted strings and url() payloads hold text, not declarations. Each is blanked
// in place (newlines kept) so offsets and line numbers stay true.
const DOUBLE_QUOTED = String.raw`"(?:\\[\s\S]|[^"\\])*"`;
const SINGLE_QUOTED = String.raw`'(?:\\[\s\S]|[^'\\])*'`;
const URL_CALL = String.raw`(?<![\w\u0080-\uffff-])url\(\s*(?:${DOUBLE_QUOTED}|${SINGLE_QUOTED}|(?:\\[\s\S]|[^)\\])*)\s*\)`;
const TEXT_ONLY = new RegExp(
  String.raw`\/\*[\s\S]*?\*\/|${DOUBLE_QUOTED}|${SINGLE_QUOTED}|${URL_CALL}`,
  'gi',
);
const maskText = (css) => css.replace(TEXT_ONLY, (text) => text.replace(/[^\n]/g, ' '));

/** A function from a character offset in `text` to its 1-based line number. */
function lineIndex(text) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

/** Splits on `separator` outside parentheses. */
function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && separator.test(char)) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** `{ property, value, line }` of each declaration in `css` (a stylesheet or a style string). */
export function declarations(css) {
  const text = maskText(css);
  const lineAt = lineIndex(text);
  const found = [];
  const add = (from, to) => {
    const statement = text.slice(from, to);
    const match = /^(\s*)(-?[a-z][\w-]*)\s*:\s*([\s\S]*)$/i.exec(statement);
    if (!match) return;
    found.push({
      property: match[2].toLowerCase(),
      value: match[3].replace(/\s*!\s*important\s*$/i, '').trim(),
      line: lineAt(from + match[1].length),
    });
  };
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (char === ';' || char === '{' || char === '}')) {
      // A statement that ends in { is a selector or an at-rule, not a declaration.
      if (char !== '{') add(start, index);
      start = index + 1;
    }
  }
  add(start, text.length);
  return found;
}

/** Why `token` may not appear in a motion value, or null. `strict` rejects unknown words. */
function tokenProblem(token, strict) {
  if (CSS_WIDE.test(token) || MOTION_VAR.test(token)) return null;
  if (/^calc\(/i.test(token)) return calcProblem(token);
  if (/^var\(/i.test(token)) {
    return 'var() must name a --muxui-semantic-motion-* token and have no fallback';
  }
  if (RAW_TIME.test(token)) return `raw time ${token}`;
  if (EASING_KEYWORD.test(token)) return `raw easing ${token}`;
  if (/^[\w-]+\(/.test(token))
    return `${token.slice(0, token.indexOf('('))}() is not a Mux motion token`;
  return strict ? `${token} is not a --muxui-semantic-motion-* token` : null;
}

function calcProblem(token) {
  const rest = token.replace(MOTION_VAR_GLOBAL, '0').replace(/\bcalc\(/gi, '(');
  if (/^[\s\d.+\-*/()]*$/.test(rest)) return null;
  const raw = /(?:^|[^\w.-])[+-]?(?:\d+\.?\d*|\.\d+)(?:ms|s)(?![\w-])/i.exec(token);
  if (raw) return `raw time ${raw[0].trim()} in calc()`;
  return 'calc() may only combine --muxui-semantic-motion-* tokens and plain numbers';
}

/** Why `value` of motion `property` breaks the rule, or null. */
export function motionValueProblem(property, value) {
  const strict = !SHORTHANDS.has(property);
  for (const item of splitTopLevel(value, /,/)) {
    if (property === 'transition' && MODE_FADE_COLOURS_VAR.test(item.replace(/\s*!important$/, '').trim())) continue;
    // A transition item has its duration (and easing) before the delay, so a time that follows
    // a Mux duration token is the delay.
    let hasDuration = false;
    for (const token of splitTopLevel(item, /\s/)) {
      if (MODE_FADE_DELAY_VAR.test(token)) {
        // The mode flip fade's delay carrier (a registered <time>) is a delay and only a delay:
        // read as a duration or an easing it would take the place of a Mux motion token.
        if (property === 'transition-delay' || (property === 'transition' && hasDuration)) continue;
        return `${token} is only a transition delay (transition-delay, or after the Mux duration in a transition)`;
      }
      const problem = tokenProblem(token, strict);
      if (problem) return problem;
      if (DURATION_VAR.test(token)) hasDuration = true;
    }
  }
  return null;
}

/** `{ line, property, value, problem }` for each motion declaration in `css` that breaks the rule. */
export function cssViolations(css) {
  return declarations(css)
    .filter(({ property }) => VALUE_PROPERTIES.has(property))
    .flatMap(({ property, value, line }) => {
      const problem = motionValueProblem(property, value);
      return problem ? [{ line, property, value, problem }] : [];
    });
}

// ─── Scripts ─────────────────────────────────────────────────────────────────

// How much code ahead of a literal `before` holds: enough for a conditional or logical
// expression in front of the literal.
const BEFORE_CHARS = 300;

/**
 * String literals of a JavaScript or TypeScript source as `{ text, line, before }`, where
 * `before` is the code just ahead of the literal with comments, regular expressions and
 * earlier string contents blanked (a plain word or CSS property name in quotes stays, so
 * quoted keys can be read). Comments are skipped, regular-expression literals are recognised
 * by what precedes them, and a template literal keeps its text with each ${...} replaced
 * by 0, so `${ms}ms` reads as a raw time.
 */
export function stringLiterals(source) {
  const literals = [];
  const length = source.length;
  const lineAt = lineIndex(source);
  const add = (text, start) => literals.push({ text, line: lineAt(start), start });
  // [start, end, keep] of every comment, literal and regular expression, in source order.
  const spans = [];
  let index = 0;
  let previous = '';

  const skipTemplate = (from) => {
    // Returns [text, end] of the template starting at the backtick at `from`.
    let text = '';
    let cursor = from + 1;
    while (cursor < length && source[cursor] !== '`') {
      if (source[cursor] === '\\') {
        text += source.slice(cursor, cursor + 2);
        cursor += 2;
      } else if (source[cursor] === '$' && source[cursor + 1] === '{') {
        cursor = skipExpression(cursor + 2);
        text += '0';
      } else {
        text += source[cursor];
        cursor += 1;
      }
    }
    return [text, cursor + 1];
  };

  // Past the } that closes a ${ expression, reading nested strings and braces.
  const skipExpression = (from) => {
    let depth = 1;
    let cursor = from;
    while (cursor < length && depth > 0) {
      const char = source[cursor];
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      if (char === "'" || char === '"') cursor = skipQuoted(cursor)[1];
      else if (char === '`') cursor = skipTemplate(cursor)[1];
      else cursor += 1;
    }
    return cursor;
  };

  const skipQuoted = (from) => {
    const quote = source[from];
    let cursor = from + 1;
    while (cursor < length && source[cursor] !== quote && source[cursor] !== '\n') {
      cursor += source[cursor] === '\\' ? 2 : 1;
    }
    return [source.slice(from + 1, cursor), cursor + 1];
  };

  while (index < length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      spans.push([index, end === -1 ? length : end, false]);
      index = end === -1 ? length : end;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      spans.push([index, end === -1 ? length : end + 2, false]);
      index = end === -1 ? length : end + 2;
    } else if (char === "'" || char === '"') {
      const [text, end] = skipQuoted(index);
      add(text, index);
      spans.push([index, end, /^[\w-]+$/.test(text)]);
      index = end;
      previous = 'a';
    } else if (char === '`') {
      const [text, end] = skipTemplate(index);
      add(text, index);
      spans.push([index, end, false]);
      index = end;
      previous = 'a';
    } else if (char === '/' && (previous === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(previous))) {
      // A regular expression literal: skip to its closing slash, past character classes.
      let cursor = index + 1;
      let inClass = false;
      while (cursor < length && source[cursor] !== '\n') {
        if (source[cursor] === '\\') cursor += 1;
        else if (source[cursor] === '[') inClass = true;
        else if (source[cursor] === ']') inClass = false;
        else if (source[cursor] === '/' && !inClass) break;
        cursor += 1;
      }
      spans.push([index, cursor + 1, false]);
      index = cursor + 1;
      previous = 'a';
    } else {
      if (!/\s/.test(char)) previous = char;
      index += 1;
    }
  }

  let code = '';
  let copied = 0;
  for (const [start, end, keep] of spans) {
    code += source.slice(copied, start);
    const span = source.slice(start, end);
    code += keep ? span : span.replace(/[^\n]/g, ' ');
    copied = end;
  }
  code += source.slice(copied);
  return literals.map(({ text, line, start }) => ({
    text,
    line,
    before: code.slice(Math.max(0, start - BEFORE_CHARS), start),
  }));
}

const RETIRED_TOKEN =
  /--bento-(?:duration|easing)-|--bento-sidebar-collapse-transition|--bento-pinned-panels-state-transition-duration/;
const RAW_TIME_IN_TEXT = /(?<![\w.:/-])[+-]?(?:\d+\.?\d*|\.\d+)(?:ms|s)(?![\w./-])/;
const NAMES_MOTION_TOKEN = /--muxui-semantic-motion-/;
const EASING_FUNCTION = /(?<![\w-])(?:cubic-bezier|steps|linear|spring)\(/;
// Where a script sets a transition or animation property (shorthand or longhand, camelCase
// or kebab-case): `style.transition =` or a bare `transition:` key, a quoted
// `{ 'transitionDuration': ... }` key, or `style.setProperty('transition-duration', ...)`.
// Run on `before` (see stringLiterals), so earlier strings and comments cannot match.
const MOTION_PROPERTY = String.raw`(transition|animation)(Duration|Delay|TimingFunction|-duration|-delay|-timing-function)?`;
const STYLE_SET = new RegExp(
  String.raw`(?:\.style\.|(?<![\w.$'"-]))${MOTION_PROPERTY}\s*(?:=(?![=>])|:(?!:))` +
    String.raw`|[{,]\s*(['"])${MOTION_PROPERTY}\3\s*:` +
    String.raw`|\.setProperty\(\s*(['"])${MOTION_PROPERTY}\6\s*,`,
  'g',
);

/**
 * Whether `gap`, the code between a style assignment and a literal, leaves the literal inside
 * the assigned expression: a conditional or logical branch (`cond ? 'a' : 'b'`, `x || 'a'`)
 * does, a new statement, an enclosing block, the next object entry or argument, or the
 * argument of a call does not.
 */
function continuesExpression(gap) {
  let depth = 0;
  for (let index = 0; index < gap.length; index += 1) {
    const char = gap[index];
    if (char === ';' || char === '{' || char === '}') return false;
    if (char === '(') {
      if (/[\w$)\]]\s*$/.test(gap.slice(0, index))) return false;
      depth += 1;
    } else if (char === '[') depth += 1;
    else if (char === ')' || char === ']') {
      depth -= 1;
      if (depth < 0) return false;
    } else if (char === ',' && depth === 0) return false;
  }
  return true;
}

/** The motion property (such as `transition-duration`) a literal is the value of, or null. */
function assignedMotionProperty(before) {
  let last = null;
  for (const match of before.matchAll(STYLE_SET)) last = match;
  if (!last || !continuesExpression(before.slice(last.index + last[0].length))) return null;
  const [base, suffix] = [last[1] ?? last[4] ?? last[7], last[2] ?? last[5] ?? last[8]];
  const longhand = suffix
    ? `-${suffix
        .replace(/^-/, '')
        .replace(/([a-z])([A-Z])/g, '$1-$2')
        .toLowerCase()}`
    : '';
  return base + longhand;
}

/** `{ line, text, problem }` for each string literal in `source` that breaks the rule. */
export function scriptViolations(source) {
  const violations = [];
  const report = (line, text, problem) => violations.push({ line, text: text.trim(), problem });
  for (const { text, line, before } of stringLiterals(source)) {
    if (RETIRED_TOKEN.test(text)) {
      report(line, text, 'a retired Bento motion token; use a --muxui-semantic-motion-* role');
      continue;
    }
    const problems = declarations(text)
      .filter(({ property }) => VALUE_PROPERTIES.has(property))
      .map(({ property, value }) => motionValueProblem(property, value))
      .filter(Boolean);
    const assigned = assignedMotionProperty(before);
    if (assigned && text.trim() !== '') problems.push(motionValueProblem(assigned, text.trim()));
    const problem = problems.find(Boolean);
    if (problem) report(line, text, problem);
    else if (EASING_FUNCTION.test(text)) report(line, text, 'raw easing function');
    else if (NAMES_MOTION_TOKEN.test(text) && RAW_TIME_IN_TEXT.test(text)) {
      // A string that names a motion token is a motion value (a piece of a transition list).
      report(line, text, `raw time ${RAW_TIME_IN_TEXT.exec(text)[0]}`);
    }
  }
  return violations;
}

// ─── Files ───────────────────────────────────────────────────────────────────

const toPosix = (path) => path.split('\\').join('/');
const shorten = (text) => {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > 90 ? `${flat.slice(0, 87)}...` : flat;
};

function listFiles(directory, include, skipDirectories = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      return skipDirectories.includes(entry.name) ? [] : listFiles(path, include, skipDirectories);
    }
    return include(entry.name) ? [path] : [];
  });
}

/** The files the check reads, as `{ file, kind }` with `file` relative to `root`. */
export function scannedFiles(root = REPO_ROOT) {
  const css = (name) => name.endsWith('.css');
  const script = (name) =>
    /\.(?:js|mjs|ts|tsx)$/.test(name) && !/\.test\.(?:js|mjs|ts|tsx)$/.test(name);
  const typescript = (name) => script(name) && !/\.(?:js|mjs)$/.test(name);
  const chromeDir = resolve(root, 'src/browser/base/content');
  const sets = [
    ['css', listFiles(resolve(root, 'extensions/bento-shell/src'), css, ['presets'])],
    [
      'css',
      listFiles(chromeDir, css, ['bento-chrome-themes']).filter(
        (file) => !file.endsWith('bento-chrome-tokens.css'),
      ),
    ],
    ['script', listFiles(resolve(root, 'extensions/bento-shell/src'), typescript)],
    ['script', [resolve(chromeDir, 'bento-shell-mount.js')]],
  ];
  return sets.flatMap(([kind, files]) =>
    files.map((file) => ({ file: toPosix(relative(root, file)), kind })),
  );
}

/** `{ file, line, detail, problem }` for every violation under `root`. */
export function findViolations(root = REPO_ROOT) {
  return scannedFiles(root).flatMap(({ file, kind }) => {
    let source;
    try {
      source = readFileSync(resolve(root, file), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return kind === 'css'
      ? cssViolations(source).map(({ line, property, value, problem }) => ({
          file,
          line,
          detail: `${property}: ${shorten(value)}`,
          problem,
        }))
      : scriptViolations(source).map(({ line, text, problem }) => ({
          file,
          line,
          detail: shorten(text),
          problem,
        }));
  });
}

function main() {
  const violations = findViolations();
  for (const { file, line, detail, problem } of violations) {
    console.log(`FAIL ${file}:${line} ${detail} (${problem})`);
  }
  if (violations.length > 0) {
    console.log(
      'Use var(--muxui-semantic-motion-<role>-transition), or the matching -transition-duration and -transition-easing pair for longhands. Role guide: docs/mux-ui-component-customisations.md.',
    );
    process.exit(1);
  }
  console.log(`OK motion values: ${scannedFiles().length} files use only Mux motion tokens`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`check-motion-values: ${error.message}`);
    process.exit(1);
  }
}
