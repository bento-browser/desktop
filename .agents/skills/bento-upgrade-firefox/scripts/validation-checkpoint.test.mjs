import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'validation-checkpoint.mjs');

function run(args, options = {}) {
  return execFileSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-validation-checkpoint-'));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Checkpoint Test']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'checkpoint@test.invalid']);
  fs.mkdirSync(path.join(root, 'patches'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'plans/\n');
  fs.mkdirSync(path.join(root, 'configs'), { recursive: true });
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'bento.json'),
    '{"firefox":{"product":"firefox","version":"152.0.6"}}\n',
  );
  fs.writeFileSync(path.join(root, 'patches', 'series.json'), '{"base":{"version":"152.0.6"}}\n');
  fs.writeFileSync(path.join(root, 'pnpm-lock.release.yaml'), 'lockfileVersion: 9.0\n');
  fs.writeFileSync(path.join(root, 'rust-toolchain.toml'), '[toolchain]\nchannel = "stable"\n');
  fs.writeFileSync(path.join(root, '.nvmrc'), '20\n');
  fs.writeFileSync(path.join(root, 'configs', 'common'), 'common\n');
  fs.writeFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'name: CI\n');
  fs.writeFileSync(path.join(root, 'README.md'), 'unrelated\n');
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
  return root;
}

test('records and reuses gates for an unchanged relevant source fingerprint', () => {
  const root = fixture();
  try {
    run(['record', root, '152.0.6', 'build', 'pnpm run build']);
    assert.match(run(['status', root, '152.0.6']), /"build"/);
    assert.match(run(['has', root, '152.0.6', 'build']), /recorded gates/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalidates recorded gates when a relevant source file changes', () => {
  const root = fixture();
  try {
    run(['record', root, '152.0.6', 'build']);
    fs.writeFileSync(
      path.join(root, 'bento.json'),
      '{"firefox":{"product":"firefox","version":"152.0.7"}}\n',
    );
    assert.throws(
      () => run(['has', root, '152.0.6', 'build']),
      (error) => error.status === 1 && /source fingerprint changed/.test(error.stderr),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fails closed when an old checkpoint schema is present', () => {
  const root = fixture();
  try {
    run(['record', root, '152.0.6', 'build']);
    const checkpoint = JSON.parse(
      fs.readFileSync(path.join(root, 'plans', 'firefox-upgrade-validation.json'), 'utf8'),
    );
    checkpoint.schemaVersion = 1;
    fs.writeFileSync(
      path.join(root, 'plans', 'firefox-upgrade-validation.json'),
      `${JSON.stringify(checkpoint)}\n`,
    );
    assert.throws(
      () => run(['has', root, '152.0.6', 'build']),
      (error) => error.status === 1 && /checkpoint schema is unsupported/.test(error.stderr),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalidates gates when a release build input changes', () => {
  const root = fixture();
  try {
    run(['record', root, '152.0.6', 'build']);
    fs.writeFileSync(path.join(root, 'rust-toolchain.toml'), '[toolchain]\nchannel = "nightly"\n');
    assert.throws(
      () => run(['has', root, '152.0.6', 'build']),
      (error) => error.status === 1 && /source fingerprint changed/.test(error.stderr),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ignores unrelated files outside upgrade input surfaces', () => {
  const root = fixture();
  try {
    run(['record', root, '152.0.6', 'build']);
    fs.writeFileSync(path.join(root, 'README.md'), 'unrelated edit\n');
    assert.match(run(['has', root, '152.0.6', 'build']), /recorded gates/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a checkpoint recorded for another target', () => {
  const root = fixture();
  try {
    run(['record', root, '152.0.6', 'build']);
    assert.throws(
      () => run(['status', root, '152.0.7']),
      (error) => error.status === 1 && /checkpoint target is 152\.0\.6/.test(error.stderr),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
