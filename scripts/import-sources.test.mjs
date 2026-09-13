import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { acquireSourceArchive, adoptExistingSource, createContext, engineStatus, findDirectory, main, sourceArchivePath, tarArchivePaths, verifyManagedEngine, verifyRecordedEngineState } from './bento-build.mjs';
import { importSourceOverlays } from './import-sources.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-build-test-'));
  await fsp.mkdir(path.join(root, 'src', 'browser', 'base'), { recursive: true });
  await fsp.mkdir(path.join(root, 'engine', 'toolkit'), { recursive: true });
  await fsp.writeFile(path.join(root, 'engine', 'toolkit', 'moz.build'), '');
  await fsp.writeFile(path.join(root, 'src', 'browser', 'base', 'one.js'), 'one\n');
  await fsp.writeFile(
    path.join(root, 'bento.json'),
    JSON.stringify({
      schemaVersion: 1,
      brand: 'bento',
      build: { mode: 'dev', windowsUseSymbolicLinks: false },
      firefox: {
        product: 'firefox',
        version: '154.0',
        source: { archiveBaseUrl: 'https://archive.mozilla.org/pub/firefox/releases', sha256: '0'.repeat(64) },
      },
      brands: { bento: {} },
    }),
  );
  return root;
}

async function lifecycleFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-lifecycle-test-'));
  await fsp.writeFile(path.join(root, 'bento.json'), JSON.stringify({
    schemaVersion: 1,
    brand: 'bento',
    build: { mode: 'dev', windowsUseSymbolicLinks: false },
    firefox: {
      product: 'firefox',
      version: '154.0',
      candidate: '154.0',
      source: { archiveBaseUrl: 'https://archive.example.invalid/releases', sha256: crypto.createHash('sha256').update('good source').digest('hex') },
    },
    brands: { bento: { release: { displayVersion: '0.0.1' } } },
    updates: { hostname: 'updates.example.invalid', channel: 'bento' },
  }));
  await fsp.mkdir(path.join(root, 'engine', 'toolkit'), { recursive: true });
  await fsp.writeFile(path.join(root, 'engine', 'toolkit', 'moz.build'), '');
  return root;
}

test('source archive paths reject traversal and invalid Firefox versions', () => {
  assert.throws(() => sourceArchivePath('/tmp/bento', '../outside'), /unsupported Firefox version/);
  assert.throws(() => sourceArchivePath('/tmp/bento', '154'), /unsupported Firefox version/);
  for (const version of ['154.0b1', '154.0esr', '154.0-rc1', '154.0.1']) {
    assert.doesNotThrow(() => sourceArchivePath('/tmp/bento', version));
  }
  assert.throws(() => sourceArchivePath('/tmp/bento', `154.0${'a'.repeat(128)}`), /unsupported Firefox version/);
});

