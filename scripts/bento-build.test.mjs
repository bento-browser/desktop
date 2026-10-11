import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createContext,
  loadConfig,
  main,
  resolveObjDir,
  verifyRecordedEngineState,
  verifySourceArchive,
  writeBrowserUpdateFiles,
  writeMozconfig,
} from './bento-build.mjs';
import { isReleaseBuild } from './build-mode.mjs';
import { importSourceOverlays } from './import-sources.mjs';
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
  const variant = process.env.BENTO_RELEASE_VARIANT;
  delete process.env.BENTO_RELEASE_VARIANT;
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
    if (variant !== undefined) process.env.BENTO_RELEASE_VARIANT = variant;
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
  const clean = { BENTO_OBJDIR: undefined, BENTO_RELEASE: undefined, BENTO_BUILD_MODE: undefined, BENTO_RELEASE_VARIANT: undefined, MOZCONFIG: undefined };
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

test('shell scripts act on the one selected object directory, never on every obj-*', async () => {
  const root = await scriptFixture();
  try {
    const shellDest = (name) => engineFile(root, name, 'dist', 'Bento.app', 'Contents', 'Resources', 'browser', 'chrome', 'browser', 'builtin-addons', 'bento-shell', 'dist');
    const actors = (name) => engineFile(root, name, 'dist', 'bin', 'browser', 'actors');
    fs.mkdirSync(path.join(root, 'extensions', 'bento-shell', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extensions', 'bento-shell', 'dist', 'app.js'), 'built');
    fs.mkdirSync(path.join(root, 'src', 'browser', 'actors'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'browser', 'actors', 'BentoKeyChild.sys.mjs'), 'actor');
    for (const name of ['obj-bento', 'obj-legacy']) {
      fs.mkdirSync(shellDest(name), { recursive: true });
      fs.mkdirSync(actors(name), { recursive: true });
    }

    const shell = runScript(root, 'sync-shell.sh');
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(fs.existsSync(path.join(shellDest('obj-bento'), 'app.js')), true);
    assert.equal(fs.existsSync(path.join(shellDest('obj-legacy'), 'app.js')), false);

    const symlinks = runScript(root, 'sync-builtin-addon-symlinks.sh');
    assert.equal(symlinks.status, 0, symlinks.stderr);
    assert.equal(fs.existsSync(path.join(actors('obj-bento'), 'BentoKeyChild.sys.mjs')), true);
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
