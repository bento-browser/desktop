#!/usr/bin/env node

// Fingerprint of what `pnpm run import` leaves in engine/, compared before and
// after a repeated import. It covers the tracked diff against HEAD plus the files
// git cannot see in that diff: untracked Bento branding and add-ons, every overlay
// recorded in .bento/import-manifest.json, and every file the patch series creates.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readSeriesPaths } from './patch-series-paths.mjs';
import { readEntry } from './read-entry.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.BENTO_REPO_ROOT || scriptRoot);
const engine = path.join(root, 'engine');
const hash = createHash('sha256');

hash.update(
  execFileSync('git', ['diff', '--binary', '--full-index', 'HEAD', '--'], {
    cwd: engine,
  }),
);

const untracked = execFileSync(
  'git',
  [
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
    'browser/branding/bento',
    'browser/extensions',
  ],
  { cwd: engine },
)
  .toString('utf8')
  .split('\0')
  .filter(Boolean);

let manifestText;
try {
  manifestText = fs.readFileSync(path.join(root, '.bento', 'import-manifest.json'), 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  throw new Error(
    'snapshot-import-output: .bento/import-manifest.json is missing; run the import first',
  );
}
const overlays = JSON.parse(manifestText).entries.map((entry) => entry.destination);

// A path can belong to several groups; sorting the union hashes each once, in a stable order.
const files = [...new Set([...untracked, ...overlays, ...readSeriesPaths(root).created])].sort();

for (const relative of files) {
  const entry = readEntry(path.join(engine, relative));
  if (!entry) throw new Error(`snapshot-import-output: engine/${relative} is missing`);
  if (!entry.content) throw new Error(`snapshot-import-output: engine/${relative} is not a file`);
  hash.update(`\0${relative}\0${entry.mode & 0o777}\0`);
  hash.update(entry.content);
}

process.stdout.write(`${hash.digest('hex')}\n`);