test('bad cached source is quarantined and a verified retry succeeds', async () => {
  const root = await lifecycleFixture();
  const previousFetch = globalThis.fetch;
  let requests = 0;
  try {
    globalThis.fetch = async () => new Response(requests++ === 0 ? 'bad source' : 'good source', { status: 200 });
    await assert.rejects(() => acquireSourceArchive(root), /digest mismatch/);
    const cache = path.dirname(sourceArchivePath(root, '154.0'));
    assert.equal(fs.readdirSync(cache).some((entry) => entry.includes('.bad-')), true);
    const result = await acquireSourceArchive(root);
    assert.equal(result.sha256, crypto.createHash('sha256').update('good source').digest('hex'));
    assert.equal(fs.existsSync(result.path), true);
  } finally {
    globalThis.fetch = previousFetch;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('source update advances config and source state with the verified archive digest', async () => {
  const root = await lifecycleFixture();
  const archiveRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-update-archive-'));
  const previousFetch = globalThis.fetch;
  const previousDigest = process.env.BENTO_SOURCE_SHA256;
  try {
    await fsp.mkdir(path.join(root, '.bento'), { recursive: true });
    const sourceRoot = path.join(archiveRoot, 'firefox-155.0', 'toolkit');
    await fsp.mkdir(sourceRoot, { recursive: true });
    await fsp.writeFile(path.join(sourceRoot, 'moz.build'), '# Firefox 155.0\n');
    const archive = path.join(archiveRoot, 'firefox-155.0.source.tar.xz');
    const packed = spawnSync('tar', ['-cJf', archive, '-C', archiveRoot, 'firefox-155.0']);
    assert.equal(packed.status, 0, packed.stderr?.toString());
    const bytes = await fsp.readFile(archive);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    process.env.BENTO_SOURCE_SHA256 = digest;

    const engine = path.join(root, 'engine');
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: engine, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['add', '-A']);
    git(['commit', '-m', 'Firefox 154.0']);
    git(['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);
    const oldBase = git(['rev-parse', 'refs/bento/firefox-base/154.0']);
    const baseBranch = git(['symbolic-ref', '--short', 'HEAD']);
    git(['switch', '-c', 'bento/patch-stack']);
    await fsp.writeFile(path.join(engine, 'toolkit', 'moz.build'), '# Firefox 154 patch\n');
    git(['add', 'toolkit/moz.build']);
    git(['commit', '-m', 'Bento patch']);
    git(['switch', baseBranch]);
    await fsp.writeFile(path.join(root, '.bento', 'engine-state.json'), '{"schemaVersion":1,"entries":[]}\n');
    await fsp.writeFile(path.join(root, '.bento', 'import-manifest.json'), '{"schemaVersion":1,"entries":[]}\n');

    globalThis.fetch = async (url) => {
      if (String(url).includes('firefox_versions.json')) {
        return new Response(JSON.stringify({ LATEST_FIREFOX_VERSION: '155.0' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(bytes, { status: 200 });
    };
    await main(['update'], root);
    const config = JSON.parse(await fsp.readFile(path.join(root, 'bento.json'), 'utf8'));
    const state = JSON.parse(await fsp.readFile(path.join(root, '.bento', 'source-state.json'), 'utf8'));
    assert.equal(config.firefox.version, '155.0');
    assert.equal(config.firefox.source.sha256, digest);
    assert.equal(state.version, '155.0');
    assert.equal(state.archiveSha256, digest);
    assert.equal(fs.existsSync(path.join(root, '.bento', 'backups')), true);
    assert.equal(git(['rev-parse', 'refs/bento/firefox-base/154.0']), oldBase);
    assert.notEqual(git(['rev-parse', 'bento/patch-stack']), '');
    assert.equal(fs.existsSync(path.join(root, '.bento', 'engine-state.json')), false);
    assert.equal(fs.existsSync(path.join(root, '.bento', 'import-manifest.json')), false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDigest === undefined) delete process.env.BENTO_SOURCE_SHA256;
    else process.env.BENTO_SOURCE_SHA256 = previousDigest;
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(archiveRoot, { recursive: true, force: true });
  }
});

test('source replacement refuses linked worktrees and preserves the engine', async () => {
  const root = await lifecycleFixture();
  const archiveRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-worktree-archive-'));
  const linked = path.join(root, 'linked-worktree');
  try {
    const sourceRoot = path.join(archiveRoot, 'firefox-154.0', 'toolkit');
    await fsp.mkdir(sourceRoot, { recursive: true });
    await fsp.writeFile(path.join(sourceRoot, 'moz.build'), '# Firefox 154.0\n');
    const archive = path.join(archiveRoot, 'firefox-154.0.source.tar.xz');
    const packed = spawnSync('tar', ['-cJf', archive, '-C', archiveRoot, 'firefox-154.0']);
    assert.equal(packed.status, 0, packed.stderr?.toString());
    const bytes = await fsp.readFile(archive);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const configPath = path.join(root, 'bento.json');
    const config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    config.firefox.source.sha256 = digest;
    await fsp.writeFile(configPath, JSON.stringify(config));
    const cachePath = sourceArchivePath(root, '154.0');
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, bytes);

    const engine = path.join(root, 'engine');
    const git = (args, cwd = engine) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['add', '-A']);
    git(['commit', '-m', 'Firefox 154.0']);
    git(['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);
    git(['worktree', 'add', '-b', 'linked-test', linked, 'HEAD']);
    await fsp.writeFile(path.join(linked, 'toolkit', 'moz.build'), 'linked user edit\n');
    await assert.rejects(() => main(['download', '--force'], root), /linked Git worktrees/);
    assert.equal(await fsp.readFile(path.join(engine, 'toolkit', 'moz.build'), 'utf8'), '');
    assert.equal(await fsp.readFile(path.join(linked, 'toolkit', 'moz.build'), 'utf8'), 'linked user edit\n');
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', linked], { cwd: path.join(root, 'engine'), stdio: 'ignore' });
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(archiveRoot, { recursive: true, force: true });
  }
});

test('source overlays use copies on Windows and preserve owned stale output semantics', async () => {
  const root = await fixture();
  try {
    const first = await importSourceOverlays({ repoRoot: root, platform: 'win32' });
    const target = path.join(root, 'engine', 'browser', 'base', 'one.js');
    assert.equal(first.entries[0].type, 'copy');
    assert.equal(fs.lstatSync(target).isSymbolicLink(), false);

    await fsp.rm(path.join(root, 'src', 'browser', 'base', 'one.js'));
    await fsp.writeFile(target, 'user change\n');
    await assert.rejects(
      () => importSourceOverlays({ repoRoot: root, platform: 'win32' }),
      /stale overlay .* user-owned/,
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'user change\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.bento', 'import-manifest.json'))).entries.length, 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('bundle lookup finds a packaged app directory', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-bundle-test-'));
  try {
    await fsp.mkdir(path.join(root, 'nested', 'Bento.app', 'Contents'), { recursive: true });
    assert.equal(findDirectory(root, (name) => name === 'Bento.app'), path.join(root, 'nested', 'Bento.app'));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('source tar paths stay local when the archive directory resembles a Windows drive', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-tar-paths-'));
  const archiveDir = path.join(root, 'C:', 'cache');
  const sourceRoot = path.join(archiveDir, 'firefox-154.0');
  const destination = path.join(archiveDir, 'staging');
  const archive = path.join(archiveDir, 'firefox-154.0.source.tar.xz');
  try {
    await fsp.mkdir(sourceRoot, { recursive: true });
    await fsp.writeFile(path.join(sourceRoot, 'toolkit.txt'), 'Firefox source\n');
    const packed = spawnSync('tar', ['-cJf', archive, '-C', archiveDir, 'firefox-154.0']);
    assert.equal(packed.status, 0, packed.stderr?.toString());

    const tarPaths = tarArchivePaths(archive, destination);
    assert.equal(tarPaths.cwd, archiveDir);
    assert.equal(tarPaths.archive, 'firefox-154.0.source.tar.xz');
    assert.equal(tarPaths.destination, 'staging');

    const listed = spawnSync('tar', ['-tf', tarPaths.archive], { cwd: tarPaths.cwd, encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    await fsp.mkdir(destination, { recursive: true });
    const extracted = spawnSync('tar', ['--strip-components=1', '-xf', tarPaths.archive, '-C', tarPaths.destination], {
      cwd: tarPaths.cwd,
      encoding: 'utf8',
    });
    assert.equal(extracted.status, 0, extracted.stderr);
    assert.equal(await fsp.readFile(path.join(destination, 'toolkit.txt'), 'utf8'), 'Firefox source\n');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('existing baseline refs can be adopted without reading generated version files', async () => {
  const root = await fixture();
  const ctx = createContext(root);
  try {
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: path.join(root, 'engine'), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['add', '-A']);
    git(['commit', '-m', 'Firefox 154.0']);
    git(['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);
    const config = JSON.parse(await fsp.readFile(ctx.configPath, 'utf8'));
    assert.equal(adoptExistingSource(ctx, config, '154.0'), true);
    const state = JSON.parse(await fsp.readFile(ctx.sourceStatePath, 'utf8'));
    assert.equal(state.version, '154.0');
    assert.equal(state.baselineCommit, git(['rev-parse', 'refs/bento/firefox-base/154.0']));
    assert.equal(state.adopted, true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('adoption rejects a clean checkout whose HEAD is newer than the pristine base', async () => {
  const root = await fixture();
  const ctx = createContext(root);
  try {
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: path.join(root, 'engine'), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['add', '-A']);
    git(['commit', '-m', 'Firefox 154.0']);
    const base = git(['rev-parse', 'HEAD']);
    git(['update-ref', 'refs/bento/firefox-base/154.0', base]);
    git(['commit', '--allow-empty', '-m', 'Unexpected clean checkout commit']);
    const config = JSON.parse(await fsp.readFile(ctx.configPath, 'utf8'));
    assert.throws(() => adoptExistingSource(ctx, config, '154.0'), /HEAD does not match pristine base/);
    assert.equal(fs.existsSync(ctx.sourceStatePath), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('download and verify reject committed drift after source adoption', async () => {
  const root = await fixture();
  try {
    const engine = path.join(root, 'engine');
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: engine, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['add', '-A']);
    git(['commit', '-m', 'Firefox 154.0']);
    git(['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);
    await main(['verify'], root);
    git(['commit', '--allow-empty', '-m', 'Unrecorded source commit']);
    await assert.rejects(() => main(['download'], root), /HEAD does not match pristine base/);
    await assert.rejects(() => main(['verify'], root), /HEAD does not match pristine base/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('verify adopts an existing engine before recording an import without source state', async () => {
  const root = await fixture();
  try {
    const engine = path.join(root, 'engine');
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: engine, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['add', '-A']);
    git(['commit', '-m', 'Firefox 154.0']);
    git(['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);
    await importSourceOverlays({ repoRoot: root, platform: 'win32' });
    await main(['verify'], root);
    assert.equal(JSON.parse(await fsp.readFile(path.join(root, '.bento', 'source-state.json'), 'utf8')).version, '154.0');
    assert.equal(fs.existsSync(path.join(root, '.bento', 'engine-state.json')), true);
    await fsp.writeFile(path.join(root, 'src', 'browser', 'base', 'one.js'), 'updated source input\n');
    await main(['verify'], root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('adoption accepts the legacy generated mozconfig and gitignore formatting', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('legacy fixture is copied from the macOS daily-driver generator');
    return;
  }
  const root = await lifecycleFixture();
  const ctx = createContext(root);
  try {
    await fsp.cp(path.join(repoRoot, 'configs'), path.join(root, 'configs'), { recursive: true });
    await fsp.mkdir(path.join(root, 'src', 'browser', 'base'), { recursive: true });
    await fsp.writeFile(path.join(root, 'src', 'browser', 'base', 'one.js'), 'one\n');
    await fsp.writeFile(path.join(root, 'engine', '.gitignore'), 'base-ignore\n');
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: path.join(root, 'engine'), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['add', '-A']);
    git(['commit', '-m', 'Firefox 154.0']);
    git(['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);
    await fsp.writeFile(path.join(root, 'engine', '.gitignore'), 'base-ignore\nbrowser/base/one.js');
    await fsp.copyFile(path.join('/Users/admin/Projects/bento-browser', 'engine', 'mozconfig'), path.join(root, 'engine', 'mozconfig'));
    const config = JSON.parse(await fsp.readFile(ctx.configPath, 'utf8'));
    config.updates.hostname = 'updates.bentobrowser.app';
    await fsp.writeFile(ctx.configPath, JSON.stringify(config));
    assert.equal(adoptExistingSource(ctx, config, '154.0'), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('adopts a legacy imported README and extension registry without accepting edits', async () => {
  const root = await fixture();
  const ctx = createContext(root);
  const engine = path.join(root, 'engine');
  try {
    await fsp.writeFile(path.join(root, 'src', 'README.md'), 'Bento source overlay\n');
    await fsp.writeFile(path.join(engine, 'README.md'), 'Firefox source\n');
    await fsp.writeFile(path.join(engine, '.gitignore'), 'base-ignore\n');
    await fsp.mkdir(path.join(engine, 'browser', 'extensions'), { recursive: true });
    await fsp.writeFile(path.join(engine, 'browser', 'extensions', 'moz.build'), 'DIRS = []\n');
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: engine, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['add', '-A']);
    git(['commit', '-m', 'Firefox 154.0']);
    git(['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);

    await fsp.rm(path.join(engine, 'README.md'));
    await fsp.symlink(path.join(root, 'src', 'README.md'), path.join(engine, 'README.md'));
    await fsp.writeFile(path.join(engine, '.gitignore'), 'base-ignore\n\nbrowser/base/one.js');
    await fsp.writeFile(
      path.join(engine, 'browser', 'extensions', 'moz.build'),
      'DIRS = []\n\nDIRS += []\n\n# BEGIN BENTO BUILTIN ADDONS\nDIRS += []\n# END BENTO BUILTIN ADDONS\n',
    );

    await fsp.rm(path.join(engine, 'README.md'));
    await fsp.writeFile(path.join(engine, 'README.md'), 'user README edit\n');
    assert.throws(
      () => adoptExistingSource(ctx, JSON.parse(fs.readFileSync(ctx.configPath, 'utf8')), '154.0'),
      /unverified changes/,
    );
    assert.equal(await fsp.readFile(path.join(engine, 'README.md'), 'utf8'), 'user README edit\n');
    assert.equal(fs.existsSync(ctx.sourceStatePath), false);
    assert.equal(fs.existsSync(path.join(ctx.stateDir, 'engine-state.json')), false);

    await fsp.rm(path.join(engine, 'README.md'));
    await fsp.symlink(path.join(root, 'src', 'README.md'), path.join(engine, 'README.md'));
    await fsp.appendFile(path.join(engine, '.gitignore'), '\nuser-ignore-pattern');
    assert.throws(
      () => adoptExistingSource(ctx, JSON.parse(fs.readFileSync(ctx.configPath, 'utf8')), '154.0'),
      /unverified changes/,
    );
    assert.equal(await fsp.readFile(path.join(engine, '.gitignore'), 'utf8'), 'base-ignore\n\nbrowser/base/one.js\nuser-ignore-pattern');
    assert.equal(fs.existsSync(ctx.sourceStatePath), false);
    assert.equal(fs.existsSync(path.join(ctx.stateDir, 'engine-state.json')), false);

    const unexpectedRegistry = 'DIRS = []\n\nDIRS += ["unexpected-addon"]\n\n# BEGIN BENTO BUILTIN ADDONS\nDIRS += []\n# END BENTO BUILTIN ADDONS\n';
    await fsp.writeFile(path.join(engine, 'browser', 'extensions', 'moz.build'), unexpectedRegistry);
    assert.throws(
      () => adoptExistingSource(ctx, JSON.parse(fs.readFileSync(ctx.configPath, 'utf8')), '154.0'),
      /unverified changes/,
    );
    assert.equal(await fsp.readFile(path.join(engine, 'browser', 'extensions', 'moz.build'), 'utf8'), unexpectedRegistry);
    assert.equal(fs.existsSync(ctx.sourceStatePath), false);
    assert.equal(fs.existsSync(path.join(ctx.stateDir, 'engine-state.json')), false);

    await fsp.writeFile(path.join(engine, '.gitignore'), 'base-ignore\n\nbrowser/base/one.js');
    await fsp.writeFile(
      path.join(engine, 'browser', 'extensions', 'moz.build'),
      'DIRS = []\n\nDIRS += []\n\n# BEGIN BENTO BUILTIN ADDONS\nDIRS += []\n# END BENTO BUILTIN ADDONS\n',
    );
    assert.deepEqual(engineStatus(root).unrecognizedFiles, []);
    assert.equal(adoptExistingSource(ctx, JSON.parse(await fsp.readFile(ctx.configPath, 'utf8')), '154.0'), true);
    assert.equal(verifyRecordedEngineState(root), true);
    assert.equal(fs.existsSync(path.join(root, '.bento', 'engine-state.json')), true);

    await fsp.rm(ctx.sourceStatePath);
    await fsp.rm(path.join(ctx.stateDir, 'engine-state.json'));
    await fsp.rm(path.join(engine, 'README.md'));
    await fsp.copyFile(path.join(root, 'src', 'README.md'), path.join(engine, 'README.md'));
    assert.deepEqual(engineStatus(root).unrecognizedFiles, []);
    assert.equal(adoptExistingSource(ctx, JSON.parse(await fsp.readFile(ctx.configPath, 'utf8')), '154.0'), true);
    assert.equal(verifyRecordedEngineState(root), true);

    await fsp.rm(path.join(engine, 'README.md'));
    await fsp.writeFile(path.join(engine, 'README.md'), 'user README edit\n');
    assert.throws(
      () => adoptExistingSource(ctx, JSON.parse(fs.readFileSync(ctx.configPath, 'utf8')), '154.0'),
      /unverified changes/,
    );
    assert.equal(await fsp.readFile(path.join(engine, 'README.md'), 'utf8'), 'user README edit\n');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('accepts installer lexical ordering for add-on jar manifests', async () => {
  const root = await fixture();
  const extensionRoot = path.join(root, 'extensions', 'mixed');
  const engineExtensionRoot = path.join(root, 'engine', 'browser', 'extensions', 'mixed');
  try {
    await fsp.mkdir(path.join(extensionRoot, 'dist'), { recursive: true });
    await fsp.writeFile(
      path.join(extensionRoot, 'manifest.json'),
      JSON.stringify({ applications: { gecko: { id: 'mixed@example.invalid' } } }),
    );
    for (const name of ['1number.js', 'B.js', '_underscore.js', 'a.js']) {
      await fsp.writeFile(path.join(extensionRoot, 'dist', name), `${name}\n`);
    }
    const runtimeFiles = ['dist/1number.js', 'dist/B.js', 'dist/_underscore.js', 'dist/a.js', 'manifest.json'];
    const jar = [
      'browser.jar:',
      ...runtimeFiles.map((file) => `    builtin-addons/mixed/${file} (${file})`),
      '',
    ].join('\n');
    await fsp.mkdir(engineExtensionRoot, { recursive: true });
    await fsp.writeFile(path.join(engineExtensionRoot, 'jar.mn'), jar);
    assert.equal(verifyManagedEngine(createContext(root), ['browser/extensions/mixed/jar.mn']), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recorded generated output remains valid after a source edit but rejects direct engine edits', async () => {
  const root = await fixture();
  try {
    const engine = path.join(root, 'engine');
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: engine, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['add', '-A']);
    git(['commit', '-m', 'Firefox 154.0']);
    await importSourceOverlays({ repoRoot: root, platform: 'win32' });
    await main(['record'], root);
    const target = path.join(root, 'engine', 'browser', 'base', 'one.js');
    await fsp.writeFile(path.join(root, 'src', 'browser', 'base', 'one.js'), 'new source input\n');
    assert.equal(verifyRecordedEngineState(root), true);
    await fsp.writeFile(target, 'direct engine edit\n');
    assert.equal(verifyRecordedEngineState(root), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('source-only edits pass the recorded-state gate used by updates', async () => {
  const root = await lifecycleFixture();
  const archiveRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-recorded-update-'));
  const previousFetch = globalThis.fetch;
  const previousDigest = process.env.BENTO_SOURCE_SHA256;
  try {
    await fsp.mkdir(path.join(root, 'src', 'browser', 'base'), { recursive: true });
    await fsp.writeFile(path.join(root, 'src', 'browser', 'base', 'one.js'), 'old source\n');
    const engine = path.join(root, 'engine');
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: engine, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['add', '-A']);
    git(['commit', '-m', 'Firefox 154.0']);
    git(['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);
    await importSourceOverlays({ repoRoot: root, platform: 'win32' });
    await main(['record'], root);
    await fsp.writeFile(path.join(root, 'src', 'browser', 'base', 'one.js'), 'new source input\n');

    const sourceRoot = path.join(archiveRoot, 'firefox-155.0', 'toolkit');
    await fsp.mkdir(sourceRoot, { recursive: true });
    await fsp.writeFile(path.join(sourceRoot, 'moz.build'), '# Firefox 155.0\n');
    const archive = path.join(archiveRoot, 'firefox-155.0.source.tar.xz');
    assert.equal(spawnSync('tar', ['-cJf', archive, '-C', archiveRoot, 'firefox-155.0']).status, 0);
    const bytes = await fsp.readFile(archive);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    process.env.BENTO_SOURCE_SHA256 = digest;
    globalThis.fetch = async (url) => String(url).includes('firefox_versions.json')
      ? new Response(JSON.stringify({ LATEST_FIREFOX_VERSION: '155.0' }), { status: 200 })
      : new Response(bytes, { status: 200 });
    await main(['update'], root);
    assert.equal(JSON.parse(await fsp.readFile(path.join(root, 'bento.json'), 'utf8')).firefox.version, '155.0');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDigest === undefined) delete process.env.BENTO_SOURCE_SHA256;
    else process.env.BENTO_SOURCE_SHA256 = previousDigest;
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rm(archiveRoot, { recursive: true, force: true });
  }
});

test('adoption accepts exact generated prefs but preserves arbitrary edits', async () => {
  const root = await lifecycleFixture();
  const ctx = createContext(root);
  try {
    await fsp.mkdir(path.join(root, 'engine', 'browser', 'app', 'profile'), { recursive: true });
    await fsp.writeFile(path.join(root, 'engine', 'browser', 'app', 'profile', 'firefox.js'), 'baseline\n');
    await fsp.mkdir(path.join(root, 'prefs'), { recursive: true });
    await fsp.writeFile(path.join(root, 'prefs', 'bento.js'), 'pref("browser.migrate.zen.enabled", true);\n');
    const git = (args) => {
      const result = spawnSync('git', args, { cwd: path.join(root, 'engine'), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.invalid']);
    git(['add', '-A']);
    git(['commit', '-m', 'Firefox 154.0']);
    git(['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);
    await fsp.writeFile(path.join(root, 'engine', 'browser', 'app', 'profile', 'firefox.js'), 'baseline\n\n// === Bento defaults (appended from prefs/bento.js) ===\npref("browser.migrate.zen.enabled", true);\n');
    const config = JSON.parse(await fsp.readFile(ctx.configPath, 'utf8'));
    assert.equal(adoptExistingSource(ctx, config, '154.0'), true);
    assert.equal(verifyRecordedEngineState(root), true);
    await fsp.writeFile(path.join(root, 'engine', 'browser', 'app', 'profile', 'firefox.js'), 'user edit\n\n// === Bento defaults (appended from prefs/bento.js) ===\npref("browser.migrate.zen.enabled", true);\n');
    assert.throws(() => adoptExistingSource(ctx, config, '154.0'), /unverified changes/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
