import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  patchTouchedPaths,
  restorePatchedMtimes,
  snapshotPatchedMtimes,
  snapshotPath,
} from './preserve-patched-mtimes.mjs';

const OLD = new Date('2020-01-02T03:04:05.678Z');

const mtimeNs = (file) => fs.statSync(file, { bigint: true }).mtimeNs;

// A restored mtime is never earlier than the recorded one, and at most one double
// step (well under a microsecond) later.
function assertRestored(file, recordedNs) {
  const actual = mtimeNs(file);
  assert.ok(actual >= recordedNs, `${actual} is earlier than ${recordedNs}`);
  assert.ok(actual - recordedNs < 1000n, `${actual} is far from ${recordedNs}`);
}

// A repo with the given patch targets and recorded patch paths, and an empty engine.
function bareFixture(t, patchTargets, recorded = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-patched-mtimes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'engine'));
  fs.mkdirSync(path.join(root, 'patches'));
  fs.writeFileSync(
    path.join(root, 'patches', 'series.patch'),
    patchTargets.map((target) => `diff --git a/${target} b/${target}\n`).join(''),
  );
  fs.mkdirSync(path.join(root, '.bento'));
  fs.writeFileSync(
    path.join(root, '.bento', 'engine-state.json'),
    JSON.stringify({ entries: recorded.map((entry) => ({ path: entry, kind: 'patch' })) }),
  );
  return { root, at: (relative) => path.join(root, 'engine', relative) };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-patched-mtimes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const engine = path.join(root, 'engine');
  fs.mkdirSync(path.join(engine, 'dir'), { recursive: true });
  fs.mkdirSync(path.join(root, 'patches', 'area'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'patches', 'area', '01.patch'),
    [
      'diff --git a/same.cpp b/same.cpp',
      'diff --git a/changed.cpp b/changed.cpp',
      'diff --git a/created.js b/created.js',
      'diff --git a/link b/link',
      'diff --git a/dir/deleted.h b/dir/deleted.h',
      '+diff --git a/not-a-header b/not-a-header',
      '',
    ].join('\n'),
  );
  fs.mkdirSync(path.join(root, '.bento'));
  fs.writeFileSync(
    path.join(root, '.bento', 'engine-state.json'),
    JSON.stringify({
      entries: [
        { path: 'old-series.cpp', kind: 'patch' },
        { path: 'same.cpp', kind: 'patch' },
        { path: 'browser/branding/bento/x', kind: 'branding' },
      ],
    }),
  );
  const at = (relative) => path.join(engine, relative);
  for (const file of ['same.cpp', 'changed.cpp', 'old-series.cpp', 'dir/deleted.h']) {
    fs.writeFileSync(at(file), `${file}\n`);
    fs.utimesSync(at(file), OLD, OLD);
  }
  fs.writeFileSync(at('target.txt'), 'target\n');
  fs.symlinkSync('target.txt', at('link'));
  return { root, at };
}

// Simulates the reset and the patch apply: every listed file is rewritten.
function rewrite(at, file, content) {
  fs.rmSync(at(file), { force: true });
  fs.writeFileSync(at(file), content);
}

test('lists every diff --git target and every recorded patch path once, sorted', (t) => {
  const { root } = fixture(t);
  assert.deepEqual(patchTouchedPaths(root), [
    'changed.cpp',
    'created.js',
    'dir/deleted.h',
    'link',
    'old-series.cpp',
    'same.cpp',
  ]);
});

test('restores the old mtime only where bytes and mode are unchanged', (t) => {
  const { root, at } = fixture(t);
  assert.equal(snapshotPatchedMtimes({ repoRoot: root, run: 'r1' }), 4);
  // What the snapshot recorded (utimes with a Date already lands a few ns off OLD).
  const recorded = mtimeNs(at('same.cpp'));

  rewrite(at, 'same.cpp', 'same.cpp\n');
  rewrite(at, 'old-series.cpp', 'old-series.cpp\n');
  fs.chmodSync(at('old-series.cpp'), 0o755);
  rewrite(at, 'changed.cpp', 'patched differently\n');
  fs.writeFileSync(at('created.js'), 'new file\n');
  fs.rmSync(at('dir/deleted.h'));
  const linkBefore = fs.lstatSync(at('link')).mtimeMs;
  const fresh = fs.statSync(at('changed.cpp')).mtimeMs;

  assert.equal(restorePatchedMtimes({ repoRoot: root, run: 'r1' }), 1);
  assertRestored(at('same.cpp'), recorded);
  assert.equal(fs.statSync(at('changed.cpp')).mtimeMs, fresh);
  assert.notEqual(fs.statSync(at('old-series.cpp')).mtimeMs, OLD.getTime());
  assert.notEqual(fs.statSync(at('created.js')).mtimeMs, OLD.getTime());
  assert.equal(fs.existsSync(at('dir/deleted.h')), false);
  assert.equal(fs.lstatSync(at('link')).mtimeMs, linkBefore);
  assert.equal(fs.existsSync(snapshotPath(root)), false);
});

test('a snapshot from another run is discarded, not applied', (t) => {
  const { root, at } = fixture(t);
  snapshotPatchedMtimes({ repoRoot: root, run: 'failed-run' });
  rewrite(at, 'same.cpp', 'same.cpp\n');
  const fresh = fs.statSync(at('same.cpp')).mtimeMs;

  assert.equal(restorePatchedMtimes({ repoRoot: root, run: 'next-run' }), undefined);
  assert.equal(fs.statSync(at('same.cpp')).mtimeMs, fresh);
  assert.equal(fs.existsSync(snapshotPath(root)), false);
});

