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
// The same run also fails when a shell stylesheet uses a `bento` or `bento.*` cascade layer that
// the order statement in theme/muxui.css does not list. An unlisted layer ranks by whichever file
// declares it first, and that differs between the dev server, the build and Ladle. Chrome CSS
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

const LAYER_TOKEN = /@layer(?![\w-])([^;{}]*)([;{])|@import(?![\w-])[^;{}]*;|[{}]/g;

/**
 * Every cascade layer `css` names, qualified by the layers around it (`@layer bento { @layer x {} }`
 * is `bento.x`). `kind` is `statement` for `@layer a, b;`, `block` for `@layer a { }` and `import`
 * for `@import url() layer(a);`. Comments, strings and url() payloads are ignored.
 */
export function layerUses(css) {
  const uses = [];
  const scopes = ['']; // the enclosing layer path at each open block
  const qualify = (name) => (scopes.at(-1) ? `${scopes.at(-1)}.${name}` : name);
  for (const [token, params, end] of maskText(css).matchAll(LAYER_TOKEN)) {
    if (token === '}') {
      if (scopes.length > 1) scopes.pop();
    } else if (token === '{') {
      scopes.push(scopes.at(-1));
    } else if (token.startsWith('@import')) {
      const name = /\blayer\(\s*([^)\s]+)\s*\)/.exec(token)?.[1];
      if (name) uses.push({ name: qualify(name), kind: 'import' });
    } else {
      const names = params
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .map(qualify);
      for (const name of names) uses.push({ name, kind: end === ';' ? 'statement' : 'block' });
      if (end === '{') scopes.push(names[0] ?? scopes.at(-1));
    }
  }
  return uses;
}

const isBentoLayer = (name) => name === 'bento' || name.startsWith('bento.');

/** The `bento` and `bento.*` layers that `orderCss` lists in `@layer a, b;` order statements. */
export function orderedBentoLayers(orderCss) {
  return new Set(
    layerUses(orderCss)
      .filter((use) => use.kind === 'statement' && isBentoLayer(use.name))
      .map((use) => use.name),
  );
}

/**
 * `{ file: names[] }` of `bento` and `bento.*` layers a stylesheet uses that the order statement
 * in `orderCss` does not list, each name once.
 *
 * @param {{ scanned: Record<string, string>, orderCss: string }} input
 */
export function findUndeclaredLayers({ scanned, orderCss }) {
  const ordered = orderedBentoLayers(orderCss);
  const undeclared = {};
  for (const [file, css] of Object.entries(scanned)) {
    const names = [
      ...new Set(
        layerUses(css)
          .map((use) => use.name)
          .filter((name) => isBentoLayer(name) && !ordered.has(name)),
      ),
    ];
    if (names.length > 0) undeclared[file] = names;
  }
  return undeclared;
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
  const orderCss = read(resolve(REPO_ROOT, LAYER_ORDER_FILE));
  const hasOrderStatement = [...orderedBentoLayers(orderCss)].some((name) =>
    name.startsWith('bento.'),
  );
  const undeclared = hasOrderStatement ? findUndeclaredLayers({ scanned: sheets, orderCss }) : {};

  for (const [file, names] of Object.entries(missing)) {
    console.log(`FAIL ${file}: ${names.join(', ')}`);
  }
  if (Object.keys(missing).length > 0) {
    console.log(
      'Declare the property (bento-tokens.css for reusable values), use a token that exists, or add a var() fallback.',
    );
  }
  if (!hasOrderStatement) {
    console.log(`FAIL ${LAYER_ORDER_FILE}: no '@layer bento.<name>, ...;' order statement`);
  }
  for (const [file, names] of Object.entries(undeclared)) {
    for (const name of names) {
      console.log(
        `FAIL ${file}: layer ${name} is missing from the order statement in ${LAYER_ORDER_FILE}`,
      );
    }
  }
  if (Object.keys(undeclared).length > 0) {
    console.log(
      'List the layer in that order statement at the rank it should have, or use a listed one.',
    );
  }
  if (Object.keys(missing).length > 0 || !hasOrderStatement || Object.keys(undeclared).length > 0) {
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
