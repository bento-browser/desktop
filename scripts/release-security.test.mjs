/* global process */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const releaseGate = path.join(root, 'scripts/check-release-security.mjs');
const sbomGenerator = path.join(root, 'scripts/generate-release-sbom.mjs');
const muxuiArtifact = path.join(root, 'artifacts/muxui/muxui-react-0.1.0-alpha.0.tgz');
const muxuiProvenance = path.join(
  root,
  'artifacts/muxui/muxui-react-0.1.0-alpha.0.provenance.json',
);

test('Mux UI candidate provenance binds the committed tarball bytes', () => {
  const provenance = JSON.parse(fs.readFileSync(muxuiProvenance, 'utf8'));
  const bytes = fs.readFileSync(muxuiArtifact);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');

  assert.equal(provenance.sourceCommit, '146f75b6ecbac1ceedb7af3ffed009568bd7c9a2');
  assert.equal(provenance.package, '@muxui/react');
  assert.equal(provenance.version, '0.1.0-alpha.0');
  assert.equal(provenance.artifact, 'muxui-react-0.1.0-alpha.0.tgz');
  assert.equal(provenance.sha256, sha256);
  assert.equal(provenance.bytes, bytes.byteLength);
  assert.match(provenance.packCommand, /^pnpm --filter @muxui\/react pack /);
  assert.equal(provenance.publicationPerformed, false);
});

