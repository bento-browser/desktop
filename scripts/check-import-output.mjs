#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanProductIdentity } from './check-product-identity.mjs';
import { readEntry } from './read-entry.mjs';
import { git, replaySeriesChanges } from './series-replay.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(process.env.BENTO_REPO_ROOT || scriptRoot);
const engine = path.join(root, 'engine');

function requireFile(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) throw new Error(`import output is missing ${relative}`);
  return file;
}

requireFile('engine/browser/branding/bento/configure.sh');

// Every chrome overlay under src/browser/base/content must reach the engine and be
// registered in browser/base/jar.mn, by file name or as a directory line (the theme
// sheets). An unregistered file imports cleanly but never ships, which leaves the
// chrome unstyled or unscripted at runtime (bento-shell-mount.css is one such file).
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const browserJar = fs.readFileSync(requireFile('engine/browser/base/jar.mn'), 'utf8');
for (const entry of fs.readdirSync(path.join(root, 'src/browser/base/content'), {
  withFileTypes: true,
})) {
  if (entry.name.startsWith('.')) continue;
  const name = escapeRegExp(entry.name);
  const line = entry.isDirectory()
    ? new RegExp(`^\\s*content/browser/${name}/\\s+\\(content/${name}/`, 'm')
    : new RegExp(`^\\s*content/browser/${name}\\s+\\(content/${name}\\)`, 'm');
  requireFile(`engine/browser/base/content/${entry.name}`);
  if (!line.test(browserJar)) {
    throw new Error(`engine/browser/base/jar.mn does not register ${entry.name}`);
  }
}

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

// Every path the patch series changes must match what applying the series to the
// base commit produces: same blob and file mode, or no file left where the series
// deletes one (a directory may take its place). The replay in series-replay.mjs is
// exact, whereas reverse-applying the patches to the live tree would accept
// whitespace-altered content because the apply flags ignore whitespace. Import
// steps that edit files outside the series (prefs, moz.build, version files) are
// never compared.
function liveEntry(relative) {
  const entry = readEntry(path.join(engine, relative));
  if (!entry) return undefined;
  if (!entry.content) return { mode: 'not a file', oid: '' };
  return {
    mode: entry.symlink ? '120000' : entry.mode & 0o100 ? '100755' : '100644',
    oid: git(engine, ['hash-object', '--no-filters', '--stdin'], { input: entry.content }).trim(),
  };
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'patches', 'series.json'), 'utf8'));
const patchFailures = [];
for (const [relative, change] of replaySeriesChanges(root)) {
  const live = liveEntry(relative);
  if (change.status === 'D') {
    if (live && live.mode !== 'not a file') {
      patchFailures.push(`engine/${relative} exists but the patch series deletes it`);
    }
  } else if (!live) {
    patchFailures.push(`engine/${relative} is missing but the patch series keeps it`);
  } else if (change.oid !== live.oid || change.mode !== live.mode) {
    patchFailures.push(`engine/${relative} differs from the patch series result`);
  }
}
if (patchFailures.length > 0) throw new Error(patchFailures.join('\n'));

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
