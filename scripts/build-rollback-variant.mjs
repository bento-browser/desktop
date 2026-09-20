#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
if (!['build', 'package', 'release', 'updates', 'check'].includes(action)) {
  throw new Error('action must be build, package, release, updates, or check');
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
  return runAt(repo, command, args, env);
}

async function runAt(cwd, command, args, env = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    );
  });
}

async function writeJsonFile(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function overlayFiles(sourceRoot, targetRoot, shouldSkip = () => false) {
  for (const source of await walk(sourceRoot)) {
    const relative = path.relative(sourceRoot, source);
    if (shouldSkip(relative)) continue;
    const target = path.join(targetRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target);
  }
}

async function copyFileTo(target, source) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target);
}

function skipGeneratedFixturePath(source) {
  const relative = path.relative(repo, source);
  return !relative.split(path.sep).some((segment) =>
    ['dist', '.rollback-staging', 'node_modules'].includes(segment),
  );
}

async function prepareStaging(stagingRoot, sourceRoot) {
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  await cp(sourceRoot, path.join(stagingRoot, 'src'), { recursive: true });
}

async function prepareRepoStaging(stagingRoot, sourceRoot) {
  await preserve(stagingRoot);
  await prepareStaging(stagingRoot, sourceRoot);
}

async function stageLegacyShellAt({ shellRoot, copyFile, writeJsonFileAt, currentManifest }) {
  const archiveShell = path.join(archive, 'extensions/bento-shell');
  for (const source of await walk(archiveShell)) {
    const relative = path.relative(archiveShell, source);
    if (relative === 'manifest.json') continue;
    await copyFile(path.join(shellRoot, relative), source);
  }
  const manifest = JSON.parse(await readFile(path.join(archiveShell, 'manifest.json'), 'utf8'));
  manifest.version = transition ? '0.0.4' : '0.0.5';
  if (transition) {
    if (!currentManifest) throw new Error('transition shell manifest is unavailable');
    manifest.experiment_apis = currentManifest.experiment_apis;
  }
  await writeJsonFileAt(path.join(shellRoot, 'manifest.json'), manifest);
}

