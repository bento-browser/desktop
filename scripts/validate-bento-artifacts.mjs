#!/usr/bin/env node
/* global process */

/**
 * Validate the package outputs produced by Bento's direct mach wrapper.
 * This intentionally checks metadata against the bytes on disk so a release
 * job cannot pass with an application package and an unrelated MAR/XML set.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readApplicationBuildId, updateMarUrl } from './bento-build.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');

function fail(message) {
  throw new Error(`validate-bento-artifacts: ${message}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

function sha512(file) {
  return crypto.createHash('sha512').update(fs.readFileSync(file)).digest('hex');
}

function walkFiles(root, current = root) {
  if (!fs.existsSync(current)) return [];
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) return walkFiles(root, target);
    return entry.isFile() ? [path.relative(root, target)] : [];
  });
}

function isPrimaryApplicationPackage(file, displayVersion) {
  const name = path.basename(file);
  const prefix = `bento-${displayVersion}.`;
  if (!name.startsWith(prefix)) return false;
  const suffix = name.slice(prefix.length);
  if (suffix.endsWith('.dmg') || suffix.endsWith('.tar.bz2') || suffix.endsWith('.tar.xz') || suffix.endsWith('.installer.exe')) {
    return true;
  }
  if (!suffix.endsWith('.zip')) return false;
  const parts = suffix.split('.');
  return parts.length === 3 && parts[1].startsWith('win') && parts[1].length > 3;
}

function packagedApplicationBuildId(manifest, root, application) {
  if (!manifest.applicationIni || !manifest.buildId) fail('artifact metadata is missing the packaged application.ini/build ID');
  const applicationIni = path.resolve(root, manifest.applicationIni);
  const relative = path.relative(root, applicationIni);
  if (path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === '..') {
    fail(`packaged application.ini escapes the repository: ${manifest.applicationIni}`);
  }
  if (!fs.existsSync(applicationIni) || !fs.statSync(applicationIni).isFile()) fail(`packaged application.ini is missing: ${manifest.applicationIni}`);
  const expected = path.basename(application).endsWith('.app')
    ? path.join(application, 'Contents', 'Resources', 'application.ini')
    : path.join(application, 'application.ini');
  if (path.resolve(applicationIni) !== path.resolve(expected)) {
    fail('packaged application.ini is not the one inside the application');
  }
  const buildId = readApplicationBuildId(fs.readFileSync(applicationIni, 'utf8'));
  if (!buildId) fail(`packaged application.ini has no [App] BuildID: ${manifest.applicationIni}`);
  if (manifest.buildId !== buildId) fail('manifest build ID does not match the packaged application');
  return buildId;
}

function parseUpdateXml(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const update = xml.match(/<update\b[^>]*>/)?.[0];
  const patch = xml.match(/<patch\b[^>]*>/)?.[0];
  if (!update || !patch) fail(`${file} is missing update/patch metadata`);
  const attribute = (source, name) => source.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  return {
    displayVersion: attribute(update, 'displayVersion'),
    appVersion: attribute(update, 'appVersion'),
    platformVersion: attribute(update, 'platformVersion'),
    buildId: attribute(update, 'buildID'),
    url: attribute(patch, 'URL'),
    hashFunction: attribute(patch, 'hashFunction'),
    hashValue: attribute(patch, 'hashValue'),
    size: Number(attribute(patch, 'size')),
  };
}

function assertMarContents(manifest, root) {
  const marPath = path.resolve(root, manifest.mar.path);
  const marTool = path.resolve(root, manifest.marTool);
  if (!fs.existsSync(marPath)) fail(`MAR is missing: ${manifest.mar.path}`);
  if (!fs.existsSync(marTool)) fail(`MAR tool is missing: ${manifest.marTool}`);
  const result = spawnSync(marTool, ['-t', marPath], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) fail(`MAR listing failed: ${result.stderr || result.stdout || 'unknown error'}`);
  const hasPrecomplete = result.stdout.split(/\r?\n/).some((entry) => {
    const fields = entry.split('\t');
    if (fields.length < 3) return false;
    const name = fields.slice(2).join('\t').trim();
    return name === 'precomplete' || name === 'Contents/Resources/precomplete';
  });
  if (!hasPrecomplete) {
    fail('MAR does not contain the updater precomplete marker');
  }
  return { marPath, marHash: sha512(marPath), marSize: fs.statSync(marPath).size };
}

export function validateArtifacts(repoRoot = DEFAULT_ROOT) {
  const root = path.resolve(repoRoot);
  const config = readJson(path.join(root, 'bento.json'));
  const manifest = readJson(path.join(root, 'dist', 'bento-artifacts.json'));
  const release = config.brands?.[config.brand]?.release;
  if (!release || manifest.schemaVersion !== 1) fail('invalid Bento artifact/config metadata');
  if (manifest.displayVersion !== release.displayVersion || manifest.firefoxVersion !== config.firefox.version) {
    fail('artifact versions do not match bento.json');
  }
  if (path.basename(manifest.mar.path) !== 'output.mar') fail('MAR metadata path must be dist/output.mar');
  if (!manifest.mar.name || !manifest.mar.url || !manifest.marTool || !manifest.application) fail('artifact metadata is incomplete');

  const { marPath, marHash, marSize } = assertMarContents(manifest, root);
  if (manifest.mar.url.endsWith('/') || !manifest.mar.url.endsWith(`/${manifest.mar.name}`)) {
    fail('MAR URL does not use the declared MAR filename');
  }
  if (manifest.mar.url !== updateMarUrl(config, manifest.mar.name)) {
    fail('MAR URL does not match the configured release URL');
  }

  const application = path.resolve(root, manifest.application);
  if (!fs.existsSync(application) || !fs.statSync(application).isDirectory()) fail(`application bundle is missing: ${manifest.application}`);
  if (!walkFiles(application).some((file) => path.basename(file) === 'precomplete')) fail('application bundle is missing precomplete');

  if (!manifest.objDist) fail('artifact metadata is missing objDist');
  const objDist = path.resolve(root, manifest.objDist);
  const packages = walkFiles(objDist).filter((file) => isPrimaryApplicationPackage(file, release.displayVersion));
  if (packages.length === 0) fail(`no primary application package found under ${path.relative(root, objDist)}`);
  const packagedId = packagedApplicationBuildId(manifest, root, application);

  const targets = [...new Set(manifest.updateTargets || [])];
  if (targets.length === 0) fail('artifact metadata has no browser update targets');
  for (const target of targets) {
    const file = path.join(root, 'dist', 'update', 'browser', target, config.updates.channel, 'update.xml');
    if (!fs.existsSync(file)) fail(`browser update metadata is missing: ${path.relative(root, file)}`);
    const update = parseUpdateXml(file);
    if (update.displayVersion !== release.displayVersion || update.appVersion !== release.displayVersion) fail(`${file} has the wrong Bento version`);
    if (update.platformVersion !== config.firefox.version) fail(`${file} has the wrong Firefox platform version`);
    if (update.url !== manifest.mar.url || update.hashFunction !== 'sha512' || update.hashValue !== marHash || update.size !== marSize) {
      fail(`${file} does not describe the produced MAR bytes`);
    }
    if (update.buildId !== packagedId) fail(`${file} build ID does not match the packaged application`);
  }

  const result = { mar: path.relative(root, marPath), marSize, updateTargets: targets, packages };
  process.stdout.write(`validate-bento-artifacts: verified ${result.mar}, ${targets.length} update target(s), and ${packages.length} package(s)\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    validateArtifacts(process.argv[2] || DEFAULT_ROOT);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
