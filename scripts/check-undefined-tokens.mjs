/* global console, process */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Fails when shell CSS reads a custom property that nothing declares. `var(--missing)` is
// invalid at computed-value time, so the declaration silently does nothing (the transparent
// welcome cells and square favicon corners this check was added after). A `var(--x, fallback)`
// read is allowed, which also covers properties that components set from JS.
//
// Declared means a `--name:` declaration or an `@property --name` rule with an `initial-value`
// in the shell's own CSS (which includes the generated presets and bento-tokens.css) or in the
// public @muxui/react styles.css/themes.css. Comments, strings and url() payloads are ignored.
// Native chrome CSS under src/browser is not scanned: it reads Firefox's own tokens too.
//
// The same run also checks the `bento` and `bento.*` cascade layers of every shell stylesheet. An
// unlisted layer ranks by whichever file declares it first, and that differs between the dev
// server, the build and Ladle, so each must appear in the top-level `@layer a, b;` statement in
// theme/muxui.css (the only order that counts). The check fails closed on CSS it cannot read: an
// anonymous `@layer` block, a layer name that is not plain dotted identifiers (an escape can spell
// `bento`), and an `@import` into a `bento` layer. Custom property values are skipped. Chrome CSS
// under src/browser (its own document and `bento.chrome-theme` layer) is not scanned.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_DIR = resolve(REPO_ROOT, 'extensions/bento-shell');
const MUX_SHEETS = ['@muxui/react/styles.css', '@muxui/react/themes.css'];
export const LAYER_ORDER_FILE = 'extensions/bento-shell/src/theme/muxui.css';

// Comments, quoted strings and url() payloads hold text, not declarations or reads. The
// earliest alternative at each position wins, so a ")" or a comment marker inside a string
// or a quoted url() cannot end or start the wrong match. An unquoted url() consumes backslash
// escapes, so an escaped ")" or quote stays inside it. The lookbehind makes "url(" match only
// as a whole function name, not the tail of "my-url(" or "myurl(".
const DOUBLE_QUOTED = String.raw`"(?:\\[\s\S]|[^"\\])*"`;
const SINGLE_QUOTED = String.raw`'(?:\\[\s\S]|[^'\\])*'`;
const URL_CALL = String.raw`(?<![\w\u0080-\uffff-])url\(\s*(?:${DOUBLE_QUOTED}|${SINGLE_QUOTED}|(?:\\[\s\S]|[^)\\])*)\s*\)`;
const TEXT_ONLY = new RegExp(
  String.raw`\/\*[\s\S]*?\*\/|${DOUBLE_QUOTED}|${SINGLE_QUOTED}|${URL_CALL}`,
  'gi',
);
const maskText = (css) => css.replace(TEXT_ONLY, ' ');

/**
 * Custom property names `css` defines: a real `--x: value` declaration (it starts a block or
 * follows `;` or `}`), or an `@property --x` rule with an `initial-value`. Without one the
 * registration gives a read nothing to resolve to.
 */
export function declaredProperties(css) {
  const source = maskText(css);
  const declared = new Set(
    [...source.matchAll(/(?:^|[{};])\s*(--[\w-]+)\s*:/g)].map((match) => match[1]),
  );
  for (const match of source.matchAll(/@property\s+(--[\w-]+)\s*\{([^}]*)\}/g)) {
    if (/(?:^|[{;\s])initial-value\s*:/.test(match[2])) declared.add(match[1]);
  }
  return declared;
}

/** Custom property names `css` reads with `var(--x)` and no fallback, once each. */
export function unguardedReads(css) {
  return [
    ...new Set([...maskText(css).matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((match) => match[1])),
  ];
}

/**
 * `{ file: names[] }` of unguarded reads that no stylesheet declares.
 *
 * @param {{ scanned: Record<string, string>, declaredIn: string[] }} input
 *   `scanned` maps file name to CSS to check; `declaredIn` is the CSS that may declare names.
 */
export function findUndefinedReads({ scanned, declaredIn }) {
  const declared = new Set(declaredIn.flatMap((css) => [...declaredProperties(css)]));
  const missing = {};
  for (const [file, css] of Object.entries(scanned)) {
    const names = unguardedReads(css).filter((name) => !declared.has(name));
    if (names.length > 0) missing[file] = names;
  }
  return missing;
}

// One pass over masked CSS, in source order: an '@layer' rule (its params, then ';' or '{', or ''
// when '}' or the end of input comes first), an '@import' rule, the start of a custom property
// declaration (its value may hold braces and '@layer' text, so it is skipped) and braces.
const LAYER_TOKEN =
  /@layer(?![\w-])([^;{}]*)([;{]|(?=}|$))|@import(?![\w-])([^;{}]*)|(?<=[{};]\s*)--[\w-]*\s*:|[{}]/gi;
const LAYER_FUNCTION = /(?<![\w-])layer\(\s*([^)]*?)\s*\)/i;
const PLAIN_NAME = /^-?[A-Za-z_][\w-]*(?:\.-?[A-Za-z_][\w-]*)*$/;
const isBentoLayer = (name) => name === 'bento' || name.startsWith('bento.');
const unreadable = (name) =>
  name
    ? `layer name '${name}' is not plain dotted identifiers (escapes and other tokens are not read)`
    : 'anonymous @layer is not read: name the layer';

/** Index after the custom property value that starts at `from`: past its ';', or at its closing '}'. */
function valueEnd(source, from) {
  let depth = 0;
  for (let index = from; index < source.length; index++) {
    const char = source[index];
    if (char === '{') depth++;
    else if (char === '}' && depth === 0) return index;
    else if (char === '}') depth--;
    else if (char === ';' && depth === 0) return index + 1;
  }
  return source.length;
}

