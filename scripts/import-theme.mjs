#!/usr/bin/env node
/**
 * Import a Tale UI Scale palette into Bento as a workspace theme preset.
 *
 * Usage:
 *   pnpm theme:import <id> <path-to-scale.css> [--name "Display Name"]
 *
 * The Scale app
 * (/Users/admin/Projects/tale-ui/core/playground/scale) emits canonical
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
 *   6. Idempotently inserts an @import in
 *      extensions/bento-shell/src/theme/presets/index.css.
 *   7. Idempotently appends a metadata entry to BENTO_THEMES in
 *      extensions/bento-shell/src/theme/presets/index.ts.
 *
 * After running, regenerate the chrome stylesheet so the chrome window
 * picks up the new theme too:
 *   pnpm run import   # invokes scripts/generate-chrome-tokens.mjs
 *
 * Idempotent: re-running with the same non-default <id> overwrites the
 * .css file but leaves index.css / index.ts unchanged (the @import +
 * metadata entry already exist). Re-running with <id> `default`
 * overwrites default.css and refreshes Default's swatch metadata.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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
  console.error('import-theme: input CSS has no --neutral-default-20 declaration — is this Scale output?');
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
css = css.replace(
  /^(\s*):root(\s*\{)/gm,
  `$1[data-bento-theme="${id}"]$2`,
);

// ─── Write the preset file ─────────────────────────────────────────────
const header =
  '/*\n' +
  ` * ${name} — generated by scripts/import-theme.mjs from Tale UI Scale\n` +
  ' * CSS output. Selectors are scoped to [data-bento-theme="' + id + '"]\n' +
  ' * so the overrides only apply when an active workspace selects this\n' +
  ' * theme. See the converter source for the selector-rewrite logic.\n' +
  ' *\n' +
  ` * Brand base: ${brand60}\n` +
  ' * Source file: ' + inputPath + '\n' +
  ' *\n' +
  ' * Re-running `pnpm theme:import ' + id + ' <path>` regenerates this\n' +
  ' * file from the source CSS. Hand edits will be lost on re-import.\n' +
  ' */\n\n';

const outputPath = resolve(PRESETS_DIR, `${id}.css`);
writeFileSync(outputPath, header + css.trimEnd() + '\n');
console.log('import-theme: wrote', outputPath);

// ─── Idempotent index.css patch ────────────────────────────────────────
const indexCssPath = resolve(PRESETS_DIR, 'index.css');
const indexCss = readFileSync(indexCssPath, 'utf-8');
const importLine = `@import './${id}.css';`;
if (indexCss.includes(importLine)) {
  console.log('import-theme: index.css already imports', id);
} else {
  // Splice in alphabetically among existing @imports if any; else append
  // after the leading comment block.
  const importLineRegex = /^@import\s+['"]\.\/([a-z0-9-]+)\.css['"]\s*;\s*$/gm;
  const existing = [...indexCss.matchAll(importLineRegex)].map((m) => ({
    id: m[1],
    line: m[0],
    index: m.index,
  }));
  let nextIndexCss;
  if (existing.length === 0) {
    nextIndexCss = indexCss.trimEnd() + '\n\n' + importLine + '\n';
  } else {
    const sorted = [...existing, { id, line: importLine, index: -1 }].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const pos = sorted.findIndex((e) => e.id === id);
    if (pos === 0) {
      // Insert before the current first import.
      const first = existing[0];
      nextIndexCss =
        indexCss.slice(0, first.index) + importLine + '\n' + indexCss.slice(first.index);
    } else {
      // Insert after the import for sorted[pos - 1].id.
      const previousId = sorted[pos - 1].id;
      const prev = existing.find((e) => e.id === previousId);
      const insertAt = prev.index + prev.line.length;
      nextIndexCss = indexCss.slice(0, insertAt) + '\n' + importLine + indexCss.slice(insertAt);
    }
  }
  writeFileSync(indexCssPath, nextIndexCss);
  console.log('import-theme: added @import to', indexCssPath);
}

// ─── Idempotent index.ts patch ─────────────────────────────────────────
const indexTsPath = resolve(PRESETS_DIR, 'index.ts');
const indexTs = readFileSync(indexTsPath, 'utf-8');
if (new RegExp(`id:\\s*['"]${id}['"]`).test(indexTs)) {
  if (id === 'default') {
    const idMatch = indexTs.match(/id:\s*['"]default['"]/);
    const objectStart = idMatch ? indexTs.lastIndexOf('\n  {', idMatch.index) : -1;
    const objectEnd = idMatch ? indexTs.indexOf('\n  },', idMatch.index) : -1;
    if (!idMatch || objectStart < 0 || objectEnd < 0) {
      console.error('import-theme: could not locate Default metadata object in index.ts');
    } else {
      const before = indexTs.slice(0, objectStart);
      const after = indexTs.slice(objectEnd + '\n  },'.length);
      const currentObject = indexTs.slice(objectStart, objectEnd + '\n  },'.length);
      const currentName = currentObject.match(/name:\s*(['"])(.*?)\1/)?.[2] || 'Default';
      const entryLines = [
        '  {',
        "    id: 'default',",
        `    name: '${(flags.name || currentName).replace(/'/g, "\\'")}',`,
      ];
      entryLines.push(`    brand60: '${brand60}',`);
      entryLines.push(`    neutral20: '${neutral20}',`);
      entryLines.push('  },');
      writeFileSync(indexTsPath, before + '\n' + entryLines.join('\n') + after);
      console.log('import-theme: refreshed Default metadata in', indexTsPath);
    }
  } else {
    console.log('import-theme: BENTO_THEMES already has id:', id);
  }
} else {
  // Find the closing `];` of `BENTO_THEMES: BentoThemeMeta[] = [ … ];`.
  // The array spans multiple lines and contains object literals; we look
  // for the first `];` after the array's opening `BENTO_THEMES…[`.
  const openMatch = indexTs.match(/BENTO_THEMES\s*:\s*BentoThemeMeta\[\]\s*=\s*\[/);
  if (!openMatch) {
    console.error('import-theme: could not locate BENTO_THEMES array in index.ts — skipping patch');
  } else {
    const arrayStart = openMatch.index + openMatch[0].length;
    const closeOffset = indexTs.indexOf('];', arrayStart);
    if (closeOffset < 0) {
      console.error('import-theme: could not find "];" closing BENTO_THEMES — skipping patch');
    } else {
      const before = indexTs.slice(0, closeOffset);
      const after = indexTs.slice(closeOffset);
      const entryLines = [
        '  {',
        `    id: '${id}',`,
        `    name: '${name.replace(/'/g, "\\'")}',`,
      ];
      entryLines.push(`    brand60: '${brand60}',`);
      entryLines.push(`    neutral20: '${neutral20}',`);
      entryLines.push('  },');
      const entry = entryLines.join('\n') + '\n';
      writeFileSync(indexTsPath, before + entry + after);
      console.log('import-theme: appended', id, 'to BENTO_THEMES in', indexTsPath);
    }
  }
}

console.log('');
console.log('Done. Next step:');
console.log('  pnpm run import   # regenerate bento-chrome-tokens.css with the new theme');
