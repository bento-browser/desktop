import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createContext,
  canonicalPath,
  refContentTree,
  stageFirefoxSourceBase,
} from './firefox-patch-stack.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(repoRoot, 'scripts', 'firefox-patch-stack.mjs');

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout.trimEnd();
}

function gitRaw(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function runFixture(root, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    env: {
      ...process.env,
      BENTO_PATCH_STACK_REPO_ROOT: root,
    },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

const tempRoots = [];
after(async () => {
  for (const root of tempRoots) await fsp.rm(root, { recursive: true, force: true });
});

/** A temp directory that is removed after the last test, also when an assertion fails. */
async function tempRoot(prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function fixture(version = '1.0') {
  const root = await tempRoot('bento-patch-stack-test-');
  await fsp.mkdir(path.join(root, 'patches', 'area'), { recursive: true });
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });
  await fsp.mkdir(path.join(root, '.bento'), { recursive: true });
  await fsp.mkdir(path.join(root, 'engine'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'bento.json'),
    `${JSON.stringify({ schemaVersion: 1, firefox: { product: 'firefox', version }, build: { mode: 'dev' }, brand: 'bento', brands: { bento: {} } }, null, 2)}\n`,
  );

  const engine = path.join(root, 'engine');
  git(engine, ['init']);
  git(engine, ['config', 'user.name', 'Test']);
  git(engine, ['config', 'user.email', 'test@example.invalid']);
  fs.writeFileSync(path.join(engine, 'file.txt'), 'alpha\n');
  git(engine, ['add', 'file.txt']);
  git(engine, ['commit', '-m', `Firefox ${version}`]);
  git(engine, ['update-ref', `refs/bento/firefox-base/${version}`, 'HEAD']);
  const tree = git(engine, ['rev-parse', 'HEAD^{tree}']);
  const contentTree = refContentTree(createContext(root), `refs/bento/firefox-base/${version}`);
  return { root, engine, tree, contentTree };
}

function writeManifest(root, { version = '1.0', tree, contentTree, entries, format } = {}) {
  const manifest = {
    schemaVersion: 1,
    ...(format ? { format } : {}),
    base: {
      product: 'firefox',
      version,
      ...(tree ? { tree } : {}),
      ...(contentTree ? { contentTree } : {}),
    },
    series: entries,
  };
  fs.writeFileSync(
    path.join(root, 'patches', 'series.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

test('patch checks reject borrowed engine or state before changing refs or cache files', async () => {
  for (const name of ['engine', '.bento']) {
    const { root, engine, tree } = await fixture();
    writeManifest(root, { tree, entries: [] });
    const foreign = await tempRoot('bento-foreign-patch-output-');
    const borrowed = path.join(root, name);
    const target = path.join(foreign, name);
    fs.renameSync(borrowed, target);
    fs.symlinkSync(target, borrowed, 'dir');
    const refs = git(engine, ['show-ref']);
    const result = runFixture(root, ['check']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /build outputs must stay inside checkout/);
    assert.equal(git(engine, ['show-ref']), refs);
    assert.equal(fs.existsSync(path.join(root, '.bento', 'patch-check.json')), false);
    assert.equal(fs.readlinkSync(borrowed), target);
  }
});

test('canonical content validation accepts platform-specific executable modes', async () => {
  const { root, engine, tree, contentTree } = await fixture();
  git(engine, ['update-index', '--chmod=+x', 'file.txt']);
  git(engine, ['commit', '-m', 'Platform-specific executable mode']);
  git(engine, ['update-ref', 'refs/bento/firefox-base/1.0', 'HEAD']);
  assert.notEqual(git(engine, ['rev-parse', 'HEAD^{tree}']), tree);
  assert.equal(refContentTree(createContext(root), 'refs/bento/firefox-base/1.0'), contentTree);
  writeManifest(root, { tree, contentTree, entries: [] });

  const result = runFixture(root, ['check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /accepted platform-specific tree/);
});

test('source base staging includes files ignored by upstream Firefox', async () => {
  const root = await tempRoot('bento-firefox-source-base-test-');
  git(root, ['init']);
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'tracked by the source baseline\n');

  stageFirefoxSourceBase(root);

  assert.deepEqual(git(root, ['ls-files']).split('\n'), ['.gitignore', 'ignored.txt']);
});

test('canonical worktree paths resolve filesystem aliases', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-canonical-path-test-'));
  const alias = `${root}-alias`;
  try {
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(canonicalPath(root), canonicalPath(alias));
    if (process.platform === 'win32') {
      assert.equal(canonicalPath(root.toUpperCase()), canonicalPath(root.toLowerCase()));
    }
  } finally {
    fs.unlinkSync(alias);
    await fsp.rm(root, { recursive: true, force: true });
  }
});

function writeLegacyPatch(root, engine, patchPath, nextContent) {
  fs.writeFileSync(path.join(engine, 'file.txt'), nextContent);
  const patch = gitRaw(engine, ['diff', '--full-index', '--', 'file.txt']);
  fs.writeFileSync(path.join(root, patchPath), patch);
  git(engine, ['checkout', '--', 'file.txt']);
  return patch;
}

test('manifest rejects missing patch files', async () => {
  const { root, tree } = await fixture();
  writeManifest(root, {
    tree,
    entries: [{ path: 'patches/area/missing.patch', id: 'missing', subject: 'Missing' }],
  });
  const result = runFixture(root, ['check']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /manifest patch is missing/);
});

test('manifest rejects extra unlisted patch files', async () => {
  const { root, engine, tree } = await fixture();
  writeLegacyPatch(root, engine, 'patches/area/listed.patch', 'beta\n');
  writeLegacyPatch(root, engine, 'patches/area/extra.patch', 'gamma\n');
  writeManifest(root, {
    tree,
    entries: [{ path: 'patches/area/listed.patch', id: 'listed', subject: 'Listed' }],
  });
  const result = runFixture(root, ['check']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /extra repo patch is not listed/);
});

test('manifest rejects unmanaged src patch files', async () => {
  const { root, engine, tree } = await fixture();
  writeLegacyPatch(root, engine, 'patches/area/listed.patch', 'beta\n');
  fs.writeFileSync(path.join(root, 'src', 'copy.patch'), 'diff --git a/x b/x\n');
  writeManifest(root, {
    tree,
    entries: [{ path: 'patches/area/listed.patch', id: 'listed', subject: 'Listed' }],
  });
  const result = runFixture(root, ['check']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /src\/copy\.patch is unmanaged/);
});

test('manifest order is authoritative even when filenames sort differently', async () => {
  const { root, engine, tree } = await fixture();
  writeLegacyPatch(root, engine, 'patches/area/02.patch', 'beta\n');
  spawnSync('git', ['apply', path.join(root, 'patches/area/02.patch')], { cwd: engine });
  git(engine, ['commit', '-am', 'First by manifest']);
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'gamma\n');
  git(engine, ['reset', '--hard', 'refs/bento/firefox-base/1.0']);
  writeManifest(root, {
    tree,
    entries: [
      { path: 'patches/area/02.patch', id: 'two', subject: 'Two' },
      { path: 'patches/area/01.patch', id: 'one', subject: 'One' },
    ],
  });
  const result = runFixture(root, ['check']);
  assert.equal(result.status, 0, result.stderr);
});

test('legacy plain diff patch materializes into one commit', async () => {
  const { root, engine, tree } = await fixture();
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'beta\n');
  writeManifest(root, {
    tree,
    entries: [{ path: 'patches/area/01.patch', id: 'one', subject: 'One' }],
  });
  const result = runFixture(root, ['materialize']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    git(engine, ['rev-list', '--count', 'refs/bento/firefox-base/1.0..bento/patch-stack']),
    '1',
  );
});

test('mail-style format-patch file materializes correctly', async () => {
  const { root, engine, tree } = await fixture();
  const originalBranch = git(engine, ['branch', '--show-current']);
  git(engine, ['switch', '-c', 'mail']);
  fs.writeFileSync(path.join(engine, 'file.txt'), 'mail\n');
  git(engine, ['commit', '-am', 'Mail patch']);
  const patch = gitRaw(engine, [
    'format-patch',
    '-1',
    '--stdout',
    '--full-index',
    '--binary',
    'HEAD',
  ]);
  fs.writeFileSync(path.join(root, 'patches/area/01.patch'), patch);
  git(engine, ['switch', originalBranch]);
  writeManifest(root, {
    tree,
    entries: [{ path: 'patches/area/01.patch', id: 'mail', subject: 'Mail patch' }],
  });
  const result = runFixture(root, ['materialize']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    git(engine, ['rev-list', '--count', 'refs/bento/firefox-base/1.0..bento/patch-stack']),
    '1',
  );
});

test('ordered replay allows patch 2 to depend on patch 1', async () => {
  const { root, engine, tree } = await fixture();
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'beta\n');
  spawnSync('git', ['apply', path.join(root, 'patches/area/01.patch')], { cwd: engine });
  git(engine, ['commit', '-am', 'Patch one']);
  writeLegacyPatch(root, engine, 'patches/area/02.patch', 'gamma\n');
  git(engine, ['reset', '--hard', 'refs/bento/firefox-base/1.0']);
  writeManifest(root, {
    tree,
    entries: [
      { path: 'patches/area/01.patch', id: 'one', subject: 'One' },
      { path: 'patches/area/02.patch', id: 'two', subject: 'Two' },
    ],
  });
  const result = runFixture(root, ['check']);
  assert.equal(result.status, 0, result.stderr);
});

test('successful rebase exports patches to the same manifest paths', async () => {
  const { root, engine, tree } = await fixture('1.0');
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'beta\n');
  writeManifest(root, {
    version: '1.0',
    tree,
    entries: [{ path: 'patches/area/01.patch', id: 'one', subject: 'One' }],
  });
  fs.writeFileSync(
    path.join(root, 'bento.json'),
    `${JSON.stringify({ schemaVersion: 1, firefox: { product: 'firefox', version: '2.0' }, build: { mode: 'dev' }, brand: 'bento', brands: { bento: {} } })}\n`,
  );
  git(engine, ['commit', '--allow-empty', '-m', 'Firefox 2.0']);
  git(engine, ['update-ref', 'refs/bento/firefox-base/2.0', 'HEAD']);
  const result = runFixture(root, ['rebase']);
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'patches/series.json'), 'utf8'));
  assert.equal(manifest.base.version, '2.0');
  assert.match(
    fs.readFileSync(path.join(root, 'patches/area/01.patch'), 'utf8'),
    /^From [0-9a-f]{40} /m,
  );
});

