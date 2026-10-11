import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  countLegacyAliases,
  evaluateCounts,
  formatCap,
  parseCap,
  refreshCap,
} from './legacy-aliases.mjs';

const CHECKER = resolve(dirname(fileURLToPath(import.meta.url)), 'check-legacy-aliases.mjs');

test('countLegacyAliases counts the five families and ignores the rest', () => {
  const css = `
    .a { color: var(--neutral-5); gap: var(--space-s) var(--space-m); }
    .b { border-radius: var( --radius-m ); box-shadow: var(--shadow-s); background: var(--color-60-fg); }
    .c { color: var(--muxui-semantic-color-neutral-5); margin: var(--bento-gap); width: var(--text-s); }
    /* var(--neutral-90) in a comment does not count */
  `;
  assert.equal(countLegacyAliases(css), 6);
  assert.equal(countLegacyAliases('.a { --neutral-5: red; }'), 0);
});

test('the cap passes at or below its counts', () => {
  const cap = { total: 7, files: { 'a.css': 4, 'b.css': 3 } };
  assert.equal(evaluateCounts({ measured: { 'a.css': 4, 'b.css': 3 }, cap }).failed, false);

  const lower = evaluateCounts({ measured: { 'a.css': 2, 'b.css': 3 }, cap });
  assert.equal(lower.failed, false);
  assert.deepEqual(lower.shrunk, [{ file: 'a.css', count: 2, allowed: 4 }]);

  // A capped file that no longer has any uses is reported as shrunk.
  const gone = evaluateCounts({ measured: { 'b.css': 3 }, cap });
  assert.deepEqual(gone.shrunk, [{ file: 'a.css', count: 0, allowed: 4 }]);
});

test('a file above its cap fails even when the total is unchanged', () => {
  const cap = { total: 7, files: { 'a.css': 4, 'b.css': 3 } };
  const moved = evaluateCounts({ measured: { 'a.css': 3, 'b.css': 4 }, cap });
  assert.equal(moved.failed, true);
  assert.equal(moved.totalGrew, false);
  assert.deepEqual(moved.grew, [{ file: 'b.css', count: 4, allowed: 3 }]);
});

test('a new file with uses fails, and the total can fail on its own', () => {
  const cap = { total: 7, files: { 'a.css': 4, 'b.css': 3 } };
  const added = evaluateCounts({ measured: { 'a.css': 4, 'b.css': 3, 'c.css': 1 }, cap });
  assert.equal(added.failed, true);
  assert.deepEqual(added.grew, [{ file: 'c.css', count: 1, allowed: 0 }]);

  const total = evaluateCounts({ measured: { 'a.css': 4, 'b.css': 3 }, cap: { ...cap, total: 6 } });
  assert.equal(total.failed, true);
  assert.equal(total.totalGrew, true);
  assert.deepEqual(total.grew, []);
});

test('refreshCap lowers freely and refuses growth unless a file is named', () => {
  const previous = { 'a.css': 4, 'b.css': 3 };
  const measured = { 'a.css': 2, 'b.css': 5, 'c.css': 1 };

  const refused = refreshCap({ previous, measured });
  assert.deepEqual(refused.next, { 'a.css': 2, 'b.css': 3, 'c.css': 0 });
  assert.deepEqual(refused.lowered, ['a.css']);
  assert.deepEqual(refused.refused, ['b.css', 'c.css']);

  const accepted = refreshCap({ previous, measured, acceptGrowth: ['b.css', 'c.css'] });
  assert.deepEqual(accepted.next, { 'a.css': 2, 'b.css': 5, 'c.css': 1 });
  assert.deepEqual(accepted.raised, ['b.css', 'c.css']);
  assert.deepEqual(accepted.refused, []);

  assert.throws(
    () => refreshCap({ previous, measured, acceptGrowth: ['nope.css'] }),
    /not scanned: nope.css/,
  );
});

test('formatCap and parseCap round-trip and reject malformed caps', () => {
  const text = formatCap({ 'b.css': 3, 'a.css': 4, 'zero.css': 0 });
  assert.deepEqual(parseCap(text), { total: 7, files: { 'a.css': 4, 'b.css': 3 } });
  assert.throws(() => parseCap('{"total": -1, "files": {}}'), /total/);
  assert.throws(() => parseCap('{"total": 1, "files": {"a.css": 0}}'), /positive integer/);
  assert.throws(() => parseCap('{"total": 1}'), /files/);
});

// End to end against a scratch tree: the CLI reads CSS under extensions/bento-shell/src.
function scratchTree(files) {
  const root = mkdtempSync(join(tmpdir(), 'bento-alias-cap-'));
  for (const [file, css] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), css);
  }
  return root;
}

const run = (root, ...args) =>
  spawnSync(process.execPath, [CHECKER, '--root', root, ...args], { encoding: 'utf8' });

test('the CLI records, enforces and ratchets the cap', () => {
  const A = 'extensions/bento-shell/src/a.css';
  const root = scratchTree({
    [A]: '.a { color: var(--neutral-5); gap: var(--space-s); }',
    // Generated presets define the aliases and are not scanned.
    'extensions/bento-shell/src/theme/presets/index.css': '.a { color: var(--neutral-5); }',
  });
  try {
    assert.equal(run(root).status, 1, 'no cap file yet');
    assert.equal(run(root, '--write-cap').status, 0);
    const cap = JSON.parse(readFileSync(join(root, '.legacy-alias-cap.json'), 'utf8'));
    assert.deepEqual(cap, { total: 2, files: { [A]: 2 } });
    assert.equal(run(root).status, 0);

    // Growth fails the check and cannot be written into the cap without the flag.
    writeFileSync(
      join(root, A),
      '.a { color: var(--neutral-5); gap: var(--space-s) var(--space-m); }',
    );
    const failed = run(root);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /FAIL .*a\.css: 3 legacy alias uses, cap 2/);
    assert.equal(run(root, '--write-cap').status, 1);
    assert.equal(run(root, '--write-cap', '--accept-growth', A).status, 0);
    assert.equal(run(root).status, 0);

    // Removing uses passes and the cap can be lowered.
    writeFileSync(join(root, A), '.a { color: var(--neutral-5); }');
    assert.match(run(root).stdout, /below their cap/);
    assert.equal(run(root, '--write-cap').status, 0);
    assert.equal(JSON.parse(readFileSync(join(root, '.legacy-alias-cap.json'), 'utf8')).total, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
