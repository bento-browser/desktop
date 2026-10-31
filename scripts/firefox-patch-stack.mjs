#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tinyGlob from 'tiny-glob';
import { completeArchiveExtraction } from './archive-members.mjs';
import { assertLocalBuildPaths } from './bento-build.mjs';

export const FIREFOX_PATCH_APPLY_ARGS = [
  '--ignore-space-change',
  '--ignore-whitespace',
  '--verbose',
];

// Git settings that change whether a patch applies (whitespace policy, line-ending
// conversion). They are pinned with `git -c` for the replay and for the live
// apply, so user, system or repository configuration cannot make one succeed
// where the other fails, and they are part of the recorded check hash.
export const FIREFOX_PATCH_GIT_CONFIG = [
  'apply.whitespace=warn',
  'core.autocrlf=false',
  'core.safecrlf=false',
];

// The scratch replay must write only to its own index and object directory. A
// split index would put sharedindex.* files in the engine's real git directory.
export const SCRATCH_GIT_CONFIG = ['core.splitIndex=false'];

function pinnedConfig(settings) {
  return settings.flatMap((setting) => ['-c', setting]);
}

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REPO_ROOT = process.env.BENTO_PATCH_STACK_REPO_ROOT || SCRIPT_ROOT;
const STACK_BRANCH = 'bento/patch-stack';
const STACK_REF = `refs/heads/${STACK_BRANCH}`;

class UserError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'UserError';
    this.exitCode = exitCode;
  }
}

function jsonRead(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function jsonWrite(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function git(args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const result = spawnSync('git', args, {
    cwd,
    env: options.env ? { ...process.env, ...options.env } : undefined,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new UserError(
      `git ${args.join(' ')} failed in ${cwd}${output ? `\n${output}` : ''}`,
      result.status || 1,
    );
  }
  return (result.stdout || '').trimEnd();
}

function gitOk(args, cwd) {
  return spawnSync('git', args, { cwd, stdio: 'ignore' }).status === 0;
}

function gitMaybe(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout.trimEnd(),
    stderr: result.stderr.trimEnd(),
    status: result.status,
  };
}

export function stageFirefoxSourceBase(sourceDir) {
  // Firefox archives contain files covered by their own .gitignore. Keep those
  // files in the immutable source baseline so patch replay is reproducible.
  git(['add', '-f', '.'], { cwd: sourceDir });
}

function ensureEngineGit(ctx) {
  if (!fs.existsSync(path.join(ctx.engineDir, '.git'))) {
    throw new UserError(
      'engine/.git is missing; run pnpm run download before using the patch stack helper.',
    );
  }
}

function baseRef(version) {
  return `refs/bento/firefox-base/${version}`;
}

function refCommit(ctx, ref) {
  return git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: ctx.engineDir });
}

function refTree(ctx, ref) {
  return git(['rev-parse', `${ref}^{tree}`], { cwd: ctx.engineDir });
}

