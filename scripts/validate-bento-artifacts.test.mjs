import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { validateArtifacts } from './validate-bento-artifacts.mjs';

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-artifact-test-'));
  const objDist = path.join(root, 'engine', 'obj-test', 'dist');
  const app = path.join(objDist, 'Bento.app', 'Contents', 'Resources');
  const marTool = path.join(objDist, 'host', 'bin', 'mar');
  await fsp.mkdir(app, { recursive: true });
  await fsp.mkdir(path.dirname(marTool), { recursive: true });
  await fsp.writeFile(path.join(app, 'precomplete'), '');
  await fsp.writeFile(path.join(objDist, 'Bento-0.0.1.dmg'), 'application');
  await fsp.writeFile(path.join(objDist, 'bento-0.0.1.en-US.win64.zip'), 'application archive');
  await fsp.writeFile(path.join(objDist, 'bento-0.0.1.en-US.win64.xpt_artifacts.zip'), 'test artifacts');
  await fsp.writeFile(marTool, '#!/bin/sh\nprintf "precomplete\\n"\n');
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
    application: 'engine/obj-test/dist/Bento.app',
    objDist: 'engine/obj-test/dist',
    updateTargets: ['Darwin_x86_64-gcc3'],
  }));
  return { root, update: path.join(root, 'dist', 'update', 'browser', 'Darwin_x86_64-gcc3', 'bento', 'update.xml') };
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
