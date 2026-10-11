/* global console, process */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { evaluateEntry, formatBaseline, parseBaseline, refreshBaseline } from './size-ratchet.mjs';

// Size ratchet. The ceilings below are targets and are always reported, but the
// check fails only when an entry grows past its committed baseline (see
// size-ratchet.mjs). Existing overages therefore pass; growth does not. Missing
// or malformed built assets also fail.
//
//   node scripts/check-size-budgets.mjs                    check against the baseline
//   node scripts/check-size-budgets.mjs --write-baseline   refresh the baseline from this build:
//       lowers shrunk entries, adds new ones, and refuses to raise an existing entry unless it
//       is named with --accept-growth <entry path> (repeatable).
const KB = 1000;
const BASELINE_PATH = '.size-baseline.json';

const jsEntryBudgets = [
  {
    name: 'bento-shell · shell cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/shell.js',
    limit: '400 KB',
  },
  {
    name: 'bento-shell · palette cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/palette.js',
    limit: '200 KB',
  },
  {
    name: 'bento-shell · address-bar cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/address-bar.js',
    limit: '200 KB',
  },
  {
    name: 'bento-shell · confirm cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/confirm.js',
    limit: '200 KB',
  },
  {
    name: 'bento-shell · edit-workspace cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/edit-workspace.js',
    limit: '200 KB',
  },
  {
    name: 'bento-shell · welcome cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/welcome.js',
    limit: '200 KB',
  },
  {
    name: 'bento-shell · menu cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/menu.js',
    limit: '200 KB',
  },
  {
    name: 'bento-shell · workspace-palette cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/workspace-palette.js',
    limit: '200 KB',
  },
  {
    name: 'bento-shell · merge-palette cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/merge-palette.js',
    limit: '200 KB',
  },
  ...['workspace-switcher', 'panel-trailer', 'panel-navigator-tooltip', 'panel-newtab'].map(
    (name) => ({
      name: `bento-shell · ${name} cold-start JS (gz)`,
      entry: `extensions/bento-shell/dist/assets/${name}.js`,
      limit: '200 KB',
    }),
  ),
];

function bytesForLimit(limit) {
  const match = /^(\d+(?:\.\d+)?)\s*KB$/i.exec(limit);
  if (!match) {
    throw new Error(`Unsupported size limit: ${limit}`);
  }
  return Number(match[1]) * KB;
}

function gzipSize(filePath) {
  return gzipSync(readFileSync(filePath), { level: 9 }).length;
}

