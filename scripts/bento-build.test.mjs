import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createContext,
  loadConfig,
  main,
  resolveObjDir,
  verifyRecordedEngineState,
  verifySourceArchive,
  writeBrowserUpdateFiles,
  writeMozconfig,
} from './bento-build.mjs';
import { importSourceOverlays } from './import-sources.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MODES = ['dev', 'debug', 'release'];

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A repo root with a committed pristine engine, as a fresh download leaves it. */
async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-build-fixture-'));
  await fsp.cp(path.join(repoRoot, 'configs'), path.join(root, 'configs'), { recursive: true });
  await fsp.mkdir(path.join(root, 'src', 'browser', 'base'), { recursive: true });
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
        source: { archiveBaseUrl: 'https://archive.example.invalid/releases', sha256: '0'.repeat(64) },
      },
      brands: { bento: { release: { displayVersion: '0.0.7' } } },
      updates: { hostname: 'updates.example.invalid', channel: 'bento' },
    }),
  );
  const engine = path.join(root, 'engine');
  await fsp.mkdir(path.join(engine, 'toolkit'), { recursive: true });
  await fsp.mkdir(path.join(engine, 'browser', 'config'), { recursive: true });
  await fsp.writeFile(path.join(engine, 'toolkit', 'moz.build'), '');
  // Firefox ignores mozconfig; the version files are tracked.
  await fsp.writeFile(path.join(engine, '.gitignore'), '/mozconfig*\n');
  await fsp.writeFile(path.join(engine, 'browser', 'config', 'version.txt'), '154.0\n');
  await fsp.writeFile(path.join(engine, 'browser', 'config', 'version_display.txt'), '154.0\n');
  git(engine, ['init']);
  git(engine, ['config', 'user.name', 'Test']);
  git(engine, ['config', 'user.email', 'test@example.invalid']);
  git(engine, ['add', '-A']);
  git(engine, ['commit', '-m', 'Firefox 154.0']);
  git(engine, ['update-ref', 'refs/bento/firefox-base/154.0', 'HEAD']);
  return root;
}

const engineFile = (root, ...segments) => path.join(root, 'engine', ...segments);