test('rebase conflict exits non-zero and preserves rebase worktree', async () => {
  const { root, engine, tree } = await fixture('1.0');
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'beta\n');
  writeManifest(root, {
    version: '1.0',
    tree,
    entries: [{ path: 'patches/area/01.patch', id: 'one', subject: 'One' }],
  });
  fs.writeFileSync(
    path.join(root, 'bento.json'),
    `${JSON.stringify({ schemaVersion: 1, firefox: { product: 'firefox', version: '2.0' }, build: { mode: 'dev' }, brand: 'bento', brands: { bento: {} } })}\n`,
  );
  fs.writeFileSync(path.join(engine, 'file.txt'), 'upstream\n');
  git(engine, ['commit', '-am', 'Firefox 2.0']);
  git(engine, ['update-ref', 'refs/bento/firefox-base/2.0', 'HEAD']);
  const result = runFixture(root, ['rebase']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rebase stopped/);
  assert.equal(fs.existsSync(path.join(root, '.bento', 'patch-stack-worktree')), true);
});

test('materialize avoids dirty live engine state', async () => {
  const { root, engine, tree } = await fixture();
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'beta\n');
  fs.writeFileSync(path.join(engine, 'untracked.txt'), 'do not touch\n');
  writeManifest(root, {
    tree,
    entries: [{ path: 'patches/area/01.patch', id: 'one', subject: 'One' }],
  });
  const result = runFixture(root, ['materialize']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(engine, 'untracked.txt'), 'utf8'), 'do not touch\n');
});