async function stageLegacyToolsAt({
  toolsRoot,
  copyFile,
  writeJsonFileAt,
  prepareStagingAt,
  currentManifest,
}) {
  const staging = path.join(toolsRoot, '.rollback-staging', 'src');
  await prepareStagingAt(path.dirname(staging), path.join(toolsRoot, 'src'));
  await overlayFiles(path.join(archive, 'extensions/bento-tools/src'), staging);

  const packagePath = path.join(toolsRoot, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  packageJson.scripts.build = transition
    ? 'node ../../scripts/build-extension-background.mjs src/rollback/rollback-transition-background.ts dist/background.js'
    : 'node ../../scripts/build-extension-background.mjs .rollback-staging/src/background.ts dist/background.js';
  await writeJsonFileAt(packagePath, packageJson);

  const manifestPath = path.join(toolsRoot, 'manifest.json');
  const manifest = transition
    ? currentManifest
    : JSON.parse(
        await readFile(path.join(archive, 'extensions/bento-tools/manifest.json'), 'utf8'),
      );
  if (!manifest) throw new Error('transition tools manifest is unavailable');
  const hasNativePreferences = Boolean(manifest.experiment_apis?.bentoNativePreferences);
  if (hasNativePreferences !== transition) {
    throw new Error(
      `${variant} tools manifest has an unexpected bentoNativePreferences experiment entry`,
    );
  }
  manifest.version = transition ? '0.1.12' : '0.1.13';
  await writeJsonFileAt(manifestPath, manifest);

  if (transition) {
    await copyFile(
      path.join(toolsRoot, 'dist/rollback.html'),
      path.join(toolsRoot, 'src/rollback/recovery.html'),
    );
    await copyFile(
      path.join(toolsRoot, 'dist/rollback.js'),
      path.join(toolsRoot, 'src/rollback/recovery.js'),
    );
  }
}

async function removeFinalFirefoxFilesAt({ shellRoot, toolsRoot, remove }) {
  if (transition) return;
  await remove(path.join(shellRoot, 'src/experiments/chrome-bridge'));
  await remove(path.join(shellRoot, 'experiments/chrome-bridge'));
  await remove(path.join(toolsRoot, 'experiments/bento-native-preferences'));
}

async function stageIsolatedShell(shellRoot) {
  const currentManifest = JSON.parse(
    await readFile(path.join(repo, 'extensions/bento-shell/manifest.json'), 'utf8'),
  );
  await stageLegacyShellAt({
    shellRoot,
    copyFile: copyFileTo,
    writeJsonFileAt: writeJsonFile,
    currentManifest,
  });
}

async function stageIsolatedTools(toolsRoot) {
  const currentManifest = JSON.parse(
    await readFile(path.join(repo, 'extensions/bento-tools/manifest.json'), 'utf8'),
  );
  await stageLegacyToolsAt({
    toolsRoot,
    copyFile: copyFileTo,
    writeJsonFileAt: writeJsonFile,
    prepareStagingAt: prepareStaging,
    currentManifest,
  });
}

async function runIsolatedCheck() {
  const isolatedRoot = await mkdtemp(path.join(tmpdir(), 'bento-rollback-mux-check-'));
  const shellRoot = path.join(isolatedRoot, 'extensions/bento-shell');
  const toolsRoot = path.join(isolatedRoot, 'extensions/bento-tools');
  await mkdir(path.join(isolatedRoot, 'extensions'), { recursive: true });
  await cp(path.join(repo, 'extensions/bento-shell'), shellRoot, {
    recursive: true,
    filter: skipGeneratedFixturePath,
  });
  await cp(path.join(repo, 'extensions/bento-tools'), toolsRoot, {
    recursive: true,
    filter: skipGeneratedFixturePath,
  });
  await cp(path.join(repo, 'extensions/_shared'), path.join(isolatedRoot, 'extensions/_shared'), {
    recursive: true,
    filter: skipGeneratedFixturePath,
  });
  await cp(path.join(repo, 'tsconfig.base.json'), path.join(isolatedRoot, 'tsconfig.base.json'));
  await symlink(path.join(repo, 'node_modules'), path.join(isolatedRoot, 'node_modules'), 'dir');

  await stageIsolatedShell(shellRoot);
  await stageIsolatedTools(toolsRoot);
  await removeFinalFirefoxFilesAt({
    shellRoot,
    toolsRoot,
    remove: (target) => rm(target, { recursive: true, force: true }),
  });

  const env = { BENTO_RELEASE: '1', BENTO_RELEASE_VARIANT: variant };
  if (!transition) {
    await runAt(
      repo,
      process.execPath,
      ['--check', path.join(archive, 'src/browser/base/content/bento-shell-mount.js')],
      env,
    );
  }
  const tscBin = path.join(repo, 'node_modules/typescript/bin/tsc');
  await runAt(shellRoot, process.execPath, [tscBin, '-p', 'tsconfig.json', '--noEmit'], env);

  const viteBin = path.join(repo, 'node_modules/vite/bin/vite.js');
  await runAt(
    shellRoot,
    process.execPath,
    [viteBin, 'build', '--config', 'vite.config.ts', '--mode', 'production'],
    env,
  );
  await mkdir(path.join(shellRoot, 'dist/assets'), { recursive: true });
  await runAt(
    shellRoot,
    process.execPath,
    [
      path.join(repo, 'scripts/build-extension-background.mjs'),
      'src/background.ts',
      'dist/assets/background.js',
    ],
    env,
  );

  const stagedTypeConfig = path.join(toolsRoot, 'tsconfig.rollback-staging.json');
  await writeJsonFile(stagedTypeConfig, {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      lib: ['ES2022', 'DOM'],
      module: 'ES2022',
      moduleResolution: 'bundler',
      target: 'ES2022',
      noEmit: true,
      types: ['firefox-webext-browser'],
    },
    files: [
      '.rollback-staging/src/background.ts',
      '.rollback-staging/src/privacy/global.d.ts',
      '.rollback-staging/src/externalMerge/global.d.ts',
    ],
  });
  const transitionTypeConfig = path.join(toolsRoot, 'tsconfig.rollback-transition.json');
  await writeJsonFile(transitionTypeConfig, {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      lib: ['ES2022', 'DOM'],
      module: 'ES2022',
      moduleResolution: 'bundler',
      target: 'ES2022',
      noEmit: true,
      types: ['firefox-webext-browser'],
    },
    files: [
      'src/rollback/rollback-transition-background.ts',
      'src/privacy/global.d.ts',
      'src/externalMerge/global.d.ts',
    ],
  });
  await runAt(toolsRoot, process.execPath, [tscBin, '-p', stagedTypeConfig, '--noEmit'], env);
  await runAt(toolsRoot, process.execPath, [tscBin, '-p', transitionTypeConfig, '--noEmit'], env);

  const backupTestConfig = path.join(toolsRoot, 'vitest.rollback.config.ts');
  await writeFile(
    backupTestConfig,
    `import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@shared': fileURLToPath(new URL('../_shared', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['.rollback-staging/src/backup/BackupStore.test.ts'],
  },
});
`,
    'utf8',
  );
  const vitestBin = path.join(repo, 'node_modules/vitest/vitest.mjs');
  await runAt(toolsRoot, process.execPath, [vitestBin, 'run', '--config', backupTestConfig], env);

  const toolsOutput = 'dist/background.js';
  await mkdir(path.dirname(path.join(toolsRoot, toolsOutput)), { recursive: true });
  const toolsEntry = transition
    ? 'src/rollback/rollback-transition-background.ts'
    : '.rollback-staging/src/background.ts';
  await runAt(
    toolsRoot,
    process.execPath,
    [
      path.join(repo, 'scripts/build-extension-background.mjs'),
      toolsEntry,
      toolsOutput,
    ],
    env,
  );

  const shellManifest = JSON.parse(
    await readFile(path.join(shellRoot, 'manifest.json'), 'utf8'),
  );
  const toolsManifest = JSON.parse(
    await readFile(path.join(toolsRoot, 'manifest.json'), 'utf8'),
  );
  const evidence = {
    action,
    variant,
    isolatedRoot,
    sourceRoots: {
      shell: shellRoot,
      tools: toolsRoot,
      shared: path.join(isolatedRoot, 'extensions/_shared'),
    },
    checks: {
      shellTypecheck: path.join(shellRoot, 'tsconfig.json'),
      shellViteDist: path.join(shellRoot, 'dist'),
      shellBackground: path.join(shellRoot, 'dist/assets/background.js'),
      stagedToolsTypecheck: stagedTypeConfig,
      transitionToolsTypecheck: transitionTypeConfig,
      stagedBackupPrivacyTests: backupTestConfig,
      toolsBackground: path.join(toolsRoot, toolsOutput),
    },
    manifestVersions: {
      shell: shellManifest.version,
      tools: toolsManifest.version,
    },
    manifestExperimentApis: {
      shell: Object.keys(shellManifest.experiment_apis ?? {}).sort(),
      tools: Object.keys(toolsManifest.experiment_apis ?? {}).sort(),
    },
  };
  await writeJsonFile(path.join(isolatedRoot, 'rollback-check.json'), evidence);
  return evidence;
}

