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

import { completeArchiveExtraction } from './archive-members.mjs';
import { BUILD_MODES, isReleaseBuild, resolveBuildMode } from './build-mode.mjs';
import { assertNoDevReloadInPackage } from './dev-reload.mjs';
import { assertShellMuxSource, stagedBrowserDir } from './muxui-source.mjs';
import {
  activeMozconfigLines,
  configuredUpdateState,
  isBentoChannel,
  mozconfigUpdaterState,
  overridesUpdateSettings,
  updaterReadinessProblems,
} from './update-readiness.mjs';
import { writeFileIfChanged } from './write-if-changed.mjs';

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
const compareNames = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
// Fixed object directory under engine/. Firefox's default name embeds the host OS
// version, so an OS update would silently start a cold build in a new directory.
export const FIXED_OBJDIR = 'obj-bento';
// Rewritten from repository config on every build (writeMozconfig). The recorded
// engine state checks them against fresh output instead of the hash taken at import.
const REGENERABLE_ENGINE_FILES = new Set([
  'mozconfig',
  'browser/config/version.txt',
  'browser/config/version_display.txt',
]);

// The build output directory inside each Bento built-in add-on. The repository
// ignores `dist/`, and every import replaces the engine copy with the repository
// build (install-builtin-addons prunes whatever it does not install), so engine
// verification does not track its files. `pnpm run shell:sync` writes a newer
// build here through the app bundle's dist symlink, and chunk names differ between
// builds.
const GENERATED_ADDON_OUTPUT_DIR = 'dist';

// macOS Finder metadata is never engine state. The engine's .gitignore ignores
// `.DS_Store` but re-includes `third_party/rust/**/.*`, so Git reports one that a
// Finder window drops under third_party/rust. `git status --porcelain` quotes a path
// that holds a space, which leaves a closing quote after the name.
const FINDER_METADATA = /(?:^|\/)\.DS_Store"?$/;
const isFinderMetadata = (relative) => FINDER_METADATA.test(relative);

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
  if (!BUILD_MODES.includes(config.build?.mode)) {
    fail('bento.json build.mode must be dev, debug, or release');
  }
  if (config.updates?.enabled !== undefined && typeof config.updates.enabled !== 'boolean') {
    fail('bento.json updates.enabled must be true or false');
  }
  return config;
}

/**
 * Whether the updater is compiled in. It stays off until Bento owns a signed update
 * path; enabling it also needs the readiness inputs (assertUpdaterReady).
 */
export function updatesEnabled(config) {
  return config.updates?.enabled === true;
}

/** Refuses an enabled updater while config/release-security.json lacks a readiness input. */
function assertUpdaterReady(ctx, config) {
  const file = path.join(ctx.root, 'config', 'release-security.json');
  if (!fs.existsSync(file)) fail('bento.json updates.enabled is true, but config/release-security.json is missing');
  const problems = updaterReadinessProblems(config, readJson(file));
  if (problems.length) {
    fail(`bento.json updates.enabled is true, but the updater is not ready (docs/build-tooling.md, Updater):\n- ${problems.join('\n- ')}`);
  }
}

