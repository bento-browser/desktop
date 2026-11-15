import assert from 'node:assert/strict';
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

// utimes takes double seconds, so a restored mtime can be off by under a microsecond.
function assertSameTime(actualMs, expectedMs) {
  assert.ok(Math.abs(actualMs - expectedMs) < 0.001, `${actualMs} != ${expectedMs}`);
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

  rewrite(at, 'same.cpp', 'same.cpp\n');
  rewrite(at, 'old-series.cpp', 'old-series.cpp\n');
  fs.chmodSync(at('old-series.cpp'), 0o755);
  rewrite(at, 'changed.cpp', 'patched differently\n');
  fs.writeFileSync(at('created.js'), 'new file\n');
  fs.rmSync(at('dir/deleted.h'));
  const linkBefore = fs.lstatSync(at('link')).mtimeMs;
  const fresh = fs.statSync(at('changed.cpp')).mtimeMs;

  assert.equal(restorePatchedMtimes({ repoRoot: root, run: 'r1' }), 1);
  assertSameTime(fs.statSync(at('same.cpp')).mtimeMs, OLD.getTime());
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
  const fresh = fs.statSync(at('same.cpp')).mtimeMs;

  snapshotPatchedMtimes({ repoRoot: root, run: 'next-run' });
  rewrite(at, 'same.cpp', 'same.cpp\n');
  restorePatchedMtimes({ repoRoot: root, run: 'next-run' });
  // The failed run's older mtime is never put back; this run's snapshot time is.
  assertSameTime(fs.statSync(at('same.cpp')).mtimeMs, fresh);
});
