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
const platformName = { darwin: 'macos', win32: 'windows' }[process.platform] || 'linux';

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

test('the resolver returns the directory mach builds into and uses a legacy build only when allowed', async () => {
  const root = await fixture();
  try {
    await withObjdirEnv(undefined, () => {
      const ctx = createContext(root);
      const engine = (name) => path.join(root, 'engine', name);
      const legacyOk = { allowLegacy: true };

      // Nothing built yet.
      assert.deepEqual(resolveObjDir(ctx), { dir: undefined, configured: engine('obj-bento'), note: undefined });
      assert.equal(resolveObjDir(ctx, legacyOk).dir, undefined);

      // One legacy directory (an older checkout): launch and sync may use it, and say so.
      // Packaging must not, since mach does not build into it.
      fs.mkdirSync(engine('obj-aarch64-apple-darwin25.5.0'));
      assert.equal(resolveObjDir(ctx).dir, undefined);
      const legacy = resolveObjDir(ctx, legacyOk);
      assert.equal(legacy.dir, engine('obj-aarch64-apple-darwin25.5.0'));
      assert.match(legacy.note, /engine\/obj-bento does not exist; using the legacy object directory engine\/obj-aarch64-apple-darwin25\.5\.0/);

      // Several legacy directories: refuse to guess.
      fs.mkdirSync(engine('obj-aarch64-apple-darwin27.0.0'));
      assert.throws(
        () => resolveObjDir(ctx, legacyOk),
        /engine\/obj-bento does not exist and several legacy Firefox object directories.*darwin25\.5\.0, obj-aarch64-apple-darwin27\.0\.0/,
      );
      assert.equal(resolveObjDir(ctx).dir, undefined);

      // obj-bento wins over every legacy directory, in both modes.
      fs.mkdirSync(engine('obj-bento'));
      for (const options of [undefined, legacyOk]) {
        assert.deepEqual(resolveObjDir(ctx, options), { dir: engine('obj-bento'), configured: engine('obj-bento'), note: undefined });
      }
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('BENTO_OBJDIR reaches the generated mozconfig, so mach and the resolver agree', async () => {
  const root = await fixture();
  try {
    const ctx = createContext(root);
    const mozconfig = engineFile(root, 'mozconfig');

    // A mozconfig generated without BENTO_OBJDIR sends mach to obj-bento. Naming an
    // existing legacy directory later must not redirect packaging to it.
    await withObjdirEnv(undefined, () => writeMozconfig(root, 'dev'));
    fs.mkdirSync(engineFile(root, 'obj-legacy'));
    await withObjdirEnv('obj-legacy', () => {
      assert.throws(() => resolveObjDir(ctx), /BENTO_OBJDIR=obj-legacy differs from engine\/obj-bento, the directory engine\/mozconfig builds into/);
      const launch = resolveObjDir(ctx, { allowLegacy: true });
      assert.equal(launch.dir, engineFile(root, 'obj-legacy'));
      assert.match(launch.note, /using engine\/obj-legacy as BENTO_OBJDIR asks/);
    });

    // Generated with BENTO_OBJDIR, the mozconfig builds there and every reader agrees,
    // with or without the variable set afterwards.
    await withObjdirEnv('obj-legacy', () => writeMozconfig(root, 'dev'));
    assert.match(fs.readFileSync(mozconfig, 'utf8'), /^mk_add_options MOZ_OBJDIR=@TOPSRCDIR@\/obj-legacy$/m);
    for (const value of ['obj-legacy', undefined]) {
      await withObjdirEnv(value, () => {
        assert.equal(resolveObjDir(ctx).dir, engineFile(root, 'obj-legacy'));
      });
    }
    // A mozconfig built under another name is not a hand edit.
    assert.equal(await withObjdirEnv(undefined, () => verifyRecordedEngineState(root)), true);

    for (const value of ['../escape', 'plain', 'obj-a/b']) {
      await withObjdirEnv(value, () => {
        assert.throws(() => writeMozconfig(root, 'dev'), /must name a directory directly under engine\/ that starts with obj-/, value);
      });
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('a mozconfig fragment or MOZCONFIG that would redirect mach is rejected', async () => {
  const root = await fixture();
  const previous = process.env.MOZCONFIG;
  try {
    await withObjdirEnv(undefined, async () => {
      for (const fragment of [path.join(root, 'mozconfig'), path.join(root, 'configs', platformName, 'mozconfig'), path.join(root, 'configs', 'common', 'mozconfig')]) {
        const original = fs.existsSync(fragment) ? fs.readFileSync(fragment) : undefined;
        fs.mkdirSync(path.dirname(fragment), { recursive: true });
        fs.appendFileSync(fragment, '\n# MOZ_OBJDIR in a comment is fine\n');
        writeMozconfig(root, 'dev');
        fs.appendFileSync(fragment, 'mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/elsewhere\n');
        assert.throws(() => writeMozconfig(root, 'dev'), /sets MOZ_OBJDIR; Bento chooses the object directory/, fragment);
        if (original === undefined) fs.rmSync(fragment);
        else fs.writeFileSync(fragment, original);
      }

      fs.writeFileSync(engineFile(root, 'mach'), '');
      process.env.MOZCONFIG = path.join(root, 'other-mozconfig');
      await assert.rejects(() => main(['build'], root), /MOZCONFIG=.* would make mach ignore the generated engine\/mozconfig/);
      await assert.rejects(() => main(['package'], root), /MOZCONFIG=.* would make mach ignore the generated engine\/mozconfig/);

      // Naming the generated file itself is fine: packaging gets as far as the object directory.
      process.env.MOZCONFIG = engineFile(root, 'mozconfig');
      await assert.rejects(() => main(['package'], root), /package: engine\/obj-bento does not exist/);
    });
  } finally {
    if (previous === undefined) delete process.env.MOZCONFIG;
    else process.env.MOZCONFIG = previous;
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test('package and updates-browser use only the directory mach builds into', async () => {
  const root = await fixture();
  try {
    await withObjdirEnv(undefined, async () => {
      fs.writeFileSync(engineFile(root, 'mach'), '');
      fs.mkdirSync(path.join(root, 'dist'));
      fs.writeFileSync(path.join(root, 'dist', 'output.mar'), 'mar');
      // An old build is not what mach builds into, so it is never packaged.
      fs.mkdirSync(engineFile(root, 'obj-aarch64-apple-darwin25.5.0', 'dist'), { recursive: true });
      await assert.rejects(() => main(['package'], root), /package: engine\/obj-bento does not exist; run pnpm run build first \(it is the directory mach builds into\)/);
      await assert.rejects(() => main(['updates-browser'], root), /updates-browser: engine\/obj-bento does not exist; run pnpm run build first/);

      // Neither may BENTO_OBJDIR point them elsewhere than engine/mozconfig does.
      writeMozconfig(root, 'dev');
      await withObjdirEnv('obj-aarch64-apple-darwin25.5.0', async () => {
        await assert.rejects(() => main(['package'], root), /BENTO_OBJDIR=obj-aarch64-apple-darwin25\.5\.0 differs from engine\/obj-bento/);
        await assert.rejects(() => main(['updates-browser'], root), /differs from engine\/obj-bento/);
      });
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

/** Runs `bento-build objdir` and returns what it wrote to stdout and stderr. */
async function objdirCommand(root, ...args) {
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  const writes = { out: '', err: '' };
  process.stdout.write = (chunk) => ((writes.out += chunk), true);
  process.stderr.write = (chunk) => ((writes.err += chunk), true);
  try {
    await main(['objdir', ...args], root);
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
  }
  return writes;
}

test('the objdir command prints the directory mach builds into; --allow-legacy and --allow-missing relax it', async () => {
  const root = await fixture();
  try {
    await withObjdirEnv(undefined, async () => {
      await assert.rejects(() => objdirCommand(root), /no Firefox object directory: engine\/obj-bento does not exist/);
      assert.deepEqual(await objdirCommand(root, '--allow-missing'), { out: '', err: '' });

      // A legacy build is used only on request, and the fallback is announced.
      fs.mkdirSync(engineFile(root, 'obj-old'));
      await assert.rejects(() => objdirCommand(root), /no Firefox object directory/);
      const legacy = await objdirCommand(root, '--allow-legacy');
      assert.equal(legacy.out, `${engineFile(root, 'obj-old')}\n`);
      assert.match(legacy.err, /^bento: engine\/obj-bento does not exist; using the legacy object directory engine\/obj-old/);

      fs.mkdirSync(engineFile(root, 'obj-bento'));
      assert.deepEqual(await objdirCommand(root), { out: `${engineFile(root, 'obj-bento')}\n`, err: '' });

      fs.rmSync(engineFile(root, 'obj-bento'), { recursive: true });
      fs.mkdirSync(engineFile(root, 'obj-other'));
      await assert.rejects(() => objdirCommand(root, '--allow-legacy', '--allow-missing'), /several legacy Firefox object directories/);
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

    // Without obj-bento, a single legacy build is used and announced...
    fs.rmSync(engineFile(root, 'obj-bento'), { recursive: true });
    const fallback = runScript(root, 'sync-shell.sh');
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.match(fallback.stderr, /engine\/obj-bento does not exist; using the legacy object directory engine\/obj-legacy/);
    assert.equal(fs.existsSync(path.join(shellDest('obj-legacy'), 'app.js')), true);

    // ...but two legacy directories are an error rather than a pick.
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
