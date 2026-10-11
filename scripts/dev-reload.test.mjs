import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isReleaseBuild, resolveBuildMode } from './build-mode.mjs';
import {
  DEV_RELOAD_COMMAND,
  assertNoDevReloadInPackage,
  findDevReload,
  releaseManifest,
} from './dev-reload.mjs';

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

/** A repo root holding only the bento.json the build mode is read from. */
function modeRoot(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-build-mode-'));
  fs.writeFileSync(path.join(dir, 'bento.json'), JSON.stringify({ build: { mode } }));
  return dir;
}

test('the build mode resolves in one place: explicit mode, BENTO_RELEASE, BENTO_BUILD_MODE, bento.json', () => {
  const config = { build: { mode: 'release' } };
  assert.equal(resolveBuildMode(config, undefined, {}), 'release');
  assert.equal(resolveBuildMode(config, undefined, { BENTO_BUILD_MODE: 'dev' }), 'dev');
  assert.equal(resolveBuildMode(config, 'debug', { BENTO_BUILD_MODE: 'dev' }), 'debug');
  assert.throws(() => resolveBuildMode(config, undefined, { BENTO_BUILD_MODE: 'fast' }), /unsupported build mode fast/);
  assert.throws(() => resolveBuildMode({ build: {} }, undefined, {}), /unsupported build mode undefined/);

  // BENTO_RELEASE=1 means release for every consumer. It outranks BENTO_BUILD_MODE (the
  // pair with dev or debug is contradictory, so release wins) but not an explicit mode.
  const dev = { build: { mode: 'dev' } };
  assert.equal(resolveBuildMode(dev, undefined, { BENTO_RELEASE: '1' }), 'release');
  assert.equal(resolveBuildMode(dev, undefined, { BENTO_RELEASE: '1', BENTO_BUILD_MODE: 'dev' }), 'release');
  assert.equal(resolveBuildMode(dev, undefined, { BENTO_RELEASE: '1', BENTO_BUILD_MODE: 'debug' }), 'release');
  assert.equal(resolveBuildMode(dev, 'debug', { BENTO_RELEASE: '1' }), 'debug');
  assert.equal(resolveBuildMode(config, undefined, { BENTO_RELEASE: '0', BENTO_BUILD_MODE: 'dev' }), 'dev');
  assert.throws(() => resolveBuildMode(dev, undefined, { BENTO_RELEASE: '1', BENTO_BUILD_MODE: 'fast' }), /unsupported build mode fast/);
});

test('bento.json build.mode release is a release build without any environment variable', () => {
  const release = modeRoot('release');
  const dev = modeRoot('dev');
  try {
    assert.equal(isReleaseBuild(release, {}), true);
    assert.equal(isReleaseBuild(dev, {}), false);
    assert.equal(isReleaseBuild(dev, { BENTO_RELEASE: '1' }), true);
    assert.equal(isReleaseBuild(dev, { BENTO_BUILD_MODE: 'release' }), true);
    assert.equal(isReleaseBuild(dev, { BENTO_BUILD_MODE: 'debug' }), false);
    // The driver builds BENTO_BUILD_MODE, so it can make a release config a dev build...
    assert.equal(isReleaseBuild(release, { BENTO_BUILD_MODE: 'dev' }), false);
    // ...but BENTO_RELEASE=1 always counts.
    assert.equal(isReleaseBuild(release, { BENTO_BUILD_MODE: 'dev', BENTO_RELEASE: '1' }), true);
    assert.throws(() => isReleaseBuild(path.join(dev, 'missing'), {}), /ENOENT/);
  } finally {
    fs.rmSync(release, { recursive: true, force: true });
    fs.rmSync(dev, { recursive: true, force: true });
  }
});

/**
 * Bundles the shell background with the real build script, as `pnpm --filter @bento/shell build`
 * does. `mode` is the build.mode of the bento.json the script reads.
 */
