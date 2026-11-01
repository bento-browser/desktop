import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { readApplicationBuildId } from './bento-build.mjs';
import { shipUpdater, writeCertificates } from './updater-fixtures.mjs';
import { validateArtifacts } from './validate-bento-artifacts.mjs';

/** What configure records for a build with the updater compiled in. */
const updaterSubsts = { MOZ_UPDATER: '1', MOZ_UPDATE_CHANNEL: 'bento', MOZ_APPUPDATE_HOST: 'updates.example.invalid', ACCEPTED_MAR_CHANNEL_IDS: 'bento' };

/**
 * `updates` says whether the build has the updater compiled in (it then has a MAR and
 * ships the host and certificates); `mode` is the build mode the manifest records and
 * `configEnabled` is bento.json updates.enabled, which only a release build obeys.
 */
async function fixture({ appBundle = true, marEntry = 'Contents/Resources/precomplete', updates = true, mode = 'release', configEnabled = updates } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-artifact-test-'));
  const objDist = path.join(root, 'engine', 'obj-test', 'dist');
  const applicationName = appBundle ? 'Bento.app' : 'bento';
  const application = path.join(objDist, applicationName);
  const app = appBundle ? path.join(application, 'Contents', 'Resources') : application;
  const marTool = path.join(objDist, 'host', 'bin', 'mar');
  await fsp.mkdir(app, { recursive: true });
  await fsp.mkdir(path.dirname(marTool), { recursive: true });
  // Firefox's packager writes precomplete whether or not the updater is built.
  await fsp.writeFile(path.join(app, 'precomplete'), '');
  await fsp.writeFile(path.join(app, 'platform.ini'), '[Build]\nMilestone=154.0\nBuildID=20260912000001\n');
  await fsp.writeFile(path.join(app, 'application.ini'), '[App]\nBuildID=20260912000000\n[Build]\nBuildID=20260912000001\n');
  await fsp.writeFile(path.join(objDist, 'bento-0.0.1.en-US.mac.dmg'), 'application');
  await fsp.writeFile(path.join(objDist, 'bento-0.0.1.en-US.win64.zip'), 'application archive');
  await fsp.writeFile(path.join(objDist, 'bento-0.0.1.en-US.win64.xpt_artifacts.zip'), 'test artifacts');
  const mar = path.join(root, 'dist', 'output.mar');
  await fsp.mkdir(path.dirname(mar), { recursive: true });
  await fsp.writeFile(path.join(root, 'bento.json'), JSON.stringify({
    schemaVersion: 1,
    brand: 'bento',
    binaryName: 'bento',
    build: { mode },
    firefox: { product: 'firefox', version: '154.0' },
    brands: { bento: { release: { displayVersion: '0.0.1' } } },
    updates: { enabled: configEnabled, hostname: 'updates.example.invalid', channel: 'bento' },
  }));
  const manifest = {
    schemaVersion: 1,
    displayVersion: '0.0.1',
    firefoxVersion: '154.0',
    updates: { enabled: updates, mode },
    application: `engine/obj-test/dist/${applicationName}`,
    applicationIni: appBundle
      ? 'engine/obj-test/dist/Bento.app/Contents/Resources/application.ini'
      : 'engine/obj-test/dist/bento/application.ini',
    buildId: '20260912000000',
    objDist: 'engine/obj-test/dist',
  };
  if (updates) {
    writeCertificates(root);
    shipUpdater({ application, objDist });
    await fsp.writeFile(path.join(root, 'engine', 'obj-test', 'config.status.json'), JSON.stringify({ substs: updaterSubsts }));
    await fsp.writeFile(marTool, `#!/bin/sh\nprintf "SIZE\\tMODE\\tNAME\\n0\\t0644\\t${marEntry}\\n"\n`);
    await fsp.chmod(marTool, 0o755);
    await fsp.writeFile(mar, 'update');
    const hash = crypto.createHash('sha512').update('update').digest('hex');
    const update = `<?xml version="1.0"?>\n<updates><update displayVersion="0.0.1" appVersion="0.0.1" platformVersion="154.0" buildID="20260912000000"><patch URL="https://updates.example.invalid/Bento-0.0.1-macos.mar" hashFunction="sha512" hashValue="${hash}" size="6" /></update></updates>\n`;
    await fsp.mkdir(path.join(root, 'dist', 'update', 'browser', 'Darwin_x86_64-gcc3', 'bento'), { recursive: true });
    await fsp.writeFile(path.join(root, 'dist', 'update', 'browser', 'Darwin_x86_64-gcc3', 'bento', 'update.xml'), update);
    Object.assign(manifest, {
      mar: { path: 'dist/output.mar', name: 'Bento-0.0.1-macos.mar', url: 'https://updates.example.invalid/Bento-0.0.1-macos.mar' },
      marTool: 'engine/obj-test/dist/host/bin/mar',
      updateTargets: ['Darwin_x86_64-gcc3'],
    });
  }
  await fsp.writeFile(path.join(root, 'dist', 'bento-artifacts.json'), JSON.stringify(manifest));
  return {
    root,
    objDist,
    manifest: path.join(root, 'dist', 'bento-artifacts.json'),
    update: path.join(root, 'dist', 'update', 'browser', 'Darwin_x86_64-gcc3', 'bento', 'update.xml'),
  };
}