async function writeJson(target, value) {
  await preserve(target);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function stageLegacyShell() {
  const currentManifest = JSON.parse(
    await readFile(path.join(repo, 'extensions/bento-shell/manifest.json'), 'utf8'),
  );
  await stageLegacyShellAt({
    shellRoot: path.join(repo, 'extensions/bento-shell'),
    copyFile: replace,
    writeJsonFileAt: writeJson,
    currentManifest,
  });
}

async function stageLegacyTools() {
  const currentManifest = JSON.parse(
    await readFile(path.join(repo, 'extensions/bento-tools/manifest.json'), 'utf8'),
  );
  await stageLegacyToolsAt({
    toolsRoot: path.join(repo, 'extensions/bento-tools'),
    copyFile: replace,
    writeJsonFileAt: writeJson,
    prepareStagingAt: prepareRepoStaging,
    currentManifest,
  });
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
  await removeFinalFirefoxFilesAt({
    shellRoot: path.join(repo, 'extensions/bento-shell'),
    toolsRoot: path.join(repo, 'extensions/bento-tools'),
    remove: removeTemporarily,
  });
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

if (action === 'check') {
  try {
    const evidence = await runIsolatedCheck();
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  process.exit(0);
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
    await run('bash', ['scripts/bento-env.sh', 'updates-browser'], env);
    await run('bash', ['scripts/bento-env.sh', 'updates-addons'], env);
  }
  await collectAudit();
} finally {
  await restore();
}