test('export refuses when commit count differs from manifest length', async () => {
  const { root, engine, tree } = await fixture('1.0');
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'beta\n');
  writeManifest(root, {
    version: '1.0',
    tree,
    entries: [
      { path: 'patches/area/01.patch', id: 'one', subject: 'One' },
      { path: 'patches/area/02.patch', id: 'two', subject: 'Two' },
    ],
  });
  fs.writeFileSync(
    path.join(root, 'patches/area/02.patch'),
    fs.readFileSync(path.join(root, 'patches/area/01.patch')),
  );
  git(engine, ['switch', '-c', 'bento/patch-stack']);
  fs.writeFileSync(path.join(engine, 'file.txt'), 'beta\n');
  git(engine, ['commit', '-am', 'One']);
  const result = runFixture(root, ['export']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /has 1 commits but patches\/series\.json lists 2 patches/);
});

test('export refuses merge commits in the patch stack', async () => {
  const { root, engine, tree } = await fixture('1.0');
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'beta\n');
  writeManifest(root, {
    version: '1.0',
    tree,
    entries: [{ path: 'patches/area/01.patch', id: 'one', subject: 'One' }],
  });
  git(engine, ['switch', '-c', 'bento/patch-stack']);
  fs.writeFileSync(path.join(engine, 'file.txt'), 'beta\n');
  git(engine, ['commit', '-am', 'One']);
  git(engine, ['switch', '-c', 'side', 'refs/bento/firefox-base/1.0']);
  fs.writeFileSync(path.join(engine, 'side.txt'), 'side\n');
  git(engine, ['add', 'side.txt']);
  git(engine, ['commit', '-m', 'Side']);
  git(engine, ['switch', 'bento/patch-stack']);
  git(engine, ['merge', '--no-ff', 'side', '-m', 'Merge side']);
  const result = runFixture(root, ['export']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /contains merge commits/);
});

