#!/usr/bin/env node
/* global process */

// Keeps the mtimes of patch-touched engine files whose bytes an import leaves
// unchanged. The import resets every patched file to pristine Firefox and applies
// the series again, so each one is rewritten even when the result is identical,
// and mach then reruns configure and recompiles whatever depends on it.
//
//   paths            print the patch-touched paths (reset-engine-patches.sh uses it)
//   snapshot <run>   before the reset: record bytes hash, mode and mtime per file
//   restore <run>    after the last step that writes those files: put the recorded
//                    mtime back on each file whose bytes and mode still match
//
// A restored (bytes, mtime) pair is one the file really had before this import,
// so mach sees the state it last saw. The snapshot belongs to one run: `restore`
// applies it only when the run id matches and deletes it either way, and
// `snapshot` replaces any snapshot an earlier, failed import left behind.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertLocalBuildPaths } from './bento-build.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_VERSION = 1;

export function snapshotPath(repoRoot = DEFAULT_ROOT) {
  return path.join(repoRoot, '.bento', 'patched-mtimes.json');
}

// What `find patches -name '*.patch'` lists: entries so named that are regular
// files or symlinks (read through the link later), found by descending only into
// real directories. Like find's default -P, a symlinked directory (patches/ itself
// included) is never entered.
function patchFiles(directory) {
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return patchFiles(absolute);
    return entry.name.endsWith('.patch') && (entry.isFile() || entry.isSymbolicLink()) ? [absolute] : [];
  });
}

