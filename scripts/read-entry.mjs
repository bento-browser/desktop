import fs from 'node:fs';

/**
 * Reads a symlink or regular file without checking the path first, so nothing
 * can change it between a check and the read. readlink decides which kind it is:
 * it succeeds on a symlink and throws EINVAL on anything else. A regular file is
 * then read through one descriptor, so its mode and content come from the same
 * file even if the path is replaced meanwhile.
 *
 * Returns undefined when the path does not exist, otherwise `{ symlink, mode,
 * content }` where content is the link target or the file bytes (undefined for
 * a directory or other special file).
 */
export function readEntry(absolute) {
  let target;
  try {
    target = fs.readlinkSync(absolute);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code !== 'EINVAL') throw error;
  }
  return target === undefined ? readFile(absolute) : readSymlink(absolute, target);
}

function readSymlink(absolute, target) {
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  return stat && { symlink: true, mode: stat.mode, content: Buffer.from(target) };
}

function readFile(absolute) {
  let fd;
  try {
    fd = fs.openSync(absolute, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    return {
      symlink: false,
      mode: stat.mode,
      content: stat.isFile() ? fs.readFileSync(fd) : undefined,
    };
  } finally {
    fs.closeSync(fd);
  }
}
