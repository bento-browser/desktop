#!/usr/bin/env node
/**
 * Import a Tale UI Scale palette into Bento as a workspace theme preset.
 *
 * Usage:
 *   pnpm theme:import <id> <path-to-scale.css> [--name "Display Name"]
 *
 * The Scale app
 * (/Users/admin/Projects/tale-ui/tale-ui/playground/scale) emits canonical
 * CSS that re-points --brand-* and --neutral-default-* under :root, plus
 * --color-N-fg overrides under various selector forms that assume the
 * page has class="tale-ui" on its root. This script:
 *
 *   1. Reads the Scale CSS.
 *   2. Extracts --brand-60 (used as the picker swatch in BENTO_THEMES).
 *   3. Rewrites top-level :root → [data-bento-theme="<id>"].
 *   4. Collapses Scale's fg-override selectors into compound form
 *      anchored on the <html> element (data-bento-theme +
 *      data-color-mode + .tale-ui all live there in Bento), dropping
 *      the legacy `.light .tale-ui` / `.dark .tale-ui` siblings.
 *   5. Writes extensions/bento-shell/src/theme/presets/<id>.css.
 *   6. Runs scripts/sync-theme-presets.mjs so the generated CSS and metadata
 *      registry include the repo-local theme alongside @tale-ui/themes.
 *
 * After running, regenerate the chrome stylesheet so the chrome window
 * picks up the new theme too:
 *   pnpm run import   # invokes scripts/generate-chrome-tokens.mjs
 *
 * Idempotent: re-running with the same <id> overwrites the repo-local CSS file
 * and deterministically regenerates index.css and index.ts.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const PRESETS_DIR = resolve(REPO_ROOT, 'extensions/bento-shell/src/theme/presets');

function usage(extra) {
  if (extra) console.error('import-theme: ' + extra + '\n');
  console.error('Usage:');
  console.error('  pnpm theme:import <id> <path-to-scale.css> [--name "Display Name"]');
  console.error('');
  console.error('  <id> must be lowercase kebab-case (matches /^[a-z][a-z0-9-]*$/).');
  console.error('  Use <id> "default" to replace Bento\'s repo-local Default preset.');
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') {
      const v = argv[i + 1];
      if (v === undefined) usage(a + ' needs a value');
      flags[a.slice(2)] = v;
      i++;
    } else if (a.startsWith('--')) {
      usage('unknown flag: ' + a);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv.slice(2));
if (positional.length !== 2) usage('expected exactly two positional args');

const id = positional[0];
const inputPath = resolve(process.cwd(), positional[1]);

if (!/^[a-z][a-z0-9-]*$/.test(id)) {
  usage('<id> must match /^[a-z][a-z0-9-]*$/ (got: ' + JSON.stringify(id) + ')');
}
if (!existsSync(inputPath)) usage('input file not found: ' + inputPath);

const name = flags.name || id.charAt(0).toUpperCase() + id.slice(1);

const raw = readFileSync(inputPath, 'utf-8');

// Extract --brand-60 + --neutral-default-20 as the metadata swatch hexes.
// brand-60 = saturated accent half; neutral-20 = pale surface half. The
// pair shows up in the Edit Workspace picker as a split-diagonal swatch.
const brandMatch = raw.match(/--brand-60\s*:\s*(#[0-9a-fA-F]+)/);
if (!brandMatch) {
  console.error('import-theme: input CSS has no --brand-60 declaration — is this Scale output?');
  process.exit(1);
}
const brand60 = brandMatch[1].toLowerCase();
const neutralMatch = raw.match(/--neutral-default-20\s*:\s*(#[0-9a-fA-F]+)/);
if (!neutralMatch) {
  console.error(
    'import-theme: input CSS has no --neutral-default-20 declaration — is this Scale output?',
  );
  process.exit(1);
}
const neutral20 = neutralMatch[1].toLowerCase();

// ─── Selector transformations ──────────────────────────────────────────
// Scale's fg-override blocks come in two selector-list shapes. We collapse
// each into a single compound selector targeting <html> directly so all
// three required conditions (theme attr + color-mode attr + .tale-ui
// class) match the same element. The legacy `.light .tale-ui` /
// `.dark .tale-ui` siblings get dropped — Bento doesn't use those
// classnames; data-color-mode is authoritative.

let css = raw;

// Light-mode fg overrides (with sibling .light .tale-ui selector).
css = css.replace(
  /:where\(html:not\(\[data-color-mode="dark"\]\)\)\s+\.tale-ui\s*,\s*\.light\s+\.tale-ui/g,
  `html[data-bento-theme="${id}"]:not([data-color-mode="dark"]).tale-ui`,
);

// Light-mode fg overrides (already alone, without .light sibling).
css = css.replace(
  /:where\(html:not\(\[data-color-mode="dark"\]\)\)\s+\.tale-ui(?!\s*,)/g,
  `html[data-bento-theme="${id}"]:not([data-color-mode="dark"]).tale-ui`,
);

// Dark-mode fg overrides (with sibling .dark .tale-ui selector).
css = css.replace(
  /html\[data-color-mode="dark"\]\s+\.tale-ui\s*,\s*\.dark\s+\.tale-ui/g,
  `html[data-bento-theme="${id}"][data-color-mode="dark"].tale-ui`,
);

// Dark-mode fg overrides (already alone).
css = css.replace(
  /html\[data-color-mode="dark"\]\s+\.tale-ui(?!\s*,)/g,
  `html[data-bento-theme="${id}"][data-color-mode="dark"].tale-ui`,
);

// @media (prefers-color-scheme: dark) inner selector.
css = css.replace(
  /:where\(html:not\(\[data-color-mode="light"\]\)\)\s+\.tale-ui/g,
  `html[data-bento-theme="${id}"]:not([data-color-mode="light"]).tale-ui`,
);

// Top-level :root { … } scopes (start of a line, optional whitespace).
css = css.replace(/^(\s*):root(\s*\{)/gm, `$1[data-bento-theme="${id}"]$2`);

// ─── Write the preset file ─────────────────────────────────────────────
const header =
  '/*\n' +
  ` * ${name} — generated by scripts/import-theme.mjs from Tale UI Scale\n` +
  ' * CSS output. Selectors are scoped to [data-bento-theme="' +
  id +
  '"]\n' +
  ' * so the overrides only apply when an active workspace selects this\n' +
  ' * theme. See the converter source for the selector-rewrite logic.\n' +
  ' *\n' +
  ` * Brand base: ${brand60}\n` +
  ' * Source file: ' +
  inputPath +
  '\n' +
  ' *\n' +
  ' * Re-running `pnpm theme:import ' +
  id +
  ' <path>` regenerates this\n' +
  ' * file from the source CSS. Hand edits will be lost on re-import.\n' +
  ' */\n\n';

const outputPath = resolve(PRESETS_DIR, `${id}.css`);
writeFileSync(outputPath, header + css.trimEnd() + '\n');
console.log('import-theme: wrote', outputPath);

const syncResult = spawnSync(
  process.execPath,
  [resolve(REPO_ROOT, 'scripts/sync-theme-presets.mjs')],
  { stdio: 'inherit' },
);
if (syncResult.status !== 0) {
  process.exit(syncResult.status ?? 1);
}

console.log('\nDone. Run `pnpm run import` to regenerate the chrome token stylesheet.');
