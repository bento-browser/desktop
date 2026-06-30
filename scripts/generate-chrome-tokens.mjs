#!/usr/bin/env node
/**
 * Generate `src/browser/base/content/bento-chrome-tokens.css` by
 * concatenating the Tale UI token CSS files into a single chrome
 * stylesheet that the Bento chrome script injects into browser.xhtml.
 *
 * Why a generator and not a hand-maintained file: chrome XHTML is a
 * different document tree from the bento-shell extension, so we can't
 * import the extension's :root cascade directly. Re-building the file
 * from Tale UI source on every `pnpm run import` keeps the chrome side
 * automatically in sync — when Tale UI's primitives shift (new neutral
 * scale, recolored brand, added radius step, etc.), chrome picks them up
 * on the next import without anyone touching this script.
 *
 * The chrome tokens use the same variable names Tale UI exposes
 * (`--color-60`, `--neutral-90`, `--radius-m`, etc.), so the future
 * Scale-app-driven theme generator can target chrome and bento-shell
 * with the same output: write a new `_color-themes.css`/`_neutral-
 * themes.css`-shaped file in the project, run this generator, and chrome
 * picks up the new theme alongside the extension.
 *
 * What this generator omits and why:
 *   - Tale UI's _base.css { html { font-size: 100% } }: chrome already
 *     runs on the browser-standard rem contract, and we only need token
 *     files here, not document-level defaults for HTML apps.
 *   - Tale UI's index.css Google Fonts @import: chrome CSP would block
 *     the network fetch and the font isn't needed in chrome anyway.
 *   - Foundations / layout / utilities CSS: those style HTML/JSX
 *     elements; chrome XUL has its own widget styling.
 */

import { readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_PATH = resolve(REPO_ROOT, 'src/browser/base/content/bento-chrome-tokens.css');

// Resolve Tale UI's CSS source dir. Scenarios:
//   1. Dev (.pnpmfile.cjs rewrites @tale-ui/core to a `link:` of the local
//      sibling checkout): node_modules/@tale-ui/core/ is a symlink to
//      ../tale-ui/core/packages/css/. src/ is right there inside it.
//   2. Release (BENTO_RELEASE=1, npm install): node_modules/@tale-ui/core/
//      is a real install of the published package. The src/ directory
//      ships in the npm tarball (Tale UI's package.json points main /
//      style at src/index.css so the source files are part of "files").
// We prefer the bento-shell workspace install because it is the actual
// consumer of @tale-ui/core. Root node_modules can be a stale hoisted copy
// when the workspace package is linked to the local Tale UI checkout.
// We walk node_modules directly rather than using
// require.resolve('@tale-ui/core/package.json') because Node's exports
// gating blocks deep manifest imports unless the package explicitly lists
// "./package.json" in exports — Tale UI doesn't.
function findTaleUiCss() {
  const candidates = [
    // The shell's concrete dependency. In dev this should be the local link;
    // in release it will be the npm package.
    resolve(REPO_ROOT, 'extensions', 'bento-shell', 'node_modules', '@tale-ui', 'core', 'src'),
    // Workspace root fallback, where pnpm with node-linker=hoisted may place it.
    resolve(REPO_ROOT, 'node_modules', '@tale-ui', 'core', 'src'),
    // Last-resort sibling checkout — pre-pnpm-install state, or scripts
    // run before any install.
    resolve(REPO_ROOT, '..', 'tale-ui', 'core', 'packages', 'css', 'src'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    'generate-chrome-tokens: could not locate Tale UI CSS source. Looked at:\n  ' +
      candidates.join('\n  ') +
      '\nRun `pnpm install` first.',
  );
}

const TALE_UI_CSS = findTaleUiCss();

// Order matters: tokens before themes so the variables exist when
// theme overrides reference them. Mirrors Tale UI's index.css order
// (minus the bits we deliberately skip — see header comment).
const SOURCES = [
  'tokens/_colors.css',
  'tokens/_neutrals.css',
  'tokens/_effects.css',
  'tokens/_spacing.css',
  'themes/_color-modes.css',
  'themes/_color-themes.css',
  'themes/_neutral-themes.css',
];

function readSource(rel) {
  const path = resolve(TALE_UI_CSS, rel);
  try {
    return { rel, content: readFileSync(path, 'utf-8') };
  } catch (err) {
    throw new Error(`generate-chrome-tokens: cannot read ${path}: ${err.message}`);
  }
}

const taleUiVersion = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(TALE_UI_CSS, '..', 'package.json'), 'utf-8'),
    );
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

const sources = SOURCES.map(readSource);

// Bento's own token layer — extends Tale UI's tokens with --bento-*
// variables (chrome-component sizing, motion, surfaces, workspace
// accent palettes). Bundled INTO this output so chrome can reference
// `var(--bento-icon-size-sm)`, `var(--bento-scrollbar-thickness)`,
// `var(--bento-workspace-accent)`, etc., the same way it can
// reference Tale UI's `var(--color-60)`. Without this, chrome would
// only see Tale UI primitives — every Bento composition would have
// to inline raw values.
const BENTO_TOKENS_PATH = resolve(
  REPO_ROOT,
  'extensions/bento-shell/src/theme/bento-tokens.css',
);
let bentoTokensContent = '';
try {
  bentoTokensContent = readFileSync(BENTO_TOKENS_PATH, 'utf-8');
} catch (err) {
  console.warn(
    'generate-chrome-tokens: bento-tokens.css unavailable (' + err.message + ')',
  );
}

