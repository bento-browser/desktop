import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const KB = 1000;

const jsEntryBudgets = [
  {
    name: 'bento-shell · shell cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/shell.js',
    limit: '196 KB',
  },
  {
    name: 'bento-shell · palette cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/palette.js',
    limit: '185 KB',
  },
  {
    name: 'bento-shell · address-bar cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/address-bar.js',
    limit: '185 KB',
  },
  {
    name: 'bento-shell · settings cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/settings.js',
    limit: '190 KB',
  },
  {
    name: 'bento-shell · confirm cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/confirm.js',
    limit: '185 KB',
  },
  {
    name: 'bento-shell · edit-workspace cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/edit-workspace.js',
    limit: '185 KB',
  },
  {
    name: 'bento-shell · welcome cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/welcome.js',
    limit: '186 KB',
  },
  {
    name: 'bento-shell · menu cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/menu.js',
    limit: '185 KB',
  },
  {
    name: 'bento-shell · workspace-palette cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/workspace-palette.js',
    limit: '185 KB',
  },
  {
    name: 'bento-shell · merge-palette cold-start JS (gz)',
    entry: 'extensions/bento-shell/dist/assets/merge-palette.js',
    limit: '185 KB',
  },
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

function checkBudget({ name, size, limit }) {
  const limitBytes = bytesForLimit(limit);
  const passed = size <= limitBytes;
  const marker = passed ? 'OK' : 'FAIL';
  console.log(`${marker} ${name}: ${formatSize(size)} / ${limit}`);
  if (!passed) {
    console.log(`  exceeded by ${formatSize(size - limitBytes)}`);
  }
  return passed;
}

let passed = true;

for (const budget of jsEntryBudgets) {
  const files = collectEntryGraph(budget.entry);
  const size = files.reduce((sum, filePath) => sum + gzipSize(filePath), 0);
  passed = checkBudget({ name: budget.name, size, limit: budget.limit }) && passed;
}

for (const budget of readDirectFileBudgets()) {
  const filePath = path.resolve(budget.path);
  if (!existsSync(filePath)) {
    throw new Error(`Missing built asset: ${budget.path}`);
  }
  passed = checkBudget({
    name: budget.name,
    size: gzipSize(filePath),
    limit: budget.limit,
  }) && passed;
}

if (!passed) {
  process.exitCode = 1;
}
