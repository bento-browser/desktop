#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BEGIN_MARKER = '# BEGIN BENTO BUILTIN ADDONS';
const END_MARKER = '# END BENTO BUILTIN ADDONS';
const compareNames = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

export const DEFAULT_RUNTIME_ENTRIES = [
  'manifest.json',
  'chrome.manifest',
  'dist',
  'experiments',
  'icons',
  '_locales',
  'background.html',
  'background.js',
  'options.html',
  'popup.html',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validateRuntimeEntry(entry, configPath) {
  if (
    typeof entry !== 'string' ||
    entry.length === 0 ||
    entry === '.' ||
    entry === '..' ||
    path.isAbsolute(entry) ||
    /^[A-Za-z]:/.test(entry) ||
    entry.includes('/') ||
    entry.includes('\\')
  ) {
    throw new Error(
      `${configPath} contains unsafe top-level runtime entry: ${JSON.stringify(entry)}`,
    );
  }
}

function runtimeEntries(extensionRoot) {
  const configPath = path.join(extensionRoot, '.bento-runtime-entries.json');
  const entries = fs.existsSync(configPath) ? readJson(configPath) : DEFAULT_RUNTIME_ENTRIES;
  if (!Array.isArray(entries)) {
    throw new Error(`${configPath} must contain a JSON string array`);
  }
  for (const entry of entries) validateRuntimeEntry(entry, configPath);
  return [...new Set([...entries, 'manifest.json'])].sort(compareNames);
}

function copyEntry(source, destination) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`install-builtin-addons: runtime entries must not contain symlinks: ${source}`);
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true, mode: stat.mode });
    for (const entry of fs
      .readdirSync(source, { withFileTypes: true })
      .sort((a, b) => compareNames(a.name, b.name))) {
      copyEntry(path.join(source, entry.name), path.join(destination, entry.name));
    }
    return;
  }
  if (stat.isFile()) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, stat.mode);
    return;
  }
  throw new Error(`install-builtin-addons: unsupported runtime entry: ${source}`);
}

function listFiles(root, current = root) {
  return fs
    .readdirSync(current, { withFileTypes: true })
    .sort((a, b) => compareNames(a.name, b.name))
    .flatMap((entry) => {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) return listFiles(root, absolute);
      if (entry.isFile()) return [path.relative(root, absolute).split(path.sep).join('/')];
      throw new Error(`install-builtin-addons: unsupported installed entry: ${absolute}`);
    });
}

function manifestId(manifest) {
  return manifest?.applications?.gecko?.id ?? manifest?.browser_specific_settings?.gecko?.id;
}

function generateAddonBuildFiles(destination, name, id) {
  const files = listFiles(destination).sort(compareNames);
  const jar = [
    'browser.jar:',
    ...files.map((file) => `    builtin-addons/${name}/${file} (${file})`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(destination, 'jar.mn'), jar);

  const mozBuild = `# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# Bento built-in add-on: ${name} (${id})
DEFINES["MOZ_APP_VERSION"] = CONFIG["MOZ_APP_VERSION"]
DEFINES["MOZ_APP_MAXVERSION"] = CONFIG["MOZ_APP_MAXVERSION"]

JAR_MANIFESTS += ["jar.mn"]
`;
  fs.writeFileSync(path.join(destination, 'moz.build'), mozBuild);
  return files.length;
}

function replaceMarkerBlock(file, names) {
  const source = fs.readFileSync(file, 'utf8');
  const beginCount = source.split(BEGIN_MARKER).length - 1;
  const endCount = source.split(END_MARKER).length - 1;
  if (beginCount !== endCount || beginCount > 1) {
    throw new Error(`install-builtin-addons: malformed Bento marker block in ${file}`);
  }

  let base = source;
  if (beginCount === 1) {
    const start = base.indexOf(BEGIN_MARKER);
    const end = base.indexOf(END_MARKER, start) + END_MARKER.length;
    base = `${base.slice(0, start)}${base.slice(end)}`;
  }
  // Remove the single unmarked line emitted by the legacy integration.
  // This is deliberately exact so unrelated upstream DIRS declarations remain.
  base = base.replace(/^DIRS \+= \["bento-shell", "bento-tools", "ublock-origin"\]\r?\n?/m, '');
  base = base.trimEnd();

  const dirs = names.map((name) => `"${name}"`).join(', ');
  const block = `${BEGIN_MARKER}\nDIRS += [${dirs}]\n${END_MARKER}`;
  fs.writeFileSync(file, `${base}\n\n${block}\n`);
}

export function installBuiltinAddons(options = {}) {
  const repoRoot = path.resolve(
    options.repoRoot || process.env.BENTO_REPO_ROOT || DEFAULT_REPO_ROOT,
  );
  const extensionsRoot = path.join(repoRoot, 'extensions');
  const engineExtensionsRoot = path.join(repoRoot, 'engine', 'browser', 'extensions');
  const engineMozBuild = path.join(engineExtensionsRoot, 'moz.build');
  if (!fs.existsSync(engineMozBuild)) {
    throw new Error('install-builtin-addons: engine/browser/extensions/moz.build is missing');
  }

  const addons = [];
  for (const entry of fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .sort((a, b) => compareNames(a.name, b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
    const source = path.join(extensionsRoot, entry.name);
    const manifestPath = path.join(source, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;

    const manifest = readJson(manifestPath);
    const id = manifestId(manifest);
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `install-builtin-addons: extensions/${entry.name}/manifest.json has no Gecko add-on ID`,
      );
    }

    const destination = path.join(engineExtensionsRoot, entry.name);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });
    for (const runtimeEntry of runtimeEntries(source)) {
      const runtimeSource = path.join(source, runtimeEntry);
      if (!fs.existsSync(runtimeSource)) continue;
      copyEntry(runtimeSource, path.join(destination, runtimeEntry));
    }

    const fileCount = generateAddonBuildFiles(destination, entry.name, id);
    addons.push({ name: entry.name, id, fileCount, destination });
  }

  replaceMarkerBlock(
    engineMozBuild,
    addons.map((addon) => addon.name),
  );
  return addons;
}

export function main() {
  const addons = installBuiltinAddons();
  for (const addon of addons) {
    process.stdout.write(
      `install-builtin-addons: ${addon.name} (${addon.fileCount} runtime files)\n`,
    );
  }
  process.stdout.write(`install-builtin-addons: installed ${addons.length} add-ons\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
