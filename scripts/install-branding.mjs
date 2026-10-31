#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertLocalBuildPaths } from './bento-build.mjs';
import { scanProductIdentity } from './check-product-identity.mjs';
import { copyFileIfChanged, pruneTree } from './write-if-changed.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
// append-prefs.sh adds this managed block to the installed branding prefs after
// the copy, so a destination holding source plus the block is already current.
const PREFS_MARKER = '// === Bento defaults (appended from prefs/bento.js)';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function collectSourceFiles(root, current = root) {
  return fs
    .readdirSync(current, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `install-branding: canonical branding must not contain symlinks: ${relative}`,
        );
      }
      if (stat.isDirectory()) return collectSourceFiles(root, absolute);
      if (stat.isFile()) return [relative];
      throw new Error(`install-branding: unsupported filesystem entry: ${relative}`);
    });
}

function isCurrentBrandingFile(source, destination) {
  if (!destination.endsWith(`pref${path.sep}firefox-branding.js`) || !fs.existsSync(destination)) {
    return false;
  }
  const installed = fs.readFileSync(destination, 'utf8');
  const markerIndex = installed.indexOf(PREFS_MARKER);
  return (
    markerIndex >= 0 &&
    installed.slice(0, markerIndex).trimEnd() === fs.readFileSync(source, 'utf8').trimEnd()
  );
}

function assertImportDidNotGenerateProductBranding(repoRoot) {
  const competitor = 'ze' + 'n';
  const competitorName = `${competitor[0].toUpperCase()}${competitor.slice(1)}`;
  const brandingRoot = path.join(repoRoot, 'engine', 'browser', 'branding');
  if (fs.existsSync(brandingRoot)) {
    for (const entry of fs.readdirSync(brandingRoot, { withFileTypes: true })) {
      if (entry.name === 'bento') continue;
      if (entry.name.toLowerCase().includes(competitor)) {
        throw new Error(`install-branding: unexpected generated branding directory: ${entry.name}`);
      }
      const absolute = path.join(brandingRoot, entry.name);
      if (!entry.isDirectory()) continue;
      for (const relative of collectSourceFiles(absolute)) {
        const data = fs.readFileSync(path.join(absolute, relative));
        for (const identity of [
          `${competitorName} Browser`,
          `${competitor}-browser`,
          'Bento Browser',
        ]) {
          if (data.indexOf(Buffer.from(identity, 'utf8')) !== -1) {
            throw new Error(
              `install-branding: unexpected product branding in ${path.relative(repoRoot, path.join(absolute, relative))}`,
            );
          }
        }
      }
    }
  }

  const sharedNsi = path.join(
    repoRoot,
    'engine',
    'browser',
    'installer',
    'windows',
    'nsis',
    'shared.nsh',
  );
  if (fs.existsSync(sharedNsi)) {
    const data = fs.readFileSync(sharedNsi);
    for (const identity of [`${competitorName} Browser`, `${competitor}-browser`]) {
      if (data.indexOf(Buffer.from(identity, 'utf8')) !== -1) {
        throw new Error(
          'install-branding: upstream import wrote forbidden publisher data to shared.nsh',
        );
      }
    }
  }
}

export function installBranding(options = {}) {
  const repoRoot = path.resolve(
    options.repoRoot || process.env.BENTO_REPO_ROOT || DEFAULT_REPO_ROOT,
  );
  assertLocalBuildPaths(repoRoot);
  const configPath = path.join(repoRoot, 'bento.json');
  if (!fs.existsSync(configPath)) throw new Error('install-branding: missing bento.json');
  const config = readJson(configPath);
  const brand = config.brand;
  if (brand !== 'bento') throw new Error(`install-branding: expected active brand "bento", received ${JSON.stringify(brand)}`);

  const source = path.join(repoRoot, 'branding', 'bento');
  const destination = path.join(repoRoot, 'engine', 'browser', 'branding', 'bento');
  if (!fs.existsSync(source)) {
    throw new Error('install-branding: canonical branding/bento directory is missing');
  }

  const files = collectSourceFiles(source);
  assertImportDidNotGenerateProductBranding(repoRoot);
  // Sync in place so unchanged files keep their mtimes and mach does not
  // reconfigure or rebuild unchanged branding.
  if (!fs.lstatSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });
  }
  pruneTree(destination, new Set(files.map((file) => file.split(path.sep).join('/'))));
  for (const file of files) {
    const installed = path.join(destination, file);
    if (!isCurrentBrandingFile(path.join(source, file), installed)) {
      copyFileIfChanged(path.join(source, file), installed);
    }
  }

  const failures = scanProductIdentity([destination], { cwd: repoRoot });
  if (failures.length > 0) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw new Error(failures.join('\n'));
  }

  return { brand, destination, fileCount: files.length };
}

export function main() {
  const result = installBranding();
  process.stdout.write(
    `install-branding: installed ${result.fileCount} files for ${result.brand}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
