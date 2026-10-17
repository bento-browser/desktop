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

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Created by the series with names Git quotes or leaves ambiguous in patch headers.
const oddNames = [
  'browser/base/has space.txt',
  'browser/base/has"quote.txt',
  'browser/base/café.txt',
];

/**
 * A repository in the state a finished import leaves: an engine whose base commit
 * (refs/bento/firefox-base/1.0) was patched by five patches, one overlay symlink
 * into src/, and the branding and add-on files check-import-output.mjs also
 * requires. The series modifies, creates and deletes a file, creates files with odd
 * names and an executable, and turns a file into a directory and a directory into
 * a file. The patches are generated from the real edits (the last two with
 * `git format-patch`), so the live engine matches the series exactly.
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
  write(engine, 'browser/base/dirlike.js', 'file\n');
  write(engine, 'browser/base/tree/leaf.js', 'leaf\n');
  git(engine, ['add', '.']);
  git(engine, ['commit', '-q', '-m', 'base']);
  git(engine, ['update-ref', 'refs/bento/firefox-base/1.0', 'HEAD']);

  const patches = [];
  const diffConfig = ['-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false'];
  const addPatch = (id, text) => {
    write(root, `patches/core/${id}.patch`, text);
    patches.push({ path: `patches/core/${id}.patch`, id });
  };
  // Records the diff of one file as a patch; the edit stays in the working tree.
  const capture = (id, relative, edit) => {
    edit();
    addPatch(id, git(engine, [...diffConfig, 'diff', '--no-ext-diff', 'HEAD', '--', relative]));
    git(engine, ['reset', '-q']);
  };
  // Same, as real `git format-patch` output for the given paths.
  const captureMail = (id, paths, edit) => {
    edit();
    git(engine, ['--literal-pathspecs', 'add', '-A', '--', ...paths]);
    git(engine, ['commit', '-q', '-m', id]);
    addPatch(id, git(engine, [...diffConfig, 'format-patch', '-1', '--stdout']));
    git(engine, ['reset', '-q', '--mixed', 'HEAD~1']);
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
  captureMail('04-odd-names', [...oddNames, 'browser/base/run.sh'], () => {
    for (const name of oddNames) write(engine, name, 'odd\n');
    write(engine, 'browser/base/run.sh', '#!/bin/sh\n');
    fs.chmodSync(path.join(engine, 'browser/base/run.sh'), 0o755);
  });
  captureMail('05-file-dir', ['browser/base/dirlike.js', 'browser/base/tree'], () => {
    fs.rmSync(path.join(engine, 'browser/base/dirlike.js'));
    write(engine, 'browser/base/dirlike.js/nested.js', 'nested\n');
    fs.rmSync(path.join(engine, 'browser/base/tree'), { recursive: true });
    write(engine, 'browser/base/tree', 'now a file\n');
  });
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

  for (const relative of ['browser/base/created.js', ...oddNames]) {
    const file = path.join(engine, relative);
    const original = fs.readFileSync(file);
    fs.writeFileSync(file, 'drifted\n');
    assert.notEqual(snapshot(), baseline, `${relative} content is covered`);
    fs.writeFileSync(file, original);
    assert.equal(snapshot(), baseline);
  }

  const overlay = path.join(engine, 'browser/overlay.txt');
  fs.rmSync(overlay);
  fs.symlinkSync(path.join(root, 'src/browser/elsewhere.txt'), overlay);
  assert.notEqual(snapshot(), baseline, 'overlay link target is covered');
});

test('snapshot fails when a patch-created file or an overlay is missing', async () => {
  for (const missing of [
    'browser/base/created.js',
    'browser/base/café.txt',
    'browser/overlay.txt',
  ]) {
    const { root, engine } = await importedFixture();
    fs.rmSync(path.join(engine, missing));
    const result = run(root, 'snapshot-import-output.mjs');
    assert.notEqual(result.status, 0, missing);
    assert.match(result.stderr, new RegExp(`engine/${escapeRegExp(missing)} is missing`));
  }
});

test('import output check compares patched content, not just changed paths', async () => {
  const { root, engine } = await importedFixture();
  const check = () => run(root, 'check-import-output.mjs');
  const passed = check();
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /5 patches verified/);

  const drifts = [
    ['browser/base/target.js', 'one\nTWO\nthree\nextra\n'],
    ['browser/base/created.js', 'other\n'],
    ['browser/base/gone.js', 'gone\n'],
    ...oddNames.map((name) => [name, 'drifted\n']),
  ];
  for (const [relative, content] of drifts) {
    const file = path.join(engine, relative);
    let original;
    try {
      original = fs.readFileSync(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    fs.writeFileSync(file, content);
    const failed = check();
    assert.notEqual(failed.status, 0, `${relative} drift is detected`);
    assert.match(failed.stderr, new RegExp(`engine/${escapeRegExp(relative)} `));
    if (original) fs.writeFileSync(file, original);
    else fs.rmSync(file);
    assert.equal(check().status, 0, `${relative} passes again once restored`);
  }
});

test('import output check follows the owner execute bit, like Git', async () => {
  const { root, engine } = await importedFixture();
  const check = () => run(root, 'check-import-output.mjs');
  // [file, live mode, whether the check passes]: Git records 100755 only for 0o100.
  const cases = [
    ['browser/base/target.js', 0o755, false],
    ['browser/base/run.sh', 0o644, false],
    ['browser/base/run.sh', 0o655, false],
    ['browser/base/target.js', 0o645, true],
    ['browser/base/run.sh', 0o700, true],
  ];
  for (const [relative, mode, passes] of cases) {
    const file = path.join(engine, relative);
    const original = fs.statSync(file).mode & 0o777;
    fs.chmodSync(file, mode);
    const result = check();
    assert.equal(
      result.status === 0,
      passes,
      `${relative} as ${mode.toString(8)}\n${result.stderr}`,
    );
    if (!passes)
      assert.match(result.stderr, new RegExp(`engine/${escapeRegExp(relative)} differs`));
    fs.chmodSync(file, original);
  }
  assert.equal(check().status, 0);
});

test('import output check accepts a directory where the series deletes a file', async () => {
  const { root, engine } = await importedFixture();
  const check = () => run(root, 'check-import-output.mjs');
  // dirlike.js became a directory and tree (a directory) became a file in the series.
  const passed = check();
  assert.equal(passed.status, 0, passed.stderr);

  fs.rmSync(path.join(engine, 'browser/base/dirlike.js'), { recursive: true });
  const missing = check();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /engine\/browser\/base\/dirlike\.js\/nested\.js is missing/);

  fs.writeFileSync(path.join(engine, 'browser/base/dirlike.js'), 'file\n');
  const stale = check();
  assert.notEqual(stale.status, 0);
  assert.match(
    stale.stderr,
    /engine\/browser\/base\/dirlike\.js exists but the patch series deletes it/,
  );
});