test('artifact validation binds update metadata to produced MAR bytes', async () => {
  const { root, update } = await fixture();
  try {
    const result = validateArtifacts(root);
    assert.equal(result.updateTargets[0], 'Darwin_x86_64-gcc3');
    assert.equal(result.packages.some((file) => file.endsWith('.xpt_artifacts.zip')), false);
    assert.equal(result.packages.some((file) => file.endsWith('.zip')), true);
    const tampered = (await fsp.readFile(update, 'utf8')).replace(/hashValue="[^"]+"/, `hashValue="${'0'.repeat(128)}"`);
    await fsp.writeFile(update, tampered);
    assert.throws(() => validateArtifacts(root), /does not describe the produced MAR bytes/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('artifact validation ignores auxiliary archives when finding application packages', async () => {
  const { root, objDist } = await fixture();
  try {
    await fsp.rm(path.join(objDist, 'bento-0.0.1.en-US.mac.dmg'));
    await fsp.rm(path.join(objDist, 'bento-0.0.1.en-US.win64.zip'));
    assert.throws(() => validateArtifacts(root), /no primary application package found/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/**
 * Replaces the fixture's DMG and ZIP with a real macOS TAR laid out like `mach package`
 * output (bento/Bento.app/...). `files` maps archive paths to contents; each call
 * rebuilds the archive from scratch.
 */
async function useMacTar({ root, objDist }, files) {
  await fsp.rm(path.join(objDist, 'bento-0.0.1.en-US.mac.dmg'), { force: true });
  await fsp.rm(path.join(objDist, 'bento-0.0.1.en-US.win64.zip'), { force: true });
  const source = path.join(root, 'tar-source');
  await fsp.rm(source, { recursive: true, force: true });
  for (const [name, content] of Object.entries(files)) {
    await fsp.mkdir(path.dirname(path.join(source, name)), { recursive: true });
    await fsp.writeFile(path.join(source, name), content);
  }
  const archive = path.join(objDist, 'bento-0.0.1.en-US.mac.tar');
  const packed = spawnSync('tar', ['-cf', archive, '-C', source, ...await fsp.readdir(source)], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  return archive;
}

const bundleIni = 'bento/Bento.app/Contents/Resources/application.ini';
const stagedBuild = '[App]\nBuildID=20260912000000\n';

test('artifact validation accepts the TAR package that Firefox 158 builds for macOS dev builds', async () => {
  const built = await fixture({ updates: false });
  try {
    await useMacTar(built, { [bundleIni]: stagedBuild });
    await fsp.writeFile(path.join(built.objDist, 'bento-0.0.1.en-US.mac.update_framework_artifacts.zip'), 'auxiliary');
    assert.deepEqual(validateArtifacts(built.root).packages, ['bento-0.0.1.en-US.mac.tar']);
  } finally {
    await fsp.rm(built.root, { recursive: true, force: true });
  }
});

test('artifact validation rejects a macOS TAR package that is not the staged application', async () => {
  const built = await fixture({ updates: false });
  try {
    const archive = await useMacTar(built, { [bundleIni]: stagedBuild });
    const whole = await fsp.readFile(archive);

    // A name alone is not a package: plain text and an archive cut inside application.ini are not readable.
    await fsp.writeFile(archive, 'application');
    assert.throws(() => validateArtifacts(built.root), /is not a readable TAR archive/);
    await fsp.writeFile(archive, whole.subarray(0, 2570));
    assert.throws(() => validateArtifacts(built.root), /is not a readable TAR archive/);

    // A valid archive without the app bundle, with the bundle nested too deep, and with the wrong BuildID.
    await useMacTar(built, { 'bento/readme.txt': 'no app here' });
    assert.throws(() => validateArtifacts(built.root), /must hold exactly one Bento\.app\/Contents\/Resources\/application\.ini, found 0/);
    await useMacTar(built, { [`nested/deeper/${bundleIni}`]: stagedBuild });
    assert.throws(() => validateArtifacts(built.root), /found 0/);
    await useMacTar(built, { [bundleIni]: '[App]\nBuildID=20260913000000\n' });
    assert.throws(() => validateArtifacts(built.root), /build ID 20260913000000 does not match the packaged application 20260912000000/);
    await useMacTar(built, { [bundleIni]: '[Build]\nBuildID=20260912000000\n' });
    assert.throws(() => validateArtifacts(built.root), /has no \[App\] BuildID/);

    await useMacTar(built, { [bundleIni]: stagedBuild });
    validateArtifacts(built.root);
  } finally {
    await fsp.rm(built.root, { recursive: true, force: true });
  }
});

test('artifact validation parses a root precomplete entry from MAR table output', async () => {
  const { root } = await fixture({ appBundle: false, marEntry: 'precomplete' });
  try {
    assert.equal(validateArtifacts(root).packages.length, 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('artifact validation binds BuildID and MAR URL to configured package metadata', async () => {
  const { root, manifest, update } = await fixture();
  try {
    const metadata = JSON.parse(await fsp.readFile(manifest, 'utf8'));
    metadata.buildId = '20260913000000';
    await fsp.writeFile(manifest, JSON.stringify(metadata));
    assert.throws(() => validateArtifacts(root), /manifest build ID does not match/);

    metadata.buildId = '20260912000000';
    metadata.mar.url = 'https://wrong.example.invalid/Bento-0.0.1-macos.mar';
    const xml = await fsp.readFile(update, 'utf8');
    await fsp.writeFile(manifest, JSON.stringify(metadata));
    await fsp.writeFile(update, xml.replaceAll('https://updates.example.invalid/Bento-0.0.1-macos.mar', metadata.mar.url));
    assert.throws(() => validateArtifacts(root), /MAR URL does not match the configured release URL/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('artifact validation rejects a non-bundle application.ini outside the application', async () => {
  const { root, manifest } = await fixture({ appBundle: false });
  try {
    const metadata = JSON.parse(await fsp.readFile(manifest, 'utf8'));
    await fsp.mkdir(path.join(root, 'engine', 'obj-test', 'dist', 'bin'), { recursive: true });
    await fsp.writeFile(path.join(root, 'engine', 'obj-test', 'dist', 'bin', 'application.ini'), '[App]\nBuildID=20260912000000\n');
    metadata.applicationIni = 'engine/obj-test/dist/bin/application.ini';
    await fsp.writeFile(manifest, JSON.stringify(metadata));
    assert.throws(() => validateArtifacts(root), /application.ini is not the one inside the application/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('with the updater disabled, artifact validation expects the packages and no MAR or update metadata', async () => {
  const { root, manifest } = await fixture({ updates: false });
  try {
    const result = validateArtifacts(root);
    assert.equal(result.updates, false);
    assert.equal(result.packages.length, 2);
    assert.equal('mar' in result, false);

    // Neither a stale MAR nor stale update XML may sit beside a build that cannot update.
    await fsp.writeFile(path.join(root, 'dist', 'output.mar'), 'stale');
    assert.throws(() => validateArtifacts(root), /holds a MAR or update metadata, but the updater is disabled/);
    await fsp.rm(path.join(root, 'dist', 'output.mar'));
    await fsp.mkdir(path.join(root, 'dist', 'update', 'browser'), { recursive: true });
    assert.throws(() => validateArtifacts(root), /holds a MAR or update metadata, but the updater is disabled/);
    await fsp.rm(path.join(root, 'dist', 'update'), { recursive: true });
    validateArtifacts(root);

    const metadata = JSON.parse(await fsp.readFile(manifest, 'utf8'));
    await fsp.writeFile(manifest, JSON.stringify({ ...metadata, updateTargets: ['Darwin_x86_64-gcc3'] }));
    assert.throws(() => validateArtifacts(root), /lists update outputs, but the updater is disabled/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('artifact validation takes the expected updater state from the recorded build mode and bento.json', async () => {
  const disabled = await fixture({ updates: false });
  const enabled = await fixture();
  const devBuild = await fixture({ updates: false, mode: 'dev', configEnabled: true });
  try {
    // A dev build has no updater even though bento.json enables it for release builds.
    assert.equal(validateArtifacts(devBuild.root).updates, false);

    // Artifacts packaged with the updater on, validated against a config that turned it off.
    const config = JSON.parse(await fsp.readFile(path.join(enabled.root, 'bento.json'), 'utf8'));
    config.updates.enabled = false;
    await fsp.writeFile(path.join(enabled.root, 'bento.json'), JSON.stringify(config));
    assert.throws(() => validateArtifacts(enabled.root), /records the updater as enabled for a release build, but bento\.json updates\.enabled is false/);

    // A release build that bento.json now enables, whose metadata says it has no updater.
    config.updates.enabled = true;
    await fsp.writeFile(path.join(disabled.root, 'bento.json'), JSON.stringify(config));
    assert.throws(() => validateArtifacts(disabled.root), /records the updater as disabled for a release build, but bento\.json updates\.enabled is true/);

    // A dev build recorded with the updater on is wrong whatever bento.json says.
    const metadata = JSON.parse(await fsp.readFile(devBuild.manifest, 'utf8'));
    await fsp.writeFile(devBuild.manifest, JSON.stringify({ ...metadata, updates: { enabled: true, mode: 'dev' } }));
    assert.throws(() => validateArtifacts(devBuild.root), /records the updater as enabled for a dev build, but bento\.json updates\.enabled is true, so such a build has it disabled/);

    // Metadata from before the mode was recorded does not say, so it is regenerated.
    for (const updates of [undefined, { enabled: true }, { enabled: true, mode: 'fast' }]) {
      const old = JSON.parse(await fsp.readFile(disabled.manifest, 'utf8'));
      await fsp.writeFile(disabled.manifest, JSON.stringify({ ...old, updates }));
      assert.throws(() => validateArtifacts(disabled.root), /does not record the updater state and build mode/);
    }
  } finally {
    await fsp.rm(devBuild.root, { recursive: true, force: true });
    await fsp.rm(disabled.root, { recursive: true, force: true });
    await fsp.rm(enabled.root, { recursive: true, force: true });
  }
});

test('the bundle needs precomplete whether or not the updater is enabled', async () => {
  const off = await fixture({ updates: false });
  const on = await fixture();
  try {
    for (const { root, objDist } of [off, on]) {
      validateArtifacts(root);
      await fsp.rm(path.join(objDist, 'Bento.app', 'Contents', 'Resources', 'precomplete'));
      assert.throws(() => validateArtifacts(root), /application bundle is missing precomplete/);
    }
  } finally {
    await fsp.rm(off.root, { recursive: true, force: true });
    await fsp.rm(on.root, { recursive: true, force: true });
  }
});

test('artifact validation checks the updater state and channel configure recorded in the object directory', async () => {
  const disabled = await fixture({ updates: false });
  const enabled = await fixture();
  const configureRecorded = (root, substs) => fsp.writeFile(path.join(root, 'engine', 'obj-test', 'config.status.json'), JSON.stringify({ substs }));
  try {
    // Agreeing with the state the mode requires, or no configure output yet, passes.
    await configureRecorded(disabled.root, { MOZ_UPDATE_CHANNEL: 'bento' });
    validateArtifacts(disabled.root);
    await configureRecorded(enabled.root, updaterSubsts);
    validateArtifacts(enabled.root);

    // Metadata and bento.json both say off, but configure built the updater in.
    await configureRecorded(disabled.root, { MOZ_UPDATER: '1', MOZ_UPDATE_CHANNEL: 'bento' });
    assert.throws(() => validateArtifacts(disabled.root), /engine\/obj-test was configured with the updater in, but a release build with bento\.json updates\.enabled false has it out/);
    await configureRecorded(enabled.root, { MOZ_UPDATE_CHANNEL: 'bento' });
    assert.throws(() => validateArtifacts(enabled.root), /engine\/obj-test was configured with the updater out, but a release build with bento\.json updates\.enabled true has it in/);

    // The updater state agrees, but configure used another channel (Mozilla's names select Mozilla's certificates).
    for (const channel of ['release', undefined]) {
      await configureRecorded(disabled.root, { MOZ_UPDATE_CHANNEL: channel });
      assert.throws(() => validateArtifacts(disabled.root), /engine\/obj-test was configured with the update channel .*, but bento\.json updates\.channel is "bento"/);
      await configureRecorded(enabled.root, { ...updaterSubsts, MOZ_UPDATE_CHANNEL: channel });
      assert.throws(() => validateArtifacts(enabled.root), /engine\/obj-test was configured with the update channel .*, but bento\.json updates\.channel is "bento"/);
    }
  } finally {
    await fsp.rm(disabled.root, { recursive: true, force: true });
    await fsp.rm(enabled.root, { recursive: true, force: true });
  }
});

/** Replaces `file` with `edit` applied to its bytes, runs `fn`, and restores it. */
async function withFileEdited(file, edit, fn) {
  const original = await fsp.readFile(file);
  await fsp.writeFile(file, edit(original));
  try {
    await fn();
  } finally {
    await fsp.writeFile(file, original);
  }
}

test('with the updater on, artifact validation finds the update host and both certificates in the shipped files', async () => {
  const cases = [{ appBundle: true }, { appBundle: false }];
  for (const options of cases) {
    const built = await fixture(options);
    const { root, objDist } = built;
    const application = path.join(objDist, options.appBundle ? 'Bento.app' : 'bento');
    const resources = options.appBundle ? path.join(application, 'Contents', 'Resources') : application;
    const executables = options.appBundle ? path.join(application, 'Contents', 'MacOS') : application;
    const updater = options.appBundle
      ? path.join(executables, 'updater.app', 'Contents', 'MacOS', 'org.mozilla.updater')
      : path.join(application, process.platform === 'win32' ? 'updater.exe' : 'updater');
    const main = path.join(executables, process.platform === 'win32' && !options.appBundle ? 'bento.exe' : 'bento');
    const wrongHost = (bytes) => Buffer.from(bytes.toString('utf8').replaceAll('updates.example.invalid', 'aus5.mozilla.org'));
    const without = (certificate) => (bytes) => Buffer.from(bytes.toString('latin1').replace(certificate.toString('latin1'), 'x'.repeat(certificate.length)), 'latin1');
    const configStatus = path.join(root, 'engine', 'obj-test', 'config.status.json');
    const substs = (change) => (bytes) => Buffer.from(JSON.stringify({ substs: { ...JSON.parse(bytes.toString()).substs, ...change } }));
    try {
      validateArtifacts(root);
      const rejects = async (file, edit, message) => withFileEdited(file, edit, () => assert.throws(() => validateArtifacts(root), message));

      // What configure recorded.
      await rejects(configStatus, substs({ MOZ_APPUPDATE_HOST: 'aus5.mozilla.org' }), /configure recorded the update host "aus5\.mozilla\.org", but bento\.json updates\.hostname is "updates\.example\.invalid"/);
      await rejects(configStatus, substs({ MOZ_APPUPDATE_HOST: undefined }), /configure recorded the update host undefined/);
      await rejects(configStatus, substs({ ACCEPTED_MAR_CHANNEL_IDS: 'release' }), /configure recorded the accepted MAR channels "release", but bento\.json updates\.channel is "bento"/);

      // The update URL in the generated and the packaged application.ini, and in the main binary.
      await rejects(path.join(objDist, 'bin', 'application.ini'), wrongHost, /the generated application\.ini has \[AppUpdate\] URL "https:\/\/aus5\.mozilla\.org\/update\/6\/.*", not one starting with https:\/\/updates\.example\.invalid\/update\/6\//);
      await rejects(path.join(resources, 'application.ini'), wrongHost, /the packaged application\.ini has \[AppUpdate\] URL "https:\/\/aus5\.mozilla\.org/);
      await rejects(path.join(resources, 'application.ini'), (bytes) => Buffer.from(bytes.toString().replace('[AppUpdate]', '[Other]')), /the packaged application\.ini has \[AppUpdate\] URL undefined/);
      await rejects(main, wrongHost, /the main binary does not contain the update URL https:\/\/updates\.example\.invalid\/update\/6\//);

      // Both committed certificates, byte for byte, inside the updater.
      await rejects(updater, without(Buffer.from('test primary certificate')), /the updater binary does not contain the committed primary\.der update certificate/);
      await rejects(updater, without(Buffer.from('test secondary certificate')), /does not contain the committed secondary\.der update certificate/);
      await withFileEdited(path.join(root, 'branding', 'bento', 'update-certificates', 'primary.der'), () => Buffer.from('another certificate'), () => {
        assert.throws(() => validateArtifacts(root), /the updater binary does not contain the committed primary\.der/);
      });

      // The files themselves.
      for (const [file, label] of [[main, 'the main binary'], [updater, 'the updater binary']]) {
        await fsp.rename(file, `${file}.moved`);
        assert.throws(() => validateArtifacts(root), new RegExp(`${label} is missing`));
        await fsp.rename(`${file}.moved`, file);
      }
      if (options.appBundle) {
        const framework = path.join(executables, 'updater.app', 'Contents', 'Frameworks', 'UpdateSettings.framework');
        const executable = path.join(framework, 'UpdateSettings');
        // The directory alone is not enough: the updater cannot launch without the framework executable.
        await fsp.rename(executable, `${executable}.moved`);
        assert.throws(() => validateArtifacts(root), /the updater has no UpdateSettings\.framework executable/);
        await fsp.rename(`${executable}.moved`, executable);
      }
      await fsp.rm(configStatus);
      assert.throws(() => validateArtifacts(root), /no config\.status\.json to prove the update host/);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  }
});

test('application.ini parser reads BuildID from the App section', () => {
  assert.equal(
    readApplicationBuildId('[Build]\nBuildID=wrong\n[App]\nName=Bento\nBuildID = 20260913000000\n[Other]\nBuildID=also-wrong\n'),
    '20260913000000',
  );
  assert.equal(readApplicationBuildId('[App]\r\nBuildID=20260913000000\r\nVersion=154.0\r\n'), '20260913000000');
  assert.equal(readApplicationBuildId('[Build]\nBuildID=wrong\n'), undefined);
});
