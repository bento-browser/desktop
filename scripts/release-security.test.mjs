import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const releaseGate = path.join(root, 'scripts/check-release-security.mjs');

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
    assert.ok(sbom.components.some((component) => component.name === '@tale-ui/react'));
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