test('check --for-import fails when manifest base differs from bento.json', async () => {
  const { root, engine, tree } = await fixture('1.0');
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'beta\n');
  fs.writeFileSync(
    path.join(root, 'bento.json'),
    `${JSON.stringify({ schemaVersion: 1, firefox: { product: 'firefox', version: '2.0' }, build: { mode: 'dev' }, brand: 'bento', brands: { bento: {} } })}\n`,
  );
  writeManifest(root, {
    version: '1.0',
    tree,
    entries: [{ path: 'patches/area/01.patch', id: 'one', subject: 'One' }],
  });
  const result = runFixture(root, ['check', '--for-import']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /patch stack base 1\.0 does not match configured Firefox 2\.0/);
});

test('apply updates the live engine in manifest order without committing', async () => {
  const { root, engine, tree } = await fixture();
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'beta\n');
  spawnSync('git', ['apply', path.join(root, 'patches/area/01.patch')], { cwd: engine });
  git(engine, ['commit', '-am', 'Patch one source']);
  writeLegacyPatch(root, engine, 'patches/area/02.patch', 'gamma\n');
  git(engine, ['reset', '--hard', 'refs/bento/firefox-base/1.0']);
  writeManifest(root, {
    tree,
    entries: [
      { path: 'patches/area/01.patch', id: 'one', subject: 'One' },
      { path: 'patches/area/02.patch', id: 'two', subject: 'Two' },
    ],
  });
  const before = git(engine, ['rev-parse', 'HEAD']);
  const result = runFixture(root, ['apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(engine, 'file.txt'), 'utf8'), 'gamma\n');
  assert.equal(git(engine, ['rev-parse', 'HEAD']), before);
  assert.match(result.stdout, /applied 2 patches/);
});

test('apply reports the manifest entry that failed after a partial application', async () => {
  const { root, engine, tree } = await fixture();
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'beta\n');
  fs.writeFileSync(
    path.join(root, 'patches/area/02.patch'),
    'diff --git a/missing.txt b/missing.txt\n--- a/missing.txt\n+++ b/missing.txt\n@@ -1 +1 @@\n-old\n+new\n',
  );
  writeManifest(root, {
    tree,
    entries: [
      { path: 'patches/area/01.patch', id: 'one', subject: 'One' },
      { path: 'patches/area/02.patch', id: 'broken', subject: 'Broken' },
    ],
  });
  const result = runFixture(root, ['apply']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /patches\/area\/02\.patch \(broken\)/);
  assert.equal(fs.readFileSync(path.join(engine, 'file.txt'), 'utf8'), 'beta\n');
});

test('apply succeeds again after the live engine is reset', async () => {
  const { root, engine, tree } = await fixture();
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'beta\n');
  writeManifest(root, {
    tree,
    entries: [{ path: 'patches/area/01.patch', id: 'one', subject: 'One' }],
  });
  assert.equal(runFixture(root, ['apply']).status, 0);
  git(engine, ['checkout', '--', 'file.txt']);
  const second = runFixture(root, ['apply']);
  assert.equal(second.status, 0, second.stderr);
});

