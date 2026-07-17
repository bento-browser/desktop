#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function requireText(file, pattern, description) {
  const content = read(file);
  if (!pattern.test(content)) throw new Error(`${file}: missing ${description}`);
}

function forbidText(file, pattern, description) {
  const content = read(file);
  if (pattern.test(content)) throw new Error(`${file}: contains ${description}`);
}

const mount = 'src/browser/base/content/bento-shell-mount.js';
requireText(mount, /LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL/, 'non-inheriting navigation load flag');
requireText(mount, /isDisallowedAddress(?:URI|Spec)/, 'unsafe address scheme rejection');
requireText(mount, /sanitizeAddressPaste/, 'paste sanitization');
requireText(
  mount,
  /triggeringPrincipal:\s*Services\.scriptSecurityManager\.getSystemPrincipal\(\)/,
  'explicit triggering principal',
);

forbidText(
  'prefs/bento.js',
  /devtools\.debugger\.prompt-connection[^\n]*false/,
  'disabled debugger connection prompt',
);
forbidText(
  'branding/bento/pref/firefox-branding.js',
  /devtools\.selfxss\.count/,
  'self-XSS bypass',
);
requireText(
  'configs/common/mozconfig',
  /export MOZ_REQUIRE_SIGNING=1/,
  'release add-on signature enforcement',
);

const zenPatch = 'patches/core-ui/09-bento-firefox-profile-first-run-import.patch';
for (const marker of [
  'tab.private',
  'tab.isPrivate',
  'tab.incognito',
  'entry?.private',
  'entry?.isPrivate',
  'entry?.incognito',
]) {
  requireText(
    zenPatch,
    new RegExp(marker.replace(/[?.]/g, '\\$&')),
    `private-session filter ${marker}`,
  );
}

const iconApi = 'extensions/bento-tools/experiments/bento-privacy/api.js';
for (const marker of [
  'MAX_SEARCH_ICON_BYTES',
  'SEARCH_ICON_FETCH_TIMEOUT_MS',
  'SEARCH_ICON_CONCURRENCY',
  "new Set(['https', 'moz-extension'])",
  "new Set(['chrome', 'resource', 'moz-icon'])",
  "credentials: 'omit'",
  "referrerPolicy: 'no-referrer'",
]) {
  requireText(
    iconApi,
    new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `bounded icon invariant ${marker}`,
  );
}

const ublockManifest = JSON.parse(read('extensions/ublock-origin/manifest.json'));
const ublockReadme = read('extensions/ublock-origin/README.md');
if (ublockManifest.browser_specific_settings?.gecko?.id !== 'uBlock0@raymondhill.net') {
  throw new Error('uBlock Origin add-on id changed unexpectedly.');
}
if (!ublockReadme.includes(`Version: ${ublockManifest.version}`)) {
  throw new Error('uBlock Origin README version does not match manifest.json.');
}
if (!/SHA-256: `[a-f0-9]{64}`/.test(ublockReadme)) {
  throw new Error('uBlock Origin provenance SHA-256 is missing.');
}
const runtimeEntries = JSON.parse(read('extensions/ublock-origin/.bento-runtime-entries.json'));
for (const entry of runtimeEntries) {
  if (!fs.existsSync(path.join(root, 'extensions/ublock-origin', entry))) {
    throw new Error(`uBlock Origin runtime entry is missing: ${entry}`);
  }
}

const releaseWorkflow = read('.github/workflows/release.yml');
requireText(
  '.github/workflows/release.yml',
  /node scripts\/generate-release-sbom\.mjs/,
  'release SBOM generation',
);
requireText(
  '.github/workflows/release.yml',
  /node scripts\/generate-release-metadata\.mjs/,
  'release checksums and manifest generation',
);
requireText('.github/workflows/release.yml', /actions\/attest@/, 'artifact provenance attestation');
const releaseSecurity = JSON.parse(read('config/release-security.json'));
if (!releaseSecurity.publicReleaseReady && !/prerelease:\s*true/.test(releaseWorkflow)) {
  throw new Error('Unapproved public release configuration must remain a prerelease.');
}

console.log('Bento security invariants passed.');
