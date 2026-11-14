/* global Buffer, process */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';

import { publishReadinessProblems, updaterReadinessProblems } from './update-readiness.mjs';

const root = path.resolve(import.meta.dirname, '..');
const releaseGate = path.join(root, 'scripts/check-release-security.mjs');
const sbomGenerator = path.join(root, 'scripts/generate-release-sbom.mjs');
const lockfile = 'pnpm-lock.yaml';
const muxuiVersion = '0.1.0-rc.6';
const muxuiIntegrity =
  'sha512-MJzCOYP8UDQ49A6DwdD/7x4Qo6vfAFVcH67/1UHMHJnQW7c1zMLCC0kZ2bS9RAkkHjvHP+vDmJkSFQJvWZZ6VA==';
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

/**
 * Runs the release gate against a temporary copy of bento.json, release-security.json,
 * the committed update certificates and patches/series.json. `tree` edits the copy
 * before the run.
 */
function gateWith({ channel = 'preview', bento = () => {}, security = () => {}, series = () => {}, tree = () => {} }) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-release-gate-'));
  try {
    const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const bentoJson = readJson('bento.json');
    const securityJson = readJson('config/release-security.json');
    const seriesJson = readJson('patches/series.json');
    bento(bentoJson);
    security(securityJson);
    series(seriesJson);
    fs.mkdirSync(path.join(tempDir, 'config'));
    fs.mkdirSync(path.join(tempDir, 'patches'));
    fs.cpSync(path.join(root, 'branding/bento/update-certificates'), path.join(tempDir, 'branding/bento/update-certificates'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'bento.json'), JSON.stringify(bentoJson));
    fs.writeFileSync(path.join(tempDir, 'config/release-security.json'), JSON.stringify(securityJson));
    fs.writeFileSync(path.join(tempDir, 'patches/series.json'), JSON.stringify(seriesJson));
    tree(tempDir);
    return spawnSync(process.execPath, [releaseGate, `--channel=${channel}`, `--root=${tempDir}`], {
      cwd: root,
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

const enableUpdates = (bento) => {
  bento.updates.enabled = true;
};
const sha256Of = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const primary = 'branding/bento/update-certificates/primary.der';
const secondary = 'branding/bento/update-certificates/secondary.der';

test('the repository ships with the updater disabled and its trust anchors committed', () => {
  const bento = JSON.parse(fs.readFileSync(path.join(root, 'bento.json'), 'utf8'));
  assert.equal(bento.updates.enabled, false);
  assert.equal(bento.updates.channel, 'bento');
  assert.deepEqual(bento.brands.bento.release.platforms, ['macos']);
  const security = JSON.parse(fs.readFileSync(path.join(root, 'config/release-security.json'), 'utf8'));
  assert.equal(security.publicReleaseReady, false);
  assert.deepEqual(security.updateService, {
    hostname: bento.updates.hostname,
    marSigningKeyFingerprint: sha256Of(primary),
    updaterCertificateFingerprint: sha256Of(primary),
    backupCertificateFingerprint: sha256Of(secondary),
    signingNickname: 'bento-mar-a',
    isolatedRoundTripVerified: false,
  });
  // The structural inputs already hold; only the signed update path is missing.
  assert.deepEqual(updaterReadinessProblems(bento, security, root), []);
  assert.deepEqual(security.platformSigning, {
    linuxManifestKeyFingerprint: '',
    macosDeveloperIdTeam: '',
    windowsCertificateThumbprint: '',
  });
});

test('the release gate refuses to enable the updater until its structural inputs hold', () => {
  const disabled = gateWith({});
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /updater disabled/);

  const ready = gateWith({ bento: enableUpdates });
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /updater enabled/);

  const wrongDigest = 'd'.repeat(64);
  const cases = [
    ['no signing fingerprint', { security: (security) => { security.updateService.marSigningKeyFingerprint = ''; } }, /marSigningKeyFingerprint must be the lowercase SHA-256 of branding\/bento\/update-certificates\/primary\.der/],
    ['a compiled certificate other than the signing key', { security: (security) => { security.updateService.updaterCertificateFingerprint = wrongDigest; } }, /updaterCertificateFingerprint must be the lowercase SHA-256/],
    ['a backup fingerprint of the primary certificate', { security: (security) => { security.updateService.backupCertificateFingerprint = sha256Of(primary); } }, /backupCertificateFingerprint must be the lowercase SHA-256 of branding\/bento\/update-certificates\/secondary\.der/],
    ['an uppercase fingerprint', { security: (security) => { security.updateService.marSigningKeyFingerprint = sha256Of(primary).toUpperCase(); } }, /marSigningKeyFingerprint must be the lowercase SHA-256/],
    ['a changed certificate file', { tree: (dir) => fs.appendFileSync(path.join(dir, primary), 'x') }, /marSigningKeyFingerprint must be the lowercase SHA-256/],
    ['a missing certificate file', { tree: (dir) => fs.rmSync(path.join(dir, secondary)) }, /secondary\.der is missing/],
    ['a series without the host patch', { series: (series) => { series.series = series.series.filter((entry) => !entry.path.includes('03-appupdate-host')); } }, /patches\/experiments\/03-appupdate-host-configure\.patch must be listed in patches\/series\.json/],
    ['a series without the certificate patch', { series: (series) => { series.series = series.series.filter((entry) => !entry.path.includes('04-updater-bento')); } }, /patches\/experiments\/04-updater-bento-certificates\.patch must be listed in patches\/series\.json/],
    ['an invalid host', { bento: (bento) => { bento.updates.hostname = 'https://Updates.example'; }, security: (security) => { security.updateService.hostname = 'https://Updates.example'; } }, /updates\.hostname .* must be a bare lowercase hostname/],
  ];
  for (const channel of ['preview', 'public']) {
    for (const [name, edits, message] of cases) {
      const result = gateWith({ channel, ...edits, bento: (bento) => { enableUpdates(bento); edits.bento?.(bento); } });
      assert.notEqual(result.status, 0, `${channel}: ${name}`);
      assert.match(result.stderr, /updates\.enabled is true, but the updater is not ready/, `${channel}: ${name}`);
      assert.match(result.stderr, message, `${channel}: ${name}`);
    }
  }

  // Mozilla's channel names compile Mozilla's update certificates into the updater, configure
  // lowercases the channel first, and any other name falls back to Mozilla's dep1.der, so only "bento" passes.
  for (const channel of ['release', 'Release', 'NIGHTLY', ' nightly ', 'Bento', 'bento-beta', '']) {
    const wrongChannel = gateWith({
      bento: (bento) => {
        enableUpdates(bento);
        bento.updates.channel = channel;
      },
    });
    assert.notEqual(wrongChannel.status, 0, JSON.stringify(channel));
    assert.match(wrongChannel.stderr, /must be exactly "bento"/, JSON.stringify(channel));
  }

  const malformed = gateWith({ bento: (bento) => { bento.updates.enabled = 'yes'; } });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /updates\.enabled must be true or false/);
});

