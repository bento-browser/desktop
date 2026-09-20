#!/usr/bin/env node
/* global Buffer, console */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const outputDir = path.resolve(root, process.argv[2] || 'release-out');
const releaseLockPath = path.resolve(
  root,
  process.env.BENTO_RELEASE_LOCK_PATH || 'pnpm-lock.release.yaml',
);
const bento = JSON.parse(fs.readFileSync(path.join(root, 'bento.json'), 'utf8'));
const ublock = JSON.parse(
  fs.readFileSync(path.join(root, 'extensions/ublock-origin/manifest.json'), 'utf8'),
);
const shellPackage = JSON.parse(
  fs.readFileSync(path.join(root, 'extensions/bento-shell/package.json'), 'utf8'),
);
const muxuiArtifact = 'artifacts/muxui/muxui-react-0.1.0-alpha.0.tgz';
const muxuiProvenance = JSON.parse(
  fs.readFileSync(path.join(root, muxuiArtifact.replace(/\.tgz$/u, '.provenance.json')), 'utf8'),
);

function readMuxuiCandidate() {
  const artifactPath = path.join(root, muxuiArtifact);
  const bytes = fs.readFileSync(artifactPath);
  const sha256 = hashBytes(bytes);
  if (muxuiProvenance.package !== '@muxui/react') {
    throw new Error('Mux UI candidate provenance names an unexpected package.');
  }
  if (muxuiProvenance.artifact !== path.basename(artifactPath)) {
    throw new Error('Mux UI candidate provenance names an unexpected artifact.');
  }
  if (!/^[0-9a-f]{40}$/.test(muxuiProvenance.sourceCommit || '')) {
    throw new Error('Mux UI candidate provenance is missing a source commit.');
  }
  if (!/^[0-9a-f]{64}$/.test(muxuiProvenance.sha256 || '')) {
    throw new Error('Mux UI candidate provenance is missing a SHA-256 digest.');
  }
  if (muxuiProvenance.sha256 !== sha256) {
    throw new Error('Mux UI candidate provenance does not match the artifact bytes.');
  }
  if (muxuiProvenance.bytes !== bytes.byteLength) {
    throw new Error('Mux UI candidate provenance does not match the artifact size.');
  }
  if (!muxuiProvenance.packCommand || muxuiProvenance.publicationPerformed !== false) {
    throw new Error('Mux UI candidate provenance is missing the pack/publication assertion.');
  }
  return { bytes, sha256 };
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function integrityFor(bytes) {
  return `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
}

const muxui = readMuxuiCandidate();

const APPROVED_SHELL_RUNTIME_DEPENDENCIES = Object.freeze({
  '@muxui/react': 'file:../../artifacts/muxui/muxui-react-0.1.0-alpha.0.tgz',
  react: '^19.0.0',
  'react-dom': '^19.0.0',
  'react-aria-components': '1.20.0',
  zustand: '^5.0.0',
  '@tanstack/react-virtual': '^3.10.0',
  'lucide-react': '^0.460.0',
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

const releaseLock = parse(fs.readFileSync(releaseLockPath, 'utf8'));
if (!releaseLock?.packages || typeof releaseLock.packages !== 'object') {
  throw new Error(`${path.basename(releaseLockPath)} does not contain a packages map.`);
}

const muxuiSource = `file:${muxuiArtifact}`;
const muxuiImporter = releaseLock.importers?.['extensions/bento-shell'];
validateShellRuntimeDependencies(
  muxuiImporter?.dependencies,
  `${path.basename(releaseLockPath)} extensions/bento-shell importer`,
);
const muxuiDependency = muxuiImporter?.dependencies?.['@muxui/react'];
const expectedImporterSpecifier = `file:${path.posix.relative('extensions/bento-shell', muxuiArtifact)}`;
const importerSpecifier = muxuiDependency?.specifier;
if (importerSpecifier !== expectedImporterSpecifier) {
  throw new Error(
    `extensions/bento-shell must resolve @muxui/react from the committed local artifact (received ${importerSpecifier || 'missing specifier'}).`,
  );
}
const importerSource = String(muxuiDependency?.version || '').split('(', 1)[0];
if (importerSource !== muxuiSource) {
  throw new Error('extensions/bento-shell @muxui/react importer resolves a different source.');
}

const muxuiLockKey = `@muxui/react@${muxuiSource}`;
const muxuiLockEntries = Object.entries(releaseLock.packages).filter(([key]) =>
  key.startsWith('@muxui/react@'),
);
if (muxuiLockEntries.length !== 1 || muxuiLockEntries[0][0] !== muxuiLockKey) {
  throw new Error(
    'pnpm-lock.release.yaml must contain exactly one local @muxui/react package entry.',
  );
}
const muxuiLockMetadata = muxuiLockEntries[0][1];
if (muxuiLockMetadata?.resolution?.tarball !== muxuiSource) {
  throw new Error(
    'pnpm-lock.release.yaml @muxui/react resolution does not point to the committed local artifact.',
  );
}
if (muxuiLockMetadata?.resolution?.integrity !== integrityFor(muxui.bytes)) {
  throw new Error(
    'pnpm-lock.release.yaml @muxui/react integrity does not match the committed artifact bytes.',
  );
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

const muxuiPackage = packages.find((component) => component.name === '@muxui/react');
if (!muxuiPackage || muxuiPackage.version !== muxuiProvenance.version) {
  throw new Error('pnpm-lock.release.yaml does not contain the committed Mux UI candidate.');
}
muxuiPackage.hashes = [{ alg: 'SHA-256', content: muxui.sha256 }];
muxuiPackage.properties = [
  { name: 'bento:artifact', value: muxuiArtifact },
  { name: 'bento:source-commit', value: muxuiProvenance.sourceCommit },
  { name: 'bento:publication-performed', value: 'false' },
  { name: 'bento:bytes', value: String(muxui.bytes.byteLength) },
];

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