function relativeJsImports(source) {
  const imports = new Set();
  const patterns = [
    /\b(?:import|export)[^'"]*?from\s*["']\.\/([^"']+)["']/g,
    /\bimport\s*["']\.\/([^"']+)["']/g,
    /\bimport\s*\(\s*["']\.\/([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      imports.add(match[1]);
    }
  }

  return [...imports];
}

function collectEntryGraph(entryPath) {
  const seen = new Set();

  function visit(filePath) {
    const absolutePath = path.resolve(filePath);
    if (seen.has(absolutePath)) return;
    if (!existsSync(absolutePath)) {
      throw new Error(`Missing built asset: ${path.relative(process.cwd(), absolutePath)}`);
    }

    seen.add(absolutePath);
    const source = readFileSync(absolutePath, 'utf8');
    for (const specifier of relativeJsImports(source)) {
      visit(path.join(path.dirname(absolutePath), specifier));
    }
  }

  visit(entryPath);
  return [...seen].sort();
}

function readDirectFileBudgets() {
  const config = JSON.parse(readFileSync('.size-limit.json', 'utf8'));
  return config.map((entry) => {
    if (typeof entry.path !== 'string') {
      throw new Error(`${entry.name} must use a single direct file path`);
    }
    if (entry.gzip !== true) {
      throw new Error(`${entry.name} must be a gzip budget`);
    }
    return entry;
  });
}

function formatSize(bytes) {
  if (bytes < KB) return `${bytes} B`;
  return `${(bytes / KB).toFixed(2)} KB`;
}

function measureBudgets() {
  const measurements = [];

  for (const budget of jsEntryBudgets) {
    const files = collectEntryGraph(budget.entry);
    measurements.push({
      key: budget.entry,
      name: budget.name,
      limit: budget.limit,
      size: files.reduce((sum, filePath) => sum + gzipSize(filePath), 0),
    });
  }

  for (const budget of readDirectFileBudgets()) {
    const filePath = path.resolve(budget.path);
    if (!existsSync(filePath)) {
      throw new Error(`Missing built asset: ${budget.path}`);
    }
    measurements.push({
      key: budget.path,
      name: budget.name,
      limit: budget.limit,
      size: gzipSize(filePath),
    });
  }

  return measurements;
}

function reportBudget({ key, name, size, limit }, baselines) {
  const ceiling = bytesForLimit(limit);
  const result = evaluateEntry({ size, baseline: baselines[key], ceiling });
  const marker = result.failed ? 'FAIL' : result.overCeiling ? 'WARN' : 'OK';
  console.log(`${marker} ${name}: ${formatSize(size)} / ${limit}`);

  if (result.overCeiling) {
    console.log(`  over ceiling by ${formatSize(size - ceiling)}`);
  }
  if (result.verdict === 'missing') {
    console.log(`  no baseline entry for ${key}; run pnpm run size:baseline`);
  } else if (result.verdict === 'grew') {
    console.log(
      `  grew ${formatSize(result.delta)} past baseline ${formatSize(baselines[key])} ` +
        `(allowed ${formatSize(Math.round(result.tolerance))})`,
    );
  } else if (result.verdict === 'shrank') {
    console.log(
      `  note: ${formatSize(-result.delta)} below baseline ${formatSize(baselines[key])}; ` +
        'run pnpm run size:baseline to lock in the gain',
    );
  }
  return result;
}

const measurements = measureBudgets();

if (process.argv.includes('--write-baseline')) {
  const args = process.argv.slice(2);
  const acceptGrowth = args.flatMap((arg, index) => {
    if (arg !== '--accept-growth') return [];
    if (!args[index + 1]) throw new Error('--accept-growth needs an entry path');
    return [args[index + 1]];
  });
  const previous = existsSync(BASELINE_PATH)
    ? parseBaseline(readFileSync(BASELINE_PATH, 'utf8'))
    : {};
  const measured = Object.fromEntries(measurements.map(({ key, size }) => [key, size]));
  const { next, added, lowered, raised, refused, removed } = refreshBaseline({
    previous,
    measured,
    acceptGrowth,
  });

  writeFileSync(BASELINE_PATH, formatBaseline(next));
  console.log(
    `Wrote ${BASELINE_PATH}: ${added.length} added, ${lowered.length} lowered, ` +
      `${raised.length} raised, ${removed.length} removed, ${refused.length} refused`,
  );
  for (const key of added) console.log(`  added ${key}: ${formatSize(measured[key])}`);
  for (const key of lowered) {
    console.log(`  lowered ${key}: ${formatSize(previous[key])} -> ${formatSize(measured[key])}`);
  }
  for (const key of raised) {
    console.log(`  raised ${key}: ${formatSize(previous[key])} -> ${formatSize(measured[key])}`);
  }
  for (const key of removed) console.log(`  removed ${key}`);
  for (const key of refused) {
    console.log(
      `  REFUSED ${key}: grew ${formatSize(previous[key])} -> ${formatSize(measured[key])}; ` +
        `baseline kept. To accept: pnpm run size:baseline -- --accept-growth ${key}`,
    );
  }
  if (refused.length > 0) process.exitCode = 1;
} else {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(`Missing ${BASELINE_PATH}; run pnpm run size:baseline`);
  }
  const baselines = parseBaseline(readFileSync(BASELINE_PATH, 'utf8'));

  const results = measurements.map((measurement) => reportBudget(measurement, baselines));
  const measuredKeys = new Set(measurements.map(({ key }) => key));
  for (const key of Object.keys(baselines)) {
    if (!measuredKeys.has(key)) {
      console.log(`note: baseline entry ${key} is no longer measured; run pnpm run size:baseline`);
    }
  }

  const overCeiling = results.filter(({ overCeiling }) => overCeiling).length;
  const failed = results.filter(({ failed }) => failed).length;
  console.log(`\n${overCeiling} entries over their ceilings (targets, not failures)`);
  if (failed > 0) {
    console.log(
      `Size ratchet failed on ${failed} of ${results.length} entries (grew past baseline or no ` +
        `baseline). If the growth is intended, run pnpm run size:baseline and commit ` +
        `${BASELINE_PATH}.`,
    );
    process.exitCode = 1;
  }
}