test('release.platforms names the shipped platforms, each checked by the preview and public gates', () => {
  for (const platforms of [undefined, [], ['macos', 'macos'], ['macos', 'beos'], ['constructor'], 'macos']) {
    for (const channel of ['preview', 'public']) {
      const result = gateWith({ channel, bento: (bento) => { bento.brands.bento.release.platforms = platforms; } });
      assert.notEqual(result.status, 0, `${channel} ${JSON.stringify(platforms)}`);
      assert.match(result.stderr, /release\.platforms must list each shipped platform once, from macos, linux, windows/);
    }
  }
});

const roundTrip = {
  date: '2026-11-20',
  fromVersion: '0.0.2',
  toVersion: '0.0.3',
  buildIds: { from: '20261120010000', to: '20261120020000' },
  marSha256: 'e'.repeat(64),
  host: 'updates-test.example.invalid',
};
const macosIdentity = (security) => {
  security.publicReleaseReady = true;
  security.platformSigning.macosDeveloperIdTeam = 'ABCDE12345';
};
const recordRoundTrip = (security) => {
  security.updateService.isolatedRoundTripVerified = true;
  security.updateService.roundTrip = roundTrip;
};

test('a public release needs the updater, the identity of each shipped platform and a recorded round trip', () => {
  const withUpdater = { channel: 'public', bento: enableUpdates };
  // Without the updater, the macOS identity alone is not enough.
  const updaterOff = gateWith({ channel: 'public', security: (security) => { macosIdentity(security); recordRoundTrip(security); } });
  assert.notEqual(updaterOff.status, 0);
  assert.match(updaterOff.stderr, /Public release is blocked until .*bento\.json updates\.enabled/);

  // Only the platforms listed in release.platforms need an identity: Linux and Windows are empty here.
  const noRoundTrip = gateWith({ ...withUpdater, security: macosIdentity });
  assert.notEqual(noRoundTrip.status, 0);
  assert.doesNotMatch(noRoundTrip.stderr, /linuxManifestKeyFingerprint|windowsCertificateThumbprint/);
  assert.match(noRoundTrip.stderr, /Public release is blocked until the update round trip is recorded/);
  assert.match(noRoundTrip.stderr, /isolatedRoundTripVerified/);

  const attestationOnly = gateWith({ ...withUpdater, security: (security) => { macosIdentity(security); security.updateService.isolatedRoundTripVerified = true; } });
  assert.notEqual(attestationOnly.status, 0);
  assert.match(attestationOnly.stderr, /updateService\.roundTrip must record the round trip as/);

  const ready = gateWith({ ...withUpdater, security: (security) => { macosIdentity(security); recordRoundTrip(security); } });
  assert.equal(ready.status, 0, ready.stderr);
  assert.match(ready.stdout, /Public release security gate passed/);

  const notReady = gateWith({ ...withUpdater, security: (security) => { macosIdentity(security); recordRoundTrip(security); security.publicReleaseReady = false; } });
  assert.match(notReady.stderr, /Public release is blocked until .*publicReleaseReady/);

  const badTeam = gateWith({ ...withUpdater, security: (security) => { macosIdentity(security); recordRoundTrip(security); security.platformSigning.macosDeveloperIdTeam = 'abc'; } });
  assert.match(badTeam.stderr, /macOS Developer ID team must be a ten-character team identifier/);

  // A platform added to release.platforms is asked for its own identity, in its own format.
  const withLinux = (security) => { macosIdentity(security); recordRoundTrip(security); };
  const linuxListed = (bento) => { enableUpdates(bento); bento.brands.bento.release.platforms = ['macos', 'linux']; };
  const missingLinux = gateWith({ channel: 'public', bento: linuxListed, security: withLinux });
  assert.match(missingLinux.stderr, /Public release is blocked until .*platformSigning\.linuxManifestKeyFingerprint/);
  const badLinux = gateWith({ channel: 'public', bento: linuxListed, security: (security) => { withLinux(security); security.platformSigning.linuxManifestKeyFingerprint = 'abc'; } });
  assert.match(badLinux.stderr, /Linux manifest key fingerprint must be a SHA-256 hex digest/);
  const goodLinux = gateWith({ channel: 'public', bento: linuxListed, security: (security) => { withLinux(security); security.platformSigning.linuxManifestKeyFingerprint = 'f'.repeat(64); } });
  assert.equal(goodLinux.status, 0, goodLinux.stderr);
});