test('a new snapshot replaces the one a failed run left behind', (t) => {
  const { root, at } = fixture(t);
  snapshotPatchedMtimes({ repoRoot: root, run: 'failed-run' });
  rewrite(at, 'same.cpp', 'same.cpp\n');
  const fresh = mtimeNs(at('same.cpp'));

  snapshotPatchedMtimes({ repoRoot: root, run: 'next-run' });
  rewrite(at, 'same.cpp', 'same.cpp\n');
  restorePatchedMtimes({ repoRoot: root, run: 'next-run' });
  // The failed run's older mtime is never put back; this run's snapshot time is.
  assertRestored(at('same.cpp'), fresh);
});

test('a recorded time the nearest double would round down is restored at or after it', (t) => {
  const { root, at } = bareFixture(t, ['file.cpp']);
  fs.writeFileSync(at('file.cpp'), 'same\n');
  snapshotPatchedMtimes({ repoRoot: root, run: 'r1' });
  // 1.79e9 s + 100 ns: the nearest double is the whole second, 100 ns early.
  const recorded = 1_790_000_000_000_000_100n;
  assert.equal(Number(recorded) / 1e9, 1_790_000_000);
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath(root), 'utf8'));
  snapshot.entries[0].mtimeNs = recorded.toString();
  fs.writeFileSync(snapshotPath(root), JSON.stringify(snapshot));
  rewrite(at, 'file.cpp', 'same\n');

  assert.equal(restorePatchedMtimes({ repoRoot: root, run: 'r1' }), 1);
  assertRestored(at('file.cpp'), recorded);
});

test('a series that turns a patched file into a directory snapshots and restores', (t) => {
  // The earlier series created engine/foo; the current one creates engine/foo/bar.
  const { root, at } = bareFixture(t, ['foo/bar'], ['foo']);
  fs.writeFileSync(at('foo'), 'file\n');
  assert.equal(snapshotPatchedMtimes({ repoRoot: root, run: 'r1' }), 1);
  fs.rmSync(at('foo'));
  fs.mkdirSync(at('foo'));
  fs.writeFileSync(at('foo/bar'), 'new\n');
  assert.equal(restorePatchedMtimes({ repoRoot: root, run: 'r1' }), 0);
});

test('a series that turns a patched directory into a file snapshots and restores', (t) => {
  // The earlier series created engine/foo/bar; the current one creates engine/foo.
  const { root, at } = bareFixture(t, ['foo'], ['foo/bar']);
  fs.mkdirSync(at('foo'));
  fs.writeFileSync(at('foo/bar'), 'file\n');
  assert.equal(snapshotPatchedMtimes({ repoRoot: root, run: 'r1' }), 1);
  fs.rmSync(at('foo'), { recursive: true });
  fs.writeFileSync(at('foo'), 'new\n');
  assert.equal(restorePatchedMtimes({ repoRoot: root, run: 'r1' }), 0);
});

test('patch discovery reads symlinked patch files and never enters symlinked directories', (t) => {
  const { root } = bareFixture(t, ['real.cpp']);
  const patches = path.join(root, 'patches');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  const header = (target) => `diff --git a/${target} b/${target}\n`;
  fs.writeFileSync(path.join(outside, 'linked.txt'), header('via-file-link.cpp'));
  fs.writeFileSync(path.join(outside, 'inside.patch'), header('via-dir-link.cpp'));
  fs.symlinkSync(path.join(outside, 'linked.txt'), path.join(patches, 'linked.patch'));
  fs.symlinkSync(path.join(outside, 'missing'), path.join(patches, 'dangling.patch'));
  fs.symlinkSync(outside, path.join(patches, 'linked-dir'));
  fs.symlinkSync(patches, path.join(patches, 'back-link'));
  fs.mkdirSync(path.join(patches, 'area'));
  fs.writeFileSync(path.join(patches, 'area', 'nested.patch'), header('nested.cpp'));

  assert.deepEqual(patchTouchedPaths(root), ['nested.cpp', 'real.cpp', 'via-file-link.cpp']);
});

test('a symlinked patches directory is not entered, like find without -L', (t) => {
  const { root } = bareFixture(t, ['real.cpp']);
  fs.renameSync(path.join(root, 'patches'), path.join(root, 'patches-real'));
  fs.symlinkSync(path.join(root, 'patches-real'), path.join(root, 'patches'));
  assert.deepEqual(patchTouchedPaths(root), []);
});

test('a FIFO at a patched path is skipped without blocking', (t) => {
  const { root, at } = bareFixture(t, ['pipe', 'kept.cpp']);
  fs.writeFileSync(at('kept.cpp'), 'same\n');
  fs.utimesSync(at('kept.cpp'), OLD, OLD);
  execFileSync('mkfifo', [at('pipe')]);
  const recorded = mtimeNs(at('kept.cpp'));
  assert.equal(snapshotPatchedMtimes({ repoRoot: root, run: 'fifo' }), 1);
  fs.writeFileSync(at('kept.cpp'), 'same\n');
  assert.equal(restorePatchedMtimes({ repoRoot: root, run: 'fifo' }), 1);
  assertRestored(at('kept.cpp'), recorded);
});
