#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tinyGlob from 'tiny-glob';

export const SURFER_APPLY_ARGS = [
  '--ignore-space-change',
  '--ignore-whitespace',
  '--verbose',
];

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

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
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

function ensureEngineGit(ctx) {
  if (!fs.existsSync(path.join(ctx.engineDir, '.git'))) {
    throw new UserError('engine/.git is missing; run pnpm run download before using the patch stack helper.');
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
    surferDir: path.join(root, '.surfer'),
    surferEngineDir: path.join(root, '.surfer', 'engine'),
    manifestPath: path.join(root, 'patches', 'series.json'),
    surferPath: path.join(root, 'surfer.json'),
    stackWorktreeDir: path.join(root, '.surfer', 'patch-stack-worktree'),
  };
}

async function surferRepoPatchOrder(ctx) {
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

function loadSurfer(ctx) {
  return jsonRead(ctx.surferPath);
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
  const repoOrder = await surferRepoPatchOrder(ctx);
  const srcPatches = await unmanagedSrcPatches(ctx);

  for (const srcPatch of srcPatches) {
    errors.push(
      `${srcPatch} is unmanaged. Surfer applies src/**/*.patch before patches/**/*.patch; this helper only manages repo-owned patches/**/*.patch files.`,
    );
  }

  for (const patchPath of repoOrder) {
    if (!manifestPathSet.has(patchPath)) {
      errors.push(`extra repo patch is not listed in patches/series.json: ${patchPath}`);
    }
  }
  for (const patchPath of manifestPaths) {
    if (!repoOrder.includes(patchPath)) {
      errors.push(`manifest patch is not in Surfer repo patch scan: ${patchPath}`);
    }
  }
  if (repoOrder.length === manifestPaths.length) {
    for (let index = 0; index < repoOrder.length; index += 1) {
      if (repoOrder[index] !== manifestPaths[index]) {
        errors.push(
          `manifest order differs from Surfer order at index ${index}: manifest has ${manifestPaths[index]}, Surfer has ${repoOrder[index]}`,
        );
        break;
      }
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
    const target = loadSurfer(ctx).version?.version;
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
  return path.join(ctx.surferEngineDir, `firefox-${version}.source.tar.xz`);
}

async function downloadFirefoxArchive(ctx, version) {
  await fsp.mkdir(ctx.surferEngineDir, { recursive: true });
  const archive = getCachedArchive(ctx, version);
  if (fs.existsSync(archive)) {
    return archive;
  }
  const url = `https://archive.mozilla.org/pub/firefox/releases/${version}/source/firefox-${version}.source.tar.xz`;
  process.stderr.write(`firefox-patch-stack: downloading ${url}\n`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new UserError(`failed to download Firefox ${version} source archive: HTTP ${response.status}`);
  }
  const file = fs.createWriteStream(archive);
  await new Promise((resolve, reject) => {
    Readable.fromWeb(response.body).pipe(file);
    file.on('finish', resolve);
    file.on('error', reject);
  });
  return archive;
}

function extractArchive(archive, dest) {
  const candidates = process.platform === 'darwin' ? ['gtar', 'tar'] : ['tar'];
  let last;
  for (const command of candidates) {
    const result = spawnSync(command, ['-xf', archive, '-C', dest], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (result.status === 0) {
      return;
    }
    last = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  }
  throw new UserError(`failed to extract ${archive}${last ? `\n${last}` : ''}`);
}

async function ensureBaseRef(ctx, version, expectedTree) {
  ensureEngineGit(ctx);
  const ref = baseRef(version);
  if (hasRef(ctx, ref)) {
    const tree = refTree(ctx, ref);
    if (expectedTree && tree !== expectedTree) {
      throw new UserError(`${ref} tree ${tree} does not match patches/series.json base.tree ${expectedTree}.`);
    }
    return { ref, commit: refCommit(ctx, ref), tree };
  }

  if (hasRef(ctx, `refs/heads/${version}`)) {
    git(['update-ref', ref, `refs/heads/${version}`], { cwd: ctx.engineDir });
    const tree = refTree(ctx, ref);
    if (expectedTree && tree !== expectedTree) {
      throw new UserError(`${ref} tree ${tree} does not match patches/series.json base.tree ${expectedTree}.`);
    }
    return { ref, commit: refCommit(ctx, ref), tree };
  }

  const archive = await downloadFirefoxArchive(ctx, version);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `bento-firefox-${version}-`));
  try {
    extractArchive(archive, tempRoot);
    const entries = (await fsp.readdir(tempRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
    if (entries.length !== 1) {
      throw new UserError(`expected one extracted Firefox source directory in ${tempRoot}, found ${entries.length}`);
    }
    const sourceDir = path.join(tempRoot, entries[0].name);
    git(['init'], { cwd: sourceDir });
    git(['config', 'user.name', 'Bento Patch Stack'], { cwd: sourceDir });
    git(['config', 'user.email', 'patch-stack@bentobrowser.invalid'], { cwd: sourceDir });
    git(['add', '-A'], { cwd: sourceDir });
    git(['commit', '-m', `Firefox ${version}`], { cwd: sourceDir, stdio: 'ignore' });
    git(['fetch', sourceDir, `HEAD:${ref}`], { cwd: ctx.engineDir });
    const tree = refTree(ctx, ref);
    if (expectedTree && tree !== expectedTree) {
      throw new UserError(`${ref} tree ${tree} does not match patches/series.json base.tree ${expectedTree}.`);
    }
    return { ref, commit: refCommit(ctx, ref), tree };
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

function removeWorktree(ctx, worktreeDir) {
  if (fs.existsSync(worktreeDir)) {
    gitMaybe(['worktree', 'remove', '--force', worktreeDir], ctx.engineDir);
    fs.rmSync(worktreeDir, { recursive: true, force: true });
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

function addDetachedWorktree(ctx, ref, prefix = 'bento-patch-replay-') {
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    git(['worktree', 'add', '--detach', worktreeDir, ref], { cwd: ctx.engineDir });
    return worktreeDir;
  } catch (error) {
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    throw error;
  }
}

function applyPatchToWorktree(ctx, worktreeDir, patchPath, { index = false } = {}) {
  const args = ['apply', ...SURFER_APPLY_ARGS];
  if (index) {
    args.push('--index');
  }
  args.push(path.join(ctx.repoRoot, patchPath));
  git(args, { cwd: worktreeDir });
}

export async function replaySeries(ctx, manifest, ref) {
  const worktreeDir = addDetachedWorktree(ctx, ref);
  try {
    for (const entry of manifest.series) {
      applyPatchToWorktree(ctx, worktreeDir, entry.path);
    }
  } finally {
    removeWorktree(ctx, worktreeDir);
  }
}

function patchIsMailStyle(ctx, patchPath) {
  return /^From [0-9a-f]{40} /m.test(fs.readFileSync(path.join(ctx.repoRoot, patchPath), 'utf8'));
}

function commitLegacyPatch(ctx, worktreeDir, entry) {
  applyPatchToWorktree(ctx, worktreeDir, entry.path, { index: true });
  git(['commit', '-m', entry.subject], { cwd: worktreeDir });
}

export async function materialize(ctx, manifest, options = {}) {
  const base = await ensureBaseRef(ctx, manifest.base.version, manifest.base.tree);
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
            ].filter(Boolean).join('\n'),
            result.status || 1,
          );
        }
      } else {
        commitLegacyPatch(ctx, worktreeDir, entry);
      }
    }
    return { worktreeDir, base };
  } catch (error) {
    throw error;
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
  const surfer = loadSurfer(ctx);
  const targetVersion = surfer.version?.version;
  const targetProduct = surfer.version?.product || manifest.base.product || 'firefox';
  const targetBase = await ensureBaseRef(ctx, targetVersion);
  if (!branchExists(ctx)) {
    throw new UserError(`missing ${STACK_BRANCH}; run pnpm run firefox:patches:materialize first.`);
  }

  const mergeBase = git(['merge-base', targetBase.ref, STACK_REF], { cwd: ctx.engineDir });
  const targetCommit = refCommit(ctx, targetBase.ref);
  if (mergeBase !== targetCommit) {
    throw new UserError(`${STACK_BRANCH} is not based on ${targetBase.ref}; run pnpm run firefox:patches:rebase.`);
  }

  const mergeCommits = git(['rev-list', '--merges', `${targetBase.ref}..${STACK_REF}`], { cwd: ctx.engineDir });
  if (mergeCommits.trim()) {
    throw new UserError(`${STACK_BRANCH} contains merge commits; keep the Firefox patch stack linear.`);
  }
  const commits = git(['rev-list', '--reverse', `${targetBase.ref}..${STACK_REF}`], { cwd: ctx.engineDir })
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
    },
  };
  jsonWrite(ctx.manifestPath, updated);
  await replaySeries(ctx, updated, targetBase.ref);
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
  const base = await ensureBaseRef(ctx, manifest.base.version, manifest.base.tree);
  await replaySeries(ctx, manifest, base.ref);
  process.stdout.write('firefox-patch-stack: check passed\n');
}

