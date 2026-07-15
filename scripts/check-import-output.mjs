#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanProductIdentity } from './check-product-identity.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.BENTO_REPO_ROOT || scriptRoot);
const engine = path.join(root, 'engine');

function requireFile(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) throw new Error(`import output is missing ${relative}`);
  return file;
}

requireFile('engine/browser/branding/bento/configure.sh');

const addonNames = ['bento-shell', 'bento-tools', 'ublock-origin'];
for (const name of addonNames) {
  requireFile(`engine/browser/extensions/${name}/manifest.json`);
  const jar = fs.readFileSync(requireFile(`engine/browser/extensions/${name}/jar.mn`), 'utf8');
  if (!jar.includes(`builtin-addons/${name}/`) || jar.includes('\\')) {
    throw new Error(`${name}/jar.mn has an invalid built-in add-on destination`);
  }
}

const mozBuild = fs.readFileSync(requireFile('engine/browser/extensions/moz.build'), 'utf8');
for (const marker of ['# BEGIN BENTO BUILTIN ADDONS', '# END BENTO BUILTIN ADDONS']) {
  if (mozBuild.split(marker).length - 1 !== 1) {
    throw new Error(`engine/browser/extensions/moz.build must contain one ${marker}`);
  }
}

const changed = new Set(
  execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: engine,
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, '')),
);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'patches', 'series.json'), 'utf8'));
for (const entry of manifest.series) {
  const patchText = fs.readFileSync(path.join(root, entry.path), 'utf8');
  const paths = [...patchText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)].map((match) => match[2]);
  if (paths.length === 0 || !paths.some((changedPath) => changed.has(changedPath))) {
    throw new Error(`no live engine change found for patch ${entry.path}`);
  }
}

const identityFailures = scanProductIdentity(
  [
    'branding/bento',
    'engine/browser/branding/bento',
    ...addonNames.map((name) => `engine/browser/extensions/${name}`),
  ],
  { cwd: root },
);
if (identityFailures.length > 0) throw new Error(identityFailures.join('\n'));

process.stdout.write(
  `check-import-output: branding, ${addonNames.length} add-ons, and ${manifest.series.length} patches verified\n`,
);
