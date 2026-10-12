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
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL_DIR = resolve(REPO_ROOT, 'extensions/bento-shell');
const MUX_SHEETS = ['@muxui/react/styles.css', '@muxui/react/themes.css'];

// Comments, quoted strings and url() payloads hold text, not declarations or reads. The
// earliest alternative at each position wins, so a ")" or a comment marker inside a string
// or a quoted url() cannot end or start the wrong match.
const TEXT_ONLY =
  /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|url\(\s*(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^)]*)\s*\)/gi;
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
  // The generated presets only define tokens, and they read Mux names Mux itself declares.
  const scannedFiles = shellFiles.filter((file) => !file.includes('/theme/presets/'));
  const missing = findUndefinedReads({
    scanned: Object.fromEntries(
      scannedFiles.map((file) => [relative(REPO_ROOT, file), read(file)]),
    ),
    declaredIn: [
      ...shellFiles.map(read),
      ...MUX_SHEETS.map((name) => read(muxRequire.resolve(name))),
    ],
  });
  for (const [file, names] of Object.entries(missing)) {
    console.log(`FAIL ${file}: ${names.join(', ')}`);
  }
  if (Object.keys(missing).length > 0) {
    console.log(
      'Declare the property (bento-tokens.css for reusable values), use a token that exists, or add a var() fallback.',
    );
    process.exit(1);
  }
  console.log(
    `OK undefined tokens: ${scannedFiles.length} shell stylesheets read only declared properties`,
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
