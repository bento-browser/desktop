#!/usr/bin/env node
/* global Buffer, console */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const outputDir = path.resolve(root, process.argv[2] || 'release-out');
// The SBOM reads the one committed lock; the env override exists for tests.
const lockPath = path.resolve(root, process.env.BENTO_LOCK_PATH || 'pnpm-lock.yaml');
const bento = JSON.parse(fs.readFileSync(path.join(root, 'bento.json'), 'utf8'));
const ublock = JSON.parse(
  fs.readFileSync(path.join(root, 'extensions/ublock-origin/manifest.json'), 'utf8'),
);
const shellPackage = JSON.parse(
  fs.readFileSync(path.join(root, 'extensions/bento-shell/package.json'), 'utf8'),
);
// Pin the published package and registry integrity so lock tampering fails offline.
const muxuiVersion = '0.1.0-rc.4';
const muxuiIntegrity =
  'sha512-9XRnBRYCvSN7quvfL8nNMtNLRV9NMriSmjjGwP8Ja7w90CycxfKCp4xykxRlrWDLWnQgs8086vJ70KKD7BkVtA==';
const muxuiTarball = `https://registry.npmjs.org/@muxui/react/-/react-${muxuiVersion}.tgz`;

const APPROVED_SHELL_RUNTIME_DEPENDENCIES = Object.freeze({
  '@muxui/react': muxuiVersion,
  react: '^19.2.0',
  'react-dom': '^19.2.0',
  zustand: '^5.0.0',
  '@tanstack/react-virtual': '^3.10.0',
  'lucide-react': '1.37.0',
  'emojibase-data': '17.0.0',
});

function validateShellRuntimeDependencies(dependencies, label) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error(`${label} is missing its approved Bento shell runtime dependencies.`);
  }

  const expectedNames = Object.keys(APPROVED_SHELL_RUNTIME_DEPENDENCIES).sort();
  const actualNames = Object.keys(dependencies).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error(
      `${label} must exactly match the approved Bento shell runtime dependencies (received ${actualNames.join(', ') || 'none'}).`,
    );
  }

  for (const [name, expectedSpecifier] of Object.entries(APPROVED_SHELL_RUNTIME_DEPENDENCIES)) {
    const entry = dependencies[name];
    const actualSpecifier = typeof entry === 'string' ? entry : entry?.specifier;
    if (actualSpecifier !== expectedSpecifier) {
      throw new Error(
        `${label} has an unapproved specifier for ${name} (received ${actualSpecifier || 'missing'}).`,
      );
    }
  }
}

validateShellRuntimeDependencies(shellPackage.dependencies, 'extensions/bento-shell/package.json');

function packageIdentity(key, metadata) {
  const sourceSeparator = key.search(/@(?:https?|git\+|file:)/);
  if (sourceSeparator > 0 && metadata?.version) {
    return { name: key.slice(0, sourceSeparator), version: String(metadata.version) };
  }
  const versionSeparator = key.lastIndexOf('@');
  if (versionSeparator <= 0) throw new Error(`Unsupported lock package key: ${key}`);
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

const lock = parse(fs.readFileSync(lockPath, 'utf8'));
if (!lock?.packages || typeof lock.packages !== 'object') {
  throw new Error(`${path.basename(lockPath)} does not contain a packages map.`);
}

const muxuiImporter = lock.importers?.['extensions/bento-shell'];
validateShellRuntimeDependencies(
  muxuiImporter?.dependencies,
  `${path.basename(lockPath)} extensions/bento-shell importer`,
);
const muxuiDependency = muxuiImporter?.dependencies?.['@muxui/react'];
const importerVersion = String(muxuiDependency?.version || '').split('(', 1)[0];
if (importerVersion !== muxuiVersion) {
  throw new Error('extensions/bento-shell @muxui/react importer resolves a different version.');
}

const muxuiLockKey = `@muxui/react@${muxuiVersion}`;
const muxuiLockEntries = Object.entries(lock.packages).filter(([key]) =>
  key.startsWith('@muxui/react@'),
);
if (muxuiLockEntries.length !== 1 || muxuiLockEntries[0][0] !== muxuiLockKey) {
  throw new Error('pnpm-lock.yaml must contain exactly one published @muxui/react package entry.');
}
const muxuiResolution = muxuiLockEntries[0][1]?.resolution;
// pnpm omits the tarball for the default npm registry; an explicit source must agree.
if (muxuiResolution?.tarball && muxuiResolution.tarball !== muxuiTarball) {
  throw new Error(
    'pnpm-lock.yaml @muxui/react resolution does not point to the published npm package.',
  );
}
if (muxuiResolution?.integrity !== muxuiIntegrity) {
  throw new Error(
    'pnpm-lock.yaml @muxui/react integrity does not match the published npm package.',
  );
}
const packages = Object.entries(lock.packages).map(([key, metadata]) => {
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
    version: bento.firefox.version,
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
      version: bento.brands.bento.release.displayVersion,
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
