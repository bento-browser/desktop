import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  acquireSourceArchive,
  adoptExistingSource,
  assertLocalBuildPaths,
  compareFirefoxVersions,
  createContext,
  engineStatus,
  extractArchive,
  loadConfig,
  main,
  nativeBuildSettings,
  recordEngineState,
  resolveObjDir,
  verifyRecordedEngineState,
  verifyManagedEngine,
  verifySourceArchive,
  writeBrowserUpdateFiles,
  writeMozconfig,
} from './bento-build.mjs';
import { isReleaseBuild } from './build-mode.mjs';
import { extractArchive as extractBaselineArchive } from './firefox-patch-stack.mjs';
import { importSourceOverlays } from './import-sources.mjs';
import { installBuiltinAddons } from './install-builtin-addons.mjs';
import { installBranding } from './install-branding.mjs';
import { activeMozconfigLines, mozconfigUpdaterState } from './update-readiness.mjs';
import { validateArtifacts } from './validate-bento-artifacts.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MODES = ['dev', 'debug', 'release'];
const platformName = { darwin: 'macos', win32: 'windows' }[process.platform] || 'linux';

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A repo root with a committed pristine engine, as a fresh download leaves it. */
async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-build-fixture-'));
  await fsp.cp(path.join(repoRoot, 'configs'), path.join(root, 'configs'), { recursive: true });
  await fsp.mkdir(path.join(root, 'src', 'browser', 'base'), { recursive: true });
  await fsp.writeFile(path.join(root, 'src', 'browser', 'base', 'one.js'), 'one\n');
  await fsp.writeFile(
    path.join(root, 'bento.json'),
    JSON.stringify({
      schemaVersion: 1,
      brand: 'bento',
      build: { mode: 'dev', windowsUseSymbolicLinks: false },
      firefox: {
        product: 'firefox',
        version: '154.0',
        source: { archiveBaseUrl: 'https://archive.example.invalid/releases', sha256: '0'.repeat(64) },
      },
      brands: { bento: { release: { displayVersion: '0.0.7' } } },
      updates: { hostname: 'updates.example.invalid', channel: 'bento' },
    }),
  );
  const engine = path.join(root, 'engine');
  await fsp.mkdir(path.join(engine, 'toolkit'), { recursive: true });
  await fsp.mkdir(path.join(engine, 'browser', 'config'), { recursive: true });
  await fsp.writeFile(path.join(engine, 'toolkit', 'moz.build'), '');
  // Firefox ignores mozconfig; the version files are tracked.
  await fsp.writeFile(path.join(engine, '.gitignore'), '/mozconfig*\n');
  await fsp.writeFile(path.join(engine, 'browser', 'config', 'version.txt'), '154.0\n');
  await fsp.writeFile(path.join(engine, 'browser', 'config', 'version_display.txt'), '154.0\n');
  git(engine, ['init']);
  git(engine, ['config', 'user.name', 'Test']);
  git(engine, ['config', 'user.email', 'test@example.invalid']);
  git(engine, ['add', '-A']);
  git(engine, ['commit', '-m', 'Firefox 154.0']);
  git(engine, ['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);
  return root;
}

const engineFile = (root, ...segments) => path.join(root, 'engine', ...segments);

function isolationFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-isolation-'));
  const root = path.join(directory, 'checkout');
  const foreign = `${root}-other`;
  fs.mkdirSync(root);
  fs.mkdirSync(foreign);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { root, foreign, directory };
}

test('build path isolation rejects independently borrowed engine and state, including sibling prefixes', (t) => {
  const { root, foreign } = isolationFixture(t);
  for (const name of ['engine', '.bento']) {
    const target = path.join(foreign, name);
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'marker'), 'foreign');
    fs.symlinkSync(target, path.join(root, name), 'dir');
    assert.throws(() => assertLocalBuildPaths(root), (error) => {
      assert.match(error.message, /build outputs must stay inside checkout/);
      assert.ok(error.message.includes(fs.realpathSync(root)));
      assert.ok(error.message.includes(`${path.join(root, name)} -> ${fs.realpathSync(target)}`));
      const localName = name === 'engine' ? '.bento' : 'engine';
      assert.ok(!error.message.includes(`${path.join(root, localName)} ->`));
      return true;
    });
    assert.equal(fs.readFileSync(path.join(target, 'marker'), 'utf8'), 'foreign');
    fs.unlinkSync(path.join(root, name));
  }
});

test('build path isolation accepts canonical root aliases, absent local outputs, and internal patch worktrees', (t) => {
  const { root, directory } = isolationFixture(t);
  const alias = path.join(directory, 'alias');
  fs.symlinkSync(root, alias, 'dir');
  assertLocalBuildPaths(alias);
  assert.deepEqual(fs.readdirSync(root), [], 'preflight creates no output directories');
  const internal = path.join(root, '.bento', 'patch-stack-worktree');
  fs.mkdirSync(internal, { recursive: true });
  fs.symlinkSync(internal, path.join(root, 'engine'), 'dir');
  assertLocalBuildPaths(alias);
});

test('build path isolation fails closed for dangling and looping output symlinks', (t) => {
  const { root } = isolationFixture(t);
  for (const name of ['engine', '.bento']) {
    const link = path.join(root, name);
    for (const target of ['missing', name]) {
      fs.symlinkSync(target, link, 'dir');
      assert.throws(() => assertLocalBuildPaths(root), /unresolvable/);
      assert.equal(fs.readlinkSync(link), target);
      fs.unlinkSync(link);
    }
  }
});

test('direct build mutators reject borrowed output paths before reading or writing state', async (t) => {
  const { root, foreign } = isolationFixture(t);
  fs.symlinkSync(foreign, path.join(root, '.bento'), 'dir');
  await assert.rejects(acquireSourceArchive(root), /build outputs must stay inside checkout/);
  for (const mutate of [
    () => adoptExistingSource(createContext(root), {}, '158.0'),
    () => recordEngineState(root),
    () => writeMozconfig(root),
  ]) assert.throws(mutate, /build outputs must stay inside checkout/);
  await assert.rejects(importSourceOverlays({ repoRoot: root }), /build outputs must stay inside checkout/);
  assert.deepEqual(fs.readdirSync(foreign), []);
});

