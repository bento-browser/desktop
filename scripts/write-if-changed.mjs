/* global Buffer */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Helpers that leave a file untouched when its bytes already match. Mach and
 * Make decide what to reconfigure or rebuild from mtimes, so rewriting identical
 * generated inputs on every import costs a reconfigure and recompiles.
 */

function sameBytes(file, data) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size === data.length && fs.readFileSync(file).equals(data);
  } catch {
    return false;
  }
}

/** Writes `content` unless the file already holds it. Returns true when it wrote. */
export function writeFileIfChanged(file, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (sameBytes(file, data)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return true;
}

/** Copies `source` over `destination` (bytes and permission bits) only when they differ. */
export function copyFileIfChanged(source, destination) {
  const mode = fs.statSync(source).mode & 0o7777;
  const changed = writeFileIfChanged(destination, fs.readFileSync(source));
  if ((fs.statSync(destination).mode & 0o7777) !== mode) fs.chmodSync(destination, mode);
  return changed;
}

/**
 * Removes everything under `root` that is not one of `keepFiles` (POSIX-style
 * relative paths of regular files), including symlinks, type conflicts and
 * directories left empty.
 */
export function pruneTree(root, keepFiles) {
  const keepDirs = new Set();
  for (const file of keepFiles) {
    for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) {
      keepDirs.add(dir);
    }
  }
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && keepDirs.has(relative)) walk(absolute, `${relative}/`);
      else if (!(entry.isFile() && keepFiles.has(relative))) {
        fs.rmSync(absolute, { recursive: true, force: true });
      }
    }
  };
  walk(root, '');
}
