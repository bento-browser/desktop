import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { readXpiManifest } from './xpi-manifest.mjs';

const ublockDir = path.resolve(import.meta.dirname, '../extensions/ublock-origin');
const xpi = path.join(ublockDir, 'uBlock0@raymondhill.net.xpi');
const readme = fs.readFileSync(path.join(ublockDir, 'README.md'), 'utf8');

test('the committed uBlock Origin XPI is the one the README describes', () => {
  const manifest = readXpiManifest(xpi);
  assert.equal(manifest.browser_specific_settings.gecko.id, 'uBlock0@raymondhill.net');
  assert.ok(readme.includes(`Version: ${manifest.version}`), 'README version');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(xpi)).digest('hex');
  assert.ok(readme.includes(`SHA-256: \`${sha256}\``), 'README SHA-256');
});

/** A one-entry zip: `name` holding `content`, stored or deflated, with the right CRC. */
function zipOf(name, content, { deflate = false } = {}) {
  const data = Buffer.from(content);
  const body = deflate ? zlib.deflateRawSync(data) : data;
  const crc = zlib.crc32(data);
  const method = deflate ? 8 : 0;
  const fileName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);
  const centralSize = central.length + fileName.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(local.length + fileName.length + body.length, 16);
  return { bytes: Buffer.concat([local, fileName, body, central, fileName, end]), bodyOffset: local.length + fileName.length };
}

function inTempDir(use) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-xpi-test-'));
  try {
    return use((name, bytes) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      return file;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('stored and deflated entries are read', () => {
  inTempDir((write) => {
    const manifest = JSON.stringify({ version: '1.2.3', note: 'x'.repeat(2000) });
    assert.equal(readXpiManifest(write('stored.xpi', zipOf('manifest.json', manifest).bytes)).version, '1.2.3');
    assert.equal(readXpiManifest(write('deflated.xpi', zipOf('manifest.json', manifest, { deflate: true }).bytes)).version, '1.2.3');
  });
});

test('a corrupted, truncated, empty or manifest-less archive fails', () => {
  inTempDir((write) => {
    const manifest = JSON.stringify({ version: '1.2.3' });
    for (const deflate of [false, true]) {
      const { bytes, bodyOffset } = zipOf('manifest.json', manifest, { deflate });
      const flipped = Buffer.from(bytes);
      flipped[bodyOffset + 2] ^= 0xff; // damage the entry: the CRC no longer matches
      assert.throws(() => readXpiManifest(write(`flipped-${deflate}.xpi`, flipped)), /cannot read manifest\.json/, `deflate ${deflate}`);
      assert.throws(() => readXpiManifest(write(`cut-${deflate}.xpi`, bytes.subarray(0, bytes.length - 40))), /cannot read manifest\.json/);
    }
    assert.throws(() => readXpiManifest(write('empty.xpi', Buffer.alloc(0))), /cannot read manifest\.json/);
    assert.throws(() => readXpiManifest(write('text.xpi', 'not a zip')), /cannot read manifest\.json/);
    assert.throws(() => readXpiManifest(write('other.xpi', zipOf('background.js', manifest).bytes)), /cannot read manifest\.json/);
    assert.throws(() => readXpiManifest(path.join(os.tmpdir(), 'bento-xpi-does-not-exist.xpi')), /cannot read manifest\.json/);
  });
});

test('a damaged copy of the real XPI fails', () => {
  inTempDir((write) => {
    const bytes = fs.readFileSync(xpi);
    assert.throws(() => readXpiManifest(write('cut.xpi', bytes.subarray(0, bytes.length >> 1))), /cannot read manifest\.json/);
  });
});
