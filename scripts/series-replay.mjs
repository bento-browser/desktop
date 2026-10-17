import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FIREFOX_PATCH_APPLY_ARGS,
  FIREFOX_PATCH_GIT_CONFIG,
  SCRATCH_GIT_CONFIG,
} from './firefox-patch-stack.mjs';

export function git(cwd, args, { env, input } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    env: env && { ...process.env, ...env },
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/**
 * Replays patches/series.json on the engine's base commit in a scratch index, the
 * way firefox-patch-stack.mjs checks the series (same pinned git settings and apply
 * flags), and returns the net change per path as a Map of path to
 * `{ status, mode, oid }`: status A (created), M, T (type change) or D (deleted),
 * with the mode and blob id after the series. Git reports the paths, so quoted or
 * odd file names need no parsing here. The engine's index, working tree and object
 * store are not touched: new blobs go to a scratch object directory.
 */
export function replaySeriesChanges(root) {
  const engine = path.join(root, 'engine');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'patches', 'series.json'), 'utf8'));
  const baseRef = `refs/bento/firefox-base/${manifest.base.version}`;
  try {
    git(engine, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
  } catch {
    throw new Error(`engine has no ${baseRef}; run the import first`);
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-series-replay-'));
  const objects = path.join(scratch, 'objects');
  fs.mkdirSync(objects);
  const env = {
    GIT_INDEX_FILE: path.join(scratch, 'index'),
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.resolve(
      engine,
      git(engine, ['rev-parse', '--git-path', 'objects']).trim(),
    ),
  };
  const config = [...FIREFOX_PATCH_GIT_CONFIG, ...SCRATCH_GIT_CONFIG].flatMap((setting) => [
    '-c',
    setting,
  ]);
  try {
    git(engine, [...config, 'read-tree', baseRef], { env });
    for (const entry of manifest.series) {
      const patch = path.join(root, entry.path);
      git(engine, [...config, 'apply', '--cached', ...FIREFOX_PATCH_APPLY_ARGS, patch], { env });
    }
    const tree = git(engine, [...config, 'write-tree'], { env }).trim();
    // -z raw records: ":<old mode> <new mode> <old oid> <new oid> <status>", then the path.
    const records = git(
      engine,
      [...config, 'diff-tree', '-r', '-z', '--no-renames', '--no-abbrev', baseRef, tree],
      { env },
    ).split('\0');
    const changes = new Map();
    for (let index = 0; records[index]; index += 2) {
      const [, mode, , oid, status] = records[index].slice(1).split(' ');
      changes.set(records[index + 1], { status, mode, oid });
    }
    return changes;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