/** The update commands and packaging have nothing to write for a build that cannot update. */
function requireUpdatesEnabled(ctx, config, command) {
  if (!updatesEnabled(config)) {
    fail(`${command}: the updater is disabled (bento.json updates.enabled is false), so this build cannot update and Bento writes no update metadata for it; see docs/build-tooling.md, Updater`);
  }
  assertUpdaterReady(ctx, config);
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

const HASH_CHUNK = Buffer.allocUnsafe(256 * 1024);

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  try {
    for (let read = fs.readSync(descriptor, HASH_CHUNK); read > 0; read = fs.readSync(descriptor, HASH_CHUNK)) {
      hash.update(HASH_CHUNK.subarray(0, read));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
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
  assertLocalBuildPaths(repoRoot);
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

/** Generated engine and state belong to the checkout whose source is being built. */
export function assertLocalBuildPaths(repoRoot = DEFAULT_ROOT) {
  const requestedRoot = path.resolve(repoRoot);
  if (!tryRealpath(requestedRoot)) fail(`cannot resolve Bento checkout: ${requestedRoot}`);
  const root = canonicalPath(requestedRoot);
  const offending = [];
  for (const name of ['engine', '.bento']) {
    const requested = path.join(requestedRoot, name);
    const resolved = tryRealpath(requested);
    if (!resolved) {
      const entry = fs.lstatSync(requested, { throwIfNoEntry: false });
      if (entry) {
        const target = entry.isSymbolicLink()
          ? path.resolve(path.dirname(requested), fs.readlinkSync(requested))
          : requested;
        offending.push(`${requested} -> ${target} (unresolvable)`);
      }
      continue;
    }
    const actual = canonicalPath(resolved);
    const relative = path.relative(root, actual);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      offending.push(`${requested} -> ${actual}`);
    }
  }
  if (offending.length) {
    fail([
      `Bento build outputs must stay inside checkout ${root}:`,
      ...offending.map((entry) => `  ${entry}`),
      'Use independent engine/ and .bento/ directories in this checkout, then run download, bootstrap, and build normally.',
      'For UI-only work, use pnpm run shell:ladle or pnpm run shell:dev.',
    ].join('\n'));
  }
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

/** Path -> SHA-256 of the regular files in .bento/engine-state.json. */
function recordedFileHashes(ctx) {
  const statePath = path.join(ctx.stateDir, 'engine-state.json');
  if (!fs.existsSync(statePath)) return new Map();
  return new Map((readJson(statePath).entries || [])
    .filter((entry) => entry.type === 'file' && entry.sha256)
    .map((entry) => [entry.path, entry.sha256]));
}

export function engineStatus(repoRoot = DEFAULT_ROOT) {
  const ctx = createContext(repoRoot);
  if (!engineIsGit(ctx)) return { exists: fs.existsSync(ctx.engineDir), git: false, dirty: false, files: [] };
  const output = git(ctx, ['status', '--porcelain', '--untracked-files=all']);
  const files = output.split('\n').filter(Boolean).map((line) => line.slice(3).trim())
    .filter((file) => file && !isFinderMetadata(file));
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
  // A build writes the display version into these, so after a version bump the files
  // still hold the previous value (as recorded at import) until the next build.
  const recordedVersionFiles = recordedFileHashes(ctx);
  for (const file of ['browser/config/version.txt', 'browser/config/version_display.txt']) {
    const target = path.join(ctx.engineDir, file);
    if (!fs.existsSync(target)) continue;
    if ((displayVersion && fs.readFileSync(target, 'utf8').trim() === displayVersion)
      || recordedVersionFiles.get(file) === sha256File(target)) owned.add(file);
  }
  if (isExactReadmeOverlay(ctx, path.join(ctx.engineDir, 'README.md'))) owned.add('README.md');
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

export async function extractArchive(archive, destination) {
  const entries = archiveEntries(archive);
  await fsp.mkdir(destination, { recursive: true });
  const tarPaths = tarArchivePaths(archive, destination);
  const commands = process.platform === 'darwin' ? ['gtar', 'tar'] : ['tar'];
  const extract = (...extraArgs) => {
    let lastError;
    for (const command of commands) {
      const result = spawnSync(command, ['--strip-components=1', '-xf', tarPaths.archive, '-C', tarPaths.destination, ...extraArgs], {
        cwd: tarPaths.cwd,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      if (result.status === 0) return;
      lastError = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    }
    fail(`unable to extract ${archive}${lastError ? `\n${lastError}` : ''}`);
  };
  extract();
  completeArchiveExtraction({
    archive,
    entries,
    destination,
    strip: 1,
    extractMembers: (listName) => extract('-T', listName),
    fail,
  });
}

function sourceVersionFromState(ctx) {
  if (!fs.existsSync(ctx.sourceStatePath)) return undefined;
  return readJson(ctx.sourceStatePath).version;
}

/** Splits "157.0.1", "158.0b5" or "140.2.0esr"; undefined for any other shape. */
function parseFirefoxVersion(version) {
  const match = /^(\d+(?:\.\d+)+)(?:b(\d+)|(esr))?$/.exec(version);
  if (!match) return undefined;
  return {
    numbers: match[1].split('.').map(Number),
    esr: match[3] === 'esr',
    // A final release is newer than every beta of the same number.
    beta: match[2] === undefined ? Infinity : Number(match[2]),
  };
}

/**
 * Orders two Firefox versions: negative when `left` is older, 0 when equal, positive
 * when newer. Compares the full dotted number, then the beta number (158.0b5 < 158.0b6
 * < 158.0). Undefined when they cannot be ordered: ESR against a non-ESR version, or a
 * version of an unrecognized shape.
 */
export function compareFirefoxVersions(left, right) {
  const [a, b] = [parseFirefoxVersion(left), parseFirefoxVersion(right)];
  if (!a || !b || a.esr !== b.esr) return undefined;
  for (let index = 0; index < Math.max(a.numbers.length, b.numbers.length); index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference) return difference;
  }
  return a.beta === b.beta ? 0 : a.beta < b.beta ? -1 : 1;
}

/**
 * How the engine's recorded Firefox version orders against `other` (see
 * compareFirefoxVersions). Undefined when nothing is recorded, or when the engine was
 * installed for another product than bento.json configures now.
 */
function compareEngineVersion(ctx, config, other) {
  if (!fs.existsSync(ctx.sourceStatePath)) return undefined;
  const state = readJson(ctx.sourceStatePath);
  if (!state.version || (state.product ?? config.firefox.product) !== config.firefox.product) return undefined;
  return compareFirefoxVersions(state.version, other);
}

/**
 * The Firefox version recorded for the engine when it is strictly older than the one
 * bento.json configures, as on a checkout that predates a version bump. Undefined when
 * the engine is current, newer, of another product or channel, or has no recorded
 * version, so none of those are replaced as "stale".
 */
function staleEngineVersion(ctx, config) {
  const recorded = sourceVersionFromState(ctx);
  return recorded && compareEngineVersion(ctx, config, config.firefox.version) < 0 ? recorded : undefined;
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
  if (!identity) {
    const stale = version === config.firefox.version ? staleEngineVersion(ctx, config) : undefined;
    fail(stale
      ? `cannot ${operation}: the engine is Firefox ${stale} but bento.json configures ${version}; run \`pnpm run firefox:sync\` to replace it`
      : `cannot ${operation}: missing pristine Firefox base ${ref}; run the protected source adoption path first`);
  }
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

function generatedLegacyBrowserExtensionsMozBuild(ctx, config) {
  const baseline = baselineText(ctx, 'browser/extensions/moz.build', config);
  if (baseline === undefined) return undefined;
  let base = baseline;
  base = base.replace(/\n?# BEGIN BENTO BUILTIN ADDONS[\s\S]*?# END BENTO BUILTIN ADDONS\n?/g, '\n');
  base = base.replace(/^DIRS \+= \["bento-shell", "bento-tools", "ublock-origin"\]\r?\n?/m, '');
  base = base.trimEnd();
  const names = extensionNames(ctx).map((name) => `"${name}"`).join(', ');
  return `${base}\n\nDIRS += []\n\n# BEGIN BENTO BUILTIN ADDONS\nDIRS += [${names}]\n# END BENTO BUILTIN ADDONS\n`;
}

function isGeneratedBrowserExtensionsMozBuild(ctx, config, target) {
  const actual = fs.readFileSync(target, 'utf8');
  return actual === generatedBrowserExtensionsMozBuild(ctx, config)
    || actual === generatedLegacyBrowserExtensionsMozBuild(ctx, config);
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

function generatedLegacyGitignore(ctx, config) {
  const baseline = baselineText(ctx, '.gitignore', config);
  if (baseline === undefined) return undefined;
  const managed = sourceOverlayPaths(ctx);
  const base = baseline.replace(/\r?\n+$/, '');
  const existing = new Set(base.split(/\r?\n/));
  const missing = managed.filter((relative) => !existing.has(relative));
  return missing.length ? `${base}\n\n${missing.join('\n')}` : baseline;
}

function isGeneratedGitignore(ctx, config, target) {
  const actual = fs.readFileSync(target, 'utf8');
  const current = generatedGitignore(ctx, config);
  const legacy = generatedLegacyGitignore(ctx, config);
  return (current !== undefined && sameKnownFinalNewline(actual, current))
    || (legacy !== undefined && sameKnownFinalNewline(actual, legacy));
}

function isExactReadmeOverlay(ctx, target) {
  const source = path.join(ctx.srcDir, 'README.md');
  if (!fs.existsSync(source) || !targetExistsSync(target)) return false;
  const stat = fs.lstatSync(target);
  return stat.isSymbolicLink()
    ? fs.readlinkSync(target) === source
    : stat.isFile() && sha256File(target) === sha256File(source);
}

// configs/common/mozconfig as the legacy generator inlined it into engine/mozconfig,
// before the debug, optimize and release flags moved from that file into the driver.
const LEGACY_COMMON_MOZCONFIG = `# Bento Browser — shared mozconfig fragment.
# Sourced by every per-platform mozconfig under configs/{linux,macos,windows}/.

ac_add_options --enable-application=browser
ac_add_options --with-app-name=bento
ac_add_options --with-app-basename=Bento
ac_add_options --with-branding=browser/branding/bento

ac_add_options --disable-crashreporter
ac_add_options --disable-tests
ac_add_options --disable-debug
ac_add_options --enable-release

# Disable Mozilla telemetry reporting for the fork build. Keep release add-on
# signature enforcement compiled in; Bento's own extensions are registered in
# Firefox's built-in add-on location, which does not require normal XPI signing.
# MOZ_SERVICES_HEALTHREPORT is intentionally NOT set here — it is an "implied"
# configure option that mach derives from other settings and rejects when
# overridden via mozconfig. Disable health-report at runtime via prefs/bento.js
# (datareporting.healthreport.uploadEnabled = false) instead.
export MOZ_REQUIRE_SIGNING=1
export MOZ_TELEMETRY_REPORTING=
export MOZ_DATA_REPORTING=
`;

// mach reads this line from engine/mozconfig to choose the object directory.
const MOZ_OBJDIR_LINE = /^mk_add_options MOZ_OBJDIR=@TOPSRCDIR@\/(obj-[A-Za-z0-9._-]+)$/m;

/**
 * The object directory name written into the generated mozconfig: BENTO_OBJDIR
 * when set, else the fixed default. Generation and resolveObjDir both start here,
 * so mach and every tool that reads its output agree.
 */
function requestedObjDirName(ctx) {
  const value = process.env.BENTO_OBJDIR;
  if (!value) return undefined;
  const resolved = path.resolve(ctx.engineDir, value);
  const name = path.basename(resolved);
  if (path.dirname(resolved) !== path.resolve(ctx.engineDir) || !/^obj-[A-Za-z0-9._-]+$/.test(name)) {
    fail(`BENTO_OBJDIR=${value} must name a directory directly under engine/ that starts with obj- (for example obj-bento)`);
  }
  return name;
}

/** The object directory name engine/mozconfig currently sends mach to, if it has one. */
function mozconfigObjDirName(ctx) {
  const file = path.join(ctx.engineDir, 'mozconfig');
  if (!fs.existsSync(file)) return undefined;
  return MOZ_OBJDIR_LINE.exec(fs.readFileSync(file, 'utf8'))?.[1];
}

/**
 * The fragments Bento appends to engine/mozconfig. They land after the options Bento
 * writes, and configure takes the last occurrence, so a fragment must not set what
 * Bento owns: a MOZ_OBJDIR would send mach somewhere resolveObjDir does not look, and
 * an updater, signature-verification or update-channel setting would undo bento.json
 * `updates` after its readiness checks (see overridesUpdateSettings).
 */
function assertFragmentsDoNotOverrideBento(ctx) {
  const fragments = [
    path.join(ctx.root, 'configs', 'common', 'mozconfig'),
    path.join(ctx.root, 'configs', platformConfigName(), 'mozconfig'),
    path.join(ctx.root, 'mozconfig'),
  ];
  for (const fragment of fragments) {
    if (!fs.existsSync(fragment)) continue;
    const lines = activeMozconfigLines(fs.readFileSync(fragment, 'utf8'));
    const name = path.relative(ctx.root, fragment);
    if (lines.some((line) => /\bMOZ_OBJDIR\b/.test(line))) {
      fail(`${name} sets MOZ_OBJDIR; Bento chooses the object directory (set BENTO_OBJDIR to use another obj-* name)`);
    }
    if (lines.some(overridesUpdateSettings)) {
      fail(`${name} sets the updater, its update channel or MAR signature verification; bento.json updates.enabled and updates.channel are the only switches (docs/build-tooling.md, Updater)`);
    }
  }
}

/** mach ignores engine/mozconfig, and so the directory Bento resolves, when MOZCONFIG names another file. */
function assertGeneratedMozconfigInUse(ctx) {
  const chosen = process.env.MOZCONFIG;
  if (chosen && canonicalPath(path.resolve(ctx.engineDir, chosen)) !== canonicalPath(path.join(ctx.engineDir, 'mozconfig'))) {
    fail(`MOZCONFIG=${chosen} would make mach ignore the generated engine/mozconfig; unset it and put local settings in the repository's root mozconfig`);
  }
}

// Firefox lowers its macOS deployment target default from 11.0 to 10.15 when developer
// options are on; dev and debug builds pin it to what release builds use.
const MACOS_DEPLOYMENT_TARGET = '11.0';

/**
 * The configure options that depend on the build mode. `dev` and `debug` turn on
 * Firefox's developer options (--disable-release), which skip the serial fat-LTO Rust
 * link and allow incremental Rust builds; `release` keeps release codegen.
 * `previous` reproduces what drivers wrote before that split, which verification
 * still has to accept.
 */
function modeOptions(mode, previous) {
  const options = {
    dev: ['--disable-debug'],
    debug: ['--enable-debug', '--disable-optimize'],
    release: ['--disable-debug', '--enable-optimize', '--enable-rust-simd'],
  }[mode];
  if (previous) return options;
  if (mode === 'release') return [...options, '--enable-release'];
  return [
    ...options,
    '--disable-release',
    ...(process.platform === 'darwin' ? [`--enable-macos-target=${MACOS_DEPLOYMENT_TARGET}`] : []),
  ];
}

/**
 * `objdir` is a directory name, or undefined for the output of drivers that predate the
 * fixed directory. `previous` reproduces the output of drivers that predate the
 * dev/release split and the updater switch.
 */
function generatedMozconfigText(ctx, config, mode, objdir, previous = false) {
  const platformName = platformConfigName();
  const platformPath = path.join(ctx.root, 'configs', platformName, 'mozconfig');
  if (!fs.existsSync(platformPath)) fail(`missing ${path.relative(ctx.root, platformPath)}`);
  const selectedMode = resolveBuildMode(config, mode);
  const lines = [
    '# This file is generated by scripts/bento-build.mjs. Edit configs/ or mozconfig instead.',
    fs.readFileSync(platformPath, 'utf8').trimEnd(),
    '',
    `# Bento ${selectedMode} build settings`,
    ...modeOptions(selectedMode, previous).map((option) => `ac_add_options ${option}`),
  ];
  // Every mode builds into one directory. An undefined name reproduces the output
  // of drivers that predate it, which verification still has to accept.
  if (objdir) lines.push('', `mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/${objdir}`);
  lines.push(
    '',
    `ac_add_options --with-branding=browser/branding/${config.brand}`,
    `ac_add_options --enable-update-channel=${config.updates.channel}`,
  );
  if (!previous) {
    lines.push(
      updatesEnabled(config)
        ? '# Updater: compiled in (bento.json updates.enabled)'
        : '# Updater: compiled out until the signed Bento update path exists (bento.json updates.enabled)',
    );
    if (!updatesEnabled(config)) lines.push('ac_add_options --disable-updater');
  }
  lines.push(
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

// The engine/mozconfig format of the previous build tool, accepted by source adoption
// for engines created before the Bento driver. Exported so tests can write it.
export function legacyMozconfigText(ctx, config) {
  const platformPath = path.join(ctx.root, 'configs', platformConfigName(), 'mozconfig');
  if (!fs.existsSync(platformPath)) return undefined;
  const platform = fs.readFileSync(platformPath, 'utf8').trim();
  const lines = [
    '# This file is automatically generated. You should only modify this if you know what you are doing!',
    '',
    LEGACY_COMMON_MOZCONFIG.trimEnd(),
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
    `export ZEN_FIREFOX_VERSION=${config.firefox.version}`,
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

function isGeneratedMozconfig(ctx, config, actual) {
  const normalizedLegacy = actual.replace(/^# Internal [A-Za-z]+ config$/m, '# Internal build config');
  const withoutLegacyTrailingSpaces = normalizedLegacy.endsWith('\n  ')
    ? normalizedLegacy.slice(0, -2)
    : normalizedLegacy;
  // Which obj-* name a build used (BENTO_OBJDIR) does not make the file hand-edited.
  const anyObjDir = actual.replace(MOZ_OBJDIR_LINE, `mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/${FIXED_OBJDIR}`);
  return ['dev', 'debug', 'release'].some((mode) => [false, true].some((previous) => (
    anyObjDir === generatedMozconfigText(ctx, config, mode, FIXED_OBJDIR, previous)
    || actual === generatedMozconfigText(ctx, config, mode, undefined, previous)
  )))
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
  return [...new Set([...entries, 'manifest.json'])].sort(compareNames);
}

function addonRuntimeFiles(ctx, name) {
  const root = path.join(ctx.root, 'extensions', name);
  const files = [];
  const collect = (directory, prefix = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => compareNames(left.name, right.name))) {
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
  return files.sort(compareNames);
}

function generatedAddonFiles(ctx, name) {
  const manifest = readJson(path.join(ctx.root, 'extensions', name, 'manifest.json'));
  const id = manifest.applications?.gecko?.id || manifest.browser_specific_settings?.gecko?.id;
  const jar = ['browser.jar:', ...addonRuntimeFiles(ctx, name).map((file) => `    builtin-addons/${name}/${file} (${file})`), ''].join('\n');
  const mozBuild = `# This Source Code Form is subject to the terms of the Mozilla Public\n# License, v. 2.0. If a copy of the MPL was not distributed with this\n# file, You can obtain one at https://mozilla.org/MPL/2.0/.\n\n# Bento built-in add-on: ${name} (${id})\nDEFINES["MOZ_APP_VERSION"] = CONFIG["MOZ_APP_VERSION"]\nDEFINES["MOZ_APP_MAXVERSION"] = CONFIG["MOZ_APP_MAXVERSION"]\n\nJAR_MANIFESTS += ["jar.mn"]\n`;
  return { jar, mozBuild };
}

/**
 * Engine paths that neither the recorded import state nor the generated Bento output
 * accounts for, for an engine Git checkout. Empty means the engine is safe to replace.
 */
function unverifiedEnginePaths(ctx, status) {
  if (fs.existsSync(path.join(ctx.stateDir, 'engine-state.json'))) return engineStateViolations(ctx.root);
  const files = [...new Set([...status.files, ...managedEnginePaths(ctx)])];
  if (!files.length || verifyManagedEngine(ctx, files)) return [];
  return status.files.length ? status.files : files;
}

function describeEnginePaths(paths) {
  const shown = paths.slice(0, 8).join(', ');
  return paths.length > 8 ? `${shown}, and ${paths.length - 8} more` : shown;
}

/** `message` followed by the sorted paths, one per line, capped at 20 with an "and N more" line. */
function withEnginePathList(message, paths) {
  const sorted = [...paths].sort();
  const lines = sorted.slice(0, 20).map((relative) => `  ${relative}`);
  if (sorted.length > 20) lines.push(`  and ${sorted.length - 20} more`);
  return [message, ...lines].join('\n');
}

function ensureCleanEngine(ctx, operation) {
  const status = engineStatus(ctx.root);
  if (!status.exists) return;
  if (!status.git) {
    fail(`cannot ${operation}: engine is not a Git checkout; preserve it before updating`);
  }
  const unverified = unverifiedEnginePaths(ctx, status);
  if (unverified.length) {
    fail(`cannot ${operation}: engine contains unrecognized user changes (${describeEnginePaths(unverified)}). Preserve or export them through the Bento patch workflow before updating it.`);
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
    assertLocalBuildPaths(ctx.root);
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
  const outputRoots = generatedAddonOutputRoots(ctx);
  try {
    return files.every((relative) => {
      if (isGeneratedAddonOutput(outputRoots, relative)) return true;
      if (expectedFiles?.has(relative)) {
        const expected = expectedFiles.get(relative);
        const target = path.join(ctx.engineDir, relative);
        return fs.existsSync(expected) && fs.existsSync(target) && sha256File(expected) === sha256File(target);
      }
      if (relative === 'README.md') return isExactReadmeOverlay(ctx, path.join(ctx.engineDir, relative));
      if (overlayEntries.has(relative) || fs.existsSync(path.join(ctx.srcDir, relative))) return sourceExact(relative);
      if (relative.startsWith('browser/branding/bento/')) return brandingExact(relative);
      if (relative === 'browser/extensions/moz.build') {
        return isGeneratedBrowserExtensionsMozBuild(ctx, config, path.join(ctx.engineDir, relative));
      }
      if (relative.startsWith('browser/extensions/')) return addonExact(relative);
      if (relative === 'browser/app/profile/firefox.js') return managedPrefsExact(ctx, relative);
      if (relative === 'browser/config/version.txt' || relative === 'browser/config/version_display.txt') {
        return fs.readFileSync(path.join(ctx.engineDir, relative), 'utf8') === config.brands.bento.release.displayVersion;
      }
      if (relative === 'mozconfig') {
        return isGeneratedMozconfig(ctx, config, fs.readFileSync(path.join(ctx.engineDir, relative), 'utf8'));
      }
      if (relative === '.gitignore') {
        return isGeneratedGitignore(ctx, config, path.join(ctx.engineDir, relative));
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
  addWhen('mozconfig', (target) => isGeneratedMozconfig(ctx, config, fs.readFileSync(target, 'utf8')));
  return paths;
}

export function recordEngineState(repoRoot = DEFAULT_ROOT) {
  assertLocalBuildPaths(repoRoot);
  const ctx = createContext(repoRoot);
  const status = engineStatus(repoRoot);
  if (!status.git) fail('cannot record engine state without an engine Git checkout');
  if (status.unrecognizedFiles?.length) {
    fail(`cannot record unrecognized engine changes: ${status.unrecognizedFiles.slice(0, 8).join(', ')}`);
  }
  const paths = new Set([...status.files, ...managedEnginePaths(ctx)].filter((relative) => !isFinderMetadata(relative)));
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

/**
 * Reads a regular file without following symlinks, from one descriptor so the type
 * check and the content describe the same file. Returns undefined for a symlink or
 * any other non-regular file; a missing file still throws ENOENT.
 */
function readRegularFileNoFollow(target) {
  let fd;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP') return undefined;
    throw error;
  }
  try {
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, 'utf8') : undefined;
  } finally {
    fs.closeSync(fd);
  }
}

function isRegeneratedEngineFile(ctx, config, relative) {
  const content = readRegularFileNoFollow(path.join(ctx.engineDir, relative));
  if (content === undefined) return false;
  return relative === 'mozconfig'
    ? isGeneratedMozconfig(ctx, config, content)
    : content === config.brands[config.brand]?.release?.displayVersion;
}

/** Whether the engine matches the recorded import state or the generated Bento output. */
export function verifyRecordedEngineState(repoRoot = DEFAULT_ROOT) {
  return engineIsGit(createContext(repoRoot)) && engineStateViolations(repoRoot).length === 0;
}

/**
 * Engine paths that neither the recorded import state nor the current Bento output
 * accounts for. Empty means verified. Needs an engine Git checkout.
 */
function engineStateViolations(repoRoot) {
  const ctx = createContext(repoRoot);
  const status = engineStatus(repoRoot);
  const statePath = path.join(ctx.stateDir, 'engine-state.json');
  if (!fs.existsSync(statePath)) return verifyManagedEngine(ctx, status.files) ? [] : status.files;
  const state = readJson(statePath);
  const config = loadConfig(ctx.root);
  // An older import may have recorded a .DS_Store; ignoring it also keeps its later deletion from failing.
  const snapshot = new Map((state.entries || []).filter((entry) => !isFinderMetadata(entry.path)).map((entry) => [entry.path, entry]));
  const currentManaged = new Set([
    ...sourceOverlayPaths(ctx),
    ...managedEnginePaths(ctx),
    ...managedPatchPaths(ctx),
  ]);
  const paths = new Set([...status.files, ...snapshot.keys()]);
  // Validate the regenerable files whenever they exist, not only when Git or the
  // snapshot mention them: Firefox ignores mozconfig, and an import before the first
  // build records nothing for it. A tracked version file is pristine until it shows
  // up in the Git status.
  for (const relative of REGENERABLE_ENGINE_FILES) {
    if (targetExistsSync(path.join(ctx.engineDir, relative)) && (relative === 'mozconfig' || status.files.includes(relative))) {
      paths.add(relative);
    }
  }
  const outputRoots = generatedAddonOutputRoots(ctx);
  const accepts = (relative) => {
    // Changed, extra and missing build output all pass: the next import replaces
    // the directory. Every other add-on file keeps the strict checks below.
    if (isGeneratedAddonOutput(outputRoots, relative)) return true;
    const expected = snapshot.get(relative);
    const target = path.join(ctx.engineDir, relative);
    if (REGENERABLE_ENGINE_FILES.has(relative) && targetExistsSync(target)) {
      // Builds rewrite these from repository config, so the hash recorded at the
      // last import goes stale after a mode switch or the first build. Accept
      // freshly generated output, or the exact bytes recorded at import (the file a
      // repository config change has not been rebuilt into yet). Anything else is
      // a hand edit.
      if (isRegeneratedEngineFile(ctx, config, relative)) return true;
      const stat = fs.lstatSync(target);
      return Boolean(expected && !expected.missing && expected.type !== 'symlink'
        && stat.isFile() && sha256File(target) === expected.sha256);
    }
    if (!expected) {
      // A newly introduced source file is safe only when its current generated
      // output already matches the source. Any other new dirty path is a user
      // edit and must be preserved before import can reset the engine.
      if (!currentManaged.has(relative) || !targetExistsSync(target)) return false;
      if (fs.existsSync(path.join(ctx.srcDir, relative))) {
        const source = path.join(ctx.srcDir, relative);
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink()) return fs.readlinkSync(target) === source;
        return stat.isFile() && sha256File(target) === sha256File(source);
      }
      return false;
    }
    if (expected.missing) return !targetExistsSync(target);
    if (!targetExistsSync(target)) {
      // Removing an overlay from the repository is a supported input change;
      // the importer will remove its old generated output after preflight.
      // Any other recorded path must still exist: a hand-deleted file, including a
      // retired patch target, is an unrecorded change. Absence is accepted only
      // where the snapshot itself records the deletion (`missing`, above).
      return expected.kind === 'overlay' && !fs.existsSync(path.join(ctx.srcDir, relative));
    }
    const stat = fs.lstatSync(target);
    if (expected.type === 'symlink') return stat.isSymbolicLink() && fs.readlinkSync(target) === expected.linkTarget;
    return stat.isFile() && sha256File(target) === expected.sha256;
  };
  // engineStatus owns files by the current patch series, overlays and add-ons, so a
  // file an earlier import changed that the series no longer touches (an engine
  // from before a version bump) is "unrecognized" there. `accepts` has already
  // compared every recorded path against its recorded bytes, so only unrecognized
  // files outside the snapshot are user changes.
  const unrecorded = status.unrecognizedFiles.filter((relative) => !snapshot.has(relative));
  return [...new Set([...[...paths].filter((relative) => !accepts(relative)), ...unrecorded])].sort();
}

/** Engine-relative `dist` directories of the Bento built-in add-ons (see GENERATED_ADDON_OUTPUT_DIR). */
function generatedAddonOutputRoots(ctx) {
  return extensionNames(ctx).map((name) => `browser/extensions/${name}/${GENERATED_ADDON_OUTPUT_DIR}`);
}

/** Whether `relative` is a Bento add-on's output directory or a path inside it. */
function isGeneratedAddonOutput(outputRoots, relative) {
  return outputRoots.some((root) => relative === root || relative.startsWith(`${root}/`));
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

/**
 * Installs the Firefox source. With `replaceStale`, an engine recorded at an older
 * version than bento.json configures is replaced through the same protected path as
 * `force` (clean-engine check, digest from bento.json, backup, Bento ref
 * preservation). `pnpm run firefox:sync` passes it; `pnpm run build` does not.
 */
async function commandDownload(ctx, version, { force = false, replaceStale = false } = {}) {
  const config = loadConfig(ctx.root);
  const existing = engineStatus(ctx.root);
  const requestedVersion = version || config.firefox.version;
  let replace = force;
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
    const replacing = replaceStale && existing.git && requestedVersion === config.firefox.version;
    const stale = replacing ? staleEngineVersion(ctx, config) : undefined;
    const recorded = sourceVersionFromState(ctx);
    if (replacing && recorded && !stale) {
      // Only a strictly older engine of the same product and channel is "stale".
      const order = compareEngineVersion(ctx, config, requestedVersion);
      if (order !== 0) {
        fail(order > 0
          ? `cannot replace Firefox source: the engine is Firefox ${recorded}, newer than the ${requestedVersion} bento.json configures; use the repository revision that matches the engine, or preserve any changes and replace it with \`download --force\``
          : `cannot replace Firefox source: the engine is Firefox ${recorded} and bento.json configures ${requestedVersion}, which cannot be ordered (a different product or channel); preserve any changes, then replace it with \`download --force\``);
      }
    }
    if (stale) {
      ensureSourceIdentity(ctx, config, stale, 'replace Firefox source');
      process.stdout.write(`bento: engine is Firefox ${stale} but bento.json configures ${requestedVersion}; replacing it\n`);
      replace = true;
    } else if (existing.git || existing.files.length > 0) {
      fail('engine already exists; use `pnpm run firefox:sync` for a protected source update');
    }
  }
  if (replace) ensureCleanEngine(ctx, 'replace Firefox source');
  const archiveInfo = await acquireSourceArchive(ctx.root, requestedVersion);
  const result = await installSource(ctx, archiveInfo, { replace });
  process.stdout.write(`bento: installed Firefox ${archiveInfo.version} source\n`);
  if (result.backup) process.stdout.write(`bento: previous source is recoverable at ${result.backup}\n`);
}

export function adoptExistingSource(ctx, config, version) {
  assertLocalBuildPaths(ctx.root);
  const ref = `refs/bento/firefox-base/${version}`;
  const identity = baseIdentity(ctx, ref);
  if (!identity) return false;
  const commit = identity.commit;
  const status = engineStatus(ctx.root);
  const unverified = unverifiedEnginePaths(ctx, status);
  if (unverified.length) {
    fail(`cannot adopt existing Firefox source with unverified changes: ${describeEnginePaths(unverified)}`);
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
  // The engine may predate bento.json (a checkout from before a version bump), so
  // check it against its own recorded version, not the configured one.
  const engineVersion = engineIsGit(ctx) ? sourceVersionFromState(ctx) : undefined;
  const previous = engineVersion || config.firefox.version;
  if (engineIsGit(ctx)) ensureSourceIdentity(ctx, config, previous, 'update Firefox source');
  // Never replace an engine with an older target. An engine that cannot be ordered
  // against the target (another product or channel) is replaced only when it is the
  // one bento.json describes.
  const order = engineVersion ? compareEngineVersion(ctx, config, version) : undefined;
  if (order > 0) {
    fail(`cannot update Firefox source: the engine is Firefox ${engineVersion}, newer than the ${version} target; refusing to downgrade. Use the repository revision that matches the engine, or preserve any changes and replace it with \`download --force\``);
  }
  if (engineVersion && order === undefined && engineVersion !== config.firefox.version) {
    fail(`cannot update Firefox source: the engine is Firefox ${engineVersion} and the ${version} target cannot be ordered against it (a different product or channel); preserve any changes, then replace it with \`download --force\``);
  }
  // Keep the installed source only when it is exactly the target: the same version
  // string and a recorded archive digest equal to the verified one. Anything else,
  // including a numerically equal spelling (158.0.0 for 158.0) or a missing digest,
  // takes the protected replacement, so source-state.json and the base ref match
  // bento.json afterwards. Metadata is never patched in place.
  let archiveInfo;
  let reuse = false;
  if (engineVersion === version) {
    archiveInfo = await acquireSourceArchive(ctx.root, version);
    const recordedDigest = readJson(ctx.sourceStatePath).archiveSha256;
    reuse = Boolean(recordedDigest) && recordedDigest === archiveInfo.sha256;
  }
  if (!reuse) ensureCleanEngine(ctx, 'update Firefox source');
  archiveInfo ??= await acquireSourceArchive(ctx.root, version);
  const previousConfig = fs.readFileSync(ctx.configPath, 'utf8');
  const previousSourceState = fs.existsSync(ctx.sourceStatePath) ? fs.readFileSync(ctx.sourceStatePath, 'utf8') : undefined;
  const engineStatePath = path.join(ctx.stateDir, 'engine-state.json');
  const previousEngineState = fs.existsSync(engineStatePath) ? fs.readFileSync(engineStatePath, 'utf8') : undefined;
  const previousOverlayManifest = fs.existsSync(ctx.overlayManifestPath) ? fs.readFileSync(ctx.overlayManifestPath, 'utf8') : undefined;
  const versionsPath = path.join(ctx.root, 'config', 'firefox-versions.json');
  const previousVersions = fs.existsSync(versionsPath) ? fs.readFileSync(versionsPath, 'utf8') : undefined;
  const result = reuse ? {} : await installSource(ctx, archiveInfo, { replace: true });
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
    if (!reuse) {
      await fsp.rm(ctx.engineDir, { recursive: true, force: true });
      if (result.backup && fs.existsSync(result.backup)) await fsp.rename(result.backup, ctx.engineDir);
    }
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
  process.stdout.write(reuse
    ? `bento: Firefox ${version} source is already installed; updated bento.json from ${config.firefox.version}\n`
    : `bento: updated Firefox ${previous} -> ${version}; previous source is recoverable at ${result.backup}\n`);
}

function platformConfigName() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  fail(`unsupported host platform ${process.platform}`);
}

/** Canonical native build intent, without writing generated engine state. */
export function nativeBuildSettings(repoRoot = DEFAULT_ROOT, mode = undefined) {
  const ctx = createContext(repoRoot);
  const config = loadConfig(repoRoot);
  const platformName = platformConfigName();
  const selectedMode = resolveBuildMode(config, mode);
  assertGeneratedMozconfigInUse(ctx);
  assertFragmentsDoNotOverrideBento(ctx);
  if (updatesEnabled(config)) assertUpdaterReady(ctx, config);
  const objdirName = requestedObjDirName(ctx) || FIXED_OBJDIR;
  return {
    mode: selectedMode,
    platform: platformName,
    objdir: path.join(ctx.engineDir, objdirName),
    mozconfig: generatedMozconfigText(ctx, config, selectedMode, objdirName),
  };
}

export function writeMozconfig(repoRoot = DEFAULT_ROOT, mode = undefined) {
  assertLocalBuildPaths(repoRoot);
  const ctx = createContext(repoRoot);
  const config = loadConfig(repoRoot);
  const settings = nativeBuildSettings(repoRoot, mode);
  const destination = path.join(ctx.engineDir, 'mozconfig');
  // Unchanged files keep their mtime: configure depends on version.txt by mtime.
  writeFileIfChanged(destination, settings.mozconfig);
  for (const file of ['browser/config/version.txt', 'browser/config/version_display.txt']) {
    const target = path.join(ctx.engineDir, file);
    if (fs.existsSync(target)) writeFileIfChanged(target, config.brands[config.brand].release.displayVersion);
  }
  return { destination, mode: settings.mode, platform: settings.platform };
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
  assertGeneratedMozconfigInUse(ctx);
  const generated = writeMozconfig(ctx.root);
  const args = ['build'];
  if (ui) args.push('faster');
  if (jobs !== undefined) args.push(`-j${jobs}`);
  const build = () => run('bash', ['scripts/mach-raw.sh', ...args], {
    cwd: ctx.root,
    env: {
      ACCEPTED_MAR_CHANNEL_IDS: loadConfig(ctx.root).updates.channel,
      MAR_CHANNEL_ID: loadConfig(ctx.root).updates.channel,
    },
  });
  if (ui) await build();
  else {
    const { withNativeBuildReceipt } = await import('./native-build-state.mjs');
    await withNativeBuildReceipt(ctx.root, build);
  }
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

/**
 * The one Firefox object directory every tool must use: the directory engine/mozconfig
 * sends mach to (engine/obj-bento unless BENTO_OBJDIR chose another name when it was
 * generated). Returns `{ dir, configured, note }`:
 * - `dir` is that directory when it exists, else undefined;
 * - `configured` is its path either way, for error messages;
 * - `note` is set when `dir` is not the configured directory.
 * `package` and `updates-browser` need the directory mach builds into, so they use the
 * default. `allowLegacy` is for syncing an existing old build before the
 * configured directory exists: it falls back to the single legacy engine/obj-* directory
 * (or an existing BENTO_OBJDIR) with a note, and throws when the choice is ambiguous.
 */
export function resolveObjDir(ctx, { allowLegacy = false } = {}) {
  const requested = requestedObjDirName(ctx);
  const configuredName = mozconfigObjDirName(ctx) ?? requested ?? FIXED_OBJDIR;
  const configured = path.join(ctx.engineDir, configuredName);
  const result = (dir, note) => ({ dir, configured, note });

  if (requested && requested !== configuredName) {
    const mismatch = `BENTO_OBJDIR=${requested} differs from engine/${configuredName}, the directory engine/mozconfig builds into`;
    if (!allowLegacy) fail(`${mismatch}; run pnpm run build with the same BENTO_OBJDIR, or unset it`);
    const dir = path.join(ctx.engineDir, requested);
    if (!fs.existsSync(dir)) fail(`${mismatch}, and engine/${requested} does not exist`);
    return result(dir, `${mismatch}; using engine/${requested} as BENTO_OBJDIR asks`);
  }
  if (fs.existsSync(configured)) return result(configured);
  if (!allowLegacy || requested || !fs.existsSync(ctx.engineDir)) return result(undefined);

  const legacy = fs.readdirSync(ctx.engineDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('obj-'))
    .map((entry) => entry.name)
    .sort(compareNames);
  if (legacy.length > 1) {
    fail(`engine/${configuredName} does not exist and several legacy Firefox object directories were found (${legacy.join(', ')}); run pnpm run build to create engine/${configuredName}, or set BENTO_OBJDIR to one of them`);
  }
  return legacy.length
    ? result(path.join(ctx.engineDir, legacy[0]), `engine/${configuredName} does not exist; using the legacy object directory engine/${legacy[0]}. Run pnpm run build to create engine/${configuredName}.`)
    : result(undefined);
}

/** The directory mach builds into, or a clear failure for commands that must not guess. */
function requireConfiguredObjDir(ctx, command) {
  const { dir, configured } = resolveObjDir(ctx);
  if (!dir) fail(`${command}: ${path.relative(ctx.root, configured)} does not exist; run pnpm run build first (it is the directory mach builds into)`);
  return dir;
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
  // obj-bento has no target triple in its name; configure records the processor.
  const objDir = path.dirname(objDist);
  const mozinfo = path.join(objDir, 'mozinfo.json');
  const target = fs.existsSync(mozinfo) ? readJson(mozinfo).processor : undefined;
  return /aarch64|arm64/.test(String(target || path.basename(objDir)).toLowerCase()) ? 'arm64' : 'x64';
}

function platformLabel(objDist) {
  const prefix = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux';
  const architecture = targetArchitecture(objDist);
  return prefix === 'macos' && architecture === 'arm64' ? 'macos' : `${prefix}-${architecture}`;
}

function updateMarName(config, objDist) {
  return `Bento-${config.brands[config.brand].release.displayVersion}-${platformLabel(objDist)}.mar`;
}

export function updateMarUrl(config, marName) {
  const release = config.brands[config.brand].release;
  const baseUrl = release.github
    ? `https://github.com/${release.github.repo}/releases/download/v${release.displayVersion}`
    : `https://${config.updates.hostname}`;
  return `${baseUrl}/${marName}`;
}

function updateTargets(objDist) {
  const architecture = targetArchitecture(objDist);
  if (process.platform === 'darwin') return architecture === 'arm64' ? ['Darwin_aarch64-gcc3'] : PLATFORM_TARGETS.darwin.slice(1);
  if (process.platform === 'win32') return architecture === 'arm64' ? ['WINNT_aarch64-msvc-aarch64'] : PLATFORM_TARGETS.win32;
  return architecture === 'arm64' ? ['Linux_aarch64-gcc3'] : PLATFORM_TARGETS.linux;
}

export function readApplicationBuildId(content) {
  let inAppSection = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inAppSection = trimmed.slice(1, -1).trim() === 'App';
      continue;
    }
    if (!inAppSection) continue;
    const separator = line.indexOf('=');
    if (separator < 0 || line.slice(0, separator).trim() !== 'BuildID') continue;
    const buildId = line.slice(separator + 1).trim();
    if (buildId) return buildId;
  }
  return undefined;
}

function applicationIni(application) {
  if (!application) fail('package: packaged application is missing; cannot read application.ini');
  const file = path.basename(application).endsWith('.app')
    ? path.join(application, 'Contents', 'Resources', 'application.ini')
    : path.join(application, 'application.ini');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`package: application.ini missing from ${application}`);
  const buildId = readApplicationBuildId(fs.readFileSync(file, 'utf8'));
  if (!buildId) fail(`package: [App] BuildID missing from ${file}`);
  return { file, buildId };
}

function packagedApplication(objDist, config) {
  if (process.platform !== 'darwin') {
    const application = path.join(objDist, config.binaryName);
    return fs.existsSync(application) ? application : undefined;
  }
  return [
    path.join(objDist, config.binaryName, `${config.build.macosBundleName || 'Bento'}.app`),
    path.join(objDist, `${config.build.macosBundleName || 'Bento'}.app`),
  ].find((candidate) => fs.existsSync(path.join(candidate, 'Contents', 'Resources', 'precomplete')));
}

async function createMar(ctx, config, objDist) {
  const mar = process.platform === 'win32' ? path.join(objDist, 'host', 'bin', 'mar.exe') : path.join(objDist, 'host', 'bin', 'mar');
  if (!fs.existsSync(mar)) fail(`package: MAR tool missing at ${mar}`);
  const appDir = packagedApplication(objDist, config);
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
  const url = updateMarUrl(config, marName);
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

/**
 * The updater state the build was configured with, which is what the package would
 * contain. Two sources are read, and each must agree with bento.json: engine/mozconfig
 * (its last updater flag wins; it is what the next configure uses) and, once configure
 * has run, the object directory's config.status.json (what the last configure used,
 * and the one a mozconfig cannot disguise). Packaging a build whose updater differs
 * from bento.json would ship an updater the metadata says is absent, or the reverse.
 * The update channel configure recorded must also be bento.json's: a different one
 * (such as Mozilla's release) selects different update certificates.
 */
function builtUpdaterState(ctx, config, objDir) {
  const expected = updatesEnabled(config);
  const mozconfig = path.join(ctx.engineDir, 'mozconfig');
  const fromMozconfig = fs.existsSync(mozconfig) ? mozconfigUpdaterState(fs.readFileSync(mozconfig, 'utf8')) : true;
  const configure = configuredUpdateState(objDir);
  const recorded = `engine/${path.basename(objDir)}/config.status.json`;
  for (const [source, state] of [
    ['engine/mozconfig compiled', fromMozconfig],
    [`${recorded} configured`, configure?.updater],
  ]) {
    if (state !== undefined && state !== expected) {
      fail(`package: ${source} the updater ${state ? 'in' : 'out'}, but bento.json updates.enabled is ${expected}; run pnpm run build first`);
    }
  }
  if (configure && !isBentoChannel(configure.channel, config)) {
    fail(`package: ${recorded} configured the update channel ${JSON.stringify(configure.channel)}, but bento.json updates.channel is ${JSON.stringify(config.updates.channel)}; run pnpm run build first`);
  }
  return configure?.updater ?? fromMozconfig;
}

/** A build that cannot update must not leave MARs or update metadata from an earlier package behind. */
function removeUpdateOutputs(ctx) {
  fs.rmSync(path.join(ctx.distDir, 'output.mar'), { force: true });
  fs.rmSync(path.join(ctx.distDir, 'update'), { recursive: true, force: true });
}

async function commandPackage(ctx) {
  requireEngine(ctx);
  const config = loadConfig(ctx.root);
  assertGeneratedMozconfigInUse(ctx);
  if (updatesEnabled(config)) assertUpdaterReady(ctx, config);
  const objDir = requireConfiguredObjDir(ctx, 'package');
  const objDist = path.join(objDir, 'dist');
  // Releases ship only the published npm Mux (docs/build-tooling.md, "Local Mux UI").
  // Packaging copies the shell from the objdir, not from the imported source, so the
  // stamp is read there. The packager's input (dist/bin) is checked first only to fail
  // before the long mach package; the staged application below is the authoritative check.
  assertShellMuxSource(path.join(objDist, 'bin', 'browser'));
  const updates = builtUpdaterState(ctx, config, objDir);
  // Likewise the dev-only reload command: a release build over an object directory an
  // earlier dev build filled can still hold it, even though the staged sources are clean.
  if (isReleaseBuild(ctx.root)) assertNoDevReloadInPackage(objDist, `${config.build.macosBundleName || 'Bento'}.app`);
  await run('bash', ['scripts/mach-raw.sh', 'package'], { cwd: ctx.root });
  await run('bash', ['scripts/mach-raw.sh', 'package-multi-locale', '--locales', ...readLocales(ctx, config)], { cwd: ctx.root });
  const application = packagedApplication(objDist, config);
  if (!application) fail(`package: packaged ${config.binaryName} application is missing under ${objDist}`);
  assertShellMuxSource(stagedBrowserDir(application));
  copyDirectoryFiles(ctx, objDist);
  const build = applicationIni(application);
  const manifest = {
    schemaVersion: 1,
    displayVersion: config.brands[config.brand].release.displayVersion,
    firefoxVersion: config.firefox.version,
    updates: { enabled: updates },
    application: path.relative(ctx.root, application),
    applicationIni: path.relative(ctx.root, build.file),
    buildId: build.buildId,
    objDist: path.relative(ctx.root, objDist),
    locales: readLocales(ctx, config),
  };
  if (updates) {
    const mar = await createMar(ctx, config, objDist);
    const update = await writeBrowserUpdateFiles(ctx, config, mar.path, build.buildId, objDist);
    await writeAddonUpdateFiles(ctx, config);
    Object.assign(manifest, {
      mar: { path: path.relative(ctx.root, mar.path), name: update.marName, url: update.url },
      marTool: path.relative(ctx.root, mar.tool),
      updateTargets: update.targets,
    });
  } else {
    removeUpdateOutputs(ctx);
  }
  writeJson(path.join(ctx.distDir, 'bento-artifacts.json'), manifest);
  process.stdout.write(updates
    ? 'bento: package, MAR, locale, and update metadata complete\n'
    : 'bento: package and locales complete; the updater is disabled, so no MAR or update metadata was written\n');
}

async function commandBrowserUpdates(ctx) {
  const config = loadConfig(ctx.root);
  requireUpdatesEnabled(ctx, config, 'updates-browser');
  const marPath = path.join(ctx.distDir, 'output.mar');
  if (!fs.existsSync(marPath)) fail('updates-browser: dist/output.mar is missing; run package first');
  const objDist = path.join(requireConfiguredObjDir(ctx, 'updates-browser'), 'dist');
  const application = packagedApplication(objDist, config);
  const build = applicationIni(application);
  const result = await writeBrowserUpdateFiles(ctx, config, marPath, build.buildId, objDist);
  process.stdout.write(`bento: wrote browser updates (${result.targets.length} targets)\n`);
}

/**
 * Prints the selected object directory for the shell scripts, which must not pick one
 * themselves. `--allow-legacy` lets sync scripts use an old build when the
 * configured directory does not exist yet (the fallback is announced on stderr);
 * `--allow-missing` prints nothing instead of failing when there is no directory.
 */
function commandObjDir(ctx, { allowLegacy, allowMissing }) {
  const { dir, configured, note } = resolveObjDir(ctx, { allowLegacy });
  if (note) process.stderr.write(`bento: ${note}\n`);
  if (dir) process.stdout.write(`${dir}\n`);
  else if (!allowMissing) fail(`no Firefox object directory: ${path.relative(ctx.root, configured)} does not exist; run pnpm run build first`);
}

async function commandAddonUpdates(ctx) {
  const config = loadConfig(ctx.root);
  requireUpdatesEnabled(ctx, config, 'updates-addons');
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
  const options = { ui: false, force: false, replaceStale: false, allowMissing: false, allowLegacy: false };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--ui') options.ui = true;
    else if (argument === '--force') options.force = true;
    else if (argument === '--replace-stale') options.replaceStale = true;
    else if (argument === '--allow-missing') options.allowMissing = true;
    else if (argument === '--allow-legacy') options.allowLegacy = true;
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
  if (['download', 'update', 'bootstrap', 'build', 'package', 'updates-browser', 'updates-addons', 'record', 'preflight'].includes(command)) {
    assertLocalBuildPaths(repoRoot);
  }
  switch (command) {
    case 'preflight': return undefined;
    case 'download': return commandDownload(ctx, options.version, options);
    case 'update': return commandUpdate(ctx);
    case 'bootstrap': return commandBootstrap(ctx);
    case 'build': return commandBuild(ctx, options.ui, options.jobs);
    case 'package': return commandPackage(ctx);
    case 'updates-browser': return commandBrowserUpdates(ctx);
    case 'objdir': return commandObjDir(ctx, options);
    case 'native-check': {
      const { assertNativeBuildFresh } = await import('./native-build-state.mjs');
      const executable = await assertNativeBuildFresh(ctx.root);
      process.stdout.write(`${executable}\n`);
      return undefined;
    }
    case 'updates-addons': return commandAddonUpdates(ctx);
    case 'license-check': return commandLicenseCheck(ctx);
    case 'verify': {
      const isGit = engineIsGit(ctx);
      if (isGit) {
        const config = loadConfig(repoRoot);
        if (!sourceVersionFromState(ctx)) adoptExistingSource(ctx, config, config.firefox.version);
        ensureSourceIdentity(ctx, config, config.firefox.version, 'verify Firefox source');
      }
      const violations = isGit ? engineStateViolations(repoRoot) : [];
      if (!isGit || violations.length) {
        fail(withEnginePathList('engine contains changes outside the recorded/generated Bento state', violations));
      }
      process.stdout.write('bento: engine state is verified\n');
      return undefined;
    }
    case 'record':
      process.stdout.write(`bento: recorded ${recordEngineState(repoRoot)} managed engine paths\n`);
      return undefined;
    case 'help':
      process.stdout.write('Usage: bento-build <download|update|bootstrap|build|package|objdir|native-check|license-check|preflight>\n');
      return undefined;
    default: fail(`unknown Bento build command: ${command}`);
  }
}

// Compare real paths: Node resolves the module URL, so a checkout reached through a
// symlink would otherwise run nothing and exit 0.
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
