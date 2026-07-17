#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const outputDir = path.resolve(root, process.argv[2] || 'release-out');
const surfer = JSON.parse(fs.readFileSync(path.join(root, 'surfer.json'), 'utf8'));
const ublock = JSON.parse(
  fs.readFileSync(path.join(root, 'extensions/ublock-origin/manifest.json'), 'utf8'),
);

function packageIdentity(key, metadata) {
  const sourceSeparator = key.search(/@(?:https?|git\+|file:)/);
  if (sourceSeparator > 0 && metadata?.version) {
    return { name: key.slice(0, sourceSeparator), version: String(metadata.version) };
  }
  const versionSeparator = key.lastIndexOf('@');
  if (versionSeparator <= 0) throw new Error(`Unsupported release lock package key: ${key}`);
  return { name: key.slice(0, versionSeparator), version: key.slice(versionSeparator + 1) };
}

function npmPurl(name, version) {
  const encodedName = name.split('/').map(encodeURIComponent).join('/');
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function integrityHashes(integrity) {
  const match = /^(sha256|sha384|sha512)-(.+)$/.exec(integrity || '');
  if (!match) return undefined;
  return [
    {
      alg: match[1].toUpperCase().replace('SHA', 'SHA-'),
      content: Buffer.from(match[2], 'base64').toString('hex'),
    },
  ];
}

const releaseLock = parse(fs.readFileSync(path.join(root, 'pnpm-lock.release.yaml'), 'utf8'));
if (!releaseLock?.packages || typeof releaseLock.packages !== 'object') {
  throw new Error('pnpm-lock.release.yaml does not contain a packages map.');
}
const packages = Object.entries(releaseLock.packages).map(([key, metadata]) => {
  const { name, version } = packageIdentity(key, metadata);
  const hashes = integrityHashes(metadata?.resolution?.integrity);
  return {
    type: 'library',
    name,
    version,
    purl: npmPurl(name, version),
    ...(hashes ? { hashes } : {}),
  };
});

const components = [
  {
    type: 'application',
    name: 'Mozilla Firefox',
    version: surfer.version.version,
    properties: [{ name: 'bento:role', value: 'upstream-browser-engine' }],
  },
  {
    type: 'application',
    name: 'uBlock Origin',
    version: ublock.version,
    properties: [{ name: 'bento:addon-id', value: ublock.browser_specific_settings.gecko.id }],
  },
  ...packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)),
];

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      name: 'Bento Browser',
      version: surfer.brands.bento.release.displayVersion,
    },
    tools: {
      components: [{ type: 'application', name: 'Bento release tooling', version: '1' }],
    },
  },
  components,
};

fs.mkdirSync(outputDir, { recursive: true });
const output = path.join(outputDir, 'bento-sbom.cdx.json');
fs.writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, output)} with ${components.length} components.`);
