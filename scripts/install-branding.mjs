#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { scanProductIdentity } from './check-product-identity.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

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
  const brandFile = path.join(repoRoot, '.surfer', 'dynamicConfig.brand.json');
  if (!fs.existsSync(brandFile)) {
    throw new Error(`install-branding: missing ${path.relative(repoRoot, brandFile)}`);
  }

  const brand = readJson(brandFile);
  if (brand !== 'bento') {
    throw new Error(
      `install-branding: expected active brand "bento", received ${JSON.stringify(brand)}`,
    );
  }

  const source = path.join(repoRoot, 'branding', 'bento');
  const destination = path.join(repoRoot, 'engine', 'browser', 'branding', 'bento');
  if (!fs.existsSync(source)) {
    throw new Error('install-branding: canonical branding/bento directory is missing');
  }

  const files = collectSourceFiles(source);
  assertImportDidNotGenerateProductBranding(repoRoot);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true, dereference: false });

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