test('release SBOM rejects a different Mux UI lock source', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-release-sbom-source-'));
  const lockPath = path.join(tempDir, 'pnpm-lock.release.yaml');
  const outputDir = path.join(tempDir, 'output');
  try {
    const lock = parse(fs.readFileSync(path.join(root, 'pnpm-lock.release.yaml'), 'utf8'));
    const lockKey = `@muxui/react@file:${path
      .relative(root, muxuiArtifact)
      .split(path.sep)
      .join('/')}`;
    lock.packages[lockKey].resolution.tarball =
      'https://registry.npmjs.org/@muxui/react/-/react-0.1.0-alpha.0.tgz';
    fs.writeFileSync(lockPath, stringify(lock));

    const result = spawnSync(process.execPath, [sbomGenerator, outputDir], {
      cwd: root,
      env: { ...process.env, BENTO_RELEASE_LOCK_PATH: lockPath },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /resolution does not point to the committed local artifact/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('developer and release locks pin one React Aria substrate graph', () => {
  const expected = {
    '@react-types/shared': '3.36.1',
    'react-aria': '3.51.0',
    'react-aria-components': '1.20.0',
    'react-stately': '3.49.0',
  };

  for (const lockfile of ['pnpm-lock.yaml', 'pnpm-lock.release.yaml']) {
    const lock = parse(fs.readFileSync(path.join(root, lockfile), 'utf8'));
    assert.deepEqual(
      Object.fromEntries(Object.keys(expected).map((name) => [name, lock.overrides[name]])),
      expected,
      lockfile,
    );
    const shell = lock.importers['extensions/bento-shell'];
    assert.equal(
      shell.dependencies['@muxui/react'].specifier,
      'file:../../artifacts/muxui/muxui-react-0.1.0-alpha.0.tgz',
      lockfile,
    );
    for (const [name, version] of Object.entries(expected)) {
      assert.ok(lock.packages[`${name}@${version}`], `${lockfile}: missing ${name}@${version}`);
    }
    assert.doesNotMatch(JSON.stringify(lock), /react-aria-components@1\.19\.0/);
    assert.doesNotMatch(JSON.stringify(lock), /react-aria@3\.50\.0/);
    assert.doesNotMatch(JSON.stringify(lock), /react-stately@3\.48\.0/);
    assert.doesNotMatch(JSON.stringify(lock), /@react-types\/shared@3\.36\.0/);
  }
});

test('developer and release locks pin the shipped Tiptap family past GHSA-j95f-988m-3j2f', () => {
  const expected = {
    '@tiptap/core': '3.31.3',
    '@tiptap/extension-image': '3.31.3',
    '@tiptap/extension-placeholder': '3.31.3',
    '@tiptap/extension-text-align': '3.31.3',
    '@tiptap/extension-text-style': '3.31.3',
    '@tiptap/extensions': '3.31.3',
    '@tiptap/pm': '3.31.3',
    '@tiptap/react': '3.31.3',
    '@tiptap/starter-kit': '3.31.3',
  };

  for (const lockfile of ['pnpm-lock.yaml', 'pnpm-lock.release.yaml']) {
    const lock = parse(fs.readFileSync(path.join(root, lockfile), 'utf8'));
    assert.deepEqual(
      Object.fromEntries(Object.keys(expected).map((name) => [name, lock.overrides[name]])),
      expected,
      lockfile,
    );
    for (const [name, version] of Object.entries(expected)) {
      assert.ok(lock.packages[`${name}@${version}`], `${lockfile}: missing ${name}@${version}`);
      assert.equal(
        Object.keys(lock.packages).some((key) => key.startsWith(`${name}@3.22.3`)),
        false,
        `${lockfile}: stale ${name}@3.22.3 remains`,
      );
    }
  }
});

test('preview releases pass while public and mismatched-tag releases stay blocked', () => {
  const preview = spawnSync(process.execPath, [releaseGate, '--channel=preview'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(preview.status, 0, preview.stderr);

  const publicRelease = spawnSync(process.execPath, [releaseGate, '--channel=public'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(publicRelease.status, 0);
  assert.match(publicRelease.stderr, /Public release is blocked/);

  const wrongTag = spawnSync(process.execPath, [releaseGate, '--channel=preview'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_REF_NAME: 'v999.0.0' },
  });
  assert.notEqual(wrongTag.status, 0);
  assert.match(wrongTag.stderr, /Release tag must be/);
});

test('release metadata covers the release-lock SBOM with valid checksums', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-release-security-'));
  try {
    execFileSync(
      process.execPath,
      [path.join(root, 'scripts/generate-release-sbom.mjs'), outputDir],
      {
        cwd: root,
      },
    );
    execFileSync(
      process.execPath,
      [path.join(root, 'scripts/generate-release-metadata.mjs'), outputDir],
      { cwd: root },
    );

    const sbom = JSON.parse(fs.readFileSync(path.join(outputDir, 'bento-sbom.cdx.json'), 'utf8'));
    assert.equal(sbom.bomFormat, 'CycloneDX');
    assert.ok(sbom.components.length > 100);
    assert.equal(
      sbom.components.some((component) => component.name.startsWith('@tale-ui/')),
      false,
    );
    const muxui = sbom.components.find((component) => component.name === '@muxui/react');
    assert.deepEqual(muxui.hashes, [
      {
        alg: 'SHA-256',
        content: '16c382ece9dea1de8bdfcae0482cf7fc511da7b8eefcc313ff8cc83200be3f4e',
      },
    ]);
    assert.equal(
      muxui.properties.find((property) => property.name === 'bento:source-commit').value,
      '146f75b6ecbac1ceedb7af3ffed009568bd7c9a2',
    );
    assert.equal(
      muxui.properties.find((property) => property.name === 'bento:publication-performed').value,
      'false',
    );
    assert.ok(sbom.components.some((component) => component.hashes?.length));
    assert.equal(
      sbom.components.some((component) =>
        /^(link:|file:|workspace:)/.test(component.version || ''),
      ),
      false,
    );

    const checksumLines = fs
      .readFileSync(path.join(outputDir, 'SHA256SUMS'), 'utf8')
      .trim()
      .split('\n');
    assert.deepEqual(checksumLines.map((line) => line.slice(66)).sort(), [
      'bento-sbom.cdx.json',
      'release-manifest.json',
    ]);
    for (const line of checksumLines) {
      const [expected, name] = line.split('  ');
      const actual = crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(outputDir, name)))
        .digest('hex');
      assert.equal(actual, expected);
    }
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
