import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { acquireSourceArchive, adoptExistingSource, createContext, engineStatus, findDirectory, legacyMozconfigText, loadConfig, main, sourceArchivePath, tarArchivePaths, verifyManagedEngine, verifyRecordedEngineState } from './bento-build.mjs';
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

test('adoption accepts the legacy generated mozconfig and gitignore formatting', async () => {
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
    // The previous generator named its tool in the header and ended the file with two spaces.
    const config = loadConfig(root);
    const legacyMozconfig = legacyMozconfigText(ctx, config)
      .replace('# Internal build config', '# Internal surfer config')
      .concat('  ');
    await fsp.writeFile(path.join(root, 'engine', 'mozconfig'), legacyMozconfig);
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

/** A one-file Firefox source archive for `version`: its bytes and SHA-256. */
async function packSourceArchive(version) {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-source-archive-'));
  try {
    await fsp.mkdir(path.join(work, `firefox-${version}`, 'toolkit'), { recursive: true });
    await fsp.writeFile(path.join(work, `firefox-${version}`, 'toolkit', 'moz.build'), `# Firefox ${version}\n`);
    const archive = path.join(work, `firefox-${version}.source.tar.xz`);
    const packed = spawnSync('tar', ['-cJf', archive, '-C', work, `firefox-${version}`]);
    assert.equal(packed.status, 0, packed.stderr?.toString());
    const bytes = await fsp.readFile(archive);
    return { bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/** Runs `fn` with fetch failing, so a test that must stay offline cannot download. */
async function withoutNetwork(fn) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`unexpected network access: ${url}`);
  };
  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

/**
 * A checkout that predates a version bump. bento.json configures 157.0.1 and its
 * verified archive is cached, but the engine is a 154.0 import recorded in .bento.
 * That import patched old.js and deleted gone.js; the current patch series only
 * touches new.js.
 */
async function staleEngineFixture() {
  const root = await lifecycleFixture();
  const ctx = createContext(root);
  const engine = path.join(root, 'engine');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: engine, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  await fsp.writeFile(path.join(engine, 'old.js'), 'original\n');
  await fsp.writeFile(path.join(engine, 'gone.js'), 'original\n');
  git(['init']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['add', '-A']);
  git(['commit', '-m', 'Firefox 154.0']);
  git(['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);
  git(['branch', 'bento/patch-stack']);

  // The 154.0 import: a patch series applied to the engine, then recorded.
  await fsp.writeFile(path.join(engine, 'old.js'), 'patched by the 154.0 series\n');
  await fsp.rm(path.join(engine, 'gone.js'));
  await fsp.mkdir(path.join(root, 'patches'), { recursive: true });
  await fsp.writeFile(path.join(root, 'patches', 'old.patch'), git(['diff']) + '\n');
  await fsp.writeFile(path.join(root, 'patches', 'series.json'), JSON.stringify({ series: [{ path: 'patches/old.patch' }] }));
  await fsp.mkdir(path.join(root, '.bento'), { recursive: true });
  await fsp.writeFile(ctx.sourceStatePath, JSON.stringify({
    schemaVersion: 1,
    product: 'firefox',
    version: '154.0',
    baselineCommit: git(['rev-parse', 'HEAD']),
    archiveSha256: loadConfig(root).firefox.source.sha256,
    adopted: true,
  }));
  await main(['record'], root);
  const recorded = JSON.parse(await fsp.readFile(path.join(root, '.bento', 'engine-state.json'), 'utf8'));
  assert.deepEqual(
    recorded.entries.map(({ path: entry, kind, missing }) => [entry, kind, missing]),
    [['gone.js', 'patch', true], ['old.js', 'patch', undefined]],
  );

  // The version bump: a new archive and a series that no longer names old.js.
  const archive = await packSourceArchive('157.0.1');
  const config = JSON.parse(await fsp.readFile(ctx.configPath, 'utf8'));
  config.firefox.version = '157.0.1';
  config.firefox.candidate = '157.0.1';
  config.firefox.source.sha256 = archive.sha256;
  await fsp.writeFile(ctx.configPath, JSON.stringify(config));
  await fsp.rm(path.join(root, 'patches', 'old.patch'));
  await fsp.writeFile(path.join(root, 'patches', 'new.patch'), 'diff --git a/new.js b/new.js\n--- a/new.js\n+++ b/new.js\n');
  await fsp.writeFile(path.join(root, 'patches', 'series.json'), JSON.stringify({ series: [{ path: 'patches/new.patch' }] }));
  const cached = sourceArchivePath(root, '157.0.1');
  await fsp.mkdir(path.dirname(cached), { recursive: true });
  await fsp.writeFile(cached, archive.bytes);
  return { root, ctx, engine, git, archive };
}

const backupsOf = (root) => {
  const dir = path.join(root, '.bento', 'backups');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

test('recorded state accepts a recorded file the current patch series no longer touches, and rejects any change to it', async () => {
  const { root, engine } = await staleEngineFixture();
  try {
    const old = path.join(engine, 'old.js');
    // engineStatus owns files by the current series, so it cannot place old.js.
    assert.deepEqual(engineStatus(root).unrecognizedFiles, ['gone.js', 'old.js']);
    assert.equal(verifyRecordedEngineState(root), true);

    await fsp.appendFile(old, 'x');
    assert.equal(verifyRecordedEngineState(root), false);
    await fsp.writeFile(old, 'patched by the 154.0 series\n');
    assert.equal(verifyRecordedEngineState(root), true);

    await fsp.writeFile(path.join(engine, 'stray.js'), 'not recorded\n');
    assert.equal(verifyRecordedEngineState(root), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recorded state refuses a retired patch target that was deleted by hand', async () => {
  const { root, engine } = await staleEngineFixture();
  try {
    // gone.js was deleted by the recorded import itself, so its absence is recorded.
    assert.equal(fs.existsSync(path.join(engine, 'gone.js')), false);
    assert.equal(verifyRecordedEngineState(root), true);

    // old.js was recorded as present, so a deletion of it is an unrecorded change.
    await fsp.rm(path.join(engine, 'old.js'));
    assert.equal(verifyRecordedEngineState(root), false);
    await withoutNetwork(async () => {
      await assert.rejects(() => main(['download', '--replace-stale'], root), /unrecognized user changes \(old\.js\)/);
    });
    assert.deepEqual(backupsOf(root), []);

    // Restoring a path whose deletion was recorded is a change too.
    await fsp.writeFile(path.join(engine, 'old.js'), 'patched by the 154.0 series\n');
    await fsp.writeFile(path.join(engine, 'gone.js'), 'original\n');
    assert.equal(verifyRecordedEngineState(root), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('the replace refusal names the unrecognized files, not every dirty one', async () => {
  const { root, engine } = await staleEngineFixture();
  try {
    await fsp.writeFile(path.join(engine, 'stray.js'), 'not recorded\n');
    await withoutNetwork(async () => {
      await assert.rejects(
        () => main(['download', '--force'], root),
        (error) => /unrecognized user changes \(stray\.js\)/.test(error.message) && !error.message.includes('old.js'),
      );
    });
    assert.deepEqual(backupsOf(root), []);

    await fsp.rm(path.join(engine, 'stray.js'));
    await fsp.appendFile(path.join(engine, 'old.js'), 'x');
    await withoutNetwork(async () => {
      await assert.rejects(() => main(['download', '--force'], root), /unrecognized user changes \(old\.js\)/);
    });
    assert.deepEqual(backupsOf(root), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('download --replace-stale replaces an engine older than bento.json through the protected path', async () => {
  const { root, engine, git, archive } = await staleEngineFixture();
  try {
    const oldBase = git(['rev-parse', 'refs/bento/firefox-base/154.0']);
    const configBefore = await fsp.readFile(path.join(root, 'bento.json'), 'utf8');

    // Without the flag nothing changes, so `pnpm run build` never replaces the engine.
    await withoutNetwork(async () => {
      await assert.rejects(() => main(['download'], root), /engine already exists/);
      await assert.rejects(() => main(['verify'], root), /Firefox 154\.0 but bento\.json configures 157\.0\.1.*firefox:sync/);
    });
    assert.deepEqual(backupsOf(root), []);
    assert.equal(await fsp.readFile(path.join(engine, 'old.js'), 'utf8'), 'patched by the 154.0 series\n');

    await withoutNetwork(() => main(['download', '--replace-stale'], root));

    const state = JSON.parse(await fsp.readFile(path.join(root, '.bento', 'source-state.json'), 'utf8'));
    assert.equal(state.version, '157.0.1');
    assert.equal(state.archiveSha256, archive.sha256);
    assert.equal(await fsp.readFile(path.join(engine, 'toolkit', 'moz.build'), 'utf8'), '# Firefox 157.0.1\n');
    assert.equal(fs.existsSync(path.join(engine, 'old.js')), false);
    assert.equal(fs.existsSync(path.join(root, '.bento', 'engine-state.json')), false);
    assert.equal(await fsp.readFile(path.join(root, 'bento.json'), 'utf8'), configBefore);

    // The previous engine, including its edit, is recoverable from the backup.
    const [backup] = backupsOf(root);
    assert.match(backup, /^firefox-154\.0-\d+$/);
    assert.equal(await fsp.readFile(path.join(root, '.bento', 'backups', backup, 'old.js'), 'utf8'), 'patched by the 154.0 series\n');

    // Bento refs of the old engine survive, next to the new base.
    assert.equal(git(['rev-parse', 'refs/bento/firefox-base/154.0']), oldBase);
    assert.equal(git(['rev-parse', 'refs/heads/bento/patch-stack']), oldBase);
    assert.equal(git(['rev-parse', 'refs/bento/firefox-base/157.0.1']), state.baselineCommit);

    // A second run finds the engine current and replaces nothing.
    await withoutNetwork(() => main(['download', '--replace-stale'], root));
    assert.equal(backupsOf(root).length, 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('download --replace-stale refuses a stale engine with unrecorded changes and keeps it', async () => {
  const { root, engine } = await staleEngineFixture();
  try {
    await fsp.appendFile(path.join(engine, 'old.js'), 'user edit\n');
    await withoutNetwork(async () => {
      await assert.rejects(() => main(['download', '--replace-stale'], root), /unrecognized user changes \(old\.js\)/);
    });
    assert.deepEqual(backupsOf(root), []);
    assert.equal(JSON.parse(await fsp.readFile(path.join(root, '.bento', 'source-state.json'), 'utf8')).version, '154.0');
    assert.match(await fsp.readFile(path.join(engine, 'old.js'), 'utf8'), /user edit/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('download --replace-stale reuses an engine that is already at the configured version', async () => {
  const { root, engine, git, archive } = await staleEngineFixture();
  try {
    const statePath = path.join(root, '.bento', 'source-state.json');
    const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    await fsp.writeFile(path.join(engine, 'marker'), 'kept\n');
    git(['update-ref', 'refs/bento/firefox-base/157.0.1', 'HEAD']);
    await fsp.writeFile(statePath, JSON.stringify({ ...state, version: '157.0.1', archiveSha256: archive.sha256 }));
    await withoutNetwork(() => main(['download', '--replace-stale'], root));
    assert.deepEqual(backupsOf(root), []);
    assert.equal(await fsp.readFile(path.join(engine, 'marker'), 'utf8'), 'kept\n');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('download --replace-stale replaces only a strictly older engine of the same product and channel', async () => {
  const { root, engine } = await staleEngineFixture();
  try {
    const statePath = path.join(root, '.bento', 'source-state.json');
    const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
    const configPath = path.join(root, 'bento.json');
    const config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
    const refuses = async (recorded, configured, message, product = 'firefox') => {
      await fsp.writeFile(statePath, JSON.stringify({ ...state, version: recorded, product }));
      await fsp.writeFile(configPath, JSON.stringify({ ...config, firefox: { ...config.firefox, version: configured } }));
      await withoutNetwork(async () => {
        await assert.rejects(() => main(['download', '--replace-stale'], root), message, `${recorded} against ${configured}`);
      });
    };
    const newer = /newer than the .* bento\.json configures/;
    const unordered = /cannot be ordered/;

    await refuses('158.0b6', '158.0b5', newer);
    await refuses('158.0', '158.0b5', newer);
    await refuses('157.0.1', '157.0', newer);
    await refuses('1000.0', '157.0.1', newer);
    await refuses('140.2.0esr', '157.0.1', unordered);
    await refuses('157.0.1', '140.2.0esr', unordered);
    await refuses('154.0', '157.0.1', unordered, 'firefox-esr');
    // Numerically equal spellings are the same release, not a stale one.
    await refuses('157.0', '157.0.0', /engine already exists/);

    assert.deepEqual(backupsOf(root), []);
    assert.equal(await fsp.readFile(path.join(engine, 'old.js'), 'utf8'), 'patched by the 154.0 series\n');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

const next158 = await packSourceArchive('158.0');

/** Runs `update` with Mozilla reporting `latest`, whose archive is `archive`. */
async function updateTo(root, latest, archive) {
  const previousDigest = process.env.BENTO_SOURCE_SHA256;
  const previousFetch = globalThis.fetch;
  try {
    process.env.BENTO_SOURCE_SHA256 = archive.sha256;
    globalThis.fetch = async (url) => String(url).includes('firefox_versions.json')
      ? new Response(JSON.stringify({ LATEST_FIREFOX_VERSION: latest }), { status: 200 })
      : new Response(archive.bytes, { status: 200 });
    return await main(['update'], root);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDigest === undefined) delete process.env.BENTO_SOURCE_SHA256;
    else process.env.BENTO_SOURCE_SHA256 = previousDigest;
  }
}

/** Records the stale fixture's engine as Firefox `version` of `product`. */
async function recordEngineAs(fixtureState, version, extra = {}) {
  const { root, git } = fixtureState;
  git(['update-ref', `refs/bento/firefox-base/${version}`, 'HEAD']);
  const statePath = path.join(root, '.bento', 'source-state.json');
  const state = JSON.parse(await fsp.readFile(statePath, 'utf8'));
  await fsp.writeFile(statePath, JSON.stringify({ ...state, version, ...extra }));
}

test('update from a stale engine checks the engine against its own recorded version', async () => {
  const { root, engine, git } = await staleEngineFixture();
  try {
    const oldBase = git(['rev-parse', 'refs/bento/firefox-base/154.0']);
    await updateTo(root, '158.0', next158);
    assert.equal(JSON.parse(await fsp.readFile(path.join(root, 'bento.json'), 'utf8')).firefox.version, '158.0');
    assert.equal(JSON.parse(await fsp.readFile(path.join(root, '.bento', 'source-state.json'), 'utf8')).version, '158.0');
    assert.equal(git(['rev-parse', 'refs/bento/firefox-base/154.0']), oldBase);
    assert.equal(backupsOf(root).length, 1);
    assert.equal(fs.existsSync(path.join(engine, 'old.js')), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('update refuses to replace a newer engine with an older target', async () => {
  const stale = await staleEngineFixture();
  const { root, engine } = stale;
  try {
    // Configured 157.0.1, engine 159.0, Mozilla's latest 158.0.
    await recordEngineAs(stale, '159.0');
    const configBefore = await fsp.readFile(path.join(root, 'bento.json'), 'utf8');
    await assert.rejects(() => updateTo(root, '158.0', next158), /refusing to downgrade/);
    assert.deepEqual(backupsOf(root), []);
    assert.equal(await fsp.readFile(path.join(root, 'bento.json'), 'utf8'), configBefore);
    assert.equal(await fsp.readFile(path.join(engine, 'old.js'), 'utf8'), 'patched by the 154.0 series\n');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('update keeps an engine that already has the target and only advances bento.json', async () => {
  const stale = await staleEngineFixture();
  const { root, engine } = stale;
  try {
    await recordEngineAs(stale, '158.0', { archiveSha256: next158.sha256 });
    await updateTo(root, '158.0', next158);
    const config = JSON.parse(await fsp.readFile(path.join(root, 'bento.json'), 'utf8'));
    assert.equal(config.firefox.version, '158.0');
    assert.equal(config.firefox.source.sha256, next158.sha256);
    assert.deepEqual(backupsOf(root), []);
    assert.equal(await fsp.readFile(path.join(engine, 'old.js'), 'utf8'), 'patched by the 154.0 series\n');
    assert.equal(JSON.parse(await fsp.readFile(path.join(root, '.bento', 'source-state.json'), 'utf8')).version, '158.0');
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('update refuses to keep an engine whose recorded digest differs from the verified archive', async () => {
  const stale = await staleEngineFixture();
  const { root } = stale;
  try {
    await recordEngineAs(stale, '158.0', { archiveSha256: 'f'.repeat(64) });
    const configBefore = await fsp.readFile(path.join(root, 'bento.json'), 'utf8');
    await assert.rejects(() => updateTo(root, '158.0', next158), /different archive digest/);
    assert.equal(await fsp.readFile(path.join(root, 'bento.json'), 'utf8'), configBefore);
    assert.deepEqual(backupsOf(root), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('update does not order an engine of another channel against the target', async () => {
  const stale = await staleEngineFixture();
  const { root } = stale;
  try {
    await recordEngineAs(stale, '140.2.0esr');
    await assert.rejects(() => updateTo(root, '158.0', next158), /cannot be ordered/);
    assert.deepEqual(backupsOf(root), []);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
