import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

const tempRoots = [];
after(async () => {
  for (const root of tempRoots) await fsp.rm(root, { recursive: true, force: true });
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`,
  );
  return result.stdout;
}

function run(root, script) {
  return spawnSync(process.execPath, [path.join(scriptsDir, script)], {
    env: { ...process.env, BENTO_REPO_ROOT: root },
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

/**
 * A repository in the state a finished import leaves: an engine whose base commit
 * (refs/bento/firefox-base/1.0) was patched by three patches (modify, create,
 * delete one file each), one overlay symlink into src/, and the branding and
 * add-on files check-import-output.mjs also requires. The patches are generated
 * from the real edits, so the live engine matches the series exactly.
 */
async function importedFixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'bento-import-output-'));
  tempRoots.push(root);
  const engine = path.join(root, 'engine');
  const write = (base, relative, content) => {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };

  fs.mkdirSync(engine);
  git(engine, ['init', '-q']);
  git(engine, ['config', 'user.name', 'Fixture']);
  git(engine, ['config', 'user.email', 'fixture@example.invalid']);
  git(engine, ['config', 'commit.gpgsign', 'false']);
  write(engine, 'browser/base/target.js', 'one\ntwo\nthree\n');
  write(engine, 'browser/base/gone.js', 'gone\n');
  write(engine, 'browser/base/jar.mn', '');
  git(engine, ['add', '.']);
  git(engine, ['commit', '-q', '-m', 'base']);
  git(engine, ['update-ref', 'refs/bento/firefox-base/1.0', 'HEAD']);

  const patches = [];
  // Records the diff of one file as a patch; the edit stays in the working tree.
  const capture = (id, relative, edit) => {
    edit();
    const diff = ['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', 'diff'];
    write(
      root,
      `patches/core/${id}.patch`,
      git(engine, [...diff, '--no-ext-diff', 'HEAD', '--', relative]),
    );
    patches.push({ path: `patches/core/${id}.patch`, id });
    git(engine, ['reset', '-q']);
  };
  capture('01-modify', 'browser/base/target.js', () =>
    write(engine, 'browser/base/target.js', 'one\nTWO\nthree\n'),
  );
  // Intent-to-add makes `git diff` print the new file; the reset above clears it.
  capture('02-create', 'browser/base/created.js', () => {
    write(engine, 'browser/base/created.js', 'created\n');
    git(engine, ['add', '-N', 'browser/base/created.js']);
  });
  capture('03-delete', 'browser/base/gone.js', () =>
    fs.rmSync(path.join(engine, 'browser/base/gone.js')),
  );
  write(
    root,
    'patches/series.json',
    JSON.stringify({
      schemaVersion: 1,
      base: { product: 'firefox', version: '1.0' },
      series: patches,
    }),
  );

  write(root, 'src/browser/overlay.txt', 'overlay\n');
  fs.symlinkSync(
    path.join(root, 'src/browser/overlay.txt'),
    path.join(engine, 'browser/overlay.txt'),
  );
  write(
    root,
    '.bento/import-manifest.json',
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          source: 'browser/overlay.txt',
          destination: 'browser/overlay.txt',
          type: 'symlink',
          linkTarget: path.join(root, 'src/browser/overlay.txt'),
        },
      ],
    }),
  );

  fs.mkdirSync(path.join(root, 'src/browser/base/content'), { recursive: true });
  write(root, 'branding/bento/placeholder.txt', 'branding\n');
  write(engine, 'browser/branding/bento/configure.sh', '# configure\n');
  write(
    engine,
    'browser/extensions/moz.build',
    '# BEGIN BENTO BUILTIN ADDONS\n# END BENTO BUILTIN ADDONS\n',
  );
  for (const name of ['bento-shell', 'bento-tools', 'ublock-origin']) {
    write(engine, `browser/extensions/${name}/manifest.json`, '{}\n');
    write(engine, `browser/extensions/${name}/jar.mn`, `builtin-addons/${name}/\n`);
  }
  return { root, engine, write };
}

test('snapshot changes when a patch-created file or an overlay link drifts', async () => {
  const { root, engine } = await importedFixture();
  const snapshot = () => {
    const result = run(root, 'snapshot-import-output.mjs');
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const baseline = snapshot();
  assert.equal(snapshot(), baseline, 'the fingerprint is deterministic');

  const created = path.join(engine, 'browser/base/created.js');
  fs.writeFileSync(created, 'drifted\n');
  assert.notEqual(snapshot(), baseline, 'created file content is covered');
  fs.writeFileSync(created, 'created\n');
  assert.equal(snapshot(), baseline);

  const overlay = path.join(engine, 'browser/overlay.txt');
  fs.rmSync(overlay);
  fs.symlinkSync(path.join(root, 'src/browser/elsewhere.txt'), overlay);
  assert.notEqual(snapshot(), baseline, 'overlay link target is covered');
});

test('snapshot fails when a patch-created file or an overlay is missing', async () => {
  for (const missing of ['browser/base/created.js', 'browser/overlay.txt']) {
    const { root, engine } = await importedFixture();
    fs.rmSync(path.join(engine, missing));
    const result = run(root, 'snapshot-import-output.mjs');
    assert.notEqual(result.status, 0, missing);
    assert.match(result.stderr, new RegExp(`engine/${missing.replace('.', '\\.')} is missing`));
  }
});

test('import output check compares patched content, not just changed paths', async () => {
  const { root, engine } = await importedFixture();
  const check = () => run(root, 'check-import-output.mjs');
  const passed = check();
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /3 patches verified/);

  const drifts = [
    [
      'browser/base/target.js',
      () =>
        fs.writeFileSync(path.join(engine, 'browser/base/target.js'), 'one\nTWO\nthree\nextra\n'),
    ],
    [
      'browser/base/created.js',
      () => fs.writeFileSync(path.join(engine, 'browser/base/created.js'), 'other\n'),
    ],
    [
      'browser/base/gone.js',
      () => fs.writeFileSync(path.join(engine, 'browser/base/gone.js'), 'gone\n'),
    ],
  ];
  for (const [relative, drift] of drifts) {
    const original = fs.existsSync(path.join(engine, relative))
      ? fs.readFileSync(path.join(engine, relative))
      : undefined;
    drift();
    const failed = check();
    assert.notEqual(failed.status, 0, `${relative} drift is detected`);
    assert.match(failed.stderr, new RegExp(`engine/${relative.replace('.', '\\.')} `));
    if (original) fs.writeFileSync(path.join(engine, relative), original);
    else fs.rmSync(path.join(engine, relative));
    assert.equal(check().status, 0, `${relative} passes again once restored`);
  }
});
