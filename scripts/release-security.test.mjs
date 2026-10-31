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
const lockfile = 'pnpm-lock.yaml';
const muxuiVersion = '0.1.0-rc.4';
const muxuiIntegrity =
  'sha512-9XRnBRYCvSN7quvfL8nNMtNLRV9NMriSmjjGwP8Ja7w90CycxfKCp4xykxRlrWDLWnQgs8086vJ70KKD7BkVtA==';
const approvedShellRuntimeDependencies = {
  '@muxui/react': muxuiVersion,
  react: '^19.2.0',
  'react-dom': '^19.2.0',
  zustand: '^5.0.0',
  '@tanstack/react-virtual': '^3.10.0',
  'lucide-react': '1.37.0',
  'emojibase-data': '17.0.0',
};

test('release SBOM rejects a different Mux UI source or integrity', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-release-sbom-source-'));
  const lockPath = path.join(tempDir, lockfile);
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
      const lock = parse(fs.readFileSync(path.join(root, lockfile), 'utf8'));
      lock.packages[`@muxui/react@${muxuiVersion}`].resolution[field] = value;
      fs.writeFileSync(lockPath, stringify(lock));
      const result = spawnSync(process.execPath, [sbomGenerator, outputDir], {
        cwd: root,
        env: { ...process.env, BENTO_LOCK_PATH: lockPath },
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
  const lockPath = path.join(tempDir, lockfile);
  const outputDir = path.join(tempDir, 'output');
  try {
    const lock = parse(fs.readFileSync(path.join(root, lockfile), 'utf8'));
    lock.importers['extensions/bento-shell'].dependencies['neutral-runtime-sample'] = {
      specifier: '1.0.0',
      version: '1.0.0',
    };
    fs.writeFileSync(lockPath, stringify(lock));

    const result = spawnSync(process.execPath, [sbomGenerator, outputDir], {
      cwd: root,
      env: { ...process.env, BENTO_LOCK_PATH: lockPath },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /approved Bento shell runtime dependencies/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('the lockfile pins one React Aria substrate graph', () => {
  const expected = {
    '@react-types/shared': '3.36.1',
    'react-aria': '3.51.0',
    'react-aria-components': '1.20.0',
    'react-stately': '3.49.0',
  };

  const lock = parse(fs.readFileSync(path.join(root, lockfile), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((name) => [name, lock.overrides[name]])),
    expected,
  );
  const shell = lock.importers['extensions/bento-shell'];
  assert.equal(shell.dependencies['@muxui/react'].specifier, muxuiVersion);
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
    assert.ok(lock.packages[`${name}@${version}`], `missing ${name}@${version}`);
  }
  assert.doesNotMatch(JSON.stringify(lock), /react-aria-components@1\.19\.0/);
  assert.doesNotMatch(JSON.stringify(lock), /react-aria@3\.50\.0/);
  assert.doesNotMatch(JSON.stringify(lock), /react-stately@3\.48\.0/);
  assert.doesNotMatch(JSON.stringify(lock), /@react-types\/shared@3\.36\.0/);
});

test('the lockfile pins the shipped Tiptap family past GHSA-j95f-988m-3j2f', () => {
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

  const lock = parse(fs.readFileSync(path.join(root, lockfile), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(Object.keys(expected).map((name) => [name, lock.overrides[name]])),
    expected,
  );
  for (const [name, version] of Object.entries(expected)) {
    assert.ok(lock.packages[`${name}@${version}`], `missing ${name}@${version}`);
    assert.equal(
      Object.keys(lock.packages).some((key) => key.startsWith(`${name}@3.22.3`)),
      false,
      `stale ${name}@3.22.3 remains`,
    );
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

/** Runs the release gate against a temporary copy of bento.json and release-security.json. */
function gateWith({ channel = 'preview', bento = () => {}, security = () => {} }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-release-gate-'));
  try {
    const bentoJson = JSON.parse(fs.readFileSync(path.join(root, 'bento.json'), 'utf8'));
    const securityJson = JSON.parse(fs.readFileSync(path.join(root, 'config/release-security.json'), 'utf8'));
    bento(bentoJson);
    security(securityJson);
    fs.mkdirSync(path.join(tempDir, 'config'));
    fs.writeFileSync(path.join(tempDir, 'bento.json'), JSON.stringify(bentoJson));
    fs.writeFileSync(path.join(tempDir, 'config/release-security.json'), JSON.stringify(securityJson));
    return spawnSync(process.execPath, [releaseGate, `--channel=${channel}`, `--root=${tempDir}`], {
      cwd: root,
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const readyUpdater = (security) => {
  Object.assign(security.updateService, {
    marSigningKeyFingerprint: 'c'.repeat(64),
    updaterCertificateFingerprint: 'C'.repeat(64),
    hostCompiledIn: true,
    isolatedRoundTripVerified: true,
  });
};
const enableUpdates = (bento) => {
  bento.updates.enabled = true;
};

test('the repository ships with the updater disabled and its readiness inputs unset', () => {
  const bento = JSON.parse(fs.readFileSync(path.join(root, 'bento.json'), 'utf8'));
  assert.equal(bento.updates.enabled, false);
  const security = JSON.parse(fs.readFileSync(path.join(root, 'config/release-security.json'), 'utf8'));
  assert.deepEqual(security.updateService, {
    hostname: bento.updates.hostname,
    marSigningKeyFingerprint: '',
    updaterCertificateFingerprint: '',
    hostCompiledIn: false,
    isolatedRoundTripVerified: false,
  });
});

test('the release gate refuses to enable the updater until every readiness input is recorded', () => {
  const disabled = gateWith({});
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /updater disabled/);

  for (const channel of ['preview', 'public']) {
    const unready = gateWith({ channel, bento: enableUpdates });
    assert.notEqual(unready.status, 0, channel);
    assert.match(unready.stderr, /updates\.enabled is true, but the updater is not ready/);
    for (const input of [
      'marSigningKeyFingerprint',
      'updaterCertificateFingerprint',
      'hostCompiledIn',
      'isolatedRoundTripVerified',
    ]) {
      assert.match(unready.stderr, new RegExp(input), `${channel} names ${input}`);
    }
  }

  const ready = gateWith({ bento: enableUpdates, security: readyUpdater });
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /updater enabled/);

  for (const [name, edit, message] of [
    ['a certificate other than the signing key', (security) => { security.updateService.updaterCertificateFingerprint = 'd'.repeat(64); }, /updaterCertificateFingerprint must equal/],
    ['an unrecorded host', (security) => { security.updateService.hostCompiledIn = false; }, /hostCompiledIn/],
    ['no isolated round trip', (security) => { security.updateService.isolatedRoundTripVerified = false; }, /isolatedRoundTripVerified/],
    ['a malformed signing fingerprint', (security) => { security.updateService.marSigningKeyFingerprint = 'abc'; }, /marSigningKeyFingerprint must be the SHA-256/],
  ]) {
    const result = gateWith({
      bento: enableUpdates,
      security: (security) => {
        readyUpdater(security);
        edit(security);
      },
    });
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, message, name);
  }

  // Mozilla's channel names compile Mozilla's update certificates into the updater,
  // and configure lowercases the channel first, so case and padding do not escape this.
  for (const channel of ['release', 'Release', 'NIGHTLY', ' nightly ']) {
    const mozillaChannel = gateWith({
      bento: (bento) => {
        enableUpdates(bento);
        bento.updates.channel = channel;
      },
      security: readyUpdater,
    });
    assert.notEqual(mozillaChannel.status, 0, JSON.stringify(channel));
    assert.match(mozillaChannel.stderr, /must be a Bento-owned channel/, JSON.stringify(channel));
  }

  const malformed = gateWith({ bento: (bento) => { bento.updates.enabled = 'yes'; } });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /updates\.enabled must be true or false/);
});

test('a public release also needs the updater enabled, not only the signing identities', () => {
  const identities = (security) => {
    security.publicReleaseReady = true;
    security.updateService.marSigningKeyFingerprint = 'c'.repeat(64);
    security.platformSigning = {
      linuxManifestKeyFingerprint: 'e'.repeat(64),
      macosDeveloperIdTeam: 'ABCDE12345',
      windowsCertificateThumbprint: 'f'.repeat(40),
    };
  };
  const updaterOff = gateWith({ channel: 'public', security: identities });
  assert.notEqual(updaterOff.status, 0);
  assert.match(updaterOff.stderr, /Public release is blocked until .*bento\.json updates\.enabled/);

  const updaterOn = gateWith({
    channel: 'public',
    bento: enableUpdates,
    security: (security) => {
      identities(security);
      readyUpdater(security);
      security.updateService.marSigningKeyFingerprint = 'c'.repeat(64);
    },
  });
  assert.equal(updaterOn.status, 0, updaterOn.stderr);
  assert.match(updaterOn.stdout, /Public release security gate passed/);
});

test('release metadata covers the lockfile SBOM with valid checksums', () => {
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