test('apply supports new text files and binary patches', async () => {
  const { root, engine, tree } = await fixture();
  const binary = Buffer.from([0, 255, 1, 254, 2, 253, 3, 252]);
  fs.writeFileSync(path.join(engine, 'added.txt'), 'new file\n');
  fs.writeFileSync(path.join(engine, 'added.bin'), binary);
  git(engine, ['add', 'added.txt', 'added.bin']);
  const patch = gitRaw(engine, ['diff', '--cached', '--full-index', '--binary']);
  fs.writeFileSync(path.join(root, 'patches/area/01.patch'), patch);
  git(engine, ['reset', '--hard', 'refs/bento/firefox-base/1.0']);
  writeManifest(root, {
    tree,
    entries: [{ path: 'patches/area/01.patch', id: 'new-binary', subject: 'New and binary' }],
  });

  const result = runFixture(root, ['apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(engine, 'added.txt'), 'utf8'), 'new file\n');
  assert.deepEqual(fs.readFileSync(path.join(engine, 'added.bin')), binary);
});

async function twoDependentPatches() {
  const setup = await fixture();
  writeLegacyPatch(setup.root, setup.engine, 'patches/area/01.patch', 'beta\n');
  spawnSync('git', ['apply', path.join(setup.root, 'patches/area/01.patch')], { cwd: setup.engine });
  git(setup.engine, ['commit', '-am', 'Patch one']);
  writeLegacyPatch(setup.root, setup.engine, 'patches/area/02.patch', 'gamma\n');
  git(setup.engine, ['reset', '--hard', 'refs/bento/firefox-base/1.0']);
  writeManifest(setup.root, {
    tree: setup.tree,
    entries: [
      { path: 'patches/area/01.patch', id: 'one', subject: 'One' },
      { path: 'patches/area/02.patch', id: 'two', subject: 'Two' },
    ],
  });
  return setup;
}

test('check --for-import validates in a scratch index and leaves the engine untouched', async () => {
  const { root, engine } = await twoDependentPatches();
  const snapshot = () => ({
    // Status first: it may refresh the index, which is then read in its final form.
    status: git(engine, ['status', '--porcelain', '--untracked-files=all']),
    index: fs.readFileSync(path.join(engine, '.git', 'index')).toString('base64'),
    objects: git(engine, ['count-objects', '-v']),
    worktrees: git(engine, ['worktree', 'list', '--porcelain']),
  });
  const before = snapshot();

  const result = runFixture(root, ['check', '--for-import']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /check passed$/m);
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.readFileSync(path.join(engine, 'file.txt'), 'utf8'), 'alpha\n');
});

test('check fails with the manifest entry of a patch that conflicts with an earlier one', async () => {
  const { root, engine, tree } = await fixture();
  // Both patches rewrite the same base line, so the second cannot apply after the first.
  writeLegacyPatch(root, engine, 'patches/area/01.patch', 'beta\n');
  writeLegacyPatch(root, engine, 'patches/area/02.patch', 'gamma\n');
  writeManifest(root, {
    tree,
    entries: [
      { path: 'patches/area/01.patch', id: 'one', subject: 'One' },
      { path: 'patches/area/02.patch', id: 'two', subject: 'Two' },
    ],
  });

  const result = runFixture(root, ['check', '--for-import']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed to apply patches\/area\/02\.patch \(two\)/);
  assert.match(result.stderr, /patch does not apply/);
  assert.equal(fs.existsSync(path.join(root, '.bento', 'patch-check.json')), false);
});

test('check skips the replay while patches and base are unchanged', async () => {
  const { root, engine } = await twoDependentPatches();
  const first = runFixture(root, ['check', '--for-import']);
  assert.equal(first.status, 0, first.stderr);
  assert.doesNotMatch(first.stdout, /unchanged/);

  const second = runFixture(root, ['check', '--for-import']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /unchanged since the last successful check/);

  const forced = runFixture(root, ['check', '--for-import', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.doesNotMatch(forced.stdout, /unchanged/);

  // A new base commit with the same tree changes the resolved base, so it replays.
  git(engine, ['commit', '--allow-empty', '-m', 'Rebuilt base']);
  git(engine, ['update-ref', 'refs/bento/firefox-base/1.0', 'HEAD']);
  const rebased = runFixture(root, ['check', '--for-import']);
  assert.equal(rebased.status, 0, rebased.stderr);
  assert.doesNotMatch(rebased.stdout, /unchanged/);
});

test('check replays and fails after a patch changes following a recorded pass', async () => {
  const { root, engine } = await twoDependentPatches();
  assert.equal(runFixture(root, ['check', '--for-import']).status, 0);

  writeLegacyPatch(root, engine, 'patches/area/02.patch', 'delta\n');
  const result = runFixture(root, ['check', '--for-import']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /failed to apply patches\/area\/02\.patch \(two\)/);
});

test('check handles added, binary and deleted files in the scratch index', async () => {
  const { root, engine, tree } = await fixture();
  fs.writeFileSync(path.join(engine, 'added.txt'), 'new file\n');
  fs.writeFileSync(path.join(engine, 'added.bin'), Buffer.from([0, 255, 1, 254, 2, 253]));
  git(engine, ['add', 'added.txt', 'added.bin']);
  git(engine, ['rm', '-q', 'file.txt']);
  fs.writeFileSync(
    path.join(root, 'patches/area/01.patch'),
    gitRaw(engine, ['diff', '--cached', '--full-index', '--binary']),
  );
  git(engine, ['reset', '--hard', 'refs/bento/firefox-base/1.0']);
  writeManifest(root, {
    tree,
    entries: [{ path: 'patches/area/01.patch', id: 'mixed', subject: 'Mixed' }],
  });

  const result = runFixture(root, ['check', '--for-import']);

  assert.equal(result.status, 0, result.stderr);
});

/** Recursive listing of everything inside a directory, for "gains no files" assertions. */
function listFiles(root, current = root) {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(current, entry.name);
    return entry.isDirectory() ? listFiles(root, absolute) : [path.relative(root, absolute)];
  });
}

test('git configuration cannot change the outcome of check or apply', async () => {
  const { root, engine, tree } = await fixture();
  // A patch that adds a line with trailing whitespace.
  fs.writeFileSync(path.join(engine, 'file.txt'), 'alpha\nbeta   \n');
  fs.writeFileSync(path.join(root, 'patches/area/01.patch'), gitRaw(engine, ['diff', '--full-index']));
  git(engine, ['checkout', '--', 'file.txt']);
  writeManifest(root, {
    tree,
    entries: [{ path: 'patches/area/01.patch', id: 'whitespace', subject: 'Whitespace' }],
  });
  assert.equal(runFixture(root, ['check', '--for-import']).status, 0);

  git(engine, ['config', 'apply.whitespace', 'error']);

  // The recorded pass must not hide a different outcome, and neither path may differ.
  const skipped = runFixture(root, ['check', '--for-import']);
  assert.equal(skipped.status, 0, skipped.stderr);
  const forced = runFixture(root, ['check', '--for-import', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  const applied = runFixture(root, ['apply']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(fs.readFileSync(path.join(engine, 'file.txt'), 'utf8'), 'alpha\nbeta   \n');
});

test('the scratch replay writes nothing into the engine git directory', async () => {
  const { root, engine } = await twoDependentPatches();
  // A split index writes sharedindex.* files into the git directory.
  git(engine, ['config', 'core.splitIndex', 'true']);
  const gitDir = path.join(engine, '.git');
  const before = listFiles(gitDir).sort();

  const result = runFixture(root, ['check', '--for-import', '--force']);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(listFiles(gitDir).sort(), before);
});

test('check refuses patches that touch symlinks when the engine cannot check them out', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation requires elevated Windows privileges');
    return;
  }
  const { root, engine } = await fixture();
  fs.symlinkSync('file.txt', path.join(engine, 'link'));
  git(engine, ['add', 'link']);
  git(engine, ['commit', '-m', 'Add a tracked symlink']);
  git(engine, ['update-ref', 'refs/bento/firefox-base/1.0', 'HEAD']);
  const tree = git(engine, ['rev-parse', 'HEAD^{tree}']);
  fs.rmSync(path.join(engine, 'link'));
  fs.symlinkSync('elsewhere', path.join(engine, 'link'));
  fs.writeFileSync(path.join(root, 'patches/area/01.patch'), gitRaw(engine, ['diff', '--full-index', '--', 'link']));
  git(engine, ['checkout', '--', 'link']);
  writeManifest(root, {
    tree,
    entries: [{ path: 'patches/area/01.patch', id: 'retarget', subject: 'Retarget the link' }],
  });
  assert.equal(runFixture(root, ['check', '--for-import']).status, 0);

  // The live apply would fail with "wrong type" on a checkout without symlinks, so
  // preflight must fail too, including when the recorded pass would skip the replay.
  git(engine, ['config', 'core.symlinks', 'false']);
  for (const args of [['check', '--for-import'], ['check', '--for-import', '--force'], ['apply']]) {
    const result = runFixture(root, args);
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, /core\.symlinks=false.*patches\/area\/01\.patch|patches\/area\/01\.patch.*core\.symlinks=false/s, args.join(' '));
  }

  // A series that never touches a symlink is unaffected.
  fs.rmSync(path.join(root, 'patches/area/01.patch'));
  writeLegacyPatch(root, engine, 'patches/area/02.patch', 'beta\n');
  writeManifest(root, {
    tree,
    entries: [{ path: 'patches/area/02.patch', id: 'plain', subject: 'Plain file' }],
  });
  assert.equal(runFixture(root, ['check', '--for-import']).status, 0);
});
