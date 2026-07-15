import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installBranding } from './install-branding.mjs';
import { FORBIDDEN_IDENTITIES, scanProductIdentity } from './check-product-identity.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-branding-test-'));
  fs.mkdirSync(path.join(root, '.surfer'), { recursive: true });
  fs.writeFileSync(path.join(root, '.surfer', 'dynamicConfig.brand.json'), '"bento"\n');
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
    fs.writeFileSync(path.join(root, '.surfer', 'dynamicConfig.brand.json'), '"other"\n');
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
