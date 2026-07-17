#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const outputDir = path.resolve(root, process.argv[2] || 'release-out');
const surfer = JSON.parse(fs.readFileSync(path.join(root, 'surfer.json'), 'utf8'));
const ublock = JSON.parse(
  fs.readFileSync(path.join(root, 'extensions/ublock-origin/manifest.json'), 'utf8'),
);
const excluded = new Set(['SHA256SUMS', 'release-manifest.json']);

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function releaseFiles() {
  return fs
    .readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !excluded.has(entry.name))
    .map((entry) => {
      if (/\r|\n/.test(entry.name)) throw new Error('Release filenames cannot contain newlines.');
      return entry.name;
    })
    .sort();
}

const files = releaseFiles().map((name) => ({
  name,
  sha256: sha256(path.join(outputDir, name)),
  size: fs.statSync(path.join(outputDir, name)).size,
}));
if (!files.length) throw new Error('No release artifacts found.');

const manifest = {
  schemaVersion: 1,
  product: 'Bento Browser',
  displayVersion: surfer.brands.bento.release.displayVersion,
  firefoxVersion: surfer.version.version,
  ublockOriginVersion: ublock.version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  files,
};
fs.writeFileSync(
  path.join(outputDir, 'release-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const checksumFiles = [...releaseFiles(), 'release-manifest.json'].sort();
const sums = checksumFiles
  .map((name) => `${sha256(path.join(outputDir, name))}  ${name}`)
  .join('\n');
fs.writeFileSync(path.join(outputDir, 'SHA256SUMS'), `${sums}\n`);
console.log(`Wrote release manifest and checksums for ${checksumFiles.length} files.`);