test('every build mode builds into the fixed object directory', async () => {
  const root = await fixture();
  try {
    for (const mode of MODES) {
      const { destination } = writeMozconfig(root, mode);
      assert.match(
        fs.readFileSync(destination, 'utf8'),
        /^mk_add_options MOZ_OBJDIR=@TOPSRCDIR@\/obj-bento$/m,
      );
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('writeMozconfig leaves unchanged files alone and rewrites changed ones', async () => {
  const root = await fixture();
  try {
    const files = [
      engineFile(root, 'mozconfig'),
      engineFile(root, 'browser', 'config', 'version.txt'),
      engineFile(root, 'browser', 'config', 'version_display.txt'),
    ];
    writeMozconfig(root, 'dev');
    const past = new Date('2020-01-01T00:00:00Z');
    for (const file of files) fs.utimesSync(file, past, past);
    const mtimes = () => files.map((file) => fs.statSync(file).mtimeMs);

    writeMozconfig(root, 'dev');
    assert.deepEqual(mtimes(), [past.getTime(), past.getTime(), past.getTime()]);

    writeMozconfig(root, 'release');
    const [mozconfig, version, display] = mtimes();
    assert.notEqual(mozconfig, past.getTime());
    assert.equal(version, past.getTime());
    assert.equal(display, past.getTime());
    assert.match(fs.readFileSync(files[0], 'utf8'), /--enable-rust-simd/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recorded state accepts regenerated files after a mode switch', async () => {
  const root = await fixture();
  try {
    writeMozconfig(root, 'dev');
    await main(['verify'], root);
    for (const mode of ['release', 'debug', 'dev']) {
      writeMozconfig(root, mode);
      assert.equal(verifyRecordedEngineState(root), true, `mode ${mode}`);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recorded state accepts the first build after an import that preceded any build', async () => {
  const root = await fixture();
  try {
    await main(['verify'], root);
    writeMozconfig(root, 'dev');
    assert.equal(
      fs.readFileSync(engineFile(root, 'browser', 'config', 'version.txt'), 'utf8'),
      '0.0.7',
    );
    assert.equal(verifyRecordedEngineState(root), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recorded state accepts a mozconfig written before the fixed object directory', async () => {
  const root = await fixture();
  try {
    const mozconfig = engineFile(root, 'mozconfig');
    writeMozconfig(root, 'dev');
    const withObjdir = fs.readFileSync(mozconfig, 'utf8');
    const previousGeneration = withObjdir.replace(/\nmk_add_options MOZ_OBJDIR=.*\n/, '');
    assert.notEqual(previousGeneration, withObjdir);
    fs.writeFileSync(mozconfig, previousGeneration);
    await main(['verify'], root);
    const recorded = JSON.parse(fs.readFileSync(path.join(root, '.bento', 'engine-state.json'), 'utf8'));
    assert.ok(recorded.entries.some((entry) => entry.path === 'mozconfig'));

    writeMozconfig(root, 'dev');
    assert.equal(verifyRecordedEngineState(root), true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('recorded state still rejects hand edits of regenerable and other recorded files', async () => {
  const root = await fixture();
  try {
    writeMozconfig(root, 'dev');
    await importSourceOverlays({ repoRoot: root, platform: 'win32' });
    await main(['verify'], root);
    assert.equal(verifyRecordedEngineState(root), true);

    const mozconfig = engineFile(root, 'mozconfig');
    const generated = fs.readFileSync(mozconfig, 'utf8');
    fs.appendFileSync(mozconfig, 'ac_add_options --enable-something-else\n');
    assert.equal(verifyRecordedEngineState(root), false);
    fs.writeFileSync(mozconfig, generated);
    assert.equal(verifyRecordedEngineState(root), true);

    const version = engineFile(root, 'browser', 'config', 'version.txt');
    fs.writeFileSync(version, 'hand edited');
    assert.equal(verifyRecordedEngineState(root), false);
    writeMozconfig(root, 'dev');
    assert.equal(verifyRecordedEngineState(root), true);

    fs.writeFileSync(engineFile(root, 'browser', 'base', 'one.js'), 'direct engine edit\n');
    assert.equal(verifyRecordedEngineState(root), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** Runs fn with BENTO_OBJDIR cleared (or set) and restores it afterwards. */
async function withObjdirEnv(value, fn) {
  const previous = process.env.BENTO_OBJDIR;
  if (value === undefined) delete process.env.BENTO_OBJDIR;
  else process.env.BENTO_OBJDIR = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.BENTO_OBJDIR;
    else process.env.BENTO_OBJDIR = previous;
  }
}

test('the object directory resolver picks obj-bento, then one legacy directory, else fails clearly', async () => {
  const root = await fixture();
  try {
    await withObjdirEnv(undefined, () => {
      const ctx = createContext(root);
      const engine = (name) => path.join(root, 'engine', name);
      assert.equal(resolveObjDir(ctx), undefined);

      // One legacy directory (an older checkout) is used as is.
      fs.mkdirSync(engine('obj-aarch64-apple-darwin25.5.0'));
      assert.equal(resolveObjDir(ctx), engine('obj-aarch64-apple-darwin25.5.0'));

      // Several legacy directories: refuse to guess.
      fs.mkdirSync(engine('obj-aarch64-apple-darwin27.0.0'));
      assert.throws(
        () => resolveObjDir(ctx),
        /engine\/obj-bento does not exist and several legacy Firefox object directories.*darwin25\.5\.0, obj-aarch64-apple-darwin27\.0\.0/,
      );

      // obj-bento wins over every legacy directory.
      fs.mkdirSync(engine('obj-bento'));
      assert.equal(resolveObjDir(ctx), engine('obj-bento'));
    });
    await withObjdirEnv('obj-aarch64-apple-darwin25.5.0', () => {
      assert.equal(
        resolveObjDir(createContext(root)),
        path.join(root, 'engine', 'obj-aarch64-apple-darwin25.5.0'),
      );
    });
    await withObjdirEnv('obj-missing', () => {
      assert.throws(
        () => resolveObjDir(createContext(root)),
        /BENTO_OBJDIR=obj-missing is not a Firefox object directory/,
      );
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** Runs `bento-build objdir` and returns what it wrote to stdout. */
async function objdirCommand(root, ...args) {
  const write = process.stdout.write;
  let output = '';
  process.stdout.write = (chunk) => {
    output += chunk;
    return true;
  };
  try {
    await main(['objdir', ...args], root);
  } finally {
    process.stdout.write = write;
  }
  return output;
}

test('the objdir command prints the resolved directory and honors --allow-missing', async () => {
  const root = await fixture();
  try {
    await withObjdirEnv(undefined, async () => {
      await assert.rejects(() => objdirCommand(root), /no Firefox object directory found under engine\//);
      assert.equal(await objdirCommand(root, '--allow-missing'), '');

      fs.mkdirSync(engineFile(root, 'obj-old'));
      fs.mkdirSync(engineFile(root, 'obj-bento'));
      assert.equal(await objdirCommand(root), `${engineFile(root, 'obj-bento')}\n`);

      fs.rmSync(engineFile(root, 'obj-bento'), { recursive: true });
      fs.mkdirSync(engineFile(root, 'obj-other'));
      await assert.rejects(() => objdirCommand(root, '--allow-missing'), /several legacy Firefox object directories/);
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** A repo copy with the scripts under test, so their node call resolves this fixture. */
async function scriptFixture() {
  const root = await fixture();
  await fsp.cp(path.join(repoRoot, 'scripts'), path.join(root, 'scripts'), { recursive: true });
  await fsp.mkdir(path.join(root, 'extensions', 'bento-shell'), { recursive: true });
  await fsp.copyFile(
    path.join(repoRoot, 'extensions', 'bento-shell', 'muxui-local.mjs'),
    path.join(root, 'extensions', 'bento-shell', 'muxui-local.mjs'),
  );
  return root;
}

const runScript = (root, script) => spawnSync('bash', [path.join(root, 'scripts', script)], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, BENTO_OBJDIR: '' },
});

test('shell scripts act on the one selected object directory, never on every obj-*', async () => {
  const root = await scriptFixture();
  try {
    const shellDest = (name) => engineFile(root, name, 'dist', 'Bento.app', 'Contents', 'Resources', 'browser', 'chrome', 'browser', 'builtin-addons', 'bento-shell', 'dist');
    const actors = (name) => engineFile(root, name, 'dist', 'bin', 'browser', 'actors');
    fs.mkdirSync(path.join(root, 'extensions', 'bento-shell', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extensions', 'bento-shell', 'dist', 'app.js'), 'built');
    fs.mkdirSync(path.join(root, 'src', 'browser', 'actors'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'browser', 'actors', 'BentoKeyChild.sys.mjs'), 'actor');
    for (const name of ['obj-bento', 'obj-legacy']) {
      fs.mkdirSync(shellDest(name), { recursive: true });
      fs.mkdirSync(actors(name), { recursive: true });
    }

    const shell = runScript(root, 'sync-shell.sh');
    assert.equal(shell.status, 0, shell.stderr);
    assert.equal(fs.existsSync(path.join(shellDest('obj-bento'), 'app.js')), true);
    assert.equal(fs.existsSync(path.join(shellDest('obj-legacy'), 'app.js')), false);

    const symlinks = runScript(root, 'sync-builtin-addon-symlinks.sh');
    assert.equal(symlinks.status, 0, symlinks.stderr);
    assert.equal(fs.existsSync(path.join(actors('obj-bento'), 'BentoKeyChild.sys.mjs')), true);
    assert.equal(fs.existsSync(path.join(actors('obj-legacy'), 'BentoKeyChild.sys.mjs')), false);

    // Without obj-bento, two legacy directories are an error rather than a pick.
    fs.rmSync(engineFile(root, 'obj-bento'), { recursive: true });
    fs.mkdirSync(engineFile(root, 'obj-legacy-two'));
    for (const script of ['sync-shell.sh', 'sync-builtin-addon-symlinks.sh']) {
      const result = runScript(root, script);
      assert.notEqual(result.status, 0, script);
      assert.match(result.stderr, /several legacy Firefox object directories/, script);
    }

    // With no object directory, the import-time sync is a no-op while sync-shell fails.
    fs.rmSync(engineFile(root, 'obj-legacy'), { recursive: true });
    fs.rmSync(engineFile(root, 'obj-legacy-two'), { recursive: true });
    const noop = runScript(root, 'sync-builtin-addon-symlinks.sh');
    assert.equal(noop.status, 0, noop.stderr);
    assert.match(noop.stdout, /nothing to do/);
    assert.notEqual(runScript(root, 'sync-shell.sh').status, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('update metadata reads the target architecture from the object directory', async () => {
  const root = await fixture();
  try {
    const ctx = createContext(root);
    const config = loadConfig(root);
    const mar = path.join(root, 'output.mar');
    fs.writeFileSync(mar, 'mar');
    const platform = { darwin: 'macos', win32: 'windows' }[process.platform] || 'linux';
    const names = {};
    for (const processor of ['aarch64', 'x86_64']) {
      const objDist = path.join(root, 'engine', `obj-bento-${processor}`, 'dist');
      fs.mkdirSync(objDist, { recursive: true });
      fs.writeFileSync(path.join(objDist, '..', 'mozinfo.json'), JSON.stringify({ processor }));
      names[processor] = (await writeBrowserUpdateFiles(ctx, config, mar, '20260101000000', objDist)).marName;
    }
    assert.equal(names.aarch64, platform === 'macos' ? 'Bento-0.0.7-macos.mar' : `Bento-0.0.7-${platform}-arm64.mar`);
    assert.equal(names.x86_64, `Bento-0.0.7-${platform}-x64.mar`);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('source archives are hashed in-process without a SHA-256 utility', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-hash-test-'));
  const previousPath = process.env.PATH;
  try {
    // Larger than the read chunk, so the digest spans several reads.
    const file = path.join(dir, 'archive.bin');
    const data = crypto.randomBytes(700 * 1024);
    fs.writeFileSync(file, data);
    const digest = crypto.createHash('sha256').update(data).digest('hex');

    process.env.PATH = path.join(dir, 'no-tools');
    assert.equal(verifySourceArchive(file, digest), digest);
    assert.throws(() => verifySourceArchive(file, '1'.repeat(64)), /digest mismatch/);
  } finally {
    process.env.PATH = previousPath;
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
