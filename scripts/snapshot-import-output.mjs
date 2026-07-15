#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  .filter(Boolean)
  .sort((a, b) => a.localeCompare(b));

for (const relative of untracked) {
  const absolute = path.join(engine, relative);
  const stat = fs.lstatSync(absolute);
  hash.update(`\0${relative}\0${stat.mode & 0o777}\0`);
  hash.update(stat.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute));
}

process.stdout.write(`${hash.digest('hex')}\n`);