test('every build mode builds into the fixed object directory', async () => {
  const root = await fixture();
  try {
    for (const mode of MODES) {
      const { destination } = writeMozconfig(root, mode);
      assert.match(
        fs.readFileSync(destination, 'utf8'),
        /^mk_add_options MOZ_OBJDIR=@TOPSRCDIR@\/obj-bento$/m,
      );
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('native build intent is read-only and ignores mutable engine mozconfig', async () => {
  const root = await fixture();
  try {
    const before = nativeBuildSettings(root);
    fs.writeFileSync(engineFile(root, 'mozconfig'), 'untrusted generated config\n');
    assert.deepEqual(nativeBuildSettings(root), before);
    assert.equal(fs.readFileSync(engineFile(root, 'mozconfig'), 'utf8'), 'untrusted generated config\n');
    fs.appendFileSync(path.join(root, 'configs', platformName, 'mozconfig'), '\nac_add_options --enable-example\n');
    assert.match(nativeBuildSettings(root).mozconfig, /--enable-example/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** The `ac_add_options` flags of a mozconfig, without the leading `ac_add_options `. */
function configureOptions(text) {
  return text.split('\n').filter((line) => line.startsWith('ac_add_options ')).map((line) => line.slice('ac_add_options '.length));
}

/** Runs `fn` as if the host were `platform`; the generator reads process.platform. */
function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

function patchBentoJson(root, edit) {
  const file = path.join(root, 'bento.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  edit(config);
  fs.writeFileSync(file, JSON.stringify(config));
}

/** Records every readiness input, then turns the updater on. */
function enableUpdater(root) {
  const fingerprint = 'a'.repeat(64);
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'config', 'release-security.json'),
    JSON.stringify({
      schemaVersion: 1,
      updateService: {
        hostname: 'updates.example.invalid',
        marSigningKeyFingerprint: fingerprint,
        updaterCertificateFingerprint: fingerprint,
        hostCompiledIn: true,
        isolatedRoundTripVerified: true,
      },
    }),
  );
  patchBentoJson(root, (config) => {
    config.updates.enabled = true;
  });
}

test('the shared fragment sets no compiler policy; each mode sets its own', async () => {
  const common = fs.readFileSync(path.join(repoRoot, 'configs', 'common', 'mozconfig'), 'utf8');
  assert.deepEqual(
    configureOptions(common).filter((option) => /release|debug|optimize/.test(option)),
    [],
  );

  const root = await fixture();
  try {
    const optionsFor = (mode) => configureOptions(fs.readFileSync(writeMozconfig(root, mode).destination, 'utf8'));
    const dev = optionsFor('dev');
    assert.ok(dev.includes('--disable-release'));
    assert.ok(dev.includes('--disable-debug'));
    assert.equal(dev.includes('--enable-release'), false);

    // Debug is a developer build too: it must not carry release policy.
    const debug = optionsFor('debug');
    assert.deepEqual(
      debug.filter((option) => /release|debug|optimize/.test(option)),
      ['--enable-debug', '--disable-optimize', '--disable-release'],
    );

    const release = optionsFor('release');
    assert.deepEqual(
      release.filter((option) => /release|debug|optimize|simd/.test(option)),
      ['--disable-debug', '--enable-optimize', '--enable-rust-simd', '--enable-release'],
    );
    assert.equal(release.some((option) => option.startsWith('--enable-macos-target')), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('developer builds pin the macOS deployment target only on macOS', async () => {
  const root = await fixture();
  try {
    for (const [platform, expected] of [['darwin', true], ['linux', false], ['win32', false]]) {
      for (const mode of ['dev', 'debug']) {
        const options = withPlatform(platform, () => configureOptions(fs.readFileSync(writeMozconfig(root, mode).destination, 'utf8')));
        assert.equal(options.includes('--enable-macos-target=11.0'), expected, `${platform} ${mode}`);
      }
      const release = withPlatform(platform, () => configureOptions(fs.readFileSync(writeMozconfig(root, 'release').destination, 'utf8')));
      assert.equal(release.some((option) => option.startsWith('--enable-macos-target')), false, `${platform} release`);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the updater is compiled out in every mode unless bento.json enables it', async () => {
  const root = await fixture();
  try {
    for (const mode of MODES) {
      const text = fs.readFileSync(writeMozconfig(root, mode).destination, 'utf8');
      const options = configureOptions(text);
      assert.ok(options.includes('--disable-updater'), mode);
      // The channel stays set so enabling the updater later needs no other change.
      assert.ok(options.includes('--enable-update-channel=bento'), mode);
    }
    patchBentoJson(root, (config) => {
      config.updates.enabled = false;
    });
    assert.ok(configureOptions(fs.readFileSync(writeMozconfig(root, 'dev').destination, 'utf8')).includes('--disable-updater'));

    enableUpdater(root);
    for (const mode of MODES) {
      const text = fs.readFileSync(writeMozconfig(root, mode).destination, 'utf8');
      assert.equal(configureOptions(text).includes('--disable-updater'), false, mode);
      assert.match(text, /^# Updater: compiled in/m);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('enabling the updater is refused until every readiness input is recorded', async () => {
  const root = await fixture();
  try {
    patchBentoJson(root, (config) => {
      config.updates.enabled = true;
    });
    assert.throws(() => writeMozconfig(root, 'dev'), /config\/release-security\.json is missing/);
    assert.equal(fs.existsSync(engineFile(root, 'mozconfig')), false);

    enableUpdater(root);
    const security = path.join(root, 'config', 'release-security.json');
    const ready = JSON.parse(fs.readFileSync(security, 'utf8'));
    const cases = [
      [(service) => { service.marSigningKeyFingerprint = ''; }, /marSigningKeyFingerprint must be the SHA-256/],
      [(service) => { service.updaterCertificateFingerprint = 'b'.repeat(64); }, /updaterCertificateFingerprint must equal marSigningKeyFingerprint/],
      [(service) => { service.hostCompiledIn = false; }, /hostCompiledIn must be true/],
      [(service) => { service.isolatedRoundTripVerified = false; }, /isolatedRoundTripVerified must be true/],
    ];
    for (const [unready, message] of cases) {
      const candidate = structuredClone(ready);
      unready(candidate.updateService);
      fs.writeFileSync(security, JSON.stringify(candidate));
      assert.throws(() => writeMozconfig(root, 'release'), message);
      assert.equal(fs.existsSync(engineFile(root, 'mozconfig')), false);
    }

    // Mozilla's channel names select Mozilla's update certificates.
    fs.writeFileSync(security, JSON.stringify(ready));
    // configure lowercases the channel before choosing certificates, so spelling does not escape this.
    for (const channel of ['release', 'Release', 'NIGHTLY', ' nightly ', 'Nightly-Try']) {
      patchBentoJson(root, (config) => {
        config.updates.channel = channel;
      });
      assert.throws(() => writeMozconfig(root, 'release'), /must be a Bento-owned channel/, JSON.stringify(channel));
    }
    patchBentoJson(root, (config) => {
      config.updates.channel = 'Bento';
    });
    assert.throws(() => writeMozconfig(root, 'release'), /must be lowercase with no surrounding whitespace/);

    patchBentoJson(root, (config) => {
      config.updates.channel = 'bento';
    });
    writeMozconfig(root, 'release');
    assert.ok(fs.existsSync(engineFile(root, 'mozconfig')));

    patchBentoJson(root, (config) => {
      config.updates.enabled = 'yes';
    });
    assert.throws(() => loadConfig(root), /updates\.enabled must be true or false/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('update metadata commands refuse to run while the updater is disabled', async () => {
  const root = await fixture();
  try {
    for (const command of ['updates-browser', 'updates-addons']) {
      await assert.rejects(() => main([command], root), new RegExp(`${command}: the updater is disabled`));
    }
    assert.equal(fs.existsSync(path.join(root, 'dist')), false);

    // Enabled but not ready is refused as well; no metadata for an updater that cannot be trusted.
    patchBentoJson(root, (config) => {
      config.updates.enabled = true;
    });
    await assert.rejects(() => main(['updates-addons'], root), /config\/release-security\.json is missing/);
    enableUpdater(root);
    await main(['updates-addons'], root);
    assert.ok(fs.existsSync(path.join(root, 'dist', 'update', 'browser', 'addons', 'bento', 'update.xml')));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/**
 * A root whose `package` can run without Firefox: scripts/mach-raw.sh and the MAR tooling
 * are stubs, and engine/obj-bento holds a staged application with the npm Mux stamp.
 */
async function packagingFixture() {
  const root = await fixture();
  const dist = engineFile(root, 'obj-bento', 'dist');
  const stamp = ['chrome', 'browser', 'builtin-addons', 'bento-shell', 'dist', 'muxui-source.json'];
  const application = process.platform === 'darwin' ? path.join(dist, 'bento', 'Bento.app') : path.join(dist, 'bento');
  const resources = process.platform === 'darwin' ? path.join(application, 'Contents', 'Resources') : application;
  for (const browserDir of [path.join(dist, 'bin', 'browser'), path.join(resources, 'browser')]) {
    fs.mkdirSync(path.dirname(path.join(browserDir, ...stamp)), { recursive: true });
    fs.writeFileSync(path.join(browserDir, ...stamp), '{"source":"npm","version":"0.1.0-rc.1"}');
  }
  fs.writeFileSync(path.join(resources, 'application.ini'), '[App]\nBuildID=20260912000000\n');
  // Firefox's packager writes precomplete whether or not the updater is built.
  fs.writeFileSync(path.join(resources, 'precomplete'), '');
  fs.writeFileSync(path.join(dist, 'bento-0.0.7.en-US.mac.dmg'), 'application');
  fs.mkdirSync(path.join(dist, 'host', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'host', 'bin', 'mar'), '#!/bin/sh\nprintf "SIZE\\tMODE\\tNAME\\n0\\t0644\\tprecomplete\\n"\n', { mode: 0o755 });
  fs.mkdirSync(engineFile(root, 'tools', 'update-packaging'), { recursive: true });
  fs.writeFileSync(engineFile(root, 'tools', 'update-packaging', 'make_full_update.sh'), '#!/bin/sh\nprintf mar > "$1/output.mar"\n');
  fs.writeFileSync(engineFile(root, 'mach'), '');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'mach-raw.sh'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.join(root, 'locales'));
  fs.writeFileSync(path.join(root, 'locales', 'supported-languages'), 'en-US\n');
  patchBentoJson(root, (config) => {
    config.binaryName = 'bento';
    config.locales = { supportedLanguages: 'locales/supported-languages', languageMaps: 'locales/language-maps' };
  });
  return { root };
}

/** Stands in for configure's record of the updater and update channel in the object directory. */
function configured(root, updater, channel = 'bento') {
  const substs = { MOZ_UPDATE_CHANNEL: channel, ...(updater ? { MOZ_UPDATER: '1' } : {}) };
  fs.writeFileSync(engineFile(root, 'obj-bento', 'config.status.json'), JSON.stringify({ substs }));
}

test('package writes a MAR and update metadata only while the updater is enabled', async (t) => {
  if (process.platform === 'win32') {
    t.skip('packaging shells out through bash and cygpath on Windows');
    return;
  }
  const { root } = await packagingFixture();
  try {
    await withObjdirEnv(undefined, async () => {
      const dist = path.join(root, 'dist');
      const manifest = () => JSON.parse(fs.readFileSync(path.join(dist, 'bento-artifacts.json'), 'utf8'));

      // Disabled (the default): a MAR and update XML from an earlier package are removed, none are written.
      writeMozconfig(root, 'dev');
      configured(root, false);
      fs.mkdirSync(path.join(dist, 'update', 'browser', 'Darwin_aarch64-gcc3', 'bento'), { recursive: true });
      fs.writeFileSync(path.join(dist, 'output.mar'), 'stale');
      await main(['package'], root);
      const off = manifest();
      assert.deepEqual(off.updates, { enabled: false });
      assert.equal(off.buildId, '20260912000000');
      for (const field of ['mar', 'marTool', 'updateTargets']) assert.equal(field in off, false, field);
      assert.equal(fs.existsSync(path.join(dist, 'output.mar')), false);
      assert.equal(fs.existsSync(path.join(dist, 'update')), false);
      assert.equal(validateArtifacts(root).updates, false);

      // Enabled: the same package also gets a MAR and update XML, and validates against them.
      enableUpdater(root);
      writeMozconfig(root, 'dev');
      configured(root, true);
      await main(['package'], root);
      const on = manifest();
      assert.deepEqual(on.updates, { enabled: true });
      assert.equal(on.mar.path, 'dist/output.mar');
      assert.ok(on.updateTargets.length > 0);
      for (const target of on.updateTargets) {
        assert.ok(fs.existsSync(path.join(dist, 'update', 'browser', target, 'bento', 'update.xml')), target);
      }
      assert.ok(fs.existsSync(path.join(dist, 'update', 'browser', 'addons', 'bento', 'update.xml')));
      assert.equal(validateArtifacts(root).updates, true);
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('package refuses a build whose updater setting differs from bento.json', async () => {
  const { root } = await packagingFixture();
  try {
    await withObjdirEnv(undefined, async () => {
      // Configured with the updater compiled out, then bento.json turned it on.
      writeMozconfig(root, 'dev');
      enableUpdater(root);
      await assert.rejects(() => main(['package'], root), /engine\/mozconfig compiled the updater out, but bento\.json updates\.enabled is true; run pnpm run build first/);

      // Configured with it compiled in, then bento.json turned it off.
      writeMozconfig(root, 'dev');
      patchBentoJson(root, (config) => {
        config.updates.enabled = false;
      });
      await assert.rejects(() => main(['package'], root), /engine\/mozconfig compiled the updater in, but bento\.json updates\.enabled is false; run pnpm run build first/);
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('package takes the updater state from the last flag in engine/mozconfig and from what configure recorded', async () => {
  const { root } = await packagingFixture();
  try {
    await withObjdirEnv(undefined, async () => {
      const mozconfig = engineFile(root, 'mozconfig');
      // Updater off in bento.json, but a later flag compiles it in: the first line must not decide.
      writeMozconfig(root, 'dev');
      fs.appendFileSync(mozconfig, 'ac_add_options --enable-updater\n');
      await assert.rejects(() => main(['package'], root), /engine\/mozconfig compiled the updater in, but bento\.json updates\.enabled is false/);

      // Updater on in bento.json, but a later flag compiles it out.
      enableUpdater(root);
      writeMozconfig(root, 'dev');
      fs.appendFileSync(mozconfig, 'ac_add_options --disable-updater\n');
      await assert.rejects(() => main(['package'], root), /engine\/mozconfig compiled the updater out, but bento\.json updates\.enabled is true/);

      // A mozconfig that reads right still loses to what configure built.
      writeMozconfig(root, 'dev');
      configured(root, false);
      await assert.rejects(() => main(['package'], root), /engine\/obj-bento\/config\.status\.json configured the updater out, but bento\.json updates\.enabled is true/);
      patchBentoJson(root, (config) => {
        config.updates.enabled = false;
      });
      writeMozconfig(root, 'dev');
      configured(root, true);
      await assert.rejects(() => main(['package'], root), /engine\/obj-bento\/config\.status\.json configured the updater in, but bento\.json updates\.enabled is false/);

      // The channel configure recorded must be bento.json's: Mozilla's names select Mozilla's certificates.
      for (const updater of [false, true]) {
        if (updater) enableUpdater(root);
        writeMozconfig(root, 'dev');
        configured(root, updater, 'release');
        await assert.rejects(() => main(['package'], root), /engine\/obj-bento\/config\.status\.json configured the update channel "release", but bento\.json updates\.channel is "bento"/);
      }
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the updater state of a mozconfig is its last updater flag, and Firefox builds the updater by default', () => {
  const cases = [
    ['', true],
    ['# ac_add_options --disable-updater\n', true],
    ['ac_add_options --disable-updater\n', false],
    ['ac_add_options --disable-updater\nac_add_options --enable-updater\n', true],
    ['ac_add_options --enable-updater\nac_add_options --disable-updater\n', false],
    ['ac_add_options --enable-updater --disable-updater\n', false],
    ['ac_add_options --disable-updater\nac_add_options --with-updater\n', true],
    ['ac_add_options --enable-updater\nac_add_options --without-updater\n', false],
    ['ac_add_options --disable-updater\nac_add_options "--enable-updater"\n', true],
    ['ac_add_options --disable-updater\r\nac_add_options --enable-updater # on again\r\n', true],
    ['ac_add_options --disable-updater\n# ac_add_options --enable-updater\n', false],
    ['ac_add_options --disable-updater # ac_add_options --enable-updater\n', false],
    ['ac_add_options --enable-updater # --disable-updater\n', true],
  ];
  for (const [text, expected] of cases) assert.equal(mozconfigUpdaterState(text), expected, JSON.stringify(text));
});

test('mozconfig lines lose full-line and trailing shell comments, but not a quoted or attached #', () => {
  const text = [
    '# full line',
    '   # indented full line',
    'ac_add_options --enable-optimize # trailing note',
    'ac_add_options --enable-optimize\t#tab then note',
    'export A=b#c',
    'export B="x # y"',
    "export C='x # y'",
    'export D=x\\ # y',
    '',
  ].join('\n');
  assert.deepEqual(activeMozconfigLines(text), [
    'ac_add_options --enable-optimize',
    'ac_add_options --enable-optimize',
    'export A=b#c',
    'export B="x # y"',
    "export C='x # y'",
    'export D=x\\ # y',
  ]);
});

test('a mozconfig fragment that sets the updater, unverified updates or the update channel is rejected, in any spelling', async () => {
  const root = await fixture();
  try {
    await withObjdirEnv(undefined, async () => {
      const fragments = [path.join(root, 'mozconfig'), path.join(root, 'configs', platformName, 'mozconfig'), path.join(root, 'configs', 'common', 'mozconfig')];
      for (const fragment of fragments) {
        let original;
        try {
          original = fs.readFileSync(fragment);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        fs.mkdirSync(path.dirname(fragment), { recursive: true });
        // Comments never count, whole-line or trailing, even when they name an option.
        fs.writeFileSync(fragment, `${original ?? ''}\n# --enable-updater and --enable-unverified-updates in a comment are fine\nac_add_options --enable-optimize # updater remains disabled\n`);
        writeMozconfig(root, 'dev');
        for (const line of [
          'ac_add_options --enable-updater',
          'ac_add_options --disable-updater',
          'ac_add_options --with-updater',
          'ac_add_options --without-updater',
          'ac_add_options "--enable-updater"',
          'ac_add_options --enable-updater # note',
          'export MOZ_UPDATER=1',
          'ac_add_options --enable-unverified-updates',
          'ac_add_options --disable-unverified-updates',
          'ac_add_options --with-unverified-updates',
          'ac_add_options --without-unverified-updates',
          'export MOZ_VERIFY_MAR_SIGNATURE=',
          'ac_add_options --enable-update-channel=release',
          'ac_add_options --disable-update-channel',
          'ac_add_options --with-update-channel=release',
          'ac_add_options --without-update-channel',
          'ac_add_options --enable-update-channel=release # note',
          'export MOZ_UPDATE_CHANNEL=release',
          'export MAR_CHANNEL_ID=release',
          'export ACCEPTED_MAR_CHANNEL_IDS=release',
          'mk_add_options ACCEPTED_MAR_CHANNEL_IDS=release',
        ]) {
          fs.writeFileSync(fragment, `${original ?? ''}\n${line}\n`);
          assert.throws(() => writeMozconfig(root, 'dev'), /sets the updater, its update channel or MAR signature verification; bento\.json updates\.enabled and updates\.channel are the only switches/, `${path.relative(root, fragment)}: ${line}`);
        }
        if (original === undefined) fs.rmSync(fragment);
        else fs.writeFileSync(fragment, original);
      }
      // Rejected before anything is written: the last accepted mozconfig is untouched and still disables the updater.
      assert.equal(mozconfigUpdaterState(fs.readFileSync(engineFile(root, 'mozconfig'), 'utf8')), false);
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('writeMozconfig leaves unchanged files alone and rewrites changed ones', async () => {
  const root = await fixture();
  try {
    const files = [
      engineFile(root, 'mozconfig'),
      engineFile(root, 'browser', 'config', 'version.txt'),
      engineFile(root, 'browser', 'config', 'version_display.txt'),
    ];
    writeMozconfig(root, 'dev');
    const past = new Date('2020-01-01T00:00:00Z');
    for (const file of files) fs.utimesSync(file, past, past);
    const mtimes = () => files.map((file) => fs.statSync(file).mtimeMs);

    writeMozconfig(root, 'dev');
    assert.deepEqual(mtimes(), [past.getTime(), past.getTime(), past.getTime()]);

    writeMozconfig(root, 'release');
    const [mozconfig, version, display] = mtimes();
    assert.notEqual(mozconfig, past.getTime());
    assert.equal(version, past.getTime());
    assert.equal(display, past.getTime());
    assert.match(fs.readFileSync(files[0], 'utf8'), /--enable-rust-simd/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recorded state accepts regenerated files after a mode switch', async () => {
  const root = await fixture();
  try {
    writeMozconfig(root, 'dev');
    await main(['verify'], root);
    for (const mode of ['release', 'debug', 'dev']) {
      writeMozconfig(root, mode);
      assert.equal(verifyRecordedEngineState(root), true, `mode ${mode}`);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recorded state accepts the first build after an import that preceded any build', async () => {
  const root = await fixture();
  try {
    await main(['verify'], root);
    writeMozconfig(root, 'dev');
    assert.equal(
      fs.readFileSync(engineFile(root, 'browser', 'config', 'version.txt'), 'utf8'),
      '0.0.7',
    );
    assert.equal(verifyRecordedEngineState(root), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recorded state accepts a mozconfig written before the fixed object directory', async () => {
  const root = await fixture();
  try {
    const mozconfig = engineFile(root, 'mozconfig');
    writeMozconfig(root, 'dev');
    const withObjdir = fs.readFileSync(mozconfig, 'utf8');
    const previousGeneration = withObjdir.replace(/\nmk_add_options MOZ_OBJDIR=.*\n/, '');
    assert.notEqual(previousGeneration, withObjdir);
    fs.writeFileSync(mozconfig, previousGeneration);
    await main(['verify'], root);
    const recorded = JSON.parse(fs.readFileSync(path.join(root, '.bento', 'engine-state.json'), 'utf8'));
    assert.ok(recorded.entries.some((entry) => entry.path === 'mozconfig'));

    writeMozconfig(root, 'dev');
    assert.equal(verifyRecordedEngineState(root), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** What drivers wrote before the dev/release split and the updater switch. */
function mozconfigBeforeTheSplit(text) {
  return text
    .split('\n')
    .filter((line) => !/^ac_add_options --(disable-release|disable-updater|enable-macos-target=.*)$/.test(line) && !line.startsWith('# Updater:'))
    .join('\n')
    .replace(/^ac_add_options --enable-release\n/m, '');
}

test('recorded state accepts a mozconfig written before the dev/release split', async () => {
  const root = await fixture();
  try {
    const mozconfig = engineFile(root, 'mozconfig');
    for (const mode of MODES) {
      writeMozconfig(root, mode);
      const current = fs.readFileSync(mozconfig, 'utf8');
      const previous = mozconfigBeforeTheSplit(current);
      assert.notEqual(previous, current, mode);
      fs.writeFileSync(mozconfig, previous);
      assert.equal(verifyRecordedEngineState(root), true, mode);
    }

    // The same file after the import recorded it, and the next build rewrites it.
    writeMozconfig(root, 'dev');
    fs.writeFileSync(mozconfig, mozconfigBeforeTheSplit(fs.readFileSync(mozconfig, 'utf8')));
    await main(['verify'], root);
    writeMozconfig(root, 'dev');
    assert.equal(verifyRecordedEngineState(root), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recorded state rejects a mozconfig that quietly turns the updater or release policy back on', async () => {
  const root = await fixture();
  try {
    const mozconfig = engineFile(root, 'mozconfig');
    writeMozconfig(root, 'dev');
    await main(['verify'], root);
    const generated = fs.readFileSync(mozconfig, 'utf8');
    for (const [from, to] of [
      ['ac_add_options --disable-updater', 'ac_add_options --enable-updater'],
      ['ac_add_options --disable-release', 'ac_add_options --enable-release'],
      ['ac_add_options --disable-updater\n', ''],
    ]) {
      fs.writeFileSync(mozconfig, generated.replace(from, to));
      assert.notEqual(fs.readFileSync(mozconfig, 'utf8'), generated);
      assert.equal(verifyRecordedEngineState(root), false, to || 'removed updater line');
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recorded state still rejects hand edits of regenerable and other recorded files', async () => {
  const root = await fixture();
  try {
    writeMozconfig(root, 'dev');
    await importSourceOverlays({ repoRoot: root, platform: 'win32' });
    await main(['verify'], root);
    assert.equal(verifyRecordedEngineState(root), true);

    const mozconfig = engineFile(root, 'mozconfig');
    const generated = fs.readFileSync(mozconfig, 'utf8');
    fs.appendFileSync(mozconfig, 'ac_add_options --enable-something-else\n');
    assert.equal(verifyRecordedEngineState(root), false);
    fs.writeFileSync(mozconfig, generated);
    assert.equal(verifyRecordedEngineState(root), true);

    const version = engineFile(root, 'browser', 'config', 'version.txt');
    fs.writeFileSync(version, 'hand edited');
    assert.equal(verifyRecordedEngineState(root), false);
    writeMozconfig(root, 'dev');
    assert.equal(verifyRecordedEngineState(root), true);

    fs.writeFileSync(engineFile(root, 'browser', 'base', 'one.js'), 'direct engine edit\n');
    assert.equal(verifyRecordedEngineState(root), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/**
 * Mirrors the Firefox .gitignore pair that lets Git report a Finder .DS_Store: it ignores
 * the file everywhere, then re-includes dotfiles under third_party/rust.
 */
function ignoreFinderMetadataLikeFirefox(root) {
  fs.writeFileSync(engineFile(root, '.git', 'info', 'exclude'), '.DS_Store\n!third_party/rust/**/.*\n');
}

function writeEngineFile(root, relative, content = 'x') {
  const target = engineFile(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

test('a Finder .DS_Store Git reports is not an engine change, and the record never lists one', async () => {
  const root = await fixture();
  try {
    ignoreFinderMetadataLikeFirefox(root);
    await main(['verify'], root);
    const strays = ['third_party/rust/nix/src/sys/.DS_Store', 'third_party/rust/with space/.DS_Store'];
    for (const stray of strays) writeEngineFile(root, stray);
    const reported = git(engineFile(root), ['status', '--porcelain', '--untracked-files=all']);
    assert.match(reported, /\.DS_Store/, 'Git must report the files for this test to mean anything');

    await main(['verify'], root);
    await main(['record'], root);
    const recorded = JSON.parse(fs.readFileSync(path.join(root, '.bento', 'engine-state.json'), 'utf8'));
    assert.deepEqual(recorded.entries.filter((entry) => entry.path.endsWith('.DS_Store')), []);

    // Only the exact name is exempt.
    writeEngineFile(root, 'third_party/rust/nix/src/sys/.DS_Store.bak');
    assert.equal(verifyRecordedEngineState(root), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a .DS_Store an older import recorded passes whether it changed or was deleted', async () => {
  const root = await fixture();
  try {
    await main(['verify'], root);
    const statePath = path.join(root, '.bento', 'engine-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.entries.push({ path: 'third_party/rust/nix/src/sys/.DS_Store', kind: 'generated', type: 'file', sha256: '0'.repeat(64) });
    fs.writeFileSync(statePath, JSON.stringify(state));

    // Missing, as after the user deletes it.
    assert.equal(verifyRecordedEngineState(root), true);
    // Present with other bytes, as after Finder rewrites it.
    writeEngineFile(root, 'third_party/rust/nix/src/sys/.DS_Store', 'rewritten');
    assert.equal(verifyRecordedEngineState(root), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a failed verify lists the offending paths, sorted and capped, and never a .DS_Store', async () => {
  const root = await fixture();
  try {
    ignoreFinderMetadataLikeFirefox(root);
    await main(['verify'], root);
    writeEngineFile(root, 'third_party/rust/nix/src/sys/.DS_Store');
    const names = Array.from({ length: 22 }, (_, index) => `stray/file${String(index).padStart(2, '0')}.txt`);
    for (const name of [...names].reverse()) writeEngineFile(root, name);

    await assert.rejects(() => main(['verify'], root), {
      message: [
        'engine contains changes outside the recorded/generated Bento state',
        ...names.slice(0, 20).map((name) => `  ${name}`),
        '  and 2 more',
      ].join('\n'),
    });

    for (const name of names.slice(1)) fs.rmSync(engineFile(root, ...name.split('/')));
    await assert.rejects(() => main(['verify'], root), {
      message: 'engine contains changes outside the recorded/generated Bento state\n  stray/file00.txt',
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recorded state accepts the recorded mozconfig after repository config changes, until the build regenerates it', async () => {
  const root = await fixture();
  try {
    writeMozconfig(root, 'dev');
    await main(['verify'], root);
    const mozconfig = engineFile(root, 'mozconfig');
    const recorded = fs.readFileSync(mozconfig, 'utf8');

    // The pipeline verifies before the build can regenerate the file.
    fs.appendFileSync(path.join(root, 'configs', platformName, 'mozconfig'), '\nac_add_options --enable-example\n');
    assert.equal(verifyRecordedEngineState(root), true);
    const config = JSON.parse(fs.readFileSync(path.join(root, 'bento.json'), 'utf8'));
    config.updates.hostname = 'moved.example.invalid';
    fs.writeFileSync(path.join(root, 'bento.json'), JSON.stringify(config));
    assert.equal(fs.readFileSync(mozconfig, 'utf8'), recorded);
    assert.equal(verifyRecordedEngineState(root), true);

    // After the build regenerates it, the fresh content is what verification accepts.
    writeMozconfig(root, 'dev');
    assert.notEqual(fs.readFileSync(mozconfig, 'utf8'), recorded);
    assert.equal(verifyRecordedEngineState(root), true);

    // A hand edit is neither the recorded nor the generated content.
    fs.appendFileSync(mozconfig, 'ac_add_options --enable-hand-edit\n');
    assert.equal(verifyRecordedEngineState(root), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

function setDisplayVersion(root, displayVersion) {
  const file = path.join(root, 'bento.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.brands.bento.release.displayVersion = displayVersion;
  fs.writeFileSync(file, JSON.stringify(config));
}

test('a displayVersion bump between a recorded build and the next import does not block it', async () => {
  const root = await fixture();
  try {
    const version = engineFile(root, 'browser', 'config', 'version.txt');
    writeMozconfig(root, 'dev');
    await main(['verify'], root);
    assert.equal(fs.readFileSync(version, 'utf8'), '0.0.7');

    // Verify and the record step that ends an import both run before the build
    // can write the new version, so the recorded bytes must count as owned.
    setDisplayVersion(root, '0.0.8');
    await main(['verify'], root);
    await main(['record'], root);
    assert.equal(verifyRecordedEngineState(root), true);

    writeMozconfig(root, 'dev');
    assert.equal(fs.readFileSync(version, 'utf8'), '0.0.8');
    assert.equal(verifyRecordedEngineState(root), true);

    // Content that is neither recorded nor generated is still a hand edit.
    fs.writeFileSync(version, 'hand edited');
    assert.equal(verifyRecordedEngineState(root), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('hand edits to the git-ignored mozconfig are caught when the import preceded the first build', async () => {
  const root = await fixture();
  try {
    await main(['verify'], root);
    const recorded = JSON.parse(fs.readFileSync(path.join(root, '.bento', 'engine-state.json'), 'utf8'));
    assert.equal(recorded.entries.some((entry) => entry.path === 'mozconfig'), false);

    // A pristine checkout with no mozconfig, and then the first build's output, pass.
    assert.equal(verifyRecordedEngineState(root), true);
    writeMozconfig(root, 'dev');
    assert.equal(verifyRecordedEngineState(root), true);

    const mozconfig = engineFile(root, 'mozconfig');
    const generated = fs.readFileSync(mozconfig, 'utf8');
    fs.appendFileSync(mozconfig, 'ac_add_options --enable-injected\n');
    assert.equal(verifyRecordedEngineState(root), false);
    fs.writeFileSync(mozconfig, generated);
    assert.equal(verifyRecordedEngineState(root), true);

    // A mozconfig written by hand before any build is not Bento's either.
    fs.writeFileSync(mozconfig, 'ac_add_options --enable-something\n');
    assert.equal(verifyRecordedEngineState(root), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** Replaces a repository add-on's build output (`files`: path inside dist/ -> content). */
function writeAddonBuild(root, name, files) {
  const dist = path.join(root, 'extensions', name, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
    fs.writeFileSync(path.join(dist, file), content);
  }
}

/** Sorted POSIX paths of the regular files under `directory`. */
function filesUnder(directory) {
  return fs.readdirSync(directory, { recursive: true })
    .map((entry) => entry.split(path.sep).join('/'))
    .filter((entry) => fs.statSync(path.join(directory, entry)).isFile())
    .sort();
}

/** Repository add-ons bento-shell and bento-tools with a build, over an engine that has Firefox's extensions/moz.build. */
async function addonFixture() {
  const root = await fixture();
  const engine = path.join(root, 'engine');
  await fsp.mkdir(path.join(engine, 'browser', 'extensions'), { recursive: true });
  await fsp.writeFile(path.join(engine, 'browser', 'extensions', 'moz.build'), '# upstream\nDIRS += ["webcompat"]\n');
  git(engine, ['add', '-A']);
  git(engine, ['commit', '-m', 'extensions']);
  git(engine, ['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);
  for (const name of ['bento-shell', 'bento-tools']) {
    await fsp.mkdir(path.join(root, 'extensions', name), { recursive: true });
    await fsp.writeFile(
      path.join(root, 'extensions', name, 'manifest.json'),
      JSON.stringify({ applications: { gecko: { id: `${name}@test` } } }),
    );
  }
  writeAddonBuild(root, 'bento-shell', { 'assets/index.js': 'build A', 'assets/chevron-right.js': 'chunk A' });
  writeAddonBuild(root, 'bento-tools', { 'background.js': 'tools A' });
  return root;
}

const addonFile = (root, name, ...segments) => engineFile(root, 'browser', 'extensions', name, ...segments);

test('recorded state accepts changed, extra and missing add-on dist/ files, and still rejects every other edit', async () => {
  const root = await addonFixture();
  try {
    installBuiltinAddons({ repoRoot: root });
    await main(['record'], root);
    assert.equal(verifyRecordedEngineState(root), true);

    // pnpm run shell:sync: a newer build overwrites recorded files in place, adds
    // chunks the record never saw, and leaves a chunk the new build no longer has.
    fs.writeFileSync(addonFile(root, 'bento-shell', 'dist', 'assets', 'index.js'), 'build B');
    fs.writeFileSync(addonFile(root, 'bento-shell', 'dist', 'assets', 'dialog-motion.js'), 'chunk B');
    fs.writeFileSync(addonFile(root, 'bento-tools', 'dist', 'background.js'), 'tools B');
    fs.rmSync(addonFile(root, 'bento-shell', 'dist', 'assets', 'chevron-right.js'));
    assert.equal(verifyRecordedEngineState(root), true);

    // Edits outside add-on build output stay refused, then pass again once undone.
    const refuses = (file, content) => {
      // One read, no existence check first: ENOENT means there was no file to restore.
      let before;
      try {
        before = fs.readFileSync(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      assert.equal(verifyRecordedEngineState(root), false, path.relative(engineFile(root), file));
      if (before === undefined) fs.rmSync(file);
      else fs.writeFileSync(file, before);
      assert.equal(verifyRecordedEngineState(root), true, `${path.relative(engineFile(root), file)} undone`);
    };
    refuses(engineFile(root, 'toolkit', 'moz.build'), 'hand edit\n');
    refuses(addonFile(root, 'bento-shell', 'manifest.json'), 'hand edit');
    refuses(addonFile(root, 'bento-shell', 'jar.mn'), 'hand edit');
    // Only the dist/ directory is exempt, not a sibling that shares its prefix, and
    // not the dist/ of an add-on Bento does not own.
    refuses(addonFile(root, 'bento-shell', 'dist-extra', 'x.js'), 'x');
    refuses(addonFile(root, 'webcompat', 'dist', 'x.js'), 'x');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('an import after shell:sync leaves exactly the repository build in each add-on dist/', async () => {
  const root = await addonFixture();
  try {
    installBuiltinAddons({ repoRoot: root });
    await main(['record'], root);

    // shell:sync copies each build over whatever the engine already holds, so chunks
    // from earlier builds stay next to the newest ones.
    writeAddonBuild(root, 'bento-shell', { 'assets/index.js': 'build C', 'assets/overlay-positioning.js': 'chunk C' });
    const engineDist = addonFile(root, 'bento-shell', 'dist');
    fs.cpSync(path.join(root, 'extensions', 'bento-shell', 'dist'), engineDist, { recursive: true });
    fs.writeFileSync(path.join(engineDist, 'assets', 'dialog-motion.js'), 'chunk B');
    assert.deepEqual(filesUnder(engineDist), [
      'assets/chevron-right.js',
      'assets/dialog-motion.js',
      'assets/index.js',
      'assets/overlay-positioning.js',
    ]);

    // The import pipeline verifies, installs the add-ons, then records.
    assert.equal(verifyRecordedEngineState(root), true);
    installBuiltinAddons({ repoRoot: root });
    await main(['record'], root);
    assert.deepEqual(filesUnder(engineDist), ['assets/index.js', 'assets/overlay-positioning.js']);
    assert.equal(fs.readFileSync(path.join(engineDist, 'assets', 'index.js'), 'utf8'), 'build C');
    assert.equal(verifyRecordedEngineState(root), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** Runs fn with BENTO_OBJDIR cleared (or set) and restores it afterwards. */
async function withObjdirEnv(value, fn) {
  const previous = process.env.BENTO_OBJDIR;
  if (value === undefined) delete process.env.BENTO_OBJDIR;
  else process.env.BENTO_OBJDIR = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.BENTO_OBJDIR;
    else process.env.BENTO_OBJDIR = previous;
  }
}

test('the resolver returns the directory mach builds into and uses a legacy build only when allowed', async () => {
  const root = await fixture();
  try {
    await withObjdirEnv(undefined, () => {
      const ctx = createContext(root);
      const engine = (name) => path.join(root, 'engine', name);
      const legacyOk = { allowLegacy: true };

      // Nothing built yet.
      assert.deepEqual(resolveObjDir(ctx), { dir: undefined, configured: engine('obj-bento'), note: undefined });
      assert.equal(resolveObjDir(ctx, legacyOk).dir, undefined);

      // One legacy directory (an older checkout): launch and sync may use it, and say so.
      // Packaging must not, since mach does not build into it.
      fs.mkdirSync(engine('obj-aarch64-apple-darwin25.5.0'));
      assert.equal(resolveObjDir(ctx).dir, undefined);
      const legacy = resolveObjDir(ctx, legacyOk);
      assert.equal(legacy.dir, engine('obj-aarch64-apple-darwin25.5.0'));
      assert.match(legacy.note, /engine\/obj-bento does not exist; using the legacy object directory engine\/obj-aarch64-apple-darwin25\.5\.0/);

      // Several legacy directories: refuse to guess.
      fs.mkdirSync(engine('obj-aarch64-apple-darwin27.0.0'));
      assert.throws(
        () => resolveObjDir(ctx, legacyOk),
        /engine\/obj-bento does not exist and several legacy Firefox object directories.*darwin25\.5\.0, obj-aarch64-apple-darwin27\.0\.0/,
      );
      assert.equal(resolveObjDir(ctx).dir, undefined);

      // obj-bento wins over every legacy directory, in both modes.
      fs.mkdirSync(engine('obj-bento'));
      for (const options of [undefined, legacyOk]) {
        assert.deepEqual(resolveObjDir(ctx, options), { dir: engine('obj-bento'), configured: engine('obj-bento'), note: undefined });
      }
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('BENTO_OBJDIR reaches the generated mozconfig, so mach and the resolver agree', async () => {
  const root = await fixture();
  try {
    const ctx = createContext(root);
    const mozconfig = engineFile(root, 'mozconfig');

    // A mozconfig generated without BENTO_OBJDIR sends mach to obj-bento. Naming an
    // existing legacy directory later must not redirect packaging to it.
    await withObjdirEnv(undefined, () => writeMozconfig(root, 'dev'));
    fs.mkdirSync(engineFile(root, 'obj-legacy'));
    await withObjdirEnv('obj-legacy', () => {
      assert.throws(() => resolveObjDir(ctx), /BENTO_OBJDIR=obj-legacy differs from engine\/obj-bento, the directory engine\/mozconfig builds into/);
      const launch = resolveObjDir(ctx, { allowLegacy: true });
      assert.equal(launch.dir, engineFile(root, 'obj-legacy'));
      assert.match(launch.note, /using engine\/obj-legacy as BENTO_OBJDIR asks/);
    });

    // Generated with BENTO_OBJDIR, the mozconfig builds there and every reader agrees,
    // with or without the variable set afterwards.
    await withObjdirEnv('obj-legacy', () => writeMozconfig(root, 'dev'));
    assert.match(fs.readFileSync(mozconfig, 'utf8'), /^mk_add_options MOZ_OBJDIR=@TOPSRCDIR@\/obj-legacy$/m);
    for (const value of ['obj-legacy', undefined]) {
      await withObjdirEnv(value, () => {
        assert.equal(resolveObjDir(ctx).dir, engineFile(root, 'obj-legacy'));
      });
    }
    // A mozconfig built under another name is not a hand edit.
    assert.equal(await withObjdirEnv(undefined, () => verifyRecordedEngineState(root)), true);

    for (const value of ['../escape', 'plain', 'obj-a/b']) {
      await withObjdirEnv(value, () => {
        assert.throws(() => writeMozconfig(root, 'dev'), /must name a directory directly under engine\/ that starts with obj-/, value);
      });
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a mozconfig fragment or MOZCONFIG that would redirect mach is rejected', async () => {
  const root = await fixture();
  const previous = process.env.MOZCONFIG;
  try {
    await withObjdirEnv(undefined, async () => {
      for (const fragment of [path.join(root, 'mozconfig'), path.join(root, 'configs', platformName, 'mozconfig'), path.join(root, 'configs', 'common', 'mozconfig')]) {
        let original;
        try {
          original = fs.readFileSync(fragment);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        fs.mkdirSync(path.dirname(fragment), { recursive: true });
        fs.appendFileSync(fragment, '\n# MOZ_OBJDIR in a comment is fine\n');
        writeMozconfig(root, 'dev');
        fs.appendFileSync(fragment, 'mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/elsewhere\n');
        assert.throws(() => writeMozconfig(root, 'dev'), /sets MOZ_OBJDIR; Bento chooses the object directory/, fragment);
        if (original === undefined) fs.rmSync(fragment);
        else fs.writeFileSync(fragment, original);
      }

      fs.writeFileSync(engineFile(root, 'mach'), '');
      process.env.MOZCONFIG = path.join(root, 'other-mozconfig');
      await assert.rejects(() => main(['build'], root), /MOZCONFIG=.* would make mach ignore the generated engine\/mozconfig/);
      await assert.rejects(() => main(['package'], root), /MOZCONFIG=.* would make mach ignore the generated engine\/mozconfig/);

      // Naming the generated file itself is fine: packaging gets as far as the object directory.
      process.env.MOZCONFIG = engineFile(root, 'mozconfig');
      await assert.rejects(() => main(['package'], root), /package: engine\/obj-bento does not exist/);
    });
  } finally {
    if (previous === undefined) delete process.env.MOZCONFIG;
    else process.env.MOZCONFIG = previous;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('package and updates-browser use only the directory mach builds into', async () => {
  const root = await fixture();
  try {
    // updates-browser exists only while the updater is on.
    enableUpdater(root);
    await withObjdirEnv(undefined, async () => {
      fs.writeFileSync(engineFile(root, 'mach'), '');
      fs.mkdirSync(path.join(root, 'dist'));
      fs.writeFileSync(path.join(root, 'dist', 'output.mar'), 'mar');
      // An old build is not what mach builds into, so it is never packaged.
      fs.mkdirSync(engineFile(root, 'obj-aarch64-apple-darwin25.5.0', 'dist'), { recursive: true });
      await assert.rejects(() => main(['package'], root), /package: engine\/obj-bento does not exist; run pnpm run build first \(it is the directory mach builds into\)/);
      await assert.rejects(() => main(['updates-browser'], root), /updates-browser: engine\/obj-bento does not exist; run pnpm run build first/);

      // Neither may BENTO_OBJDIR point them elsewhere than engine/mozconfig does.
      writeMozconfig(root, 'dev');
      await withObjdirEnv('obj-aarch64-apple-darwin25.5.0', async () => {
        await assert.rejects(() => main(['package'], root), /BENTO_OBJDIR=obj-aarch64-apple-darwin25\.5\.0 differs from engine\/obj-bento/);
        await assert.rejects(() => main(['updates-browser'], root), /differs from engine\/obj-bento/);
      });
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** Runs `fn` with the given environment variables set (undefined unsets), then restores them. */
async function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const apply = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(previous);
  }
}

test('a release package is refused while the object directory still holds the dev-only reload command', async () => {
  const root = await fixture();
  const shellAddon = ['chrome', 'browser', 'builtin-addons', 'bento-shell'];
  const objDist = engineFile(root, 'obj-bento', 'dist');
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const setBuildMode = (mode) => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'bento.json'), 'utf8'));
    config.build.mode = mode;
    fs.writeFileSync(path.join(root, 'bento.json'), JSON.stringify(config));
  };
  const clean = { BENTO_OBJDIR: undefined, BENTO_RELEASE: undefined, BENTO_BUILD_MODE: undefined, MOZCONFIG: undefined };
  try {
    fs.writeFileSync(engineFile(root, 'mach'), '');
    // What an earlier dev build leaves: a current stamp in the loose tree the Mux check reads,
    // and a stale dev manifest and handler in the app bundle that gets packaged.
    const stamp = '{"source":"npm","version":"0.1.0-rc.1"}';
    write(path.join(objDist, 'bin', 'browser', ...shellAddon, 'dist', 'muxui-source.json'), stamp);
    const bundle = path.join(objDist, 'Bento.app', 'Contents', 'Resources', 'browser', ...shellAddon);
    write(path.join(bundle, 'manifest.json'), '{"commands":{"dev-reload":{"description":"Dev reload"}}}');
    write(path.join(bundle, 'dist', 'assets', 'background.js'), 'c==="dev-reload"&&browser.runtime.reload()');

    // The fixture has no scripts/mach-raw.sh, so a package that passes the guard fails there.
    const reachesMach = /scripts\/mach-raw\.sh package failed/;
    const refused = /Release package would ship the dev-only reload command: .*Contents\/Resources\/browser\/chrome\/browser\/builtin-addons\/bento-shell\/(manifest\.json|dist\/assets\/background\.js)/;

    await withEnv(clean, async () => {
      writeMozconfig(root, 'dev');
      await assert.rejects(() => main(['package'], root), reachesMach, 'a dev build may package it');
      await withEnv({ BENTO_BUILD_MODE: 'debug' }, () => assert.rejects(() => main(['package'], root), reachesMach));

      // Release however it was asked for: the variable alone, the mode variable, or bento.json alone.
      await withEnv({ BENTO_RELEASE: '1' }, () => assert.rejects(() => main(['package'], root), refused));
      await withEnv({ BENTO_BUILD_MODE: 'release' }, () => assert.rejects(() => main(['package'], root), refused));
      setBuildMode('release');
      await assert.rejects(() => main(['package'], root), refused);
      // ...unless the driver itself is told to build something else.
      await withEnv({ BENTO_BUILD_MODE: 'dev' }, () => assert.rejects(() => main(['package'], root), reachesMach));

      // Once the stale files are gone the release package goes ahead.
      fs.rmSync(path.join(bundle, 'dist'), { recursive: true });
      write(path.join(bundle, 'manifest.json'), '{}');
      await assert.rejects(() => main(['package'], root), reachesMach);
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** Runs `bento-build objdir` and returns what it wrote to stdout and stderr. */
async function objdirCommand(root, ...args) {
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  const writes = { out: '', err: '' };
  process.stdout.write = (chunk) => ((writes.out += chunk), true);
  process.stderr.write = (chunk) => ((writes.err += chunk), true);
  try {
    await main(['objdir', ...args], root);
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  return writes;
}

test('the native build, the extension build, and the release guards resolve the same mode', async () => {
  const root = await fixture();
  const shell = path.join(repoRoot, 'extensions', 'bento-shell');
  const clean = { BENTO_OBJDIR: undefined, BENTO_RELEASE: undefined, BENTO_BUILD_MODE: undefined };
  const setBuildMode = (mode) => {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'bento.json'), 'utf8'));
    config.build.mode = mode;
    fs.writeFileSync(path.join(root, 'bento.json'), JSON.stringify(config));
  };
  // The real background build script reads bento.json from BENTO_REPO_ROOT; an undefined value unsets a variable.
  const bundleKeepsReloadHandler = (env) => {
    const out = path.join(root, 'background.js');
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'build-extension-background.mjs'), 'src/background.ts', out],
      { cwd: shell, env: { ...process.env, BENTO_REPO_ROOT: root, ...env }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    return fs.readFileSync(out, 'utf8').includes('dev-reload');
  };
  try {
    await withEnv(clean, async () => {
      for (const jsonMode of ['dev', 'release']) {
        setBuildMode(jsonMode);
        for (const release of [undefined, '0', '1']) {
          for (const buildMode of [undefined, 'dev', 'debug', 'release']) {
            const env = { BENTO_RELEASE: release, BENTO_BUILD_MODE: buildMode };
            const label = `bento.json ${jsonMode}, BENTO_RELEASE=${release}, BENTO_BUILD_MODE=${buildMode}`;
            // BENTO_RELEASE=1 means release; otherwise BENTO_BUILD_MODE, then bento.json.
            const expected = release === '1' ? 'release' : buildMode ?? jsonMode;

            const native = await withEnv(env, () => writeMozconfig(root).mode);
            assert.equal(native, expected, label);
            assert.match(fs.readFileSync(engineFile(root, 'mozconfig'), 'utf8'), new RegExp(`^# Bento ${expected} build settings$`, 'm'), label);
            assert.equal(await withEnv(env, () => isReleaseBuild(root)), expected === 'release', label);
            assert.equal(bundleKeepsReloadHandler(env), expected !== 'release', label);
          }
        }
      }
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the objdir command prints the directory mach builds into; --allow-legacy and --allow-missing relax it', async () => {
  const root = await fixture();
  try {
    await withObjdirEnv(undefined, async () => {
      await assert.rejects(() => objdirCommand(root), /no Firefox object directory: engine\/obj-bento does not exist/);
      assert.deepEqual(await objdirCommand(root, '--allow-missing'), { out: '', err: '' });

      // A legacy build is used only on request, and the fallback is announced.
      fs.mkdirSync(engineFile(root, 'obj-old'));
      await assert.rejects(() => objdirCommand(root), /no Firefox object directory/);
      const legacy = await objdirCommand(root, '--allow-legacy');
      assert.equal(legacy.out, `${engineFile(root, 'obj-old')}\n`);
      assert.match(legacy.err, /^bento: engine\/obj-bento does not exist; using the legacy object directory engine\/obj-old/);

      fs.mkdirSync(engineFile(root, 'obj-bento'));
      assert.deepEqual(await objdirCommand(root), { out: `${engineFile(root, 'obj-bento')}\n`, err: '' });

      fs.rmSync(engineFile(root, 'obj-bento'), { recursive: true });
      fs.mkdirSync(engineFile(root, 'obj-other'));
      await assert.rejects(() => objdirCommand(root, '--allow-legacy', '--allow-missing'), /several legacy Firefox object directories/);
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** A repo copy with the scripts under test, so their node call resolves this fixture. */
async function scriptFixture() {
  const root = await fixture();
  await fsp.cp(path.join(repoRoot, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  await fsp.mkdir(path.join(root, 'extensions', 'bento-shell'), { recursive: true });
  await fsp.copyFile(
    path.join(repoRoot, 'extensions', 'bento-shell', 'muxui-local.mjs'),
    path.join(root, 'extensions', 'bento-shell', 'muxui-local.mjs'),
  );
  return root;
}

const runScript = (root, script) => spawnSync('bash', [path.join(root, 'scripts', script)], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, BENTO_OBJDIR: '' },
});

test('import and shell entry points reject borrowed outputs without changing marker bytes or app links', async (t) => {
  for (const name of ['engine', '.bento']) {
    const root = await scriptFixture();
    const { foreign } = isolationFixture(t);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const installed = engineFile(root, 'browser', 'extensions', 'bento-shell', 'dist');
    const deployed = engineFile(root, 'obj-bento', 'dist', 'Bento.app', 'Contents', 'Resources', 'browser', 'chrome', 'browser', 'builtin-addons', 'bento-shell', 'dist');
    const built = path.join(root, 'extensions', 'bento-shell', 'dist');
    fs.mkdirSync(installed, { recursive: true });
    fs.mkdirSync(path.dirname(deployed), { recursive: true });
    fs.mkdirSync(built);
    fs.mkdirSync(path.join(root, '.bento'));
    fs.writeFileSync(path.join(installed, 'app.js'), 'installed old shell');
    fs.writeFileSync(path.join(built, 'app.js'), 'checkout new shell');
    fs.writeFileSync(path.join(root, '.bento', 'marker'), 'old state');
    fs.symlinkSync(installed, deployed, 'dir');
    const borrowed = path.join(root, name);
    const destination = path.join(foreign, name);
    fs.renameSync(borrowed, destination);
    fs.symlinkSync(destination, borrowed, 'dir');
    for (const script of ['import.sh', 'sync-shell.sh', 'sync-builtin-addon-symlinks.sh', 'reset-engine-patches.sh', 'append-prefs.sh', 'mach-raw.sh']) {
      const result = runScript(root, script);
      assert.notEqual(result.status, 0, script);
      assert.match(result.stderr, /build outputs must stay inside checkout/, script);
      assert.equal(fs.readFileSync(path.join(installed, 'app.js'), 'utf8'), 'installed old shell');
      assert.equal(fs.readFileSync(path.join(root, '.bento', 'marker'), 'utf8'), 'old state');
      assert.equal(fs.readlinkSync(deployed), installed);
      assert.equal(fs.readlinkSync(borrowed), destination);
    }
  }
});

test('objdir stays read-only and an explicit BENTO_BIN launches without permitting borrowed-output writes', async (t) => {
  const root = await scriptFixture();
  const { foreign } = isolationFixture(t);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originalEngine = path.join(root, 'engine');
  fs.renameSync(originalEngine, path.join(foreign, 'engine'));
  fs.symlinkSync(path.join(foreign, 'engine'), originalEngine, 'dir');
  const executable = path.join(foreign, 'fake-bento');
  const marker = path.join(foreign, 'launched');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf launched > "$BENTO_TEST_LAUNCH_MARKER"\n');
  fs.chmodSync(executable, 0o755);
  const run = (script, args = [], extra = {}) => spawnSync('bash', [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, BENTO_BIN: '', BENTO_TEST_LAUNCH_MARKER: marker, ...extra },
  });
  const lookup = spawnSync(process.execPath, [path.join(root, 'scripts', 'bento-build.mjs'), 'objdir', '--allow-missing'], { encoding: 'utf8' });
  assert.equal(lookup.status, 0, lookup.stderr);
  assert.equal(engineStatus(root).git, true, 'engine status remains readable');
  await assert.rejects(main(['verify'], root), /build outputs must stay inside checkout/);
  fs.mkdirSync(path.join(root, 'patches'));
  fs.writeFileSync(path.join(root, 'patches', 'one.patch'), 'diff --git a/.gitignore b/.gitignore\n');
  fs.writeFileSync(path.join(root, 'patches', 'series.json'), JSON.stringify({ series: [{ path: 'patches/one.patch' }] }));
  assert.throws(() => verifyManagedEngine(createContext(root), ['.gitignore']), /build outputs must stay inside checkout/);
  assert.equal(run('dev-launch.sh').status, 1);
  assert.equal(fs.existsSync(marker), false);
  const launch = run('dev-launch.sh', [path.join(root, 'test-profile')], { BENTO_BIN: executable });
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'launched');
  assert.notEqual(run('sync-shell.sh', [], { BENTO_BIN: executable }).status, 0);

  const mach = engineFile(root, 'mach');
  fs.writeFileSync(mach, '#!/bin/sh\nprintf "fake mach %s\\n" "$1"\n');
  fs.chmodSync(mach, 0o755);
  for (const argument of ['--help', '--version']) {
    const help = run('mach-raw.sh', [argument]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /fake mach/);
  }
});

test('direct installers honor effective BENTO_REPO_ROOT and reject before pruning foreign files', (t) => {
  const { root, foreign } = isolationFixture(t);
  fs.symlinkSync(foreign, path.join(root, 'engine'), 'dir');
  const stale = path.join(foreign, 'stale');
  fs.writeFileSync(stale, 'preserve');
  const previous = process.env.BENTO_REPO_ROOT;
  process.env.BENTO_REPO_ROOT = root;
  try {
    for (const install of [installBranding, installBuiltinAddons]) {
      assert.throws(() => install(), /build outputs must stay inside checkout/);
    }
    for (const script of ['install-branding.mjs', 'install-builtin-addons.mjs']) {
      const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', script)], { encoding: 'utf8' });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /build outputs must stay inside checkout/);
    }
    assert.equal(fs.readFileSync(stale, 'utf8'), 'preserve');
  } finally {
    if (previous === undefined) delete process.env.BENTO_REPO_ROOT;
    else process.env.BENTO_REPO_ROOT = previous;
  }
});

test('shell scripts act on the one selected object directory, never on every obj-*', async () => {
  const root = await scriptFixture();
  try {
    const shellDest = (name) => engineFile(root, name, 'dist', 'Bento.app', 'Contents', 'Resources', 'browser', 'chrome', 'browser', 'builtin-addons', 'bento-shell', 'dist');
    const actors = (name) => engineFile(root, name, 'dist', 'bin', 'browser', 'actors');
    fs.mkdirSync(path.join(root, 'extensions', 'bento-shell', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extensions', 'bento-shell', 'dist', 'app.js'), 'built');
    // Every actor the repo ships. A dev build links them into dist as a symlink chain back into
    // src/browser/actors, which a content process cannot read (sandbox read paths), so the
    // script must replace each with a real file.
    const actorFiles = fs.readdirSync(path.join(repoRoot, 'src', 'browser', 'actors')).filter((f) => f.endsWith('.sys.mjs'));
    assert.ok(actorFiles.some((f) => f.endsWith('Child.sys.mjs')), 'the repo has content-process actors');
    const appActors = (name) => engineFile(root, name, 'dist', 'Bento.app', 'Contents', 'Resources', 'browser', 'actors');
    fs.mkdirSync(path.join(root, 'src', 'browser', 'actors'), { recursive: true });
    for (const file of actorFiles) {
      fs.writeFileSync(path.join(root, 'src', 'browser', 'actors', file), `actor ${file}`);
    }
    for (const name of ['obj-bento', 'obj-legacy']) {
      fs.mkdirSync(shellDest(name), { recursive: true });
      fs.mkdirSync(actors(name), { recursive: true });
    }
    fs.mkdirSync(appActors('obj-bento'), { recursive: true });
    for (const dir of [actors('obj-bento'), appActors('obj-bento')]) {
      for (const file of actorFiles) {
        fs.symlinkSync(path.join(root, 'src', 'browser', 'actors', file), path.join(dir, file));
      }
    }

    const shell = runScript(root, 'sync-shell.sh');
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(fs.existsSync(path.join(shellDest('obj-bento'), 'app.js')), true);
    assert.equal(fs.existsSync(path.join(shellDest('obj-legacy'), 'app.js')), false);

    const symlinks = runScript(root, 'sync-builtin-addon-symlinks.sh');
    assert.equal(symlinks.status, 0, symlinks.stderr);
    for (const dir of [actors('obj-bento'), appActors('obj-bento')]) {
      for (const file of actorFiles) {
        // O_NOFOLLOW makes the open fail (ELOOP) on a leftover symlink, so one open both checks
        // and reads the file instead of an lstat followed by a separate read.
        const fd = fs.openSync(path.join(dir, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          assert.equal(fs.readFileSync(fd, 'utf8'), `actor ${file}`);
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    assert.equal(fs.existsSync(path.join(actors('obj-legacy'), 'BentoKeyChild.sys.mjs')), false);

    // Without obj-bento, a single legacy build is used and announced...
    fs.rmSync(engineFile(root, 'obj-bento'), { recursive: true });
    const fallback = runScript(root, 'sync-shell.sh');
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stderr, /engine\/obj-bento does not exist; using the legacy object directory engine\/obj-legacy/);
    assert.equal(fs.existsSync(path.join(shellDest('obj-legacy'), 'app.js')), true);

    // ...but two legacy directories are an error rather than a pick.
    fs.mkdirSync(engineFile(root, 'obj-legacy-two'));
    for (const script of ['sync-shell.sh', 'sync-builtin-addon-symlinks.sh']) {
      const result = runScript(root, script);
      assert.notEqual(result.status, 0, script);
      assert.match(result.stderr, /several legacy Firefox object directories/, script);
    }

    // With no object directory, the import-time sync is a no-op while sync-shell fails.
    fs.rmSync(engineFile(root, 'obj-legacy'), { recursive: true });
    fs.rmSync(engineFile(root, 'obj-legacy-two'), { recursive: true });
    const noop = runScript(root, 'sync-builtin-addon-symlinks.sh');
    assert.equal(noop.status, 0, noop.stderr);
    assert.match(noop.stdout, /nothing to do/);
    assert.notEqual(runScript(root, 'sync-shell.sh').status, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('Firefox versions order by release number, then beta number; ESR is not ordered against other channels', () => {
  const order = (left, right) => Math.sign(compareFirefoxVersions(left, right));
  // Full dotted numbers, not a prefix or a string.
  assert.equal(order('157.0.1', '157.0'), 1);
  assert.equal(order('157.0', '157.0.1'), -1);
  assert.equal(order('99.0', '157.0.1'), -1);
  assert.equal(order('1000.0', '157.0.1'), 1);
  assert.equal(order('157.0', '157.0.0'), 0);
  // Betas order by number, and a final release is newer than its betas.
  assert.equal(order('158.0b5', '158.0b6'), -1);
  assert.equal(order('158.0b6', '158.0b5'), 1);
  assert.equal(order('158.0b6', '158.0b6'), 0);
  assert.equal(order('158.0b5', '158.0'), -1);
  assert.equal(order('158.0', '158.0b9'), 1);
  assert.equal(order('158.0b1', '157.0.1'), 1);
  assert.equal(order('158.0b9', '158.0.1'), -1);
  // ESR only orders against ESR; unrecognized shapes order against nothing.
  assert.equal(order('140.2.0esr', '140.3.0esr'), -1);
  assert.equal(compareFirefoxVersions('140.2.0esr', '157.0.1'), undefined);
  assert.equal(compareFirefoxVersions('157.0.1', '140.2.0esr'), undefined);
  assert.equal(compareFirefoxVersions('158.0a1', '158.0'), undefined);
  assert.equal(compareFirefoxVersions('158.0-rc1', '158.0'), undefined);
});

test('the patch reset reverts every path an earlier import patched, not only the current series', async (t) => {
  const root = await scriptFixture();
  try {
    const engine = path.join(root, 'engine');
    const at = (...segments) => path.join(engine, ...segments);
    const symlinks = process.platform !== 'win32';
    for (const file of ['old.js', 'gone.js', 'series-gone.js', 'target.txt', 'other.txt']) fs.writeFileSync(at(file), 'original\n');
    if (symlinks) fs.symlinkSync('target.txt', at('link'));
    git(engine, ['add', '-A']);
    git(engine, ['commit', '--amend', '--no-edit']);
    git(engine, ['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);

    // What the recorded import left behind: an edit, a deletion, a retargeted
    // symlink and a created symlink (dangling), none named by the current series.
    fs.writeFileSync(at('old.js'), 'patched by an earlier series\n');
    fs.rmSync(at('gone.js'));
    const entries = [
      { path: 'old.js', kind: 'patch', type: 'file', sha256: '0'.repeat(64) },
      { path: 'gone.js', kind: 'patch', missing: true },
    ];
    if (symlinks) {
      fs.rmSync(at('link'));
      fs.symlinkSync('other.txt', at('link'));
      fs.symlinkSync('no-such-target', at('created-link'));
      entries.push(
        { path: 'link', kind: 'patch', type: 'symlink', linkTarget: 'other.txt' },
        { path: 'created-link', kind: 'patch', type: 'symlink', linkTarget: 'no-such-target' },
      );
    }
    // The current series deletes series-gone.js, which an earlier reset must restore.
    fs.rmSync(at('series-gone.js'));
    fs.writeFileSync(at('toolkit', 'moz.build'), 'user edit\n');
    fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
    fs.writeFileSync(path.join(root, 'patches', 'new.patch'), 'diff --git a/series-gone.js b/series-gone.js\n');
    fs.mkdirSync(path.join(root, '.bento'), { recursive: true });
    fs.writeFileSync(path.join(root, '.bento', 'engine-state.json'), JSON.stringify({ schemaVersion: 1, entries }));

    const reset = runScript(root, 'reset-engine-patches.sh');
    assert.equal(reset.status, 0, reset.stderr);
    assert.equal(fs.readFileSync(at('old.js'), 'utf8'), 'original\n');
    assert.equal(fs.readFileSync(at('gone.js'), 'utf8'), 'original\n');
    assert.equal(fs.readFileSync(at('series-gone.js'), 'utf8'), 'original\n');
    if (symlinks) {
      assert.equal(fs.readlinkSync(at('link')), 'target.txt');
      assert.equal(fs.lstatSync(at('created-link'), { throwIfNoEntry: false }), undefined);
    } else {
      t.diagnostic('symlink reset skipped on win32');
    }
    // Only Bento's own output is reset; other edits stay for verify to catch.
    assert.equal(fs.readFileSync(at('toolkit', 'moz.build'), 'utf8'), 'user edit\n');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('update metadata reads the target architecture from the object directory', async () => {
  const root = await fixture();
  try {
    const ctx = createContext(root);
    const config = loadConfig(root);
    const mar = path.join(root, 'output.mar');
    fs.writeFileSync(mar, 'mar');
    const platform = { darwin: 'macos', win32: 'windows' }[process.platform] || 'linux';
    const names = {};
    for (const processor of ['aarch64', 'x86_64']) {
      const objDist = path.join(root, 'engine', `obj-bento-${processor}`, 'dist');
      fs.mkdirSync(objDist, { recursive: true });
      fs.writeFileSync(path.join(objDist, '..', 'mozinfo.json'), JSON.stringify({ processor }));
      names[processor] = (await writeBrowserUpdateFiles(ctx, config, mar, '20260101000000', objDist)).marName;
    }
    assert.equal(names.aarch64, platform === 'macos' ? 'Bento-0.0.7-macos.mar' : `Bento-0.0.7-${platform}-arm64.mar`);
    assert.equal(names.x86_64, `Bento-0.0.7-${platform}-x64.mar`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('source archives are hashed in-process without a SHA-256 utility', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-hash-test-'));
  const previousPath = process.env.PATH;
  try {
    // Larger than the read chunk, so the digest spans several reads.
    const file = path.join(dir, 'archive.bin');
    const data = crypto.randomBytes(700 * 1024);
    fs.writeFileSync(file, data);
    const digest = crypto.createHash('sha256').update(data).digest('hex');

    process.env.PATH = path.join(dir, 'no-tools');
    assert.equal(verifySourceArchive(file, digest), digest);
    assert.throws(() => verifySourceArchive(file, '1'.repeat(64)), /digest mismatch/);
  } finally {
    process.env.PATH = previousPath;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

// Stands in for tar: runs the real one, then deletes $BENTO_TEST_TAR_DROP after an extraction,
// the way Cygwin tar loses `baz.exe` when `baz` follows it. Repair runs (-T) delete it again
// only while $BENTO_TEST_TAR_DROP_AGAIN is set.
const DROPPING_TAR = `#!/bin/sh
PATH="$BENTO_TEST_TAR_PATH" "$(basename "$0")" "$@" || exit $?
case "$*" in
  *-xf*-T*) [ -z "$BENTO_TEST_TAR_DROP_AGAIN" ] || rm -f "$BENTO_TEST_TAR_DROP" ;;
  *-xf*) rm -f "$BENTO_TEST_TAR_DROP" ;;
esac
exit 0
`;

/** A Firefox-shaped archive (bare ./, one root, baz.exe before baz) and a PATH whose tar drops baz.exe. */
async function droppingTarFixture(t, { dropAgain, dropped, readOnlyArchiveDir = false }) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-tar-drop-'));
  const previousPath = process.env.PATH;
  t.after(async () => {
    await fsp.chmod(path.join(dir, 'archive'), 0o755);
    process.env.PATH = previousPath;
    for (const name of ['BENTO_TEST_TAR_PATH', 'BENTO_TEST_TAR_DROP', 'BENTO_TEST_TAR_DROP_AGAIN']) delete process.env[name];
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const source = path.join(dir, 'source');
  await fsp.mkdir(path.join(source, 'root', 'which'), { recursive: true });
  await fsp.writeFile(path.join(source, 'root', 'which', 'baz.exe'), 'exe\n');
  await fsp.writeFile(path.join(source, 'root', 'which', 'baz'), 'plain\n');
  const members = path.join(dir, 'members.txt');
  await fsp.writeFile(members, './\nroot/\nroot/which/\nroot/which/baz.exe\nroot/which/baz\n');
  const archiveDir = path.join(dir, 'archive');
  await fsp.mkdir(archiveDir);
  const archive = path.join(archiveDir, 'source.tar');
  const created = spawnSync('tar', ['-cf', archive, '-C', source, '--no-recursion', '-T', members], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  assert.equal(created.status, 0, created.stderr);
  if (readOnlyArchiveDir) await fsp.chmod(archiveDir, 0o555);

  const bin = path.join(dir, 'bin');
  await fsp.mkdir(bin);
  for (const name of ['tar', 'gtar']) await fsp.writeFile(path.join(bin, name), DROPPING_TAR, { mode: 0o755 });
  const destination = path.join(dir, 'extracted');
  await fsp.mkdir(destination);
  process.env.BENTO_TEST_TAR_PATH = previousPath;
  process.env.BENTO_TEST_TAR_DROP = path.join(destination, ...dropped);
  if (dropAgain) process.env.BENTO_TEST_TAR_DROP_AGAIN = '1';
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  return { archive, destination };
}

function assertNoMemberList(destination) {
  assert.deepEqual(
    fs.readdirSync(path.dirname(destination)).filter((name) => name.startsWith('.bento-missing-members-')),
    [],
    'the member list is removed',
  );
}

// The build driver strips the root directory; the patch stack keeps it.
const SOURCE_EXTRACTORS = [
  ['build driver', (archive, destination) => extractArchive(archive, destination), ['which', 'baz.exe']],
  ['patch stack', async (archive, destination) => extractBaselineArchive(archive, destination), ['root', 'which', 'baz.exe']],
];

test('a source archive member that tar leaves out is extracted again', { skip: process.platform === 'win32' }, async (t) => {
  for (const [name, extract, dropped] of SOURCE_EXTRACTORS) {
    await t.test(name, async (subtest) => {
      const { archive, destination } = await droppingTarFixture(subtest, { dropAgain: false, dropped });
      await extract(archive, destination);
      assert.equal(fs.readFileSync(path.join(destination, ...dropped), 'utf8'), 'exe\n');
      assert.equal(fs.readFileSync(path.join(destination, ...dropped.slice(0, -1), 'baz'), 'utf8'), 'plain\n');
      assertNoMemberList(destination);
    });
  }
});

test('a source archive member that stays missing fails the extraction with its name', { skip: process.platform === 'win32' }, async (t) => {
  for (const [name, extract, dropped] of SOURCE_EXTRACTORS) {
    await t.test(name, async (subtest) => {
      const { archive, destination } = await droppingTarFixture(subtest, { dropAgain: true, dropped });
      await assert.rejects(extract(archive, destination), (error) => {
        assert.match(error.message, /left 1 member\(s\) missing after a second attempt: root\/which\/baz\.exe\n/);
        assert.match(error.message, /'\.exe' suffix are a known hazard of Windows tar/);
        return true;
      });
      assertNoMemberList(destination);
    });
  }
});

test('a dropped member is restored when the archive directory is read-only', { skip: process.platform === 'win32' }, async (t) => {
  for (const [name, extract, dropped] of SOURCE_EXTRACTORS) {
    await t.test(name, async (subtest) => {
      const { archive, destination } = await droppingTarFixture(subtest, { dropAgain: false, dropped, readOnlyArchiveDir: true });
      await extract(archive, destination);
      assert.equal(fs.readFileSync(path.join(destination, ...dropped), 'utf8'), 'exe\n');
      assertNoMemberList(destination);
    });
  }
});
