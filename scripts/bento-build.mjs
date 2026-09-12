#!/usr/bin/env node
/* global Buffer, WritableStream, fetch, process */

/**
 * Bento's small build driver. It owns the lifecycle around Mozilla's `mach`
 * entry point without reimplementing Mozilla's build system.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '..');
const SOURCE_STATE = 'source-state.json';
const OVERLAY_MANIFEST = 'import-manifest.json';
const PLATFORM_TARGETS = {
  linux: ['Linux_x86_64-gcc3'],
  darwin: [
    'Darwin_aarch64-gcc3',
    'Darwin_x86_64-gcc3-u-i386-x86_64',
    'Darwin_x86-gcc3-u-i386-x86_64',
    'Darwin_x86-gcc3',
    'Darwin_x86_64-gcc3',
  ],
  win32: ['WINNT_x86_64-msvc', 'WINNT_x86_64-msvc-x64'],
};

function fail(message) {
  const error = new Error(message);
  error.code = 'BENTO_USER_ERROR';
  throw error;
}

function isSupportedFirefoxVersion(version) {
  return typeof version === 'string'
    && version.length > 0
    && version.length <= 128
    && /^[0-9]+(?:\.[0-9]+)+(?:[A-Za-z][0-9A-Za-z.-]*|-[0-9A-Za-z.-]+)?$/.test(version);
}

export function createContext(repoRoot = DEFAULT_ROOT) {
  const root = path.resolve(repoRoot);
  return {
    root,
    configPath: path.join(root, 'bento.json'),
    stateDir: path.join(root, '.bento'),
    sourceCacheDir: path.join(root, '.bento', 'cache', 'source'),
    backupDir: path.join(root, '.bento', 'backups'),
    engineDir: path.join(root, 'engine'),
    distDir: path.join(root, 'dist'),
    srcDir: path.join(root, 'src'),
    overlayManifestPath: path.join(root, '.bento', OVERLAY_MANIFEST),
    sourceStatePath: path.join(root, '.bento', SOURCE_STATE),
  };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadConfig(repoRoot = DEFAULT_ROOT) {
  const ctx = createContext(repoRoot);
  if (!fs.existsSync(ctx.configPath)) fail(`missing ${path.relative(ctx.root, ctx.configPath)}`);
  const config = readJson(ctx.configPath);
  if (config.schemaVersion !== 1) fail('bento.json must use schemaVersion 1');
  if (!config.firefox?.version || !config.firefox?.product) {
    fail('bento.json must define firefox.product and firefox.version');
  }
  if (!config.brand || !config.brands?.[config.brand]) {
    fail('bento.json must define one active brand and its metadata');
  }
  if (!['dev', 'debug', 'release'].includes(config.build?.mode)) {
    fail('bento.json build.mode must be dev, debug, or release');
  }
  return config;
}

export function sourceArchivePath(repoRoot, version) {
  validateVersion(version);
  const ctx = createContext(repoRoot);
  const target = path.resolve(ctx.sourceCacheDir, version, `firefox-${version}.source.tar.xz`);
  if (!target.startsWith(`${path.resolve(ctx.sourceCacheDir)}${path.sep}`)) fail(`source archive path escapes Bento cache: ${version}`);
  return target;
}

function validateVersion(version) {
  if (!isSupportedFirefoxVersion(version)) {
    fail(`unsupported Firefox version: ${JSON.stringify(version)}`);
  }
  return version;
}

function sourceUrl(config, version) {
  validateVersion(version);
  const base = String(config.firefox.source?.archiveBaseUrl || '').replace(/\/$/, '');
  if (!base) fail('bento.json firefox.source.archiveBaseUrl is missing');
  return `${base}/${version}/source/firefox-${version}.source.tar.xz`;
}

function sha256File(file) {
  for (const command of process.platform === 'win32' ? ['sha256sum', 'certutil'] : ['shasum', 'sha256sum']) {
    const args = command === 'shasum' ? ['-a', '256', file] : command === 'sha256sum' ? [file] : ['-hashfile', file, 'SHA256'];
    const result = spawnSync(command, args, { encoding: 'utf8', stdio: 'pipe' });
    if (result.status !== 0) continue;
    const digest = result.stdout.match(/\b[a-f0-9]{64}\b/i)?.[0];
    if (digest) return digest.toLowerCase();
  }
  fail('no SHA-256 utility is available to verify Firefox source');
}

export function verifySourceArchive(file, expected) {
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) {
    fail('Firefox source verification requires a 64-character SHA-256 digest');
  }
  const actual = sha256File(file);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    fail(`Firefox source digest mismatch for ${file}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

async function downloadFile(url, target) {
  const response = await fetch(url);
  if (!response.ok || !response.body) fail(`Firefox source download failed with HTTP ${response.status}`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.part-${process.pid}`;
  try {
    await fsp.rm(temporary, { force: true });
    const output = fs.createWriteStream(temporary, { flags: 'wx' });
    await new Promise((resolve, reject) => {
      const stream = response.body.pipeTo(
        new WritableStream({
          write(chunk) {
            return new Promise((done, error) => output.write(Buffer.from(chunk), (err) => (err ? error(err) : done())));
          },
          close() {
            output.end(resolve);
          },
          abort(error) {
            output.destroy(error);
            reject(error);
          },
        }),
      );
      stream.catch(reject);
    });
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

export async function acquireSourceArchive(repoRoot = DEFAULT_ROOT, version = undefined) {
  const config = loadConfig(repoRoot);
  const requestedVersion = version || config.firefox.version;
  const target = sourceArchivePath(repoRoot, requestedVersion);
  const expected = requestedVersion === config.firefox.version
    ? config.firefox.source?.sha256
    : process.env.BENTO_SOURCE_SHA256;
  if (fs.existsSync(target)) {
    try {
      const digest = verifySourceArchive(target, expected);
      return { path: target, sha256: digest, version: requestedVersion, url: sourceUrl(config, requestedVersion) };
    } catch (error) {
      const quarantined = `${target}.bad-${Date.now()}`;
      await fsp.rename(target, quarantined).catch(() => undefined);
      throw error;
    }
  }
  process.stdout.write(`bento: downloading Firefox ${requestedVersion} source\n`);
  try {
    await downloadFile(sourceUrl(config, requestedVersion), target);
    const digest = verifySourceArchive(target, expected);
    return { path: target, sha256: digest, version: requestedVersion, url: sourceUrl(config, requestedVersion) };
  } catch (error) {
    if (fs.existsSync(target)) {
      const quarantined = `${target}.bad-${Date.now()}`;
      await fsp.rename(target, quarantined).catch(() => undefined);
    }
    throw error;
  }
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout || '';
}

async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      stdio: options.stdio || 'inherit',
      shell: options.shell || false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed (${code ?? signal})`));
    });
  });
}

function git(ctx, args, options = {}) {
  return runSync('git', args, { cwd: options.cwd || ctx.engineDir, stdio: options.stdio });
}

function engineIsGit(ctx) {
  return fs.existsSync(path.join(ctx.engineDir, '.git'));
}

function tryRealpath(target) {
  for (const resolver of [fs.realpathSync.native, fs.realpathSync]) {
    if (typeof resolver !== 'function') continue;
    try {
      return resolver(target);
    } catch {
      // Try the portable resolver before falling back to the lexical path.
    }
  }
  return undefined;
}

function canonicalPath(target) {
  const absolute = path.resolve(target);
  const canonical = tryRealpath(absolute)
    || path.join(tryRealpath(path.dirname(absolute)) || path.dirname(absolute), path.basename(absolute));
  const normalized = path.normalize(canonical);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function linkedEngineWorktrees(ctx) {
  if (!engineIsGit(ctx)) return [];
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: ctx.engineDir,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    fail(`cannot inspect Firefox worktrees before replacing engine: ${result.stderr || ''}`.trim());
  }
  const enginePath = canonicalPath(ctx.engineDir);
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)))
    .filter((worktree) => {
      return canonicalPath(worktree) !== enginePath;
    });
}

function ensureNoLinkedEngineWorktrees(ctx, operation) {
  const worktrees = linkedEngineWorktrees(ctx);
  if (worktrees.length === 0) return;
  fail([
    `cannot ${operation}: Firefox has linked Git worktrees that would be orphaned`,
    ...worktrees.map((worktree) => `  ${worktree}`),
    'Finish or export any patch/rebase work, then remove the linked worktree before retrying.',
    `Inspect with: git -C ${ctx.engineDir} worktree list --porcelain`,
  ].join('\n'));
}

export function engineStatus(repoRoot = DEFAULT_ROOT) {
  const ctx = createContext(repoRoot);
  if (!engineIsGit(ctx)) return { exists: fs.existsSync(ctx.engineDir), git: false, dirty: false, files: [] };
  const output = git(ctx, ['status', '--porcelain', '--untracked-files=all']);
  const files = output.split('\n').filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
  const owned = new Set();
  if (fs.existsSync(ctx.overlayManifestPath)) {
    for (const entry of readJson(ctx.overlayManifestPath).entries || []) owned.add(entry.destination);
  }
  if (fs.existsSync(ctx.srcDir)) {
    const collectSources = (directory, prefix = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = `${prefix}${entry.name}`;
        if (entry.isDirectory()) collectSources(path.join(directory, entry.name), `${relative}/`);
        else if (entry.isFile() && relative !== 'README.md') owned.add(relative);
      }
    };
    collectSources(ctx.srcDir);
  }
  owned.add('browser/branding/bento/');
  for (const name of extensionNames(ctx)) owned.add(`browser/extensions/${name}/`);
  for (const prefix of [
    'browser/app/profile/firefox.js',
    'browser/extensions/moz.build',
    'mozconfig',
    '.gitignore',
  ]) owned.add(prefix);
  const configPath = path.join(ctx.root, 'bento.json');
  const displayVersion = fs.existsSync(configPath)
    ? readJson(configPath).brands?.bento?.release?.displayVersion
    : undefined;
  for (const file of ['browser/config/version.txt', 'browser/config/version_display.txt']) {
    const target = path.join(ctx.engineDir, file);
    if (displayVersion && fs.existsSync(target) && fs.readFileSync(target, 'utf8').trim() === displayVersion) owned.add(file);
  }
  if (fs.existsSync(path.join(ctx.root, 'patches'))) {
    const patchFiles = [];
    const collect = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(target);
        else if (entry.isFile() && entry.name.endsWith('.patch')) patchFiles.push(target);
      }
    };
    collect(path.join(ctx.root, 'patches'));
    for (const patch of patchFiles) {
      const content = fs.readFileSync(patch, 'utf8');
      for (const match of content.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)) owned.add(match[1]);
    }
  }
  const isOwned = (file) => [...owned].some((prefix) => prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix);
  const unrecognizedFiles = files.filter((file) => !isOwned(file));
  return { exists: true, git: true, dirty: files.length > 0, files, ownedFiles: files.filter(isOwned), unrecognizedFiles };
}

export function tarArchivePaths(archive, destination = undefined) {
  const archivePath = path.resolve(archive);
  const archiveDir = path.dirname(archivePath);
  const relativeDestination = destination === undefined
    ? undefined
    : path.relative(archiveDir, path.resolve(destination)) || '.';
  const destinationArg = relativeDestination?.replaceAll(path.sep, '/');
  if (destinationArg !== undefined && path.isAbsolute(destinationArg)) {
    fail('source archive and extraction destination must be on the same volume');
  }
  return {
    cwd: archiveDir,
    archive: path.basename(archivePath),
    destination: destinationArg,
  };
}

function archiveEntries(archive) {
  // A Firefox source archive has far more than the default 1 MiB child-process
  // output limit. Keep the listing bounded while allowing a normal source
  // tree to be inspected before extraction.
  const tarPaths = tarArchivePaths(archive);
  const listing = spawnSync('tar', ['-tf', tarPaths.archive], {
    cwd: tarPaths.cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (listing.status !== 0) fail(`unable to inspect source archive ${archive}: ${listing.stderr || ''}`.trim());
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  let root = null;
  for (const entry of entries) {
    const normalized = entry.replaceAll('\\', '/').replace(/^\.\//, '');
    if (!normalized) continue;
    if (path.posix.isAbsolute(normalized) || normalized.split('/').includes('..')) {
      fail(`source archive contains unsafe path: ${entry}`);
    }
    const [first] = normalized.split('/');
    if (first && !root) root = first;
    if (first && first !== root) fail(`source archive contains multiple top-level directories: ${entry}`);
  }
  return entries;
}

async function extractArchive(archive, destination) {
  archiveEntries(archive);
  await fsp.mkdir(destination, { recursive: true });
  const tarPaths = tarArchivePaths(archive, destination);
  const commands = process.platform === 'darwin' ? ['gtar', 'tar'] : ['tar'];
  let lastError;
  for (const command of commands) {
    const result = spawnSync(command, ['--strip-components=1', '-xf', tarPaths.archive, '-C', tarPaths.destination], {
      cwd: tarPaths.cwd,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (result.status === 0) return;
    lastError = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  }
  fail(`unable to extract ${archive}${lastError ? `\n${lastError}` : ''}`);
}

function sourceVersionFromState(ctx) {
  if (!fs.existsSync(ctx.sourceStatePath)) return undefined;
  return readJson(ctx.sourceStatePath).version;
}

function baseIdentity(ctx, ref) {
  const commitResult = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ctx.engineDir, encoding: 'utf8', stdio: 'pipe' });
  if (commitResult.status !== 0) return undefined;
  const commit = commitResult.stdout.trim();
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd: ctx.engineDir, encoding: 'utf8', stdio: 'pipe' });
  const baseTree = spawnSync('git', ['rev-parse', '--verify', `${ref}^{tree}`], { cwd: ctx.engineDir, encoding: 'utf8', stdio: 'pipe' });
  const headTree = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{tree}'], { cwd: ctx.engineDir, encoding: 'utf8', stdio: 'pipe' });
  if (head.status !== 0 || baseTree.status !== 0 || headTree.status !== 0 || head.stdout.trim() !== commit || headTree.stdout.trim() !== baseTree.stdout.trim()) {
    fail(`cannot use existing Firefox source: engine HEAD does not match pristine base ${ref}; preserve or reset the checkout before retrying`);
  }
  return { commit, tree: baseTree.stdout.trim() };
}

function ensureSourceIdentity(ctx, config, version, operation) {
  const state = fs.existsSync(ctx.sourceStatePath) ? readJson(ctx.sourceStatePath) : undefined;
  const ref = `refs/bento/firefox-base/${version}`;
  const identity = baseIdentity(ctx, ref);
  if (!identity) fail(`cannot ${operation}: missing pristine Firefox base ${ref}; run the protected source adoption path first`);
  if (!state || state.version !== version || state.baselineCommit !== identity.commit) {
    fail(`cannot ${operation}: source-state.json, configured Firefox version, and ${ref} do not agree`);
  }
  if (version === config.firefox.version && state.archiveSha256 !== config.firefox.source?.sha256) {
    fail(`cannot ${operation}: source-state.json archive digest does not match bento.json`);
  }
  return identity;
}

function baselineText(ctx, relative, config) {
  if (!engineIsGit(ctx)) return undefined;
  const version = sourceVersionFromState(ctx) || config.firefox.version;
  const ref = `refs/bento/firefox-base/${version}`;
  const result = spawnSync('git', ['show', `${ref}:${relative}`], {
    cwd: ctx.engineDir,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return result.status === 0 ? result.stdout : undefined;
}

function sourceOverlayPaths(ctx) {
  const paths = [];
  const collect = (directory, prefix = '') => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = `${prefix}${entry.name}`;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(target, `${relative}/`);
      else if (entry.isFile() && relative !== 'README.md') paths.push(relative);
    }
  };
  collect(ctx.srcDir);
  return paths;
}

function extensionNames(ctx) {
  const root = path.join(ctx.root, 'extensions');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && fs.existsSync(path.join(root, entry.name, 'manifest.json')))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function generatedBrowserExtensionsMozBuild(ctx, config) {
  const baseline = baselineText(ctx, 'browser/extensions/moz.build', config);
  if (baseline === undefined) return undefined;
  let base = baseline;
  base = base.replace(/\n?# BEGIN BENTO BUILTIN ADDONS[\s\S]*?# END BENTO BUILTIN ADDONS\n?/g, '\n');
  base = base.replace(/^DIRS \+= \["bento-shell", "bento-tools", "ublock-origin"\]\r?\n?/m, '');
  base = base.trimEnd();
  const names = extensionNames(ctx).map((name) => `"${name}"`).join(', ');
  return `${base}\n\n# BEGIN BENTO BUILTIN ADDONS\nDIRS += [${names}]\n# END BENTO BUILTIN ADDONS\n`;
}

function generatedGitignore(ctx, config) {
  const baseline = baselineText(ctx, '.gitignore', config);
  if (baseline === undefined) return undefined;
  const managed = sourceOverlayPaths(ctx);
  const base = baseline.replace(/\r?\n+$/, '');
  const existing = new Set(base.split(/\r?\n/));
  const missing = managed.filter((relative) => !existing.has(relative));
  return missing.length ? `${base}\n${missing.join('\n')}\n` : baseline;
}

function generatedMozconfigText(ctx, config, mode) {
  const platformName = platformConfigName();
  const platformPath = path.join(ctx.root, 'configs', platformName, 'mozconfig');
  if (!fs.existsSync(platformPath)) fail(`missing ${path.relative(ctx.root, platformPath)}`);
  const selectedMode = mode || process.env.BENTO_BUILD_MODE || config.build.mode;
  if (!['dev', 'debug', 'release'].includes(selectedMode)) fail(`unsupported build mode ${selectedMode}`);
  const lines = [
    '# This file is generated by scripts/bento-build.mjs. Edit configs/ or mozconfig instead.',
    fs.readFileSync(platformPath, 'utf8').trimEnd(),
    '',
    `# Bento ${selectedMode} build settings`,
  ];
  if (selectedMode === 'dev') lines.push('ac_add_options --disable-debug');
  if (selectedMode === 'debug') lines.push('ac_add_options --enable-debug', 'ac_add_options --disable-optimize');
  if (selectedMode === 'release') lines.push('ac_add_options --disable-debug', 'ac_add_options --enable-optimize', 'ac_add_options --enable-rust-simd');
  lines.push(
    '',
    `ac_add_options --with-branding=browser/branding/${config.brand}`,
    `ac_add_options --enable-update-channel=${config.updates.channel}`,
    `export ACCEPTED_MAR_CHANNEL_IDS=${config.updates.channel}`,
    `export MAR_CHANNEL_ID=${config.updates.channel}`,
    `mk_add_options ACCEPTED_MAR_CHANNEL_IDS=${config.updates.channel}`,
    `export BENTO_FIREFOX_VERSION=${config.firefox.version}`,
    `export MOZ_APPUPDATE_HOST=${config.updates.hostname}`,
  );
  if (process.platform === 'darwin') lines.push(`export MOZ_MACBUNDLE_NAME="${config.build.macosBundleName || 'Bento'}.app"`);
  const customPath = path.join(ctx.root, 'mozconfig');
  if (fs.existsSync(customPath)) lines.push('', fs.readFileSync(customPath, 'utf8').trimEnd());
  return `${lines.join('\n')}\n`;
}

function legacyMozconfigText(ctx, config) {
  const commonPath = path.join(ctx.root, 'configs', 'common', 'mozconfig');
  const platformPath = path.join(ctx.root, 'configs', platformConfigName(), 'mozconfig');
  if (!fs.existsSync(commonPath) || !fs.existsSync(platformPath)) return undefined;
  const platform = fs.readFileSync(platformPath, 'utf8').trim();
  const legacyVersionVariable = `${String.fromCharCode(90, 69, 78)}_FIREFOX_VERSION`;
  const lines = [
    '# This file is automatically generated. You should only modify this if you know what you are doing!',
    '',
    fs.readFileSync(commonPath, 'utf8').trimEnd(),
    '',
    '',
    platform,
    '',
    '',
    '',
    '',
    '# =====================',
    '# Internal build config',
    '# =====================',
    '',
    '# Release build settings',
    'ac_add_options --disable-debug',
    'ac_add_options --enable-optimize',
    'ac_add_options --enable-rust-simd',
    '',
    '# Custom branding',
    `ac_add_options --with-branding=browser/branding/${config.brand}`,
    '',
    '# Config for updates',
    `ac_add_options --enable-update-channel=${config.updates.channel}`,
    '',
    `export ACCEPTED_MAR_CHANNEL_IDS=${config.updates.channel}`,
    `export MAR_CHANNEL_ID=${config.updates.channel}`,
    '',
    `mk_add_options ACCEPTED_MAR_CHANNEL_IDS=${config.updates.channel}`,
    '',
    `export ${legacyVersionVariable}=${config.firefox.version}`,
    `export MOZ_APPUPDATE_HOST=${config.updates.hostname}`,
    '',
    '',
    '# MacOS specific settings',
  ];
  if (platformConfigName() === 'macos') lines.push(`export MOZ_MACBUNDLE_NAME="${config.build.macosBundleName || 'Bento'}.app"`);
  return `${lines.join('\n')}\n`;
}

function sameKnownFinalNewline(actual, expected) {
  const normalize = (value) => value.replaceAll('\r\n', '\n').replace(/\n$/, '');
  return normalize(actual) === normalize(expected);
}

function isGeneratedMozconfig(ctx, config, target) {
  const actual = fs.readFileSync(target, 'utf8');
  const normalizedLegacy = actual.replace(/^# Internal [A-Za-z]+ config$/m, '# Internal build config');
  const withoutLegacyTrailingSpaces = normalizedLegacy.endsWith('\n  ')
    ? normalizedLegacy.slice(0, -2)
    : normalizedLegacy;
  return ['dev', 'debug', 'release'].some((mode) => actual === generatedMozconfigText(ctx, config, mode))
    || sameKnownFinalNewline(withoutLegacyTrailingSpaces, legacyMozconfigText(ctx, config) || '');
}

const DEFAULT_RUNTIME_ENTRIES = [
  'manifest.json', 'chrome.manifest', 'dist', 'experiments', 'icons', '_locales',
  'background.html', 'background.js', 'options.html', 'popup.html',
];

function addonRuntimeEntries(ctx, name) {
  const root = path.join(ctx.root, 'extensions', name);
  const configPath = path.join(root, '.bento-runtime-entries.json');
  const entries = fs.existsSync(configPath) ? readJson(configPath) : DEFAULT_RUNTIME_ENTRIES;
  return [...new Set([...entries, 'manifest.json'])].sort((left, right) => left.localeCompare(right));
}

function addonRuntimeFiles(ctx, name) {
  const root = path.join(ctx.root, 'extensions', name);
  const files = [];
  const collect = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = `${prefix}${entry.name}`;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(target, `${relative}/`);
      else if (entry.isFile()) files.push(relative);
    }
  };
  for (const entry of addonRuntimeEntries(ctx, name)) {
    const target = path.join(root, entry);
    if (fs.existsSync(target)) {
      if (fs.statSync(target).isDirectory()) collect(target, `${entry}/`);
      else if (fs.statSync(target).isFile()) files.push(entry);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function generatedAddonFiles(ctx, name) {
  const manifest = readJson(path.join(ctx.root, 'extensions', name, 'manifest.json'));
  const id = manifest.applications?.gecko?.id || manifest.browser_specific_settings?.gecko?.id;
  const jar = ['browser.jar:', ...addonRuntimeFiles(ctx, name).map((file) => `    builtin-addons/${name}/${file} (${file})`), ''].join('\n');
  const mozBuild = `# This Source Code Form is subject to the terms of the Mozilla Public\n# License, v. 2.0. If a copy of the MPL was not distributed with this\n# file, You can obtain one at https://mozilla.org/MPL/2.0/.\n\n# Bento built-in add-on: ${name} (${id})\nDEFINES["MOZ_APP_VERSION"] = CONFIG["MOZ_APP_VERSION"]\nDEFINES["MOZ_APP_MAXVERSION"] = CONFIG["MOZ_APP_MAXVERSION"]\n\nJAR_MANIFESTS += ["jar.mn"]\n`;
  return { jar, mozBuild };
}

function ensureCleanEngine(ctx, operation) {
  const status = engineStatus(ctx.root);
  if (status.exists && !status.git) {
    fail(`cannot ${operation}: engine is not a Git checkout; preserve it before updating`);
  }
  const files = [...new Set([...status.files, ...managedEnginePaths(ctx)])];
  const hasRecordedState = fs.existsSync(path.join(ctx.stateDir, 'engine-state.json'));
  const valid = hasRecordedState ? verifyRecordedEngineState(ctx.root) : !files.length || verifyManagedEngine(ctx, files);
  if (status.exists && (files.length || hasRecordedState) && !valid) {
    const details = status.files.slice(0, 8).join(', ');
    fail(`cannot ${operation}: engine contains unrecognized user changes${details ? ` (${details})` : ''}. Preserve or export them through the Bento patch workflow before updating it.`);
  }
}

export function verifyManagedEngine(ctx, files) {
  const config = loadConfig(ctx.root);
  const overlayManifest = fs.existsSync(ctx.overlayManifestPath) ? readJson(ctx.overlayManifestPath) : undefined;
  const overlayEntries = new Map((overlayManifest?.entries || []).map((entry) => [entry.destination, entry]));
  const sourceExact = (relative) => {
    const source = path.join(ctx.srcDir, relative);
    const target = path.join(ctx.engineDir, relative);
    if (!fs.existsSync(source) || !targetExistsSync(target)) return false;
    const stat = fs.lstatSync(target);
    return stat.isSymbolicLink()
      ? fs.readlinkSync(target) === source
      : stat.isFile() && sha256File(target) === sha256File(source);
  };
  const brandingExact = (relative) => {
    const source = path.join(ctx.root, 'branding', 'bento', relative.replace(/^browser\/branding\/bento\//, ''));
    const target = path.join(ctx.engineDir, relative);
    if (!fs.existsSync(source) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
    const expected = fs.readFileSync(source, 'utf8');
    let actual = fs.readFileSync(target, 'utf8');
    const marker = '// === Bento defaults (appended from prefs/bento.js) ===';
    if (relative.endsWith('pref/firefox-branding.js')) {
      const markerIndex = actual.indexOf(marker);
      if (markerIndex < 0) return actual === expected;
      const base = actual.slice(0, markerIndex).trimEnd() + '\n';
      const suffix = actual.slice(markerIndex);
      return base === expected && suffix === `${marker}\n${fs.readFileSync(ctx.root + '/prefs/bento.js', 'utf8')}`;
    }
    return actual === expected;
  };
  const addonExact = (relative) => {
    const match = /^browser\/extensions\/([^/]+)\/(.+)$/.exec(relative);
    if (!match) return false;
    const source = path.join(ctx.root, 'extensions', match[1], match[2]);
    const target = path.join(ctx.engineDir, relative);
    if (fs.existsSync(source) && fs.existsSync(target) && fs.statSync(source).isFile() && fs.statSync(target).isFile()) {
      return sha256File(source) === sha256File(target);
    }
    if (match[2] === 'moz.build' || match[2] === 'jar.mn') {
      const generated = generatedAddonFiles(ctx, match[1]);
      return fs.readFileSync(target, 'utf8') === generated[match[2] === 'moz.build' ? 'mozBuild' : 'jar'];
    }
    return false;
  };
  const patchPaths = new Set();
  const manifestPath = path.join(ctx.root, 'patches', 'series.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = readJson(manifestPath);
    for (const entry of manifest.series || []) {
      const patch = path.join(ctx.root, entry.path);
      if (!fs.existsSync(patch)) continue;
      for (const match of fs.readFileSync(patch, 'utf8').matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)) patchPaths.add(match[1]);
    }
  }
  let expectedWorktree;
  let expectedFiles;
  const patchFiles = files.filter((file) => patchPaths.has(file));
  if (patchFiles.length) {
    const version = sourceVersionFromState(ctx) || config.firefox.version;
    const ref = `refs/bento/firefox-base/${version}`;
    const check = spawnSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ctx.engineDir, stdio: 'ignore' });
    if (check.status !== 0) return false;
    expectedWorktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-managed-check-'));
    try {
      runSync('git', ['worktree', 'add', '--detach', expectedWorktree, ref], { cwd: ctx.engineDir });
      const manifest = readJson(manifestPath);
      for (const entry of manifest.series || []) runSync('git', ['apply', '--ignore-space-change', '--ignore-whitespace', path.join(ctx.root, entry.path)], { cwd: expectedWorktree });
      expectedFiles = new Map(patchFiles.map((file) => [file, path.join(expectedWorktree, file)]));
    } catch {
      if (expectedWorktree) runSync('git', ['worktree', 'remove', '--force', expectedWorktree], { cwd: ctx.engineDir, stdio: 'ignore' });
      fs.rmSync(expectedWorktree, { recursive: true, force: true });
      return false;
    }
  }
  try {
    return files.every((relative) => {
      if (expectedFiles?.has(relative)) {
        const expected = expectedFiles.get(relative);
        const target = path.join(ctx.engineDir, relative);
        return fs.existsSync(expected) && fs.existsSync(target) && sha256File(expected) === sha256File(target);
      }
      if (overlayEntries.has(relative) || fs.existsSync(path.join(ctx.srcDir, relative))) return sourceExact(relative);
      if (relative.startsWith('browser/branding/bento/')) return brandingExact(relative);
      if (relative.startsWith('browser/extensions/')) return addonExact(relative);
      if (relative === 'browser/app/profile/firefox.js') return managedPrefsExact(ctx, relative);
      if (relative === 'browser/config/version.txt' || relative === 'browser/config/version_display.txt') {
        return fs.readFileSync(path.join(ctx.engineDir, relative), 'utf8') === config.brands.bento.release.displayVersion;
      }
      if (relative === 'browser/extensions/moz.build') {
        const expected = generatedBrowserExtensionsMozBuild(ctx, config);
        return expected !== undefined && fs.readFileSync(path.join(ctx.engineDir, relative), 'utf8') === expected;
      }
      if (relative === 'mozconfig') {
        return isGeneratedMozconfig(ctx, config, path.join(ctx.engineDir, relative));
      }
      if (relative === '.gitignore') {
        const expected = generatedGitignore(ctx, config);
        return expected !== undefined && sameKnownFinalNewline(fs.readFileSync(path.join(ctx.engineDir, relative), 'utf8'), expected);
      }
      return false;
    });
  } finally {
    if (expectedWorktree) {
      runSync('git', ['worktree', 'remove', '--force', expectedWorktree], { cwd: ctx.engineDir, stdio: 'ignore' });
      fs.rmSync(expectedWorktree, { recursive: true, force: true });
    }
  }
}

function managedPrefsExact(ctx, relative) {
  const config = loadConfig(ctx.root);
  const target = path.join(ctx.engineDir, relative);
  const source = path.join(ctx.root, 'prefs', 'bento.js');
  const marker = '// === Bento defaults (appended from prefs/bento.js) ===';
  if (!fs.existsSync(target) || !fs.existsSync(source)) return false;
  const actual = fs.readFileSync(target, 'utf8');
  const markerIndex = actual.indexOf(marker);
  if (markerIndex < 0) return false;
  const baseline = baselineText(ctx, relative, config);
  if (baseline === undefined) return false;
  const base = actual.slice(0, markerIndex).trimEnd() + '\n';
  const suffix = actual.slice(markerIndex);
  return base === baseline && suffix === `${marker}\n${fs.readFileSync(source, 'utf8')}`;
}

function managedPatchPaths(ctx) {
  const paths = new Set();
  const manifestPath = path.join(ctx.root, 'patches', 'series.json');
  if (!fs.existsSync(manifestPath)) return paths;
  for (const entry of readJson(manifestPath).series || []) {
    const patch = path.join(ctx.root, entry.path);
    if (!fs.existsSync(patch)) continue;
    for (const match of fs.readFileSync(patch, 'utf8').matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)) paths.add(match[1]);
  }
  return paths;
}

function managedEnginePaths(ctx) {
  const paths = new Set();
  const add = (relative) => {
    if (targetExistsSync(path.join(ctx.engineDir, relative))) paths.add(relative);
  };
  const addWhen = (relative, predicate) => {
    const target = path.join(ctx.engineDir, relative);
    if (targetExistsSync(target) && predicate(target)) paths.add(relative);
  };
  for (const relative of sourceOverlayPaths(ctx)) add(relative);
  const addTree = (root, prefix) => {
    if (!fs.existsSync(root)) return;
    const walk = (directory, current = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = `${current}${entry.name}`;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(target, `${relative}/`);
        else if (entry.isFile()) add(`${prefix}${relative}`);
      }
    };
    walk(root);
  };
  addTree(path.join(ctx.root, 'branding', 'bento'), 'browser/branding/bento/');
  for (const name of extensionNames(ctx)) {
    addTree(path.join(ctx.root, 'extensions', name), `browser/extensions/${name}/`);
    add(`browser/extensions/${name}/jar.mn`);
    add(`browser/extensions/${name}/moz.build`);
  }
  for (const relative of [
    'browser/app/profile/firefox.js',
  ]) addWhen(relative, (target) => fs.readFileSync(target, 'utf8').includes('// === Bento defaults (appended from prefs/bento.js) ==='));
  const config = loadConfig(ctx.root);
  for (const relative of ['browser/config/version.txt', 'browser/config/version_display.txt']) {
    addWhen(relative, (target) => fs.readFileSync(target, 'utf8') === config.brands[config.brand].release.displayVersion);
  }
  addWhen('browser/extensions/moz.build', (target) => fs.readFileSync(target, 'utf8').includes('# BEGIN BENTO BUILTIN ADDONS'));
  addWhen('mozconfig', (target) => {
    return isGeneratedMozconfig(ctx, config, target);
  });
  return paths;
}

export function recordEngineState(repoRoot = DEFAULT_ROOT) {
  const ctx = createContext(repoRoot);
  const status = engineStatus(repoRoot);
  if (!status.git) fail('cannot record engine state without an engine Git checkout');
  if (status.unrecognizedFiles?.length) {
    fail(`cannot record unrecognized engine changes: ${status.unrecognizedFiles.slice(0, 8).join(', ')}`);
  }
  const paths = new Set([...status.files, ...managedEnginePaths(ctx)]);
  const sourcePaths = new Set(sourceOverlayPaths(ctx));
  const patchPaths = managedPatchPaths(ctx);
  const stateEntryKind = (relative) => {
    if (sourcePaths.has(relative)) return 'overlay';
    if (patchPaths.has(relative)) return 'patch';
    if (relative.startsWith('browser/branding/bento/')) return 'branding';
    if (relative.startsWith('browser/extensions/')) return 'addon';
    return 'generated';
  };
  const entries = [...paths].sort().map((relative) => {
    const target = path.join(ctx.engineDir, relative);
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return { path: relative, kind: stateEntryKind(relative), missing: true };
    return stat.isSymbolicLink()
      ? { path: relative, kind: stateEntryKind(relative), type: 'symlink', linkTarget: fs.readlinkSync(target) }
      : { path: relative, kind: stateEntryKind(relative), type: 'file', sha256: sha256File(target) };
  });
  writeJson(path.join(ctx.stateDir, 'engine-state.json'), { schemaVersion: 1, baseline: sourceVersionFromState(ctx), entries });
  return entries.length;
}

export function verifyRecordedEngineState(repoRoot = DEFAULT_ROOT) {
  const ctx = createContext(repoRoot);
  const status = engineStatus(repoRoot);
  if (!status.git) return false;
  const statePath = path.join(ctx.stateDir, 'engine-state.json');
  if (!fs.existsSync(statePath)) return verifyManagedEngine(ctx, status.files);
  const state = readJson(statePath);
  const snapshot = new Map((state.entries || []).map((entry) => [entry.path, entry]));
  const currentManaged = new Set([
    ...sourceOverlayPaths(ctx),
    ...managedEnginePaths(ctx),
    ...managedPatchPaths(ctx),
  ]);
  const paths = new Set([...status.files, ...snapshot.keys()]);
  for (const relative of paths) {
    const expected = snapshot.get(relative);
    const target = path.join(ctx.engineDir, relative);
    if (!expected) {
      // A newly introduced source file is safe only when its current generated
      // output already matches the source. Any other new dirty path is a user
      // edit and must be preserved before import can reset the engine.
      if (!currentManaged.has(relative) || !targetExistsSync(target)) return false;
      if (fs.existsSync(path.join(ctx.srcDir, relative))) {
        const source = path.join(ctx.srcDir, relative);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) {
          if (fs.readlinkSync(target) !== source) return false;
        } else if (!stat.isFile() || sha256File(target) !== sha256File(source)) return false;
      } else {
        return false;
      }
      continue;
    }
    if (expected.missing) {
      if (targetExistsSync(target)) return false;
      continue;
    }
    if (!targetExistsSync(target)) {
      // Removing an overlay from the repository is a supported input change;
      // the importer will remove its old generated output after preflight.
      if (expected.kind === 'overlay' && !fs.existsSync(path.join(ctx.srcDir, relative))) continue;
      if (expected.kind === 'patch' && !managedPatchPaths(ctx).has(relative)) continue;
      return false;
    }
    const stat = fs.lstatSync(target);
    if (expected.type === 'symlink') {
      if (!stat.isSymbolicLink() || fs.readlinkSync(target) !== expected.linkTarget) return false;
    } else if (!stat.isFile() || sha256File(target) !== expected.sha256) return false;
  }
  return status.unrecognizedFiles.length === 0;
}

function targetExistsSync(target) {
  return fs.existsSync(target) || Boolean(fs.lstatSync(target, { throwIfNoEntry: false }));
}

async function initializeEngine(ctx, version, archiveInfo, destination) {
  await run('git', ['init'], { cwd: destination });
  await run('git', ['config', 'user.name', 'Bento Firefox Source'], { cwd: destination });
  await run('git', ['config', 'user.email', 'source@bentobrowser.invalid'], { cwd: destination });
  await run('git', ['add', '-f', '.'], { cwd: destination });
  await run('git', ['commit', '-m', `Firefox ${version}`], { cwd: destination });
  const commit = git(ctx, ['-C', destination, 'rev-parse', 'HEAD'], { cwd: ctx.root }).trim();
  await run('git', ['update-ref', `refs/bento/firefox-base/${version}`, commit], { cwd: destination });
  writeJson(ctx.sourceStatePath, {
    schemaVersion: 1,
    product: ctx.config?.firefox?.product || 'firefox',
    version,
    archive: archiveInfo.path,
    archiveSha256: archiveInfo.sha256,
    sourceUrl: archiveInfo.url,
    baselineCommit: commit,
  });
  return commit;
}

function bentoRefNames(engineDir) {
  const result = spawnSync('git', ['for-each-ref', '--format=%(refname)', 'refs/bento', 'refs/heads/bento/patch-stack'], {
    cwd: engineDir,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) fail(`cannot inventory Bento Git refs before source replacement: ${result.stderr || ''}`.trim());
  return [...new Set(result.stdout.split(/\r?\n/).map((ref) => ref.trim()).filter(Boolean))];
}

async function preserveBentoRefs(sourceDir, destination, refs, currentVersion) {
  const currentBase = `refs/bento/firefox-base/${currentVersion}`;
  for (const ref of refs) {
    // initializeEngine has just created the authoritative base for this
    // version. Keep it even when a prior checkout had a stale same-version ref.
    if (ref === currentBase) continue;
    await run('git', ['fetch', '--no-tags', sourceDir, `+${ref}:${ref}`], { cwd: destination });
  }
}

async function installSource(ctx, archiveInfo, { replace = false } = {}) {
  if (fs.existsSync(ctx.engineDir)) {
    const entries = await fsp.readdir(ctx.engineDir);
    if (entries.length > 0 && !replace) {
      if (engineStatus(ctx.root).git && !engineStatus(ctx.root).dirty) {
        return { reused: true, commit: git(ctx, ['rev-parse', 'HEAD']) };
      }
      fail('engine already exists; preserve or export engine changes through the Bento patch workflow before updating it');
    }
  }

  const stagingRoot = await fsp.mkdtemp(path.join(ctx.stateDir, 'source-'));
  const sourceDir = path.join(stagingRoot, 'firefox');
  try {
    await extractArchive(archiveInfo.path, sourceDir);
  } catch (error) {
    await fsp.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  if (!fs.existsSync(path.join(sourceDir, 'toolkit', 'moz.build'))) {
    await fsp.rm(stagingRoot, { recursive: true, force: true });
    fail('Firefox source archive did not contain toolkit/moz.build');
  }

  let backup;
  let engineReplaced = false;
  const previousStateFiles = new Map();
  for (const file of [ctx.sourceStatePath, path.join(ctx.stateDir, 'engine-state.json'), ctx.overlayManifestPath]) {
    if (fs.existsSync(file)) previousStateFiles.set(file, fs.readFileSync(file));
  }
  let priorRefs = [];
  try {
    if (fs.existsSync(ctx.engineDir)) {
      ensureNoLinkedEngineWorktrees(ctx, 'replace Firefox source');
      priorRefs = bentoRefNames(ctx.engineDir);
      await fsp.mkdir(ctx.backupDir, { recursive: true });
      const oldVersion = sourceVersionFromState(ctx) || 'unknown';
      backup = path.join(ctx.backupDir, `firefox-${oldVersion}-${Date.now()}`);
      await fsp.rename(ctx.engineDir, backup);
      engineReplaced = true;
    }
    await fsp.rename(sourceDir, ctx.engineDir);
    engineReplaced = true;
    ctx.config = loadConfig(ctx.root);
    const commit = await initializeEngine(ctx, archiveInfo.version, archiveInfo, ctx.engineDir);
    if (backup && priorRefs.length) await preserveBentoRefs(backup, ctx.engineDir, priorRefs, archiveInfo.version);
    await fsp.rm(path.join(ctx.stateDir, 'engine-state.json'), { force: true });
    await fsp.rm(ctx.overlayManifestPath, { force: true });
    await fsp.rm(stagingRoot, { recursive: true, force: true });
    return { reused: false, backup, commit, preservedRefs: priorRefs.filter((ref) => ref !== `refs/bento/firefox-base/${archiveInfo.version}`) };
  } catch (error) {
    if (engineReplaced && fs.existsSync(ctx.engineDir)) await fsp.rm(ctx.engineDir, { recursive: true, force: true });
    if (backup && fs.existsSync(backup)) await fsp.rename(backup, ctx.engineDir);
    for (const file of [ctx.sourceStatePath, path.join(ctx.stateDir, 'engine-state.json'), ctx.overlayManifestPath]) {
      if (previousStateFiles.has(file)) fs.writeFileSync(file, previousStateFiles.get(file));
      else await fsp.rm(file, { force: true });
    }
    await fsp.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function commandDownload(ctx, version, force) {
  const config = loadConfig(ctx.root);
  const existing = engineStatus(ctx.root);
  const requestedVersion = version || config.firefox.version;
  if (existing.exists && !force) {
    if (existing.git && sourceVersionFromState(ctx) === requestedVersion) {
      ensureSourceIdentity(ctx, config, requestedVersion, 'reuse Firefox source');
      process.stdout.write(`bento: Firefox ${requestedVersion} source already installed\n`);
      return;
    }
    if (existing.git && !sourceVersionFromState(ctx) && adoptExistingSource(ctx, config, requestedVersion)) {
      process.stdout.write(`bento: adopted existing Firefox ${requestedVersion} baseline\n`);
      return;
    }
    if (existing.git || existing.files.length > 0) {
      fail('engine already exists; use `pnpm run firefox:sync` for a protected source update');
    }
  }
  if (force) ensureCleanEngine(ctx, 'replace Firefox source');
  const archiveInfo = await acquireSourceArchive(ctx.root, requestedVersion);
  await installSource(ctx, archiveInfo, { replace: force });
  process.stdout.write(`bento: installed Firefox ${archiveInfo.version} source\n`);
}

export function adoptExistingSource(ctx, config, version) {
  const ref = `refs/bento/firefox-base/${version}`;
  const identity = baseIdentity(ctx, ref);
  if (!identity) return false;
  const commit = identity.commit;
  const status = engineStatus(ctx.root);
  const files = [...new Set([...status.files, ...managedEnginePaths(ctx)])];
  const statePath = path.join(ctx.stateDir, 'engine-state.json');
  const valid = fs.existsSync(statePath) ? verifyRecordedEngineState(ctx.root) : !files.length || verifyManagedEngine(ctx, files);
  if ((files.length || fs.existsSync(statePath)) && !valid) {
    fail(`cannot adopt existing Firefox source with unverified changes: ${status.files.slice(0, 8).join(', ')}`);
  }
  const engineStatePath = path.join(ctx.stateDir, 'engine-state.json');
  const previousSourceState = fs.existsSync(ctx.sourceStatePath) ? fs.readFileSync(ctx.sourceStatePath) : undefined;
  const previousEngineState = fs.existsSync(engineStatePath) ? fs.readFileSync(engineStatePath) : undefined;
  try {
    writeJson(ctx.sourceStatePath, {
      schemaVersion: 1,
      product: config.firefox.product,
      version,
      baselineCommit: commit,
      archiveSha256: version === config.firefox.version ? config.firefox.source?.sha256 : undefined,
      sourceUrl: sourceUrl(config, version),
      adopted: true,
    });
    // Preserve the validated legacy/generated bytes as the ownership baseline.
    // Future imports can then compare against this snapshot even after source
    // inputs change, instead of reconstructing the old output from new inputs.
    recordEngineState(ctx.root);
  } catch (error) {
    if (previousSourceState !== undefined) fs.writeFileSync(ctx.sourceStatePath, previousSourceState);
    else fs.rmSync(ctx.sourceStatePath, { force: true });
    if (previousEngineState !== undefined) fs.writeFileSync(engineStatePath, previousEngineState);
    else fs.rmSync(engineStatePath, { force: true });
    throw error;
  }
  return true;
}

async function latestFirefoxVersion(product) {
  const target = {
    firefox: 'LATEST_FIREFOX_VERSION',
    'firefox-beta': 'LATEST_FIREFOX_DEVEL_VERSION',
    'firefox-esr': 'FIREFOX_ESR',
    'firefox-nightly': 'FIREFOX_NIGHTLY',
  }[product];
  if (!target) fail(`unsupported Firefox product: ${product}`);
  const response = await fetch('https://product-details.mozilla.org/1.0/firefox_versions.json');
  if (!response.ok) fail(`Mozilla version lookup failed with HTTP ${response.status}`);
  const value = (await response.json())[target];
  if (!value) fail(`Mozilla version response did not include ${target}`);
  return value;
}

async function commandUpdate(ctx) {
  const config = loadConfig(ctx.root);
  const version = await latestFirefoxVersion(config.firefox.product);
  if (version === config.firefox.version) {
    if (engineIsGit(ctx)) {
      if (!sourceVersionFromState(ctx)) adoptExistingSource(ctx, config, config.firefox.version);
      ensureSourceIdentity(ctx, config, config.firefox.version, 'check Firefox source');
    }
    process.stdout.write(`bento: Firefox ${version} is already current\n`);
    return;
  }
  if (!sourceVersionFromState(ctx) && engineIsGit(ctx)) adoptExistingSource(ctx, config, config.firefox.version);
  if (engineIsGit(ctx)) ensureSourceIdentity(ctx, config, config.firefox.version, 'update Firefox source');
  ensureCleanEngine(ctx, 'update Firefox source');
  const archiveInfo = await acquireSourceArchive(ctx.root, version);
  const previous = config.firefox.version;
  const previousConfig = fs.readFileSync(ctx.configPath, 'utf8');
  const previousSourceState = fs.existsSync(ctx.sourceStatePath) ? fs.readFileSync(ctx.sourceStatePath, 'utf8') : undefined;
  const engineStatePath = path.join(ctx.stateDir, 'engine-state.json');
  const previousEngineState = fs.existsSync(engineStatePath) ? fs.readFileSync(engineStatePath, 'utf8') : undefined;
  const previousOverlayManifest = fs.existsSync(ctx.overlayManifestPath) ? fs.readFileSync(ctx.overlayManifestPath, 'utf8') : undefined;
  const versionsPath = path.join(ctx.root, 'config', 'firefox-versions.json');
  const previousVersions = fs.existsSync(versionsPath) ? fs.readFileSync(versionsPath, 'utf8') : undefined;
  const result = await installSource(ctx, archiveInfo, { replace: true });
  const updated = {
    ...config,
    firefox: {
      ...config.firefox,
      version,
      candidate: version,
      candidateBuild: 1,
      source: { ...config.firefox.source, sha256: archiveInfo.sha256 },
    },
  };
  try {
    writeJson(ctx.configPath, updated);
    if (fs.existsSync(versionsPath)) {
      const versions = readJson(versionsPath);
      const release = versions.channels?.find((entry) => entry.channel === 'release');
      if (release) {
        release.version = version;
        release.bentoConfig = 'bento.json';
        writeJson(versionsPath, versions);
      }
    }
  } catch (error) {
    await fsp.rm(ctx.engineDir, { recursive: true, force: true });
    if (result.backup && fs.existsSync(result.backup)) await fsp.rename(result.backup, ctx.engineDir);
    fs.writeFileSync(ctx.configPath, previousConfig);
    if (previousVersions !== undefined) fs.writeFileSync(versionsPath, previousVersions);
    if (previousSourceState !== undefined) fs.writeFileSync(ctx.sourceStatePath, previousSourceState);
    else await fsp.rm(ctx.sourceStatePath, { force: true });
    if (previousEngineState !== undefined) fs.writeFileSync(engineStatePath, previousEngineState);
    else await fsp.rm(engineStatePath, { force: true });
    if (previousOverlayManifest !== undefined) fs.writeFileSync(ctx.overlayManifestPath, previousOverlayManifest);
    else await fsp.rm(ctx.overlayManifestPath, { force: true });
    throw error;
  }
  process.stdout.write(`bento: updated Firefox ${previous} -> ${version}; previous source is recoverable at ${result.backup}\n`);
}

function platformConfigName() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  fail(`unsupported host platform ${process.platform}`);
}

export function writeMozconfig(repoRoot = DEFAULT_ROOT, mode = undefined) {
  const ctx = createContext(repoRoot);
  const config = loadConfig(repoRoot);
  const platformName = platformConfigName();
  const selectedMode = mode || process.env.BENTO_BUILD_MODE || config.build.mode;
  const content = generatedMozconfigText(ctx, config, selectedMode);
  const destination = path.join(ctx.engineDir, 'mozconfig');
  fs.writeFileSync(destination, content);
  for (const file of ['browser/config/version.txt', 'browser/config/version_display.txt']) {
    const target = path.join(ctx.engineDir, file);
    if (fs.existsSync(target)) fs.writeFileSync(target, config.brands[config.brand].release.displayVersion);
  }
  return { destination, mode: selectedMode, platform: platformName };
}

function requireEngine(ctx) {
  if (!fs.existsSync(path.join(ctx.engineDir, 'mach'))) fail('engine/mach is missing; run pnpm run download first');
}

async function commandBootstrap(ctx) {
  requireEngine(ctx);
  await run('bash', ['scripts/mach-raw.sh', 'bootstrap', '--application-choice', 'browser'], { cwd: ctx.root });
}

async function commandBuild(ctx, ui, jobs) {
  requireEngine(ctx);
  const generated = writeMozconfig(ctx.root);
  const args = ['build'];
  if (ui) args.push('faster');
  if (jobs !== undefined) args.push(`-j${jobs}`);
  await run('bash', ['scripts/mach-raw.sh', ...args], {
    cwd: ctx.root,
    env: {
      ACCEPTED_MAR_CHANNEL_IDS: loadConfig(ctx.root).updates.channel,
      MAR_CHANNEL_ID: loadConfig(ctx.root).updates.channel,
    },
  });
  process.stdout.write(`bento: ${generated.mode} ${ui ? 'UI ' : ''}build complete\n`);
}

function readLocales(ctx, config) {
  const source = path.join(ctx.root, config.locales.supportedLanguages);
  const mapsPath = path.join(ctx.root, config.locales.languageMaps);
  if (!fs.existsSync(source)) fail(`missing ${path.relative(ctx.root, source)}`);
  const mappings = new Map();
  if (fs.existsSync(mapsPath)) {
    for (const line of fs.readFileSync(mapsPath, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const [from, to] = line.split(':', 2).map((part) => part.trim());
      if (from && to) mappings.set(from, to);
    }
  }
  return fs.readFileSync(source, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((locale) => mappings.get(locale) || locale);
}

function objDirs(ctx) {
  if (!fs.existsSync(ctx.engineDir)) return [];
  const candidates = fs.readdirSync(ctx.engineDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && entry.name.startsWith('obj-')).map((entry) => path.join(ctx.engineDir, entry.name));
  if (candidates.length <= 1) return candidates;
  const requested = process.env.BENTO_OBJDIR && path.resolve(ctx.engineDir, process.env.BENTO_OBJDIR);
  if (requested && candidates.includes(requested)) return [requested];
  fail(`multiple Firefox object directories found; set BENTO_OBJDIR to one of ${candidates.map((candidate) => path.basename(candidate)).join(', ')}`);
}

function copyDirectoryFiles(ctx, objDist) {
  fs.mkdirSync(ctx.distDir, { recursive: true });
  for (const entry of fs.readdirSync(objDist, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    fs.copyFileSync(path.join(objDist, entry.name), path.join(ctx.distDir, entry.name));
  }
}

function xmlEscape(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]));
}

function targetArchitecture(objDist) {
  const name = path.basename(path.dirname(objDist)).toLowerCase();
  return /aarch64|arm64/.test(name) ? 'arm64' : 'x64';
}

function platformLabel(objDist) {
  const prefix = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  const architecture = targetArchitecture(objDist);
  return prefix === 'macos' && architecture === 'arm64' ? 'macos' : `${prefix}-${architecture}`;
}

function updateMarName(config, objDist) {
  return `Bento-${config.brands[config.brand].release.displayVersion}-${platformLabel(objDist)}.mar`;
}

function updateTargets(objDist) {
  const architecture = targetArchitecture(objDist);
  if (process.platform === 'darwin') return architecture === 'arm64' ? ['Darwin_aarch64-gcc3'] : PLATFORM_TARGETS.darwin.slice(1);
  if (process.platform === 'win32') return architecture === 'arm64' ? ['WINNT_aarch64-msvc-aarch64'] : PLATFORM_TARGETS.win32;
  return architecture === 'arm64' ? ['Linux_aarch64-gcc3'] : PLATFORM_TARGETS.linux;
}

function platformIni(objDist, binaryName) {
  const candidates = [path.join(objDist, binaryName, 'platform.ini'), path.join(objDist, 'bin', 'platform.ini'), path.join(objDist, 'platform.ini')];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) fail(`package: platform.ini missing under ${objDist}`);
  const section = fs.readFileSync(file, 'utf8').match(/^\[Build\]([\s\S]*?)(?=^\[|$)/m)?.[1] || '';
  const buildId = section.match(/^BuildID\s*=\s*(\S+)/m)?.[1];
  if (!buildId) fail(`package: BuildID missing from ${file}`);
  return buildId;
}

async function createMar(ctx, config, objDist) {
  const mar = process.platform === 'win32' ? path.join(objDist, 'host', 'bin', 'mar.exe') : path.join(objDist, 'host', 'bin', 'mar');
  if (!fs.existsSync(mar)) fail(`package: MAR tool missing at ${mar}`);
  const appDir = process.platform === 'darwin'
    ? [
      path.join(objDist, config.binaryName, `${config.build.macosBundleName || 'Bento'}.app`),
      path.join(objDist, `${config.build.macosBundleName || 'Bento'}.app`),
    ].find((candidate) => fs.existsSync(path.join(candidate, 'Contents', 'Resources', 'precomplete')))
    : path.join(objDist, config.binaryName);
  if (!appDir || !fs.existsSync(appDir)) fail(`package: packaged ${config.binaryName} application is missing under ${objDist}`);
  fs.mkdirSync(ctx.distDir, { recursive: true });
  const output = path.join(ctx.distDir, 'output.mar');
  const shellPath = (target) => {
    if (process.platform !== 'win32') return target;
    const converted = spawnSync('cygpath', ['-u', target], { encoding: 'utf8', stdio: 'pipe' });
    return converted.status === 0 ? converted.stdout.trim() : target.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  };
  await run('bash', [shellPath(path.join(ctx.engineDir, 'tools/update-packaging/make_full_update.sh')), shellPath(ctx.distDir), shellPath(appDir)], {
    cwd: ctx.engineDir,
    env: {
      MOZ_PRODUCT_VERSION: config.brands[config.brand].release.displayVersion,
      MAR_CHANNEL_ID: config.updates.channel,
      ACCEPTED_MAR_CHANNEL_IDS: config.updates.channel,
      MAR: shellPath(mar),
    },
  });
  if (!fs.existsSync(output)) fail(`package: MAR tool did not write ${output}`);
  return { path: output, tool: mar, application: appDir };
}

export function findDirectory(root, predicate) {
  if (!fs.existsSync(root)) return undefined;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory() && predicate(entry.name)) return target;
    if (entry.isDirectory()) {
      const nested = findDirectory(target, predicate);
      if (nested) return nested;
    }
  }
  return undefined;
}

export async function writeBrowserUpdateFiles(ctx, config, marPath, buildId, objDist) {
  const marName = updateMarName(config, objDist);
  const release = config.brands[config.brand].release;
  const baseUrl = release.github
    ? `https://github.com/${release.github.repo}/releases/download/v${release.displayVersion}`
    : `https://${config.updates.hostname}`;
  const url = `${baseUrl}/${marName}`;
  const hash = crypto.createHash('sha512').update(fs.readFileSync(marPath)).digest('hex');
  const size = fs.statSync(marPath).size;
  const targets = updateTargets(objDist);
  if (!targets) fail(`unsupported update platform ${process.platform}`);
  const xml = `<?xml version="1.0"?>\n<updates>\n  <update type="minor" displayVersion="${xmlEscape(release.displayVersion)}" appVersion="${xmlEscape(release.displayVersion)}" platformVersion="${xmlEscape(config.firefox.version)}" buildID="${xmlEscape(buildId)}">\n    <patch type="complete" URL="${xmlEscape(url)}" hashFunction="sha512" hashValue="${hash}" size="${size}" />\n  </update>\n</updates>\n`;
  for (const target of targets) {
    const file = path.join(ctx.distDir, 'update', 'browser', target, config.updates.channel, 'update.xml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, xml);
  }
  return { marName, url, targets };
}

export async function writeAddonUpdateFiles(ctx, config) {
  const file = path.join(ctx.distDir, 'update', 'browser', 'addons', config.updates.channel, 'update.xml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '<?xml version="1.0"?>\n<updates><addons /></updates>\n');
  return file;
}

async function commandPackage(ctx) {
  requireEngine(ctx);
  const config = loadConfig(ctx.root);
  const objects = objDirs(ctx);
  if (objects.length === 0) fail('package: no engine object directory found; run pnpm run build first');
  const objDist = path.join(objects[objects.length - 1], 'dist');
  await run('bash', ['scripts/mach-raw.sh', 'package'], { cwd: ctx.root });
  await run('bash', ['scripts/mach-raw.sh', 'package-multi-locale', '--locales', ...readLocales(ctx, config)], { cwd: ctx.root });
  copyDirectoryFiles(ctx, objDist);
  const mar = await createMar(ctx, config, objDist);
  const buildId = platformIni(objDist, config.binaryName);
  const update = await writeBrowserUpdateFiles(ctx, config, mar.path, buildId, objDist);
  await writeAddonUpdateFiles(ctx, config);
  writeJson(path.join(ctx.distDir, 'bento-artifacts.json'), {
    schemaVersion: 1,
    displayVersion: config.brands[config.brand].release.displayVersion,
    firefoxVersion: config.firefox.version,
    mar: { path: path.relative(ctx.root, mar.path), name: update.marName, url: update.url },
    marTool: path.relative(ctx.root, mar.tool),
    application: path.relative(ctx.root, mar.application),
    objDist: path.relative(ctx.root, objDist),
    updateTargets: update.targets,
    locales: readLocales(ctx, config),
  });
  process.stdout.write(`bento: package, MAR, locale, and update metadata complete\n`);
}

async function commandBrowserUpdates(ctx) {
  const config = loadConfig(ctx.root);
  const marPath = path.join(ctx.distDir, 'output.mar');
  if (!fs.existsSync(marPath)) fail('updates-browser: dist/output.mar is missing; run package first');
  const objects = objDirs(ctx);
  if (objects.length !== 1) fail('updates-browser: set BENTO_OBJDIR when more than one object directory exists');
  const objDist = path.join(objects[0], 'dist');
  const buildId = platformIni(objDist, config.binaryName);
  const result = await writeBrowserUpdateFiles(ctx, config, marPath, buildId, objDist);
  process.stdout.write(`bento: wrote browser updates (${result.targets.length} targets)\n`);
}

async function commandAddonUpdates(ctx) {
  const config = loadConfig(ctx.root);
  await writeAddonUpdateFiles(ctx, config);
  process.stdout.write('bento: wrote add-on update metadata\n');
}

async function commandLicenseCheck(ctx) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  walk(ctx.srcDir);
  const ignored = /\.(json|patch|md|jpe?g|png|gif|tiff|ico|woff2|dep)$/i;
  const valid = files.filter((file) => ignored.test(file) || /(?:Mozilla Public|creativecommons\.org\/publicdomain)/.test(fs.readFileSync(file, 'utf8').slice(0, 1200)) || /\.min\.(?:m?js)$/.test(file));
  const missing = files.filter((file) => !valid.includes(file));
  if (missing.length) fail(`license check failed:\n${missing.join('\n')}`);
  process.stdout.write(`bento: license check passed (${files.length} files)\n`);
}

function parseArgs(argv) {
  const command = argv[0] || 'help';
  const options = { ui: false, force: false };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--ui') options.ui = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--jobs' || argument === '-j') options.jobs = Number(argv[++index]);
    else if (argument.startsWith('--jobs=')) options.jobs = Number(argument.slice('--jobs='.length));
    else if (argument === '--version') options.version = argv[++index];
    else if (!argument.startsWith('-') && !options.version) options.version = argument;
    else fail(`unknown option ${argument}`);
  }
  if (options.jobs !== undefined && (!Number.isInteger(options.jobs) || options.jobs < 1)) fail('--jobs must be a positive integer');
  return { command, options };
}

export async function main(argv = process.argv.slice(2), repoRoot = DEFAULT_ROOT) {
  const ctx = createContext(repoRoot);
  const { command, options } = parseArgs(argv);
  switch (command) {
    case 'download': return commandDownload(ctx, options.version, options.force);
    case 'update': return commandUpdate(ctx);
    case 'bootstrap': return commandBootstrap(ctx);
    case 'build': return commandBuild(ctx, options.ui, options.jobs);
    case 'package': return commandPackage(ctx);
    case 'updates-browser': return commandBrowserUpdates(ctx);
    case 'updates-addons': return commandAddonUpdates(ctx);
    case 'license-check': return commandLicenseCheck(ctx);
    case 'verify':
      if (engineIsGit(ctx)) {
        const config = loadConfig(repoRoot);
        if (!sourceVersionFromState(ctx)) adoptExistingSource(ctx, config, config.firefox.version);
        ensureSourceIdentity(ctx, config, config.firefox.version, 'verify Firefox source');
      }
      if (!verifyRecordedEngineState(repoRoot)) fail('engine contains changes outside the recorded/generated Bento state');
      process.stdout.write('bento: engine state is verified\n');
      return undefined;
    case 'record':
      process.stdout.write(`bento: recorded ${recordEngineState(repoRoot)} managed engine paths\n`);
      return undefined;
    case 'help':
      process.stdout.write('Usage: bento-build <download|update|bootstrap|build|package|license-check>\n');
      return undefined;
    default: fail(`unknown Bento build command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