const header = [
  '/* This Source Code Form is subject to the terms of the Mozilla Public',
  ' * License, v. 2.0. If a copy of the MPL was not distributed with this',
  ' * file, You can obtain one at http://mozilla.org/MPL/2.0/. */',
  '',
  '/*',
  ' * AUTO-GENERATED — do not edit.',
  ' * Regenerated by scripts/generate-chrome-tokens.mjs from',
  ` * ${TALE_UI_CSS} (Tale UI @${taleUiVersion}) +`,
  ` * ${BENTO_TOKENS_PATH} (Bento token layer).`,
  ' * Runs as part of `pnpm run import` — bump `import` script if removed.',
  ' *',
  ' * Loaded into browser.xhtml as a chrome stylesheet via',
  ' * `chrome://browser/content/bento-chrome-tokens.css` and applied by',
  ' * src/browser/base/content/bento-shell-mount.js. Same variable names',
  ' * Tale UI + Bento publish — chrome inline styles can use',
  ' * `var(--color-60)`, `var(--radius-m)`, `var(--neutral-90)`,',
  ' * `var(--bento-scrollbar-thickness)`, etc., with auto light/dark',
  ' * flips per Tale UI _color-modes.css.',
  ' */',
  '',
].join('\n');

// Tale UI's color-mode + theme rules target `html` because they're written
// for HTML documents. Chrome XHTML's documentElement is `<window>` (XUL),
// so `html[data-color-mode="dark"]` etc. never match. Rewrite `html` (as
// an element selector — bare, not part of a longer identifier) to `:root`
// so the same cascade flips chrome tokens via the data-color-mode
// attribute we set on the chrome window in bento-shell-mount.js.
//
// Conservative regex: matches `html` only when (a) preceded by start of
// line, whitespace, comma, paren, colon, or bracket, AND (b) followed by
// whitespace, comma, dot, hash, colon, bracket, paren, or end of line.
// That covers `html { ... }`, `html:not(...)`, `html[data-...]`,
// `:where(html:not(...))`, and `html, .light` — without touching the
// `html` substring inside `<html lang="en">` if it ever appears in a
// comment (Tale UI source has none today, but the guard keeps us safe).
function rewriteHtmlToRoot(css) {
  return css.replace(
    /(^|[\s,(:\[])html(?=[\s,.#:\[)]|$)/g,
    (_match, prefix) => prefix + ':root',
  );
}

const body = sources
  .map(({ rel, content }) => {
    const banner = `/* ─── from tale-ui/${rel} ────────────────────────────── */\n`;
    return banner + rewriteHtmlToRoot(content.trimEnd()) + '\n';
  })
  .join('\n');

const bentoSection = bentoTokensContent
  ? '\n/* ─── from extensions/bento-shell/src/theme/bento-tokens.css ─── */\n' +
    bentoTokensContent.trimEnd() +
    '\n'
  : '';

// Workspace theme presets. scripts/sync-theme-presets.mjs compiles raw
// Scale CSS files from theme/presets/*.css into this generated index.css,
// scoped by `[data-bento-theme="<id>"]`. Loading the compiled output into
// chrome's stylesheet means switching a workspace's theme (which sets
// `data-bento-theme` on the chrome `<window>` element via the BENTO_THEME
// title-IPC handler in bento-shell-mount.js) re-skins the chrome UI from
// the same compiled source as the shell.
//
// Foreground-override selectors (`html[data-bento-theme="<id>"]…
// .tale-ui`) won't match in chrome because chrome's documentElement
// doesn't carry the `.tale-ui` class — accepted no-op, fg overrides are
// shell-only (chrome doesn't use Tale UI components).
const PRESETS_INDEX_PATH = resolve(
  REPO_ROOT,
  'extensions/bento-shell/src/theme/presets/index.css',
);
let presetsSection = '';
try {
  if (existsSync(PRESETS_INDEX_PATH)) {
    const content = readFileSync(PRESETS_INDEX_PATH, 'utf-8');
    presetsSection =
      '\n/* ─── from extensions/bento-shell/src/theme/presets/index.css ─── */\n' +
      rewriteHtmlToRoot(content.trimEnd()) +
      '\n';
  }
} catch (err) {
  console.warn(
    'generate-chrome-tokens: theme presets unavailable (' + err.message + ')',
  );
}

writeFileSync(OUT_PATH, header + body + bentoSection + presetsSection);

const stat = statSync(OUT_PATH);
const kb = (stat.size / 1024).toFixed(1);
console.log(`generate-chrome-tokens: wrote ${OUT_PATH} (${kb} kB)`);
