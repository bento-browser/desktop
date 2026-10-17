#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanProductIdentity } from './check-product-identity.mjs';
import {
  FIREFOX_PATCH_APPLY_ARGS,
  FIREFOX_PATCH_GIT_CONFIG,
  SCRATCH_GIT_CONFIG,
} from './firefox-patch-stack.mjs';
import { readSeriesPaths } from './patch-series-paths.mjs';
import { readEntry } from './read-entry.mjs';

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

// Every path the series touches must match what applying the series to the base
// commit produces. The series is replayed once in a scratch index, the way
// firefox-patch-stack.mjs checks it, and each touched path is compared with the
// live tree by blob id and file mode; a path the series deletes must be absent.
// Reverse-applying the patches to the live tree would be weaker, because the apply
// flags ignore whitespace and would accept altered content. Import steps that edit
// files outside the series (prefs, moz.build, version files) are never compared.
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'patches', 'series.json'), 'utf8'));
const { touched } = readSeriesPaths(root);

function git(args, { env, input } = {}) {
  const result = spawnSync('git', args, {
    cwd: engine,
    env: env && { ...process.env, ...env },
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in engine\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

// Mode and blob id per touched path after the series, from a scratch index and
// object directory so the engine's index and object store stay untouched.
function expectedSeriesEntries(paths) {
  const baseRef = `refs/bento/firefox-base/${manifest.base.version}`;
  const hasBase = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`], {
    cwd: engine,
  });
  if (hasBase.status !== 0) throw new Error(`engine has no ${baseRef}; run the import first`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-import-check-'));
  const objects = path.join(scratch, 'objects');
  fs.mkdirSync(objects);
  const env = {
    GIT_INDEX_FILE: path.join(scratch, 'index'),
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.resolve(
      engine,
      git(['rev-parse', '--git-path', 'objects']).trim(),
    ),
  };
  const config = [...FIREFOX_PATCH_GIT_CONFIG, ...SCRATCH_GIT_CONFIG].flatMap((setting) => [
    '-c',
    setting,
  ]);
  try {
    git([...config, 'read-tree', baseRef], { env });
    for (const entry of manifest.series) {
      git(
        [...config, 'apply', '--cached', ...FIREFOX_PATCH_APPLY_ARGS, path.join(root, entry.path)],
        { env },
      );
    }
    const listing = git(
      [...config, '--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...paths],
      { env },
    );
    return new Map(
      listing
        .split('\0')
        .filter(Boolean)
        .map((record) => {
          const tab = record.indexOf('\t');
          const [mode, oid] = record.slice(0, tab).split(' ');
          return [record.slice(tab + 1), { mode, oid }];
        }),
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function liveEntry(relative) {
  const entry = readEntry(path.join(engine, relative));
  if (!entry) return undefined;
  if (!entry.content) return { mode: 'not a file', oid: '' };
  return {
    mode: entry.symlink ? '120000' : entry.mode & 0o111 ? '100755' : '100644',
    oid: git(['hash-object', '--no-filters', '--stdin'], { input: entry.content }).trim(),
  };
}

const expected = expectedSeriesEntries([...touched.keys()]);
const patchFailures = [];
for (const [relative, patch] of touched) {
  const want = expected.get(relative);
  const live = liveEntry(relative);
  if (!want && live) {
    patchFailures.push(`engine/${relative} exists but the patch series deletes it (${patch})`);
  } else if (want && !live) {
    patchFailures.push(`engine/${relative} is missing but the patch series keeps it (${patch})`);
  } else if (want && (want.oid !== live.oid || want.mode !== live.mode)) {
    patchFailures.push(`engine/${relative} differs from the patch series result (${patch})`);
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