/**
 * The cascade layers `css` names. `names` is every layer named, qualified by the layers around it
 * (`@layer bento { @layer x {} }` is `bento.x`). `ordered` is the names in top-level `@layer a, b;`
 * statements, the only ones that order layers (a statement inside a block such as `@media` may not
 * apply). `unsupported` is one reason per construct it does not read, which contributes no names:
 * an anonymous block, a name that is not plain dotted identifiers, an `@import ... layer(bento...)`
 * (the imported sheet's own layers would nest under it unseen) and an `@layer` with no end.
 */
export function readLayers(css) {
  const source = maskText(css);
  const names = [];
  const ordered = [];
  const unsupported = new Set();
  const scopes = ['']; // the enclosing layer path at each open block
  const qualify = (name) => (scopes.at(-1) ? `${scopes.at(-1)}.${name}` : name);
  const token = new RegExp(LAYER_TOKEN);
  let match;
  while ((match = token.exec(source))) {
    const [text, params, end, imported] = match;
    if (text === '{') {
      scopes.push(scopes.at(-1));
    } else if (text === '}') {
      if (scopes.length > 1) scopes.pop();
    } else if (text.startsWith('--')) {
      token.lastIndex = valueEnd(source, token.lastIndex);
    } else if (imported !== undefined) {
      const name = LAYER_FUNCTION.exec(imported)?.[1];
      if (name === undefined) continue;
      if (!PLAIN_NAME.test(name)) unsupported.add(unreadable(name));
      else if (isBentoLayer(name))
        unsupported.add(
          `@import into layer ${name} is not read: its own layers would nest under it`,
        );
    } else if (end === '') {
      unsupported.add("@layer with no ';' or block");
    } else {
      const listed = (end === ';' ? params.split(',') : [params]).map((name) => name.trim());
      const bad = listed.filter((name) => !PLAIN_NAME.test(name));
      for (const name of bad) unsupported.add(unreadable(name));
      const qualified = bad.length > 0 ? [] : listed.map(qualify);
      names.push(...qualified);
      if (end === ';' && scopes.length === 1) ordered.push(...qualified);
      if (end === '{') scopes.push(qualified[0] ?? scopes.at(-1));
    }
  }
  return { names, ordered, unsupported: [...unsupported] };
}

/**
 * `<file>: <reason>` lines for layer problems in `scanned` (file name to CSS, including
 * `LAYER_ORDER_FILE`). `unsupported` is what `readLayers` rejects plus a missing `bento.*` order
 * statement; `undeclared` is each `bento` or `bento.*` layer a file uses that the top-level order
 * statement in `LAYER_ORDER_FILE` does not list, once per file.
 */
export function findLayerProblems(scanned) {
  const ordered = new Set(readLayers(scanned[LAYER_ORDER_FILE] ?? '').ordered);
  const hasOrder = [...ordered].some((name) => name.startsWith('bento.'));
  const layers = Object.entries(scanned).map(([file, css]) => [file, readLayers(css)]);
  const unsupported = layers.flatMap(([file, read]) =>
    read.unsupported.map((reason) => `${file}: ${reason}`),
  );
  if (!hasOrder) {
    unsupported.unshift(
      `${LAYER_ORDER_FILE}: no top-level '@layer bento.<name>, ...;' order statement`,
    );
  }
  const undeclared = layers.flatMap(([file, read]) =>
    [...new Set(read.names)]
      .filter((name) => hasOrder && isBentoLayer(name) && !ordered.has(name))
      .map(
        (name) =>
          `${file}: layer ${name} is missing from the order statement in ${LAYER_ORDER_FILE}`,
      ),
  );
  return { unsupported, undeclared };
}

function cssFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

function main() {
  const muxRequire = createRequire(resolve(SHELL_DIR, 'package.json'));
  const read = (path) => readFileSync(path, 'utf8');
  const shellFiles = cssFiles(resolve(SHELL_DIR, 'src'));
  const sheets = Object.fromEntries(
    shellFiles.map((file) => [relative(REPO_ROOT, file), read(file)]),
  );
  // The generated presets only define tokens, and they read Mux names Mux itself declares.
  const scannedFiles = shellFiles.filter((file) => !file.includes('/theme/presets/'));
  const missing = findUndefinedReads({
    scanned: Object.fromEntries(
      scannedFiles.map((file) => [relative(REPO_ROOT, file), read(file)]),
    ),
    declaredIn: [
      ...Object.values(sheets),
      ...MUX_SHEETS.map((name) => read(muxRequire.resolve(name))),
    ],
  });
  // Every shell stylesheet counts for layers, presets included.
  const { unsupported, undeclared } = findLayerProblems(sheets);

  for (const [file, names] of Object.entries(missing)) {
    console.log(`FAIL ${file}: ${names.join(', ')}`);
  }
  if (Object.keys(missing).length > 0) {
    console.log(
      'Declare the property (bento-tokens.css for reusable values), use a token that exists, or add a var() fallback.',
    );
  }
  for (const problem of [...unsupported, ...undeclared]) console.log(`FAIL ${problem}`);
  if (undeclared.length > 0) {
    console.log(
      'List the layer in that order statement at the rank it should have, or use a listed one.',
    );
  }
  if (Object.keys(missing).length > 0 || unsupported.length > 0 || undeclared.length > 0) {
    process.exit(1);
  }
  console.log(
    `OK undefined tokens: ${scannedFiles.length} shell stylesheets read only declared properties`,
  );
  console.log(
    `OK bento layers: ${shellFiles.length} shell stylesheets use only layers in the order statement in ${LAYER_ORDER_FILE}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`check-undefined-tokens: ${error.message}`);
    process.exit(1);
  }
}
