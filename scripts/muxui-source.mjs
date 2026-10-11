// Reads the shell's Mux source stamp from packaged output so packaging can
// refuse anything but the published npm @muxui/react (see docs/build-tooling.md,
// "Local Mux UI"). The stamp is `dist/muxui-source.json` of the bento-shell
// built-in add-on, which Firefox installs under
// `chrome/browser/builtin-addons/bento-shell/dist/` of the browser resources:
// as loose files in the objdir's `dist/bin/browser`, and inside `omni.ja` of the
// staged application that `mach package` produces.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import { MUX_SOURCE_STAMP, assertMuxSourceStamp } from '../extensions/bento-shell/muxui-local.mjs';
import { ROLLBACK_VARIANTS } from './rollback-variants.mjs';

const STAMP_ENTRY = `chrome/browser/builtin-addons/bento-shell/dist/${MUX_SOURCE_STAMP}`;

/** Returns one entry of a zip archive (such as omni.ja), or undefined when absent. */
export function readZipEntry(zipPath, entryName) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const tail = Buffer.alloc(Math.min(size, 22 + 0xffff));
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (eocd < 0) throw new Error(`${zipPath} is not a zip archive`);
    const count = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    const directory = Buffer.alloc(directorySize);
    fs.readSync(fd, directory, 0, directorySize, directoryOffset);

    let at = 0;
    for (let index = 0; index < count; index += 1) {
      if (directory.readUInt32LE(at) !== 0x02014b50) throw new Error(`${zipPath} is corrupt`);
      const method = directory.readUInt16LE(at + 10);
      const compressedSize = directory.readUInt32LE(at + 20);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const localOffset = directory.readUInt32LE(at + 42);
      const name = directory.toString('utf8', at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      if (name !== entryName) continue;

      const local = Buffer.alloc(30);
      fs.readSync(fd, local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`${zipPath} is corrupt`);
      const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const data = Buffer.alloc(compressedSize);
      fs.readSync(fd, data, 0, compressedSize, dataOffset);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(`${zipPath}: unsupported compression method ${method} for ${entryName}`);
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** The browser resources directory of a staged application. */
export function stagedBrowserDir(application) {
  return path.basename(application).endsWith('.app')
    ? path.join(application, 'Contents', 'Resources', 'browser')
    : path.join(application, 'browser');
}

/** Stamp text and its location under a browser resources directory; omni.ja wins when present. */
export function readShellMuxStamp(browserDir) {
  const omni = path.join(browserDir, 'omni.ja');
  if (fs.existsSync(omni)) {
    return {
      where: `${omni}!/${STAMP_ENTRY}`,
      text: readZipEntry(omni, STAMP_ENTRY)?.toString('utf8'),
    };
  }
  const file = path.join(browserDir, ...STAMP_ENTRY.split('/'));
  return { where: file, text: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined };
}

/**
 * Throws unless the shell shipped under `browserDir` carries an allowed stamp:
 * npm without a rollback variant, otherwise only that variant's own stamp.
 */
export function assertShellMuxSource(browserDir, variant) {
  const { text, where } = readShellMuxStamp(browserDir);
  assertMuxSourceStamp(text, { where, variant, variants: ROLLBACK_VARIANTS });
}
