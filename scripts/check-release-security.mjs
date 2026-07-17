#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const channelArg = process.argv.find((arg) => arg.startsWith('--channel='));
const channel = channelArg?.split('=', 2)[1] || 'preview';

if (!['preview', 'public'].includes(channel)) {
  throw new Error(`Unknown release channel: ${channel}`);
}

const config = JSON.parse(fs.readFileSync(path.join(root, 'config/release-security.json'), 'utf8'));
const surfer = JSON.parse(fs.readFileSync(path.join(root, 'surfer.json'), 'utf8'));

if (config.schemaVersion !== 1) {
  throw new Error('Unsupported release-security schema version.');
}
if (config.updateService?.hostname !== surfer.updateHostname) {
  throw new Error('Release security update hostname does not match surfer.json.');
}
const expectedTag = `v${surfer.brands.bento.release.displayVersion}`;
if (process.env.GITHUB_REF_NAME?.startsWith('v') && process.env.GITHUB_REF_NAME !== expectedTag) {
  throw new Error(`Release tag must be ${expectedTag}, received ${process.env.GITHUB_REF_NAME}.`);
}

if (channel === 'preview') {
  console.log('Preview release gate passed (draft + prerelease artifacts only).');
  process.exit(0);
}

const required = [
  ['publicReleaseReady', config.publicReleaseReady === true],
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
