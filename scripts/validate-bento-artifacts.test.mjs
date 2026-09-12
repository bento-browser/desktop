import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readPlatformBuildId } from './bento-build.mjs';
import { validateArtifacts } from './validate-bento-artifacts.mjs';

async function fixture({ appBundle = true, marEntry = 'Contents/Resources/precomplete' } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-artifact-test-'));
  const objDist = path.join(root, 'engine', 'obj-test', 'dist');
  const applicationName = appBundle ? 'Bento.app' : 'bento';
  const application = path.join(objDist, applicationName);
  const app = appBundle ? path.join(application, 'Contents', 'Resources') : application;
  const marTool = path.join(objDist, 'host', 'bin', 'mar');
  await fsp.mkdir(app, { recursive: true });
  await fsp.mkdir(path.dirname(marTool), { recursive: true });
  await fsp.writeFile(path.join(app, 'precomplete'), '');
  await fsp.writeFile(path.join(app, 'platform.ini'), '[Build]\nMilestone=154.0\nBuildID=20260912000000\n');
  await fsp.writeFile(path.join(objDist, 'bento-0.0.1.en-US.mac.dmg'), 'application');
  await fsp.writeFile(path.join(objDist, 'bento-0.0.1.en-US.win64.zip'), 'application archive');
  await fsp.writeFile(path.join(objDist, 'bento-0.0.1.en-US.win64.xpt_artifacts.zip'), 'test artifacts');
  await fsp.writeFile(marTool, `#!/bin/sh\nprintf "SIZE\\tMODE\\tNAME\\n0\\t0644\\t${marEntry}\\n"\n`);
  await fsp.chmod(marTool, 0o755);
  const mar = path.join(root, 'dist', 'output.mar');
  await fsp.mkdir(path.dirname(mar), { recursive: true });
  await fsp.writeFile(mar, 'update');
  const hash = crypto.createHash('sha512').update('update').digest('hex');
  await fsp.writeFile(path.join(root, 'bento.json'), JSON.stringify({
    schemaVersion: 1,
    brand: 'bento',
    build: { mode: 'release' },
    firefox: { product: 'firefox', version: '154.0' },
    brands: { bento: { release: { displayVersion: '0.0.1' } } },
    updates: { hostname: 'updates.example.invalid', channel: 'bento' },
  }));
  const update = `<?xml version="1.0"?>\n<updates><update displayVersion="0.0.1" appVersion="0.0.1" platformVersion="154.0" buildID="20260912000000"><patch URL="https://updates.example.invalid/Bento-0.0.1-macos.mar" hashFunction="sha512" hashValue="${hash}" size="6" /></update></updates>\n`;
  await fsp.mkdir(path.join(root, 'dist', 'update', 'browser', 'Darwin_x86_64-gcc3', 'bento'), { recursive: true });
  await fsp.writeFile(path.join(root, 'dist', 'update', 'browser', 'Darwin_x86_64-gcc3', 'bento', 'update.xml'), update);
  await fsp.writeFile(path.join(root, 'dist', 'bento-artifacts.json'), JSON.stringify({
    schemaVersion: 1,
    displayVersion: '0.0.1',
    firefoxVersion: '154.0',
    mar: { path: 'dist/output.mar', name: 'Bento-0.0.1-macos.mar', url: 'https://updates.example.invalid/Bento-0.0.1-macos.mar' },
    marTool: 'engine/obj-test/dist/host/bin/mar',
    application: `engine/obj-test/dist/${applicationName}`,
    platformIni: appBundle
      ? 'engine/obj-test/dist/Bento.app/Contents/Resources/platform.ini'
      : 'engine/obj-test/dist/bento/platform.ini',
    buildId: '20260912000000',
    objDist: 'engine/obj-test/dist',
    updateTargets: ['Darwin_x86_64-gcc3'],
  }));
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

test('artifact validation rejects a non-bundle platform.ini outside the application', async () => {
  const { root, manifest } = await fixture({ appBundle: false });
  try {
    const metadata = JSON.parse(await fsp.readFile(manifest, 'utf8'));
    await fsp.mkdir(path.join(root, 'engine', 'obj-test', 'dist', 'bin'), { recursive: true });
    await fsp.writeFile(path.join(root, 'engine', 'obj-test', 'dist', 'bin', 'platform.ini'), '[Build]\nBuildID=20260912000000\n');
    metadata.platformIni = 'engine/obj-test/dist/bin/platform.ini';
    await fsp.writeFile(manifest, JSON.stringify(metadata));
    assert.throws(() => validateArtifacts(root), /platform.ini is not the one inside the application/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('platform.ini parser reads BuildID from a multiline Build section', () => {
  assert.equal(
    readPlatformBuildId('[App]\nBuildID=wrong\n[Build]\nMilestone=154.0\nBuildID = 20260913000000\n[Other]\nBuildID=also-wrong\n'),
    '20260913000000',
  );
  assert.equal(readPlatformBuildId('[Build]\r\nBuildID=20260913000000\r\nMilestone=154.0\r\n'), '20260913000000');
  assert.equal(readPlatformBuildId('[App]\nBuildID=wrong\n'), undefined);
});
