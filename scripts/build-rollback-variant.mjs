#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = path.join(repo, 'rollback/legacy-source');
const [variant, action = 'build'] = process.argv.slice(2);
if (!['rollback-transition-r1', 'rollback-final-r2'].includes(variant)) {
  throw new Error('variant must be rollback-transition-r1 or rollback-final-r2');
}
if (!['build', 'package', 'release', 'updates'].includes(action)) {
  throw new Error('action must be build, package, release, or updates');
}
const transition = variant === 'rollback-transition-r1';
const temporary = await mkdtemp(path.join(tmpdir(), 'bento-rollback-'));
const backups = new Map();
const created = new Set();
let engineNeedsRestore = false;

async function exists(target) {
  return stat(target).then(() => true, () => false);
}

function assertRepoPath(target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(`${repo}${path.sep}`)) throw new Error(`unsafe path: ${resolved}`);
  return resolved;
}

async function preserve(target) {
  target = assertRepoPath(target);
  if (backups.has(target) || created.has(target)) return;
  if (!(await exists(target))) {
    created.add(target);
    return;
  }
  const backup = path.join(temporary, `backup-${backups.size}`);
  await cp(target, backup, { recursive: true });
  backups.set(target, backup);
}

async function replace(target, source) {
  await preserve(target);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

async function removeTemporarily(target) {
  await preserve(target);
  await rm(assertRepoPath(target), { recursive: true, force: true });
}

async function walk(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...(await walk(absolute)));
    else output.push(absolute);
  }
  return output;
}

async function run(command, args, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    );
  });
}

async function writeJson(target, value) {
  await preserve(target);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function stageLegacyShell() {
  const shellRoot = path.join(archive, 'extensions/bento-shell');
  for (const source of await walk(shellRoot)) {
    const relative = path.relative(shellRoot, source);
    if (relative === 'manifest.json') continue;
    await replace(path.join(repo, 'extensions/bento-shell', relative), source);
  }
  const legacyManifest = JSON.parse(await readFile(path.join(shellRoot, 'manifest.json'), 'utf8'));
  legacyManifest.version = transition ? '0.0.4' : '0.0.5';
  if (transition) {
    const current = JSON.parse(
      await readFile(path.join(repo, 'extensions/bento-shell/manifest.json'), 'utf8'),
    );
    legacyManifest.experiment_apis = current.experiment_apis;
  }
  await writeJson(path.join(repo, 'extensions/bento-shell/manifest.json'), legacyManifest);
}

async function stageLegacyTools() {
  const staging = path.join(repo, 'extensions/bento-tools/.rollback-staging');
  await preserve(staging);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await cp(path.join(repo, 'extensions/bento-tools/src'), path.join(staging, 'src'), {
    recursive: true,
  });
  const legacyRoot = path.join(archive, 'extensions/bento-tools/src');
  for (const source of await walk(legacyRoot)) {
    const relative = path.relative(legacyRoot, source);
    const target = path.join(staging, 'src', relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target);
  }

  const packagePath = path.join(repo, 'extensions/bento-tools/package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  packageJson.scripts.build = transition
    ? 'node ../../scripts/build-extension-background.mjs src/rollback/rollback-transition-background.ts dist/background.js'
    : 'node ../../scripts/build-extension-background.mjs .rollback-staging/src/background.ts dist/background.js';
  await writeJson(packagePath, packageJson);

  const manifestPath = path.join(repo, 'extensions/bento-tools/manifest.json');
  const manifest = transition
    ? JSON.parse(await readFile(manifestPath, 'utf8'))
    : JSON.parse(
        await readFile(path.join(archive, 'extensions/bento-tools/manifest.json'), 'utf8'),
      );
  manifest.version = transition ? '0.1.12' : '0.1.13';
  await writeJson(manifestPath, manifest);

  if (transition) {
    const dist = path.join(repo, 'extensions/bento-tools/dist');
    await mkdir(dist, { recursive: true });
    await replace(
      path.join(dist, 'rollback.html'),
      path.join(repo, 'extensions/bento-tools/src/rollback/recovery.html'),
    );
    await replace(
      path.join(dist, 'rollback.js'),
      path.join(repo, 'extensions/bento-tools/src/rollback/recovery.js'),
    );
  }
}

async function stageFinalFirefox() {
  await replace(
    path.join(repo, 'src/browser/base/content/bento-shell-mount.js'),
    path.join(archive, 'src/browser/base/content/bento-shell-mount.js'),
  );
  const seriesPath = path.join(repo, 'patches/series.json');
  const series = JSON.parse(await readFile(seriesPath, 'utf8'));
  series.series = series.series.filter(
    (entry) => entry.path !== 'patches/core-ui/15-bento-native-preferences.patch',
  );
  await writeJson(seriesPath, series);
  await removeTemporarily(
    path.join(repo, 'extensions/bento-tools/experiments/bento-native-preferences'),
  );
  await removeTemporarily(path.join(repo, 'extensions/bento-shell/experiments/chrome-bridge'));
  await removeTemporarily(path.join(repo, 'extensions/bento-shell/src/experiments/chrome-bridge'));
  engineNeedsRestore = true;
}

async function collectAudit() {
  const output = path.join(repo, 'artifacts', variant);
  await mkdir(output, { recursive: true });
  const files = [];
  for (const candidate of [path.join(repo, 'dist'), path.join(repo, 'release-out')]) {
    if (!(await exists(candidate))) continue;
    for (const file of await walk(candidate)) {
      const bytes = await readFile(file);
      files.push({
        path: path.relative(repo, file),
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  await writeFile(
    path.join(output, 'manifest-audit.json'),
    `${JSON.stringify(
      {
        variant,
        action,
        toolsVersion: transition ? '0.1.12' : '0.1.13',
        shellVersion: transition ? '0.0.4' : '0.0.5',
        automaticFinalUpdate: false,
        files,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function restore() {
  for (const target of created) await rm(target, { recursive: true, force: true });
  for (const [target, backup] of [...backups.entries()].reverse()) {
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(backup, target, { recursive: true });
  }
  await rm(temporary, { recursive: true, force: true });
  if (engineNeedsRestore) await run('pnpm', ['run', 'import']);
}

try {
  await stageLegacyShell();
  await stageLegacyTools();
  if (!transition) await stageFinalFirefox();
  const env = { BENTO_RELEASE_VARIANT: variant };
  if (action === 'build') {
    await run('pnpm', ['run', 'ext:build'], env);
    await run('pnpm', ['run', 'build'], env);
    await run('pnpm', ['run', 'package'], env);
  } else if (action === 'package') {
    await run('pnpm', ['run', 'ext:build'], env);
    await run('pnpm', ['run', 'import'], env);
    await run('pnpm', ['run', 'package'], env);
  } else if (action === 'release') {
    await run('pnpm', ['run', 'build:release'], env);
  } else {
    if (!transition) throw new Error('final rollback updates are intentionally disabled');
    await run('bash', ['scripts/surfer-env.sh', 'updates-browser'], env);
    await run('bash', ['scripts/surfer-env.sh', 'updates-addons'], env);
  }
  await collectAudit();
} finally {
  await restore();
}
