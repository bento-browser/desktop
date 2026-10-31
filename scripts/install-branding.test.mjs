import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { installBranding } from './install-branding.mjs';
import { FORBIDDEN_IDENTITIES, scanProductIdentity } from './check-product-identity.mjs';

// Reads the mtime through a descriptor, so it does not pair a path stat with a later read.
function mtimeOf(file) {
  const fd = fs.openSync(file, 'r');
  try {
    return fs.fstatSync(fd).mtimeMs;
  } finally {
    fs.closeSync(fd);
  }
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-branding-test-'));
  fs.writeFileSync(
    path.join(root, 'bento.json'),
    JSON.stringify({ schemaVersion: 1, brand: 'bento', build: {}, brands: { bento: {} } }),
  );
  fs.mkdirSync(path.join(root, 'branding', 'bento', 'pref'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'branding', 'bento', 'pref', 'firefox-branding.js'),
    '// Bento\n',
  );
  fs.mkdirSync(path.join(root, 'engine', 'browser', 'branding', 'bento'), { recursive: true });
  fs.writeFileSync(path.join(root, 'engine', 'browser', 'branding', 'bento', 'stale'), 'stale');
  return root;
}

test('installs canonical branding and removes stale files', () => {
  const root = fixture();
  try {
    const result = installBranding({ repoRoot: root });
    assert.equal(result.fileCount, 1);
    assert.equal(fs.existsSync(path.join(result.destination, 'stale')), false);
    assert.equal(
      fs.readFileSync(path.join(result.destination, 'pref', 'firefox-branding.js'), 'utf8'),
      '// Bento\n',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requires the bento active brand', () => {
  const root = fixture();
  try {
    fs.writeFileSync(
      path.join(root, 'bento.json'),
      JSON.stringify({ schemaVersion: 1, brand: 'other', build: {}, brands: { other: {} } }),
    );
    assert.throws(() => installBranding({ repoRoot: root }), /expected active brand/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects forbidden product identity and removes the destination', () => {
  const root = fixture();
  try {
    fs.writeFileSync(
      path.join(root, 'branding', 'bento', 'pref', 'firefox-branding.js'),
      `https://${FORBIDDEN_IDENTITIES[0]}`,
    );
    assert.throws(() => installBranding({ repoRoot: root }), /forbidden identity/);
    assert.equal(fs.existsSync(path.join(root, 'engine', 'browser', 'branding', 'bento')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects publisher data written by the upstream import', () => {
  const root = fixture();
  try {
    const shared = path.join(
      root,
      'engine',
      'browser',
      'installer',
      'windows',
      'nsis',
      'shared.nsh',
    );
    fs.mkdirSync(path.dirname(shared), { recursive: true });
    fs.writeFileSync(shared, `Publisher=${'Ze' + 'n Browser'}\n`);
    assert.throws(() => installBranding({ repoRoot: root }), /forbidden publisher data/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects generated Bento product branding outside the canonical destination', () => {
  const root = fixture();
  try {
    const other = path.join(root, 'engine', 'browser', 'branding', 'unexpected', 'brand.txt');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'Bento Browser');
    assert.throws(() => installBranding({ repoRoot: root }), /unexpected product branding/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects symlinks in canonical branding', (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires elevated Windows privileges');
    return;
  }
  const root = fixture();
  try {
    fs.symlinkSync('/tmp', path.join(root, 'branding', 'bento', 'link'));
    assert.throws(() => installBranding({ repoRoot: root }), /must not contain symlinks/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('product identity scan tolerates dangling development symlinks', (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires elevated Windows privileges');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-identity-test-'));
  try {
    fs.symlinkSync(path.join(root, 'missing-runtime-file'), path.join(root, 'runtime-link'));
    assert.deepEqual(scanProductIdentity([root], { cwd: root }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reinstalling keeps unchanged branding, including the appended prefs block', () => {
  const root = fixture();
  try {
    const result = installBranding({ repoRoot: root });
    const prefs = path.join(result.destination, 'pref', 'firefox-branding.js');
    const appended = '// Bento\n\n// === Bento defaults (appended from prefs/bento.js) ===\npref("a", 1);\n';
    fs.writeFileSync(prefs, appended);
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(prefs, past, past);

    installBranding({ repoRoot: root });
    assert.equal(fs.readFileSync(prefs, 'utf8'), appended);
    assert.equal(mtimeOf(prefs), past.getTime());

    fs.writeFileSync(path.join(root, 'branding', 'bento', 'pref', 'firefox-branding.js'), '// Changed\n');
    installBranding({ repoRoot: root });
    assert.equal(fs.readFileSync(prefs, 'utf8'), '// Changed\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('append-prefs rewrites a pref file only when its content changes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-append-prefs-test-'));
  try {
    fs.cpSync(
      path.dirname(new URL(import.meta.url).pathname),
      path.join(root, 'scripts'),
      { recursive: true },
    );
    fs.mkdirSync(path.join(root, 'extensions', 'bento-shell'), { recursive: true });
    fs.copyFileSync(
      new URL('../extensions/bento-shell/muxui-local.mjs', import.meta.url),
      path.join(root, 'extensions', 'bento-shell', 'muxui-local.mjs'),
    );
    fs.writeFileSync(path.join(root, 'bento.json'), JSON.stringify({ brand: 'bento' }));
    fs.mkdirSync(path.join(root, 'prefs'));
    fs.writeFileSync(path.join(root, 'prefs', 'bento.js'), 'pref("a", 1);\n');
    const branding = path.join(root, 'engine', 'browser', 'branding', 'bento', 'pref', 'firefox-branding.js');
    const firefox = path.join(root, 'engine', 'browser', 'app', 'profile', 'firefox.js');
    for (const file of [branding, firefox]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '// base\n');
    }
    const run = () => spawnSync('bash', ['scripts/append-prefs.sh'], { cwd: root, encoding: 'utf8' });

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const past = new Date('2020-01-01T00:00:00Z');
    for (const file of [branding, firefox]) fs.utimesSync(file, past, past);
    const unchanged = run();
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.match(unchanged.stdout, /already current/);
    assert.equal(mtimeOf(firefox), past.getTime());
    assert.equal(mtimeOf(branding), past.getTime());

    fs.writeFileSync(path.join(root, 'prefs', 'bento.js'), 'pref("a", 2);\n');
    assert.equal(run().status, 0);
    assert.notEqual(mtimeOf(firefox), past.getTime());
    assert.match(fs.readFileSync(firefox, 'utf8'), /pref\("a", 2\);/);
    assert.equal(fs.readFileSync(firefox, 'utf8').match(/Bento defaults/g).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