test('publish readiness binds the recorded round trip to one exact artifact', () => {
  const artifact = { version: '0.0.3', buildId: '20261120020000', marSha256: 'e'.repeat(64) };
  const security = (change = {}) => ({ updateService: { isolatedRoundTripVerified: true, roundTrip, ...change } });

  assert.deepEqual(publishReadinessProblems(security()), []);
  assert.deepEqual(publishReadinessProblems(security(), artifact), []);
  assert.match(publishReadinessProblems({})[0], /isolatedRoundTripVerified must be true/);
  assert.match(publishReadinessProblems(security({ isolatedRoundTripVerified: false }))[0], /isolatedRoundTripVerified must be true/);
  for (const incomplete of [undefined, {}, { ...roundTrip, buildIds: { from: '20261120010000' } }, { ...roundTrip, marSha256: 'abc' }, { ...roundTrip, host: '' }]) {
    assert.match(publishReadinessProblems(security({ roundTrip: incomplete }))[0], /roundTrip must record the round trip as/);
  }
  assert.match(publishReadinessProblems(security(), { ...artifact, version: '0.0.4' }).join('\n'), /is for version 0\.0\.3, not 0\.0\.4/);
  assert.match(publishReadinessProblems(security(), { ...artifact, buildId: '20261121000000' }).join('\n'), /updated to build 20261120020000, not 20261121000000/);
  assert.match(publishReadinessProblems(security(), { ...artifact, marSha256: 'a'.repeat(64) }).join('\n'), /different MAR/);
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
