import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import { main as bentoBuild } from './bento-build.mjs';
import { assertShellMuxSource, readZipEntry, stagedBrowserDir } from './muxui-source.mjs';
import { ROLLBACK_VARIANTS } from './rollback-variants.mjs';

const STAMP_ENTRY = 'chrome/browser/builtin-addons/bento-shell/dist/muxui-source.json';
const npm = '{"source":"npm","version":"0.1.0-rc.1"}';
const local = '{"source":"local"}';
const rollback = (variant) => JSON.stringify({ source: 'rollback', variant });
const [variantA, variantB] = ROLLBACK_VARIANTS;

/** A minimal zip with stored or deflated entries, like omni.ja's layout. */
function zip(entries, { deflate = false } = {}) {
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text);
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(zlib.crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(zlib.crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, nameBytes, body);
    directory.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directoryBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directoryBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directoryBytes, end]);
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bento-muxui-source-'));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A staged application whose browser resources hold the given omni.ja entries. */
function stagedApp(root, layout, entries, options) {
  const application =
    layout === 'mac' ? path.join(root, 'bento', 'Bento.app') : path.join(root, 'bento');
  write(path.join(stagedBrowserDir(application), 'omni.ja'), zip(entries, options));
  return application;
}

const staged = (stamp) => [
  ['chrome/browser/other.txt', 'x'],
  ...(stamp === undefined ? [] : [[STAMP_ENTRY, stamp]]),
];

test('readZipEntry reads stored and deflated entries and reports absent ones', () => {
  for (const deflate of [false, true]) {
    const file = path.join(tempDir(), 'omni.ja');
    write(
      file,
      zip(
        [
          ['a.txt', 'first'],
          ['dir/b.json', '{"b":1}'.repeat(50)],
        ],
        { deflate },
      ),
    );
    assert.equal(readZipEntry(file, 'a.txt').toString(), 'first');
    assert.equal(readZipEntry(file, 'dir/b.json').toString(), '{"b":1}'.repeat(50));
    assert.equal(readZipEntry(file, 'missing'), undefined);
  }
  const notZip = path.join(tempDir(), 'omni.ja');
  write(notZip, 'not a zip');
  assert.throws(() => readZipEntry(notZip, 'a'), /not a zip/);
});

test('the staged application is checked inside omni.ja on every platform layout', () => {
  for (const layout of ['mac', 'other']) {
    const check = (stamp, variant, options) =>
      assertShellMuxSource(
        stagedBrowserDir(stagedApp(tempDir(), layout, staged(stamp), options)),
        variant,
      );
    assert.doesNotThrow(() => check(npm, undefined));
    assert.doesNotThrow(() => check(npm, undefined, { deflate: true }));
    assert.throws(() => check(local, undefined), /"source":"local"/);
    assert.throws(() => check(undefined, undefined), /omni\.ja!.*is missing/);
    assert.doesNotThrow(() => check(rollback(variantA), variantA));
    assert.throws(() => check(rollback(variantB), variantA), new RegExp(`expected ${variantA}`));
    assert.throws(() => check(npm, variantA), new RegExp(`expected ${variantA}`));
    assert.throws(() => check(rollback(variantA), undefined), /expected the published npm/);
    assert.throws(
      () => check(rollback('not-a-rollback-variant'), 'not-a-rollback-variant'),
      /not a rollback variant/,
    );
  }
});

test('omni.ja is authoritative over loose files beside it', () => {
  const application = stagedApp(tempDir(), 'other', staged(local));
  write(path.join(application, 'browser', ...STAMP_ENTRY.split('/')), npm);
  assert.throws(() => assertShellMuxSource(stagedBrowserDir(application), undefined), /local/);
});

test('without omni.ja the loose chrome tree is checked', () => {
  const browser = path.join(tempDir(), 'bin', 'browser');
  assert.throws(() => assertShellMuxSource(browser, undefined), /is missing/);
  write(path.join(browser, ...STAMP_ENTRY.split('/')), local);
  assert.throws(() => assertShellMuxSource(browser, undefined), /local/);
  write(path.join(browser, ...STAMP_ENTRY.split('/')), npm);
  assert.doesNotThrow(() => assertShellMuxSource(browser, undefined));
});

/** A repo root for `bento-build package` with an npm source copy and an objdir stamp. */
function packageFixture(objdirStamp) {
  const root = tempDir();
  write(path.join(root, 'engine', 'mach'), '');
  fs.copyFileSync(
    path.join(import.meta.dirname, '..', 'bento.json'),
    path.join(root, 'bento.json'),
  );
  // The imported source copy says npm; only the objdir (what gets packaged) differs.
  write(
    path.join(root, 'engine', 'browser', 'extensions', 'bento-shell', 'dist', 'muxui-source.json'),
    npm,
  );
  const browser = path.join(root, 'engine', 'obj-test', 'dist', 'bin', 'browser');
  fs.mkdirSync(browser, { recursive: true });
  if (objdirStamp !== undefined) {
    write(path.join(browser, ...STAMP_ENTRY.split('/')), objdirStamp);
  }
  return root;
}

async function withVariant(variant, body) {
  const previous = process.env.BENTO_RELEASE_VARIANT;
  if (variant === undefined) delete process.env.BENTO_RELEASE_VARIANT;
  else process.env.BENTO_RELEASE_VARIANT = variant;
  try {
    await body();
  } finally {
    if (previous === undefined) delete process.env.BENTO_RELEASE_VARIANT;
    else process.env.BENTO_RELEASE_VARIANT = previous;
  }
}

test('bento-build package rejects a local objdir even when the source copy says npm', async () => {
  await withVariant(undefined, async () => {
    await assert.rejects(bentoBuild(['package'], packageFixture(local)), /"source":"local"/);
    await assert.rejects(bentoBuild(['package'], packageFixture(undefined)), /is missing/);
    await assert.rejects(
      bentoBuild(['package'], packageFixture(rollback(variantA))),
      /expected the published npm/,
    );
    // An npm objdir passes the early check; the fixture has no scripts/mach-raw.sh, so
    // the next step (mach package) fails instead of the stamp check.
    await assert.rejects(bentoBuild(['package'], packageFixture(npm)), (error) => {
      assert.doesNotMatch(error.message, /muxui-source/);
      return true;
    });
  });
});

test('bento-build package checks the rollback variant against its own stamp', async () => {
  await withVariant(variantA, async () => {
    await assert.rejects(
      bentoBuild(['package'], packageFixture(npm)),
      new RegExp(`expected ${variantA}`),
    );
    await assert.rejects(bentoBuild(['package'], packageFixture(undefined)), /is missing/);
    await assert.rejects(
      bentoBuild(['package'], packageFixture(rollback(variantB))),
      new RegExp(`expected ${variantA}`),
    );
    await assert.rejects(bentoBuild(['package'], packageFixture(rollback(variantA))), (error) => {
      assert.doesNotMatch(error.message, /muxui-source/);
      return true;
    });
  });
  await withVariant('not-a-rollback-variant', async () => {
    await assert.rejects(
      bentoBuild(['package'], packageFixture(rollback('not-a-rollback-variant'))),
      /not a rollback variant/,
    );
  });
});