function bundleBackground(env, mode = 'dev') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-dev-reload-bundle-'));
  const repoRoot = modeRoot(mode);
  try {
    const out = path.join(dir, 'background.js');
    // An undefined value unsets the variable in the child.
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/build-extension-background.mjs'), 'src/background.ts', out],
      {
        cwd: shell,
        env: { ...process.env, BENTO_REPO_ROOT: repoRoot, ...env },
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(out, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
}

const unset = { BENTO_RELEASE: undefined, BENTO_BUILD_MODE: undefined };

test('the dev background bundle keeps the reload handler', () => {
  const bundle = bundleBackground(unset);
  assert.match(bundle, /dev-reload/);
  assert.match(bundle, /runtime\.reload\(\)/);
  // The driver's BENTO_BUILD_MODE wins over a release bento.json, so this is a dev build.
  assert.match(bundleBackground({ ...unset, BENTO_BUILD_MODE: 'dev' }, 'release'), /dev-reload/);
});

test('release background bundles compile out the reload handler', () => {
  for (const [env, mode] of [
    [{ ...unset, BENTO_RELEASE: '1' }, 'dev'],
    [{ ...unset, BENTO_BUILD_MODE: 'release' }, 'dev'],
    // bento.json alone, which is what `pnpm run build` follows when no variable is set.
    [unset, 'release'],
  ]) {
    const bundle = bundleBackground(env, mode);
    assert.doesNotMatch(bundle, /dev-reload/);
    assert.doesNotMatch(bundle, /runtime\.reload\(\)/);
  }
});

const shellAddon = ['chrome', 'browser', 'builtin-addons', 'bento-shell'];

/** Writes files (relative path -> text) under `base`. */
function writeFiles(base, files) {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

test('the package guard scans the real files of the object directory shell', () => {
  const objDist = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-package-guard-'));
  try {
    assert.throws(() => assertNoDevReloadInPackage(objDist, 'Bento.app'), /no bento-shell built-in add-on/);

    // The app bundle's dist/ is a symlink to the imported engine copy, as the sync script leaves it.
    const staged = path.join(objDist, 'staged-dist');
    writeFiles(staged, { 'assets/background.js': '(()=>{})()' });
    const addon = path.join(objDist, 'Bento.app/Contents/Resources/browser', ...shellAddon);
    writeFiles(addon, { 'manifest.json': '{"name":"x"}' });
    fs.symlinkSync(staged, path.join(addon, 'dist'), 'dir');
    assertNoDevReloadInPackage(objDist, 'Bento.app');

    // A stale file behind the symlink is found, reported under the path the package sees.
    writeFiles(staged, { 'assets/background.js': 'c==="dev-reload"' });
    assert.throws(
      () => assertNoDevReloadInPackage(objDist, 'Bento.app'),
      (error) =>
        /would ship the dev-only reload command/.test(error.message) &&
        error.message.includes(path.join(...shellAddon, 'dist/assets/background.js')),
    );

    // A stale manifest in the loose bin/browser tree is found as well.
    writeFiles(staged, { 'assets/background.js': '(()=>{})()' });
    assertNoDevReloadInPackage(objDist, 'Bento.app');
    writeFiles(path.join(objDist, 'bin/browser', ...shellAddon), {
      'manifest.json': '{"commands":{"dev-reload":{}}}',
    });
    assert.throws(
      () => assertNoDevReloadInPackage(objDist, 'Bento.app'),
      /bin\/browser\/chrome\/browser\/builtin-addons\/bento-shell\/manifest\.json/,
    );
  } finally {
    fs.rmSync(objDist, { recursive: true, force: true });
  }
});

test('the package guard fails closed on a dangling link and survives a link loop', () => {
  const objDist = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-package-guard-'));
  try {
    const addon = path.join(objDist, 'bin/browser', ...shellAddon);
    writeFiles(addon, { 'manifest.json': '{}' });
    fs.symlinkSync(addon, path.join(addon, 'loop'), 'dir');
    assertNoDevReloadInPackage(objDist, 'Bento.app');

    fs.symlinkSync(path.join(objDist, 'missing'), path.join(addon, 'dist'), 'dir');
    assert.throws(() => assertNoDevReloadInPackage(objDist, 'Bento.app'), /ENOENT/);
  } finally {
    fs.rmSync(objDist, { recursive: true, force: true });
  }
});
