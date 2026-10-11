#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { findDevReload } from './dev-reload.mjs';
import { updaterReadinessProblems } from './update-readiness.mjs';

// --root points the gate at another checkout layout; the tests use it.
const rootArg = process.argv.find((arg) => arg.startsWith('--root='));
const root = path.resolve(
  rootArg ? rootArg.slice('--root='.length) : path.join(import.meta.dirname, '..'),
);

// `--built-shell` is a standalone check of build output (the channel and tag
// gates below do not apply): a release shell must not carry the dev-only reload
// command. It scans the built bundle and, once imported, the manifest and bundle
// copied into the engine.
if (process.argv.includes('--built-shell')) {
  const buildRoot = path.resolve(process.env.BENTO_REPO_ROOT || root);
  const dist = path.join(buildRoot, 'extensions/bento-shell/dist');
  const imported = path.join(buildRoot, 'engine/browser/extensions/bento-shell');
  if (!fs.existsSync(dist)) {
    throw new Error(`--built-shell needs a built shell: ${dist} is missing.`);
  }
  const hits = findDevReload([dist, ...(fs.existsSync(imported) ? [imported] : [])]);
  if (hits.length > 0) {
    throw new Error(
      `Release shell still contains the dev-only reload command: ${hits.map((file) => path.relative(buildRoot, file)).join(', ')}`,
    );
  }
  console.log('Release shell has no dev-only reload command.');
  process.exit(0);
}

const channelArg = process.argv.find((arg) => arg.startsWith('--channel='));
const channel = channelArg?.split('=', 2)[1] || 'preview';

if (!['preview', 'public'].includes(channel)) {
  throw new Error(`Unknown release channel: ${channel}`);
}

const config = JSON.parse(fs.readFileSync(path.join(root, 'config/release-security.json'), 'utf8'));
const bento = JSON.parse(fs.readFileSync(path.join(root, 'bento.json'), 'utf8'));

if (config.schemaVersion !== 1) {
  throw new Error('Unsupported release-security schema version.');
}
if (config.updateService?.hostname !== bento.updates?.hostname) {
  throw new Error('Release security update hostname does not match bento.json.');
}
if (bento.updates?.enabled !== undefined && typeof bento.updates.enabled !== 'boolean') {
  throw new Error('bento.json updates.enabled must be true or false.');
}
// The updater is compiled out until Bento owns a signed update path. Enabling it
// is refused here, for every channel, until the readiness inputs are recorded.
const updatesEnabled = bento.updates?.enabled === true;
if (updatesEnabled) {
  const problems = updaterReadinessProblems(bento, config);
  if (problems.length) {
    throw new Error(
      `bento.json updates.enabled is true, but the updater is not ready:\n- ${problems.join('\n- ')}`,
    );
  }
}
const expectedTag = `v${bento.brands.bento.release.displayVersion}`;
if (process.env.GITHUB_REF_NAME?.startsWith('v') && process.env.GITHUB_REF_NAME !== expectedTag) {
  throw new Error(`Release tag must be ${expectedTag}, received ${process.env.GITHUB_REF_NAME}.`);
}

if (channel === 'preview') {
  console.log(
    `Preview release gate passed (draft + prerelease artifacts only; updater ${updatesEnabled ? 'enabled' : 'disabled'}).`,
  );
  process.exit(0);
}

const required = [
  ['publicReleaseReady', config.publicReleaseReady === true],
  ['bento.json updates.enabled', updatesEnabled],
  ['updateService.marSigningKeyFingerprint', config.updateService?.marSigningKeyFingerprint],
  [
    'platformSigning.linuxManifestKeyFingerprint',
    config.platformSigning?.linuxManifestKeyFingerprint,
  ],
  ['platformSigning.macosDeveloperIdTeam', config.platformSigning?.macosDeveloperIdTeam],
  [
    'platformSigning.windowsCertificateThumbprint',
    config.platformSigning?.windowsCertificateThumbprint,
  ],
];
const missing = required.filter(([, value]) => !value).map(([name]) => name);
if (missing.length) {
  throw new Error(
    `Public release is blocked until these externally provisioned controls are recorded: ${missing.join(', ')}`,
  );
}
const fingerprints = [
  config.updateService.marSigningKeyFingerprint,
  config.platformSigning.linuxManifestKeyFingerprint,
];
if (fingerprints.some((value) => !/^[a-f0-9]{64}$/i.test(value))) {
  throw new Error('MAR and Linux manifest fingerprints must be SHA-256 hex digests.');
}
if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/i.test(config.platformSigning.windowsCertificateThumbprint)) {
  throw new Error('Windows certificate thumbprint must be a SHA-1 or SHA-256 hex digest.');
}
if (!/^[A-Z0-9]{10}$/.test(config.platformSigning.macosDeveloperIdTeam)) {
  throw new Error('macOS Developer ID team must be a ten-character team identifier.');
}

console.log('Public release security gate passed.');
