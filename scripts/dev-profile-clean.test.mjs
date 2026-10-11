import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./dev-profile-clean.sh', import.meta.url));
const MARKER = '.bento-dev-profile-marker';

function write(root, rel, content = 'x') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Throwaway git repo with a copy of the script and a few tracked source files. */
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bento-profile-clean-')));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'dev-profile-clean.sh'));
  write(root, 'src/app.js');
  write(root, 'extensions/shell/manifest.json');
  write(root, 'fixtures/prefs.js'); // a tracked file that looks like a profile file
  write(root, 'README.md');
  const git = spawnSync('git', ['init', '-q'], { cwd: root });
  assert.equal(git.status, 0, String(git.stderr));
  const add = spawnSync('git', ['add', '-A'], { cwd: root });
  assert.equal(add.status, 0, String(add.stderr));
  return root;
}

function clean(root, profile) {
  const result = spawnSync('bash', [path.join(root, 'scripts', 'dev-profile-clean.sh')], {
    cwd: root,
    env: { ...process.env, BENTO_DEV_PROFILE: profile },
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

/** Sorted relative paths with file contents, to prove a refused run changed nothing. */
function snapshot(dir) {
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        entries.push(`${rel}/`);
        walk(full);
      } else {
        entries.push(`${rel}=${fs.readFileSync(full, 'utf8')}`);
      }
    }
  };
  walk(dir);
  return entries.sort();
}

function withFixture(fn) {
  const root = fixture();
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('creates and marks a profile that does not exist yet', () => {
  withFixture((root) => {
    const result = clean(root, '.bento-dev-profile');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(path.join(root, '.bento-dev-profile', MARKER)), true);
  });
});

test('marks and cleans an empty directory', () => {
  withFixture((root) => {
    fs.mkdirSync(path.join(root, 'empty-profile'));
    const result = clean(root, 'empty-profile');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readdirSync(path.join(root, 'empty-profile')), [MARKER]);
  });
});

test('cleans a marked profile, keeps allowlisted data, and drops crash-recovery files', () => {
  withFixture((root) => {
    const profile = path.join(root, '.bento-dev-profile');
    write(profile, MARKER);
    write(profile, 'places.sqlite', 'history');
    write(profile, 'sessionstore.jsonlz4', 'clean-session');
    write(profile, 'sessionstore-backups/recovery.jsonlz4', 'crash');
    write(profile, 'sessionstore-backups/recovery.baklz4', 'crash');
    write(profile, 'sessionstore-backups/previous.jsonlz4', 'previous');
    write(profile, 'startupCache/scriptCache', 'cache');
    write(profile, 'addonStartup.json.lz4', 'stale');
    write(profile, '.startup-incomplete', '');

    const result = clean(root, '.bento-dev-profile');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(profile), [
      `${MARKER}=x`,
      'places.sqlite=history',
      'sessionstore-backups/',
      'sessionstore-backups/previous.jsonlz4=previous',
      'sessionstore.jsonlz4=clean-session',
    ]);
  });
});

test('cleans an existing unmarked Firefox profile and marks it', () => {
  withFixture((root) => {
    const profile = path.join(root, '.bento-dev-profile');
    write(profile, 'times.json', '{}');
    write(profile, 'prefs.js', 'user_pref("a", 1);');
    write(profile, 'cache2/entries/abc', 'cache');

    const result = clean(root, '.bento-dev-profile');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(snapshot(profile), [
      `${MARKER}=Bento dev profile. scripts/dev-profile-clean.sh may delete everything here except its allowlist.\n`,
      'prefs.js=user_pref("a", 1);',
    ]);
  });
});

test('refuses directories that contain git-tracked files and leaves them untouched', () => {
  withFixture((root) => {
    // fixtures/ holds a tracked prefs.js, so the profile signature must not be trusted.
    write(root, 'fixtures/untracked-scratch.txt');
    for (const target of ['src', 'extensions/shell', 'fixtures']) {
      const before = snapshot(path.join(root, target));
      const result = clean(root, target);
      assert.notEqual(result.status, 0, target);
      assert.match(result.stderr, /refusing to clean/, target);
      assert.match(result.stderr, /git-tracked files/, target);
      assert.deepEqual(snapshot(path.join(root, target)), before, target);
    }
  });
});

test('refuses the checkout root, top-level source directories, and repository metadata', () => {
  withFixture((root) => {
    write(root, 'engine/obj/keep.txt'); // untracked Firefox tree
    const before = snapshot(root);
    for (const target of ['.', 'src', 'extensions', 'SRC', '.git', 'engine/obj', 'node_modules']) {
      const result = clean(root, target);
      assert.notEqual(result.status, 0, target);
      assert.match(result.stderr, /refusing to clean/, target);
    }
    assert.deepEqual(snapshot(root), before);
  });
});

test('refuses an unmarked non-empty directory that is not a profile and leaves it untouched', () => {
  withFixture((root) => {
    const dir = path.join(root, 'my-notes');
    write(dir, 'todo.txt', 'keep me');
    write(dir, 'nested/data.bin', 'keep me too');
    const before = snapshot(dir);

    const result = clean(root, 'my-notes');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not empty and not a dev profile/);
    assert.deepEqual(snapshot(dir), before);
  });
});
