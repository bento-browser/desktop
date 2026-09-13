#!/usr/bin/env node
/* global process */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');
const MANIFEST_VERSION = 1;

function repoContext(repoRoot = DEFAULT_ROOT) {
  const root = path.resolve(repoRoot);
  return {
    root,
    source: path.join(root, 'src'),
    engine: path.join(root, 'engine'),
    state: path.join(root, '.bento'),
    manifest: path.join(root, '.bento', 'import-manifest.json'),
    config: path.join(root, 'bento.json'),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function safeRelative(relative) {
  const normalized = relative.split(path.sep).join('/');
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`import-sources: unsafe overlay path ${relative}`);
  }
  return normalized;
}

function listFiles(root, current = root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).flatMap((entry) => {
    const absolute = path.join(current, entry.name);
    const relative = safeRelative(path.relative(root, absolute));
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`import-sources: source overlays must not contain symlinks: ${relative}`);
    if (stat.isDirectory()) return listFiles(root, absolute);
    if (stat.isFile()) return [{ absolute, relative }];
    throw new Error(`import-sources: unsupported source entry ${relative}`);
  });
}

function loadManifest(ctx) {
  if (!fs.existsSync(ctx.manifest)) return { schemaVersion: MANIFEST_VERSION, entries: [] };
  const manifest = readJson(ctx.manifest);
  if (manifest.schemaVersion !== MANIFEST_VERSION || !Array.isArray(manifest.entries)) {
    throw new Error(`import-sources: invalid ${path.relative(ctx.root, ctx.manifest)}`);
  }
  return manifest;
}

function config(ctx) {
  const value = readJson(ctx.config);
  if (value.schemaVersion !== 1 || !value.build) throw new Error('import-sources: invalid bento.json');
  return value;
}

function isOwnedDestination(target, oldEntry) {
  if (!fs.existsSync(target) && !fs.lstatSync(target, { throwIfNoEntry: false })) return true;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) {
    return fs.readlinkSync(target) === oldEntry.linkTarget;
  }
  return stat.isFile() && oldEntry.destinationSha256 && hashFile(target) === oldEntry.destinationSha256;
}

function isExpectedOverlay(target, entry) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return fs.readlinkSync(target) === entry.sourceAbsolute;
  return stat.isFile() && hashFile(target) === hashFile(entry.sourceAbsolute);
}

function targetExists(target) {
  return fs.existsSync(target) || Boolean(fs.lstatSync(target, { throwIfNoEntry: false }));
}

function preflight(ctx, previous, current) {
  const wanted = new Set(current.map((entry) => entry.destination));
  const previousByDestination = new Map(previous.entries.map((entry) => [entry.destination, entry]));
  const targets = new Set(current.map((entry) => entry.destination));
  for (const oldEntry of previous.entries) {
    if (wanted.has(oldEntry.destination)) continue;
    const target = path.join(ctx.engine, oldEntry.destination);
    if (!targetExists(target)) continue;
    if (!isOwnedDestination(target, oldEntry)) {
      throw new Error(`import-sources: stale overlay ${oldEntry.destination} is user-owned; refusing to remove it`);
    }
    targets.add(oldEntry.destination);
  }
  for (const entry of current) {
    const target = path.join(ctx.engine, entry.destination);
    const oldEntry = previousByDestination.get(entry.destination);
    if (targetExists(target) && oldEntry && !isOwnedDestination(target, oldEntry)) {
      throw new Error(`import-sources: overlay target ${entry.destination} has uncommitted user changes; refusing to overwrite it`);
    }
    if (targetExists(target) && !oldEntry && !isExpectedOverlay(target, entry)) {
      throw new Error(`import-sources: preexisting overlay target ${entry.destination} is not an exact source copy/link; refusing to overwrite it`);
    }
  }
  return { targets, previousByDestination };
}

async function snapshotTargets(ctx, targets, transaction) {
  const snapshots = new Map();
  for (const relative of targets) {
    const target = path.join(ctx.engine, relative);
    if (!targetExists(target)) {
      snapshots.set(relative, undefined);
      continue;
    }
    const snapshot = path.join(transaction, relative);
    await fsp.mkdir(path.dirname(snapshot), { recursive: true });
    await fsp.cp(target, snapshot, { recursive: true, dereference: false });
    snapshots.set(relative, snapshot);
  }
  return snapshots;
}

async function restoreTargets(ctx, snapshots) {
  for (const [relative, snapshot] of snapshots) {
    const target = path.join(ctx.engine, relative);
    await fsp.rm(target, { recursive: true, force: true });
    if (snapshot) {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.cp(snapshot, target, { recursive: true, dereference: false });
    }
  }
}

function removeOwnedStale(ctx, previous, current) {
  const wanted = new Set(current.map((entry) => entry.destination));
  for (const oldEntry of previous.entries) {
    if (wanted.has(oldEntry.destination)) continue;
    const target = path.join(ctx.engine, oldEntry.destination);
    if (!targetExists(target)) continue;
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function installEntry(ctx, entry, useLinks) {
  const target = path.join(ctx.engine, entry.destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (targetExists(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  if (useLinks) {
    fs.symlinkSync(entry.sourceAbsolute, target);
    entry.linkTarget = entry.sourceAbsolute;
  } else {
    fs.copyFileSync(entry.sourceAbsolute, target);
    entry.destinationSha256 = hashFile(target);
  }
}

export async function importSourceOverlays({ repoRoot = DEFAULT_ROOT, platform = process.platform } = {}) {
  const ctx = repoContext(repoRoot);
  if (!fs.existsSync(path.join(ctx.engine, 'toolkit', 'moz.build'))) throw new Error('import-sources: engine is missing; run pnpm run download first');
  const activeConfig = config(ctx);
  const useLinks = platform !== 'win32' || activeConfig.build.windowsUseSymbolicLinks === true;
  const previous = loadManifest(ctx);
  const files = listFiles(ctx.source).filter(({ relative }) => relative !== 'README.md' && !relative.endsWith('.patch') && !relative.split('/').includes('node_modules'));
  const current = files.map(({ absolute, relative }) => ({
    source: relative,
    sourceAbsolute: absolute,
    destination: relative,
    type: useLinks ? 'symlink' : 'copy',
  }));
  const { targets } = preflight(ctx, previous, current);
  await fsp.mkdir(ctx.state, { recursive: true });
  const transaction = await fsp.mkdtemp(path.join(ctx.state, 'import-transaction-'));
  const snapshots = await snapshotTargets(ctx, targets, transaction);
  try {
    removeOwnedStale(ctx, previous, current);
    for (const entry of current) installEntry(ctx, entry, useLinks);
    const manifest = {
      schemaVersion: MANIFEST_VERSION,
      sourceRoot: 'src',
      platform,
      entries: current.map(({ source, destination, type, linkTarget, destinationSha256 }) => ({
        source,
        destination,
        type,
        ...(linkTarget ? { linkTarget } : {}),
        ...(destinationSha256 ? { destinationSha256 } : {}),
      })),
    };
    fs.mkdirSync(ctx.state, { recursive: true });
    const temporaryManifest = `${ctx.manifest}.tmp-${process.pid}`;
    fs.writeFileSync(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(temporaryManifest, ctx.manifest);
    return manifest;
  } catch (error) {
    await restoreTargets(ctx, snapshots);
    throw error;
  } finally {
    await fsp.rm(transaction, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const manifest = await importSourceOverlays();
    process.stdout.write(`import-sources: installed ${manifest.entries.length} source overlays\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