async function commandMaterialize(ctx) {
  const manifest = loadManifest(ctx);
  const errors = await validateManifest(ctx, manifest);
  if (errors.length) {
    throw new UserError(errors.join('\n'));
  }
  await materialize(ctx, manifest);
  process.stdout.write(`firefox-patch-stack: materialized ${manifest.series.length} commits on ${STACK_BRANCH}\n`);
}

async function commandRebase(ctx) {
  const manifest = loadManifest(ctx);
  const errors = await validateManifest(ctx, manifest);
  if (errors.length) {
    throw new UserError(errors.join('\n'));
  }
  const surfer = loadSurfer(ctx);
  const targetVersion = surfer.version?.version;
  const oldBase = await ensureBaseRef(ctx, manifest.base.version, manifest.base.tree);
  const targetBase = await ensureBaseRef(ctx, targetVersion);

  await materialize(ctx, manifest);
  assertNoActiveStackWorktree(ctx);
  await fsp.mkdir(path.dirname(ctx.stackWorktreeDir), { recursive: true });
  git(['worktree', 'add', ctx.stackWorktreeDir, STACK_BRANCH], { cwd: ctx.engineDir });
  const result = gitMaybe(['rebase', '--onto', targetBase.ref, oldBase.ref, STACK_BRANCH], ctx.stackWorktreeDir);
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
      ].filter((line) => line !== undefined).join('\n'),
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
    default:
      throw new UserError(`unknown command: ${command}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof UserError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(error.exitCode);
    }
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}
