import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEV_RELOAD_COMMAND, findDevReload, releaseManifest } from './dev-reload.mjs';

const root = path.resolve(import.meta.dirname, '..');
const shell = path.join(root, 'extensions/bento-shell');
const devReload = { suggested_key: { default: 'Alt+Shift+R' }, description: 'Dev reload' };

test('release manifest drops the reload command and an emptied commands block', () => {
  const manifest = { name: 'x', commands: { [DEV_RELOAD_COMMAND]: devReload } };
  assert.deepEqual(releaseManifest(manifest), { name: 'x' });
  assert.ok(DEV_RELOAD_COMMAND in manifest.commands, 'the input is not mutated');

  const withOther = { commands: { [DEV_RELOAD_COMMAND]: devReload, other: { description: 'o' } } };
  assert.deepEqual(releaseManifest(withOther), { commands: { other: { description: 'o' } } });
});

test('release manifest returns manifests without the command untouched', () => {
  const plain = { name: 'x' };
  assert.equal(releaseManifest(plain), plain);
  const other = { commands: { other: {} } };
  assert.equal(releaseManifest(other), other);
});

test('the shell manifest declares the command for dev and not for release', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(shell, 'manifest.json'), 'utf8'));
  assert.ok(manifest.commands[DEV_RELOAD_COMMAND], 'dev loop depends on Alt+Shift+R');
  assert.doesNotMatch(JSON.stringify(releaseManifest(manifest)), /dev-reload/);
});

test('findDevReload reports only files that mention the command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-dev-reload-scan-'));
  try {
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'clean.js'), 'console.log(1)');
    fs.writeFileSync(path.join(dir, 'assets', 'leak.js'), 'if(c==="dev-reload")r()');
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{"commands":{"dev-reload":{}}}');
    assert.deepEqual(
      findDevReload([dir]).map((file) => path.relative(dir, file)),
      ['assets/leak.js', 'manifest.json'],
    );
    assert.deepEqual(findDevReload([path.join(dir, 'assets', 'clean.js')]), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** Bundles the shell background with the real build script, as `pnpm --filter @bento/shell build` does. */
function bundleBackground(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-dev-reload-bundle-'));
  try {
    const out = path.join(dir, 'background.js');
    // An undefined value unsets the variable in the child.
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/build-extension-background.mjs'), 'src/background.ts', out],
      { cwd: shell, env: { ...process.env, ...env }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(out, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the dev background bundle keeps the reload handler', () => {
  const bundle = bundleBackground({ BENTO_RELEASE: undefined, BENTO_BUILD_MODE: undefined });
  assert.match(bundle, /dev-reload/);
  assert.match(bundle, /runtime\.reload\(\)/);
});

test('release background bundles compile out the reload handler', () => {
  for (const env of [
    { BENTO_RELEASE: '1', BENTO_BUILD_MODE: undefined },
    { BENTO_RELEASE: undefined, BENTO_BUILD_MODE: 'release' },
  ]) {
    const bundle = bundleBackground(env);
    assert.doesNotMatch(bundle, /dev-reload/);
    assert.doesNotMatch(bundle, /runtime\.reload\(\)/);
  }
});