export function refContentTree(ctx, ref) {
  const result = spawnSync('git', ['ls-tree', '-r', '-z', ref], {
    cwd: ctx.engineDir,
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .map((value) => value.toString('utf8'))
      .join('\n')
      .trim();
    throw new UserError(
      `git ls-tree -r -z ${ref} failed in ${ctx.engineDir}${output ? `\n${output}` : ''}`,
      result.status || 1,
    );
  }

  const hash = crypto.createHash('sha256');
  for (const record of result.stdout.subarray(0, -1).toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, object] = record.slice(0, tab).split(' ');
    const objectKind = mode === '120000' ? 'symlink' : mode === '160000' ? 'submodule' : type;
    hash.update(objectKind);
    hash.update('\0');
    hash.update(object);
    hash.update('\0');
    hash.update(record.slice(tab + 1));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function hasRef(ctx, ref) {
  return gitOk(['rev-parse', '--verify', `${ref}^{commit}`], ctx.engineDir);
}

function parseArgs(argv) {
  const command = argv[0] || 'check';
  const flags = new Set(argv.slice(1).filter((arg) => arg.startsWith('--')));
  return { command, flags };
}

export function createContext(repoRoot = DEFAULT_REPO_ROOT) {
  const root = path.resolve(repoRoot);
  return {
    repoRoot: root,
    patchesDir: path.join(root, 'patches'),
    srcDir: path.join(root, 'src'),
    engineDir: path.join(root, 'engine'),
    bentoDir: path.join(root, '.bento'),
    bentoSourceDir: path.join(root, '.bento', 'cache', 'source'),
    manifestPath: path.join(root, 'patches', 'series.json'),
    bentoPath: path.join(root, 'bento.json'),
    stackWorktreeDir: path.join(root, '.bento', 'patch-stack-worktree'),
    checkRecordPath: path.join(root, '.bento', 'patch-check.json'),
  };
}

async function repoPatchPaths(ctx) {
  if (!fs.existsSync(ctx.patchesDir)) {
    return [];
  }
  const patches = await tinyGlob('**/*.patch', {
    cwd: ctx.patchesDir,
    filesOnly: true,
  });
  return patches.map((patch) => `patches/${patch.split(path.sep).join('/')}`);
}

async function unmanagedSrcPatches(ctx) {
  if (!fs.existsSync(ctx.srcDir)) {
    return [];
  }
  const patches = await tinyGlob('**/*.patch', {
    cwd: ctx.srcDir,
    filesOnly: true,
  });
  return patches.map((patch) => `src/${patch.split(path.sep).join('/')}`);
}

function loadBento(ctx) {
  return jsonRead(ctx.bentoPath);
}

function loadManifest(ctx) {
  if (!fs.existsSync(ctx.manifestPath)) {
    throw new UserError('patches/series.json is missing.');
  }
  return jsonRead(ctx.manifestPath);
}

function validateManifestShape(ctx, manifest) {
  const errors = [];
  if (manifest.schemaVersion !== 1) {
    errors.push('schemaVersion must be 1.');
  }
  if (!manifest.base || typeof manifest.base !== 'object') {
    errors.push('base must be an object.');
  } else {
    if (!manifest.base.product) errors.push('base.product is required.');
    if (!manifest.base.version) errors.push('base.version is required.');
    if (manifest.base.tree !== undefined && typeof manifest.base.tree !== 'string') {
      errors.push('base.tree must be a string when present.');
    }
    if (
      manifest.base.contentTree !== undefined &&
      !/^[0-9a-f]{64}$/.test(manifest.base.contentTree)
    ) {
      errors.push('base.contentTree must be a lowercase SHA-256 hash when present.');
    }
  }
  if (!Array.isArray(manifest.series)) {
    errors.push('series must be an array.');
    return errors;
  }

  const paths = new Set();
  const ids = new Set();
  for (const [index, entry] of manifest.series.entries()) {
    const label = `series[${index}]`;
    if (!entry || typeof entry !== 'object') {
      errors.push(`${label} must be an object.`);
      continue;
    }
    if (!entry.path || typeof entry.path !== 'string') {
      errors.push(`${label}.path is required.`);
    } else {
      if (!entry.path.startsWith('patches/') || !entry.path.endsWith('.patch')) {
        errors.push(`${entry.path} must be under patches/**/*.patch.`);
      }
      if (path.isAbsolute(entry.path) || entry.path.includes('..')) {
        errors.push(`${entry.path} must be a clean repo-relative path.`);
      }
      if (paths.has(entry.path)) errors.push(`duplicate patch path: ${entry.path}`);
      paths.add(entry.path);
      if (!fs.existsSync(path.join(ctx.repoRoot, entry.path))) {
        errors.push(`manifest patch is missing: ${entry.path}`);
      }
    }
    if (!entry.id || typeof entry.id !== 'string') {
      errors.push(`${label}.id is required.`);
    } else {
      if (ids.has(entry.id)) errors.push(`duplicate patch id: ${entry.id}`);
      ids.add(entry.id);
    }
    if (!entry.subject || typeof entry.subject !== 'string') {
      errors.push(`${label}.subject is required.`);
    }
  }
  return errors;
}

async function validateManifest(ctx, manifest, options = {}) {
  const errors = validateManifestShape(ctx, manifest);
  if (errors.length) {
    return errors;
  }

  const manifestPaths = manifest.series.map((entry) => entry.path);
  const manifestPathSet = new Set(manifestPaths);
  const repoPatches = await repoPatchPaths(ctx);
  const srcPatches = await unmanagedSrcPatches(ctx);

  for (const srcPatch of srcPatches) {
    errors.push(
      `${srcPatch} is unmanaged. Bento applies only the ordered patches listed in patches/series.json.`,
    );
  }

  for (const patchPath of repoPatches) {
    if (!manifestPathSet.has(patchPath)) {
      errors.push(`extra repo patch is not listed in patches/series.json: ${patchPath}`);
    }
  }
  for (const patchPath of manifestPaths) {
    if (!repoPatches.includes(patchPath)) {
      errors.push(`manifest patch is not present under patches/: ${patchPath}`);
    }
  }

  for (const patchPath of manifestPaths) {
    const content = fs.readFileSync(path.join(ctx.repoRoot, patchPath), 'utf8');
    if (!content.includes('diff --git ')) {
      errors.push(`${patchPath} has no diff --git section.`);
    }
    if (manifest.format === 'git-format-patch' && !/^From [0-9a-f]{40} /m.test(content)) {
      errors.push(`${patchPath} is not mail-style git format-patch output.`);
    }
  }

  if (options.forImport) {
    const target = loadBento(ctx).firefox?.version;
    if (manifest.base.version !== target) {
      errors.push(
        [
          `patch stack base ${manifest.base.version} does not match configured Firefox ${target}.`,
          'Run: pnpm run firefox:patches:rebase',
          'Then: pnpm run import',
        ].join('\n'),
      );
    }
  }

  return errors;
}

function getCachedArchive(ctx, version) {
  if (!isSupportedFirefoxVersion(version)) {
    throw new UserError(`unsupported Firefox version: ${JSON.stringify(version)}`);
  }
  return path.join(ctx.bentoSourceDir, version, `firefox-${version}.source.tar.xz`);
}

function isSupportedFirefoxVersion(version) {
  return typeof version === 'string'
    && version.length > 0
    && version.length <= 128
    && /^[0-9]+(?:\.[0-9]+)+(?:[A-Za-z][0-9A-Za-z.-]*|-[0-9A-Za-z.-]+)?$/.test(version);
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

async function downloadFirefoxArchive(ctx, version) {
  await fsp.mkdir(path.dirname(getCachedArchive(ctx, version)), { recursive: true });
  const archive = getCachedArchive(ctx, version);
  const config = loadBento(ctx);
  const expected = version === config.firefox?.version
    ? config.firefox.source?.sha256
    : process.env.BENTO_SOURCE_SHA256;
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) {
    throw new UserError(
      `no trusted SHA-256 digest is configured for Firefox ${version}; set BENTO_SOURCE_SHA256 before fetching another baseline`,
    );
  }
  if (fs.existsSync(archive)) {
    const actual = await sha256File(archive);
    if (actual !== expected.toLowerCase()) {
      const quarantined = `${archive}.bad-${Date.now()}`;
      await fsp.rename(archive, quarantined).catch(() => undefined);
      throw new UserError(`Firefox ${version} source archive digest mismatch: expected ${expected}, got ${actual}`);
    }
    return archive;
  }
  const url = `https://archive.mozilla.org/pub/firefox/releases/${version}/source/firefox-${version}.source.tar.xz`;
  process.stderr.write(`firefox-patch-stack: downloading ${url}\n`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new UserError(
      `failed to download Firefox ${version} source archive: HTTP ${response.status}`,
    );
  }
  const file = fs.createWriteStream(archive);
  await new Promise((resolve, reject) => {
    Readable.fromWeb(response.body).pipe(file);
    file.on('finish', resolve);
    file.on('error', reject);
  });
  const actual = await sha256File(archive);
  if (actual !== expected.toLowerCase()) {
    await fsp.rm(archive, { force: true });
    throw new UserError(`Firefox ${version} source archive digest mismatch: expected ${expected}, got ${actual}`);
  }
  return archive;
}

export function extractArchive(archive, dest) {
  const candidates = process.platform === 'darwin' ? ['gtar', 'tar'] : ['tar'];
  const base = process.platform === 'win32' ? ['--force-local'] : [];
  // Runs from the archive's directory, where completeArchiveExtraction puts its member list.
  const tar = (...args) => {
    let last;
    for (const command of candidates) {
      const result = spawnSync(command, [...base, ...args], {
        cwd: path.dirname(archive),
        encoding: 'utf8',
        stdio: 'pipe',
        // The listing of a Firefox source archive is tens of megabytes.
        maxBuffer: 256 * 1024 * 1024,
      });
      if (result.status === 0) {
        return result.stdout;
      }
      last = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    }
    throw new UserError(`failed to extract ${archive}${last ? `\n${last}` : ''}`);
  };
  const entries = tar('-tf', archive).split(/\r?\n/).filter(Boolean);
  tar('-xf', archive, '-C', dest);
  completeArchiveExtraction({
    archive,
    entries,
    destination: dest,
    extractMembers: (listName) => tar('-xf', archive, '-C', dest, '-T', listName),
    fail: (message) => {
      throw new UserError(message);
    },
  });
}

function assertExpectedBase(ctx, ref, expectedTree, expectedContentTree) {
  const tree = refTree(ctx, ref);
  if (!expectedTree || tree === expectedTree) {
    return { tree, contentTree: expectedContentTree ? refContentTree(ctx, ref) : undefined };
  }

  const contentTree = refContentTree(ctx, ref);
  if (expectedContentTree && contentTree === expectedContentTree) {
    process.stderr.write(
      `firefox-patch-stack: accepted platform-specific tree ${tree}; canonical content matches ${expectedContentTree}\n`,
    );
    return { tree, contentTree };
  }

  throw new UserError(
    [
      `${ref} tree ${tree} does not match patches/series.json base.tree ${expectedTree}.`,
      expectedContentTree
        ? `Canonical content tree ${contentTree} does not match ${expectedContentTree}.`
        : 'No canonical base.contentTree fallback is recorded.',
    ].join('\n'),
  );
}

async function ensureBaseRef(ctx, version, expectedTree, expectedContentTree) {
  assertLocalBuildPaths(ctx.repoRoot);
  ensureEngineGit(ctx);
  const ref = baseRef(version);
  if (hasRef(ctx, ref)) {
    const validated = assertExpectedBase(ctx, ref, expectedTree, expectedContentTree);
    return { ref, commit: refCommit(ctx, ref), ...validated };
  }

  if (hasRef(ctx, `refs/heads/${version}`)) {
    git(['update-ref', ref, `refs/heads/${version}`], { cwd: ctx.engineDir });
    const validated = assertExpectedBase(ctx, ref, expectedTree, expectedContentTree);
    return { ref, commit: refCommit(ctx, ref), ...validated };
  }

  const archive = await downloadFirefoxArchive(ctx, version);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `bento-firefox-${version}-`));
  try {
    extractArchive(archive, tempRoot);
    const entries = (await fsp.readdir(tempRoot, { withFileTypes: true })).filter((entry) =>
      entry.isDirectory(),
    );
    if (entries.length !== 1) {
      throw new UserError(
        `expected one extracted Firefox source directory in ${tempRoot}, found ${entries.length}`,
      );
    }
    const sourceDir = path.join(tempRoot, entries[0].name);
    git(['init'], { cwd: sourceDir });
    git(['config', 'user.name', 'Bento Patch Stack'], { cwd: sourceDir });
    git(['config', 'user.email', 'patch-stack@bentobrowser.invalid'], { cwd: sourceDir });
    stageFirefoxSourceBase(sourceDir);
    git(['commit', '-m', `Firefox ${version}`], { cwd: sourceDir, stdio: 'ignore' });
    git(['fetch', sourceDir, `HEAD:${ref}`], { cwd: ctx.engineDir });
    const validated = assertExpectedBase(ctx, ref, expectedTree, expectedContentTree);
    return { ref, commit: refCommit(ctx, ref), ...validated };
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

function registeredWorktrees(ctx) {
  const result = gitMaybe(['worktree', 'list', '--porcelain'], ctx.engineDir);
  if (!result.ok) {
    throw new UserError(
      `cannot inspect registered Git worktrees before cleanup in ${ctx.engineDir}: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => canonicalPath(line.slice('worktree '.length)));
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

export function canonicalPath(target) {
  const absolute = path.resolve(target);
  const canonical = tryRealpath(absolute)
    || path.join(tryRealpath(path.dirname(absolute)) || path.dirname(absolute), path.basename(absolute));
  const normalized = path.normalize(canonical);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function removeWorktree(ctx, worktreeDir) {
  const requested = canonicalPath(worktreeDir);
  const registered = registeredWorktrees(ctx).includes(requested);
  if (!fs.existsSync(worktreeDir)) {
    if (registered) {
      throw new UserError(
        `registered patch worktree is missing: ${worktreeDir}. Inspect with git -C ${ctx.engineDir} worktree list --porcelain before pruning it.`,
      );
    }
    return;
  }
  if (!registered) {
    const entries = fs.readdirSync(worktreeDir);
    if (entries.length > 0) {
      throw new UserError(
        `unregistered patch worktree directory contains files: ${worktreeDir}. Preserve or remove it explicitly before retrying.`,
      );
    }
    fs.rmdirSync(worktreeDir);
    return;
  }
  const status = gitMaybe(['status', '--porcelain', '--untracked-files=all'], worktreeDir);
  if (!status.ok) {
    throw new UserError(
      `cannot inspect patch worktree before cleanup: ${worktreeDir}\n${status.stderr || status.stdout}`,
    );
  }
  if (status.stdout.trim()) {
    throw new UserError(
      `refusing to delete dirty patch worktree: ${worktreeDir}\nPreserve or resolve it first.\n${status.stdout}`,
    );
  }
  const removed = gitMaybe(['worktree', 'remove', worktreeDir], ctx.engineDir);
  if (!removed.ok) {
    throw new UserError(
      `failed to deregister patch worktree ${worktreeDir}; it was preserved.\n${removed.stderr || removed.stdout}`,
    );
  }
  if (registeredWorktrees(ctx).includes(requested)) {
    throw new UserError(`Git still registers patch worktree ${worktreeDir}; it was preserved.`);
  }
  if (fs.existsSync(worktreeDir)) {
    const entries = fs.readdirSync(worktreeDir);
    if (entries.length > 0) {
      throw new UserError(
        `deregistered patch worktree still contains files: ${worktreeDir}. Preserve them before retrying.`,
      );
    }
    fs.rmdirSync(worktreeDir);
  }
}

function assertNoActiveStackWorktree(ctx) {
  if (!fs.existsSync(ctx.stackWorktreeDir)) {
    return;
  }
  throw new UserError(
    [
      `patch stack worktree already exists: ${ctx.stackWorktreeDir}`,
      'Finish or remove that worktree before rerunning this command.',
      `Inspect: git -C ${ctx.stackWorktreeDir} status`,
    ].join('\n'),
  );
}

function applyPatchToWorktree(ctx, worktreeDir, patchPath, { index = false } = {}) {
  const args = [...pinnedConfig(FIREFOX_PATCH_GIT_CONFIG), 'apply', ...FIREFOX_PATCH_APPLY_ARGS];
  if (index) {
    args.push('--index');
  }
  args.push(path.join(ctx.repoRoot, patchPath));
  git(args, { cwd: worktreeDir });
}

/**
 * Validates that the series applies in manifest order without checking out a
 * worktree (Firefox has ~470k files). The base tree is read into a temporary
 * index and each patch is applied to it with `git apply --cached`, using the
 * same whitespace arguments as `apply`. The engine's index, working tree and
 * object store are not touched: blobs the patches create go to a scratch
 * object directory that reads the engine's objects through an alternate.
 */
export async function replaySeries(ctx, manifest, ref) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-patch-replay-'));
  const objects = path.join(scratch, 'objects');
  fs.mkdirSync(objects);
  const env = {
    GIT_INDEX_FILE: path.join(scratch, 'index'),
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.resolve(
      ctx.engineDir,
      git(['rev-parse', '--git-path', 'objects'], { cwd: ctx.engineDir }),
    ),
  };
  try {
    const config = pinnedConfig([...FIREFOX_PATCH_GIT_CONFIG, ...SCRATCH_GIT_CONFIG]);
    git([...config, 'read-tree', ref], { cwd: ctx.engineDir, env });
    for (const entry of manifest.series) {
      try {
        git(
          [
            ...config,
            'apply',
            '--cached',
            ...FIREFOX_PATCH_APPLY_ARGS,
            path.join(ctx.repoRoot, entry.path),
          ],
          { cwd: ctx.engineDir, env },
        );
      } catch (error) {
        throw new UserError(
          `failed to apply ${entry.path} (${entry.id}) onto ${ref}\n${error.message}`,
          error.exitCode,
        );
      }
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A checkout without symlink support (core.symlinks=false) materializes tracked
 * symlinks as plain files, so `apply` fails on a patch that changes one with
 * "wrong type" while the index-only replay passes. Fail up front, before any
 * mutation, when the series touches a symlink on such a checkout.
 */
function assertSymlinkPatchesSupported(ctx, manifest, ref) {
  const setting = gitMaybe(['config', '--type=bool', '--get', 'core.symlinks'], ctx.engineDir);
  if (!setting.ok || setting.stdout !== 'false') return;

  const pathsByPatch = new Map();
  const symlinkPatches = new Set();
  for (const entry of manifest.series) {
    const text = fs.readFileSync(path.join(ctx.repoRoot, entry.path), 'utf8');
    pathsByPatch.set(
      entry.path,
      [...text.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)].flatMap((match) => [match[1], match[2]]),
    );
    // Mode lines and "index <old>..<new> 120000" name the symlink file mode.
    if (/^(?:(?:old|new|deleted file|new file) mode |index [0-9a-f]+\.\.[0-9a-f]+ )120000\s*$/m.test(text)) {
      symlinkPatches.add(entry.path);
    }
  }
  const patched = [...new Set([...pathsByPatch.values()].flat())];
  if (patched.length) {
    const listing = git(['ls-tree', '-z', ref, '--', ...patched], { cwd: ctx.engineDir });
    const baseSymlinks = new Set(
      listing
        .split('\0')
        .filter((record) => record.startsWith('120000 '))
        .map((record) => record.slice(record.indexOf('\t') + 1)),
    );
    for (const [patchPath, paths] of pathsByPatch) {
      if (paths.some((file) => baseSymlinks.has(file))) symlinkPatches.add(patchPath);
    }
  }
  if (symlinkPatches.size) {
    throw new UserError(
      [
        'core.symlinks=false in the engine repository, so tracked symlinks are checked out as',
        'plain files and applying a patch that changes one fails with "wrong type".',
        `Patches that touch symlinks: ${[...symlinkPatches].join(', ')}`,
        'Enable symlink support for the engine checkout (core.symlinks=true) and retry.',
      ].join('\n'),
    );
  }
}

/**
 * Hash of everything the replay result depends on: the resolved base commit,
 * the apply arguments, the pinned git settings, and every file under patches/
 * (series.json included).
 */
async function seriesInputsHash(ctx, base) {
  const hash = crypto.createHash('sha256');
  hash.update(`${base.commit}\0${FIREFOX_PATCH_APPLY_ARGS.join(' ')}\0`);
  hash.update(`${[...FIREFOX_PATCH_GIT_CONFIG, ...SCRATCH_GIT_CONFIG].join(' ')}\0`);
  const files = await tinyGlob('**/*', { cwd: ctx.patchesDir, filesOnly: true });
  for (const file of files.map((name) => name.split(path.sep).join('/')).sort()) {
    hash.update(`${file}\0`);
    hash.update(fs.readFileSync(path.join(ctx.patchesDir, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function recordedSeriesHash(ctx) {
  try {
    return jsonRead(ctx.checkRecordPath).hash;
  } catch {
    return undefined;
  }
}

/**
 * Replays the series unless these exact patches already passed against this
 * exact base. The pass is recorded under .bento/ so unchanged imports skip it.
 */
async function checkSeries(ctx, manifest, base, { force = false } = {}) {
  // Not part of the recorded hash because it depends on local git configuration.
  assertSymlinkPatchesSupported(ctx, manifest, base.ref);
  const hash = await seriesInputsHash(ctx, base);
  if (!force && recordedSeriesHash(ctx) === hash) return { skipped: true };
  await replaySeries(ctx, manifest, base.ref);
  fs.mkdirSync(ctx.bentoDir, { recursive: true });
  jsonWrite(ctx.checkRecordPath, { schemaVersion: 1, hash });
  return { skipped: false };
}

function patchIsMailStyle(ctx, patchPath) {
  return /^From [0-9a-f]{40} /m.test(fs.readFileSync(path.join(ctx.repoRoot, patchPath), 'utf8'));
}

function commitLegacyPatch(ctx, worktreeDir, entry) {
  applyPatchToWorktree(ctx, worktreeDir, entry.path, { index: true });
  git(['commit', '-m', entry.subject], { cwd: worktreeDir });
}

export async function materialize(ctx, manifest, options = {}) {
  const base = await ensureBaseRef(
    ctx,
    manifest.base.version,
    manifest.base.tree,
    manifest.base.contentTree,
  );
  const worktreeDir = options.worktreeDir || ctx.stackWorktreeDir;
  if (!options.allowExistingWorktree) {
    assertNoActiveStackWorktree(ctx);
  }
  removeWorktree(ctx, worktreeDir);
  await fsp.mkdir(path.dirname(worktreeDir), { recursive: true });
  git(['worktree', 'add', '--detach', worktreeDir, base.ref], { cwd: ctx.engineDir });
  try {
    git(['switch', '-C', STACK_BRANCH, base.ref], { cwd: worktreeDir });
    git(['config', 'user.name', 'Bento Patch Stack'], { cwd: worktreeDir });
    git(['config', 'user.email', 'patch-stack@bentobrowser.invalid'], { cwd: worktreeDir });
    for (const entry of manifest.series) {
      if (patchIsMailStyle(ctx, entry.path)) {
        const result = gitMaybe(['am', '-3', path.join(ctx.repoRoot, entry.path)], worktreeDir);
        if (!result.ok) {
          throw new UserError(
            [
              `failed to apply ${entry.path} with git am in ${worktreeDir}.`,
              result.stdout,
              result.stderr,
              `Inspect: git -C ${worktreeDir} status`,
            ]
              .filter(Boolean)
              .join('\n'),
            result.status || 1,
          );
        }
      } else {
        commitLegacyPatch(ctx, worktreeDir, entry);
      }
    }
    return { worktreeDir, base };
  } finally {
    if (options.keepWorktree !== true) {
      removeWorktree(ctx, worktreeDir);
    }
  }
}

function branchExists(ctx, branch = STACK_BRANCH) {
  return gitOk(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], ctx.engineDir);
}

async function exportStack(ctx, manifest, options = {}) {
  const bento = loadBento(ctx);
  const targetVersion = bento.firefox?.version;
  const targetProduct = bento.firefox?.product || manifest.base.product || 'firefox';
  const targetBase = await ensureBaseRef(ctx, targetVersion);
  if (!branchExists(ctx)) {
    throw new UserError(`missing ${STACK_BRANCH}; run pnpm run firefox:patches:materialize first.`);
  }

  const mergeBase = git(['merge-base', targetBase.ref, STACK_REF], { cwd: ctx.engineDir });
  const targetCommit = refCommit(ctx, targetBase.ref);
  if (mergeBase !== targetCommit) {
    throw new UserError(
      `${STACK_BRANCH} is not based on ${targetBase.ref}; run pnpm run firefox:patches:rebase.`,
    );
  }

  const mergeCommits = git(['rev-list', '--merges', `${targetBase.ref}..${STACK_REF}`], {
    cwd: ctx.engineDir,
  });
  if (mergeCommits.trim()) {
    throw new UserError(
      `${STACK_BRANCH} contains merge commits; keep the Firefox patch stack linear.`,
    );
  }
  const commits = git(['rev-list', '--reverse', `${targetBase.ref}..${STACK_REF}`], {
    cwd: ctx.engineDir,
  })
    .split('\n')
    .filter(Boolean);
  if (commits.length !== manifest.series.length) {
    throw new UserError(
      `${STACK_BRANCH} has ${commits.length} commits but patches/series.json lists ${manifest.series.length} patches.`,
    );
  }

  for (const [index, commit] of commits.entries()) {
    const entry = manifest.series[index];
    const output = execFileSync(
      'git',
      ['format-patch', '-1', '--stdout', '--full-index', '--binary', commit],
      { cwd: ctx.engineDir, encoding: 'utf8' },
    );
    fs.writeFileSync(path.join(ctx.repoRoot, entry.path), output);
  }

  const updated = {
    ...manifest,
    format: 'git-format-patch',
    base: {
      product: targetProduct,
      version: targetVersion,
      tree: targetBase.tree,
      contentTree: targetBase.contentTree || refContentTree(ctx, targetBase.ref),
    },
  };
  jsonWrite(ctx.manifestPath, updated);
  await checkSeries(ctx, updated, targetBase, { force: true });
  if (!options.quiet) {
    process.stdout.write(`exported ${commits.length} Firefox patch commits for ${targetVersion}\n`);
  }
  return updated;
}

async function commandCheck(ctx, flags) {
  const manifest = loadManifest(ctx);
  const errors = await validateManifest(ctx, manifest, { forImport: flags.has('--for-import') });
  if (errors.length) {
    throw new UserError(errors.join('\n'));
  }
  const base = await ensureBaseRef(
    ctx,
    manifest.base.version,
    manifest.base.tree,
    manifest.base.contentTree,
  );
  const { skipped } = await checkSeries(ctx, manifest, base, { force: flags.has('--force') });
  process.stdout.write(
    skipped
      ? 'firefox-patch-stack: check passed (patches and base unchanged since the last successful check; use --force to replay)\n'
      : 'firefox-patch-stack: check passed\n',
  );
}

async function commandMaterialize(ctx) {
  const manifest = loadManifest(ctx);
  const errors = await validateManifest(ctx, manifest);
  if (errors.length) {
    throw new UserError(errors.join('\n'));
  }
  await materialize(ctx, manifest);
  process.stdout.write(
    `firefox-patch-stack: materialized ${manifest.series.length} commits on ${STACK_BRANCH}\n`,
  );
}

async function commandRebase(ctx) {
  const manifest = loadManifest(ctx);
  const errors = await validateManifest(ctx, manifest);
  if (errors.length) {
    throw new UserError(errors.join('\n'));
  }
  const bento = loadBento(ctx);
  const targetVersion = bento.firefox?.version;
  const oldBase = await ensureBaseRef(
    ctx,
    manifest.base.version,
    manifest.base.tree,
    manifest.base.contentTree,
  );
  const targetBase = await ensureBaseRef(ctx, targetVersion);

  await materialize(ctx, manifest);
  assertNoActiveStackWorktree(ctx);
  await fsp.mkdir(path.dirname(ctx.stackWorktreeDir), { recursive: true });
  git(['worktree', 'add', ctx.stackWorktreeDir, STACK_BRANCH], { cwd: ctx.engineDir });
  const result = gitMaybe(
    ['rebase', '--onto', targetBase.ref, oldBase.ref, STACK_BRANCH],
    ctx.stackWorktreeDir,
  );
  if (!result.ok) {
    throw new UserError(
      [
        `Firefox patch stack rebase stopped in ${ctx.stackWorktreeDir}.`,
        result.stdout,
        result.stderr,
        '',
        `git -C ${ctx.stackWorktreeDir} status`,
        `# resolve files in ${ctx.stackWorktreeDir}`,
        `git -C ${ctx.stackWorktreeDir} add <files>`,
        `git -C ${ctx.stackWorktreeDir} rebase --continue`,
        'pnpm run firefox:patches:export',
        'pnpm run import',
      ]
        .filter((line) => line !== undefined)
        .join('\n'),
      result.status || 1,
    );
  }
  removeWorktree(ctx, ctx.stackWorktreeDir);
  await exportStack(ctx, manifest);
}

async function commandExport(ctx) {
  const manifest = loadManifest(ctx);
  const errors = await validateManifest(ctx, manifest);
  if (errors.length) {
    throw new UserError(errors.join('\n'));
  }
  await exportStack(ctx, manifest);
}

async function commandApply(ctx) {
  const manifest = loadManifest(ctx);
  const errors = await validateManifest(ctx, manifest, { forImport: true });
  if (errors.length) {
    throw new UserError(errors.join('\n'));
  }
  ensureEngineGit(ctx);
  const base = await ensureBaseRef(
    ctx,
    manifest.base.version,
    manifest.base.tree,
    manifest.base.contentTree,
  );
  assertSymlinkPatchesSupported(ctx, manifest, base.ref);
  for (const entry of manifest.series) {
    try {
      applyPatchToWorktree(ctx, ctx.engineDir, entry.path);
    } catch (error) {
      throw new UserError(`failed to apply ${entry.path} (${entry.id})\n${error.message}`);
    }
  }
  process.stdout.write(`firefox-patch-stack: applied ${manifest.series.length} patches\n`);
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const ctx = createContext(options.repoRoot || DEFAULT_REPO_ROOT);
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case 'check':
      await commandCheck(ctx, flags);
      break;
    case 'materialize':
      await commandMaterialize(ctx);
      break;
    case 'rebase':
      await commandRebase(ctx);
      break;
    case 'export':
      await commandExport(ctx);
      break;
    case 'apply':
      await commandApply(ctx);
      break;
    default:
      throw new UserError(`unknown command: ${command}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof UserError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(error.exitCode);
    }
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
