/* global Buffer, process */

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
const muxuiVersion = '0.1.0-rc.1';
const muxuiIntegrity =
  'sha512-J7MB0roUffNcwygIxEO1KmTR0vW5Eh5IY1naCOahJjDsYMlR/OIp1QGzHs2zWCP/DQo4dDUnTHVZwzoCYgefJQ==';
const approvedShellRuntimeDependencies = {
  '@muxui/react': muxuiVersion,
  react: '^19.0.0',
  'react-dom': '^19.0.0',
  zustand: '^5.0.0',
  '@tanstack/react-virtual': '^3.10.0',
  'lucide-react': '^0.460.0',
  'emojibase-data': '17.0.0',
};

test('release SBOM rejects a different Mux UI source or integrity', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-release-sbom-source-'));
  const lockPath = path.join(tempDir, 'pnpm-lock.release.yaml');
  const outputDir = path.join(tempDir, 'output');
  try {
    for (const [field, value, message] of [
      [
        'tarball',
        'file:unapproved-package.tgz',
        /resolution does not point to the published npm package/,
      ],
      [
        'tarball',
        'https://example.com/react.tgz',
        /resolution does not point to the published npm package/,
      ],
      [
        'integrity',
        `sha512-${Buffer.alloc(64).toString('base64')}`,
        /integrity does not match the published npm package/,
      ],
    ]) {
      const lock = parse(fs.readFileSync(path.join(root, 'pnpm-lock.release.yaml'), 'utf8'));
      lock.packages[`@muxui/react@${muxuiVersion}`].resolution[field] = value;
      fs.writeFileSync(lockPath, stringify(lock));
      const result = spawnSync(process.execPath, [sbomGenerator, outputDir], {
        cwd: root,
        env: { ...process.env, BENTO_RELEASE_LOCK_PATH: lockPath },
        encoding: 'utf8',
      });
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, message);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('release SBOM rejects an unapproved shell runtime dependency', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-release-sbom-dependency-'));
  const lockPath = path.join(tempDir, 'pnpm-lock.release.yaml');
  const outputDir = path.join(tempDir, 'output');
  try {
    const lock = parse(fs.readFileSync(path.join(root, 'pnpm-lock.release.yaml'), 'utf8'));
    lock.importers['extensions/bento-shell'].dependencies['neutral-runtime-sample'] = {
      specifier: '1.0.0',
      version: '1.0.0',
    };
    fs.writeFileSync(lockPath, stringify(lock));

    const result = spawnSync(process.execPath, [sbomGenerator, outputDir], {
      cwd: root,
      env: { ...process.env, BENTO_RELEASE_LOCK_PATH: lockPath },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /approved Bento shell runtime dependencies/);
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
    assert.equal(shell.dependencies['@muxui/react'].specifier, muxuiVersion, lockfile);
    assert.equal(
      lock.packages[`@muxui/react@${muxuiVersion}`]?.resolution?.integrity,
      muxuiIntegrity,
    );
    assert.equal(
      Object.keys(lock.packages).filter((key) => key.startsWith('@muxui/react@')).length,
      1,
    );
    assert.equal('react-aria-components' in shell.dependencies, false);
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
    '@tiptap/core': '3.31.4',
    '@tiptap/extension-image': '3.31.4',
    '@tiptap/extension-placeholder': '3.31.4',
    '@tiptap/extension-text-align': '3.31.4',
    '@tiptap/extension-text-style': '3.31.4',
    '@tiptap/extensions': '3.31.4',
    '@tiptap/pm': '3.31.4',
    '@tiptap/react': '3.31.4',
    '@tiptap/starter-kit': '3.31.4',
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
    for (const dependencyName of Object.keys(approvedShellRuntimeDependencies)) {
      assert.ok(
        sbom.components.some((component) => component.name === dependencyName),
        `SBOM is missing approved shell runtime dependency ${dependencyName}`,
      );
    }
    const muxui = sbom.components.find((component) => component.name === '@muxui/react');
    assert.equal(muxui.version, muxuiVersion);
    assert.deepEqual(muxui.hashes, [
      { alg: 'SHA-512', content: Buffer.from(muxuiIntegrity.slice(7), 'base64').toString('hex') },
    ]);
    assert.equal(muxui.purl, `pkg:npm/%40muxui/react@${muxuiVersion}`);
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

test('--built-shell fails while a built shell or imported manifest still has the reload command', () => {
  const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-built-shell-'));
  const check = () =>
    spawnSync(process.execPath, [releaseGate, '--built-shell'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, BENTO_REPO_ROOT: buildRoot },
    });
  const write = (relative, text) => {
    const file = path.join(buildRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  try {
    assert.match(check().stderr, /needs a built shell/);

    write('extensions/bento-shell/dist/assets/background.js', '(()=>{})()');
    const clean = check();
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /no dev-only reload command/);

    write('engine/browser/extensions/bento-shell/manifest.json', '{"commands":{"dev-reload":{}}}');
    const imported = check();
    assert.notEqual(imported.status, 0);
    assert.match(imported.stderr, /engine\/browser\/extensions\/bento-shell\/manifest\.json/);

    write('engine/browser/extensions/bento-shell/manifest.json', '{}');
    write('extensions/bento-shell/dist/assets/background.js', 'c==="dev-reload"');
    const bundle = check();
    assert.notEqual(bundle.status, 0);
    assert.match(bundle.stderr, /extensions\/bento-shell\/dist\/assets\/background\.js/);
  } finally {
    fs.rmSync(buildRoot, { recursive: true, force: true });
  }
});