// Like the reset's old `grep 2>/dev/null`: a dangling or unreadable link is skipped.
function readPatch(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Engine-relative paths the import resets: every `diff --git a/<path>` target in
 * the .patch files under patches/, plus the `kind: "patch"` entries of .bento/engine-state.json
 * (paths an earlier series patched that the current one may no longer name).
 */
export function patchTouchedPaths(repoRoot = DEFAULT_ROOT) {
  const paths = new Set();
  for (const file of patchFiles(path.join(repoRoot, 'patches'))) {
    for (const line of readPatch(file).split('\n')) {
      if (!line.startsWith('diff --git')) continue;
      // awk's default field split: runs of spaces and tabs.
      const target = line.split(/[ \t]+/)[2];
      if (target) paths.add(target.replace(/^a\//, ''));
    }
  }
  const state = path.join(repoRoot, '.bento', 'engine-state.json');
  if (fs.existsSync(state)) {
    for (const entry of JSON.parse(fs.readFileSync(state, 'utf8')).entries || []) {
      if (entry.kind === 'patch') paths.add(entry.path);
    }
  }
  return [...paths].sort();
}

// A path that is missing, sits under a file where the series now has a directory
// (or the reverse), or is a symlink (O_NOFOLLOW).
const NOT_A_FILE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP']);

// Opens a regular file without following a symlink or blocking on a FIFO, and
// decides from the open descriptor alone, so the file checked is the file used.
// Undefined for anything else (missing, symlink, directory, device).
function openRegular(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (NOT_A_FILE.has(error.code)) return undefined;
    throw error;
  }
  if (fs.fstatSync(fd).isFile()) return fd;
  fs.closeSync(fd);
  return undefined;
}

function stateOf(fd) {
  const stat = fs.fstatSync(fd, { bigint: true });
  return {
    sha256: crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex'),
    mode: Number(stat.mode & 0o7777n),
    atimeNs: stat.atimeNs.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  };
}

function fileState(file) {
  const fd = openRegular(file);
  if (fd === undefined) return undefined;
  try {
    return stateOf(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function snapshotPatchedMtimes({ repoRoot = DEFAULT_ROOT, run }) {
  if (!run) throw new Error('preserve-patched-mtimes: snapshot needs a run id');
  assertLocalBuildPaths(repoRoot);
  const target = snapshotPath(repoRoot);
  fs.rmSync(target, { force: true });
  const engine = path.join(repoRoot, 'engine');
  const entries = [];
  for (const relative of patchTouchedPaths(repoRoot)) {
    const state = fileState(path.join(engine, relative));
    if (state) entries.push({ path: relative, ...state });
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, run, entries })}\n`);
  fs.renameSync(temporary, target);
  return entries.length;
}

function readSnapshot(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    return null;
  }
}

const seconds = (ns) => Number(BigInt(ns)) / 1e9;

// The next double above a positive `value`.
function nextUp(value) {
  const bits = new BigUint64Array(new Float64Array([value]).buffer);
  bits[0] += 1n;
  return new Float64Array(bits.buffer)[0];
}

// Sets the recorded mtime, never an earlier one. utimes takes seconds as a double
// (about 2.4e-7 s apart near 1.8e9 s), so the nearest double can land just below
// the recorded nanoseconds; mozbuild rebuilds only what is strictly older than an
// input, so an earlier mtime could skip a needed reconfigure or rebuild. Stepping up
// one double at a time can land up to one step later, which at worst costs a
// rebuild. If no step reaches the recorded time, the file gets the current time.
function setMtimeNotEarlier(fd, atimeNs, mtimeNs) {
  const wanted = BigInt(mtimeNs);
  let candidate = seconds(mtimeNs);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    fs.futimesSync(fd, seconds(atimeNs), candidate);
    if (fs.fstatSync(fd, { bigint: true }).mtimeNs >= wanted) return true;
    candidate = nextUp(candidate);
  }
  const now = new Date();
  fs.futimesSync(fd, now, now);
  return false;
}

/** Returns how many files got their mtime back, or undefined when no snapshot of `run` applied. */
export function restorePatchedMtimes({ repoRoot = DEFAULT_ROOT, run }) {
  if (!run) throw new Error('preserve-patched-mtimes: restore needs a run id');
  assertLocalBuildPaths(repoRoot);
  const target = snapshotPath(repoRoot);
  const snapshot = readSnapshot(target);
  fs.rmSync(target, { force: true });
  if (snapshot?.schemaVersion !== SCHEMA_VERSION || snapshot.run !== run || !Array.isArray(snapshot.entries)) {
    return undefined;
  }
  const engine = path.join(repoRoot, 'engine');
  let restored = 0;
  for (const entry of snapshot.entries) {
    // Compare and set through one descriptor, so the times land on the bytes checked.
    const fd = openRegular(path.join(engine, entry.path));
    if (fd === undefined) continue;
    try {
      const current = stateOf(fd);
      if (current.sha256 !== entry.sha256 || current.mode !== entry.mode) continue;
      if (current.mtimeNs === entry.mtimeNs) continue;
      if (setMtimeNotEarlier(fd, entry.atimeNs, entry.mtimeNs)) restored += 1;
    } finally {
      fs.closeSync(fd);
    }
  }
  return restored;
}

// Compares real paths: under a symlinked directory (macOS /var, /tmp) the module URL
// is the resolved path, and a silent no-op `paths` would make the reset skip every file.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const [command, run] = process.argv.slice(2);
  try {
    if (command === 'paths') {
      for (const relative of patchTouchedPaths()) process.stdout.write(`${relative}\n`);
    } else if (command === 'snapshot') {
      const count = snapshotPatchedMtimes({ run });
      process.stdout.write(`preserve-patched-mtimes: recorded ${count} patched file(s)\n`);
    } else if (command === 'restore') {
      const restored = restorePatchedMtimes({ run });
      process.stdout.write(
        restored === undefined
          ? 'preserve-patched-mtimes: no snapshot for this import; patched files keep new mtimes\n'
          : `preserve-patched-mtimes: kept the previous mtime of ${restored} unchanged patched file(s)\n`,
      );
    } else {
      process.stderr.write('usage: preserve-patched-mtimes.mjs <paths|snapshot <run>|restore <run>>\n');
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
