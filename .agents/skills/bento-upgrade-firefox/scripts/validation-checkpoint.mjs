#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const schemaVersion = 2;
const relevantPaths = [
  'bento.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-lock.release.yaml',
  'config',
  'configs',
  'patches',
  'branding/bento',
  'src',
  'prefs',
  'extensions',
  'scripts',
  'rust-toolchain.toml',
  '.nvmrc',
  '.github/workflows/ci.yml',
  '.github/workflows/release.yml',
];

function fail(message) {
  console.error(`validation-checkpoint: ${message}`);
  process.exit(1);
}

function git(repoRoot, args, options = {}) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

function checkpointPath(repoRoot) {
  return path.join(repoRoot, 'plans', 'firefox-upgrade-validation.json');
}

function fingerprint(repoRoot) {
  const output = git(
    repoRoot,
    ['ls-files', '-co', '--exclude-standard', '-z', '--', ...relevantPaths],
    { encoding: 'buffer' },
  );
  const files = [...new Set(output.toString('utf8').split('\0').filter(Boolean))].sort();
  const hash = crypto.createHash('sha256');

  for (const relativePath of files) {
    const absolutePath = path.join(repoRoot, relativePath);
    hash.update(relativePath);
    hash.update('\0');
    try {
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        hash.update('symlink\0');
        hash.update(fs.readlinkSync(absolutePath));
      } else if (stat.isFile()) {
        hash.update(`file:${stat.mode & 0o777}\0`);
        hash.update(fs.readFileSync(absolutePath));
      } else {
        hash.update('other\0');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      hash.update('missing\0');
    }
    hash.update('\0');
  }

  return hash.digest('hex');
}

function readCheckpoint(repoRoot) {
  try {
    return JSON.parse(fs.readFileSync(checkpointPath(repoRoot), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function currentCheckpoint(repoRoot, target) {
  const checkpoint = readCheckpoint(repoRoot);
  if (!checkpoint) {
    return { valid: false, reason: 'checkpoint is missing' };
  }
  if (checkpoint.schemaVersion !== schemaVersion) {
    return { valid: false, reason: 'checkpoint schema is unsupported' };
  }
  if (checkpoint.target !== target) {
    return { valid: false, reason: `checkpoint target is ${checkpoint.target}` };
  }
  const currentFingerprint = fingerprint(repoRoot);
  if (checkpoint.fingerprint !== currentFingerprint) {
    return { valid: false, reason: 'source fingerprint changed' };
  }
  return { valid: true, checkpoint };
}

function assertCheckpointIgnored(repoRoot) {
  const relativePath = path.relative(repoRoot, checkpointPath(repoRoot));
  try {
    git(repoRoot, ['check-ignore', '-q', '--', relativePath]);
  } catch {
    fail(`${relativePath} must be gitignored before recording validation`);
  }
}

function writeCheckpoint(repoRoot, checkpoint) {
  assertCheckpointIgnored(repoRoot);
  const destination = checkpointPath(repoRoot);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`);
  fs.renameSync(temporary, destination);
}

function usage() {
  console.error(
    'usage: validation-checkpoint.mjs <fingerprint|status|has|record> <repo-root> [target] [gate...]',
  );
  process.exit(2);
}

const [command, repoArgument, target, ...rest] = process.argv.slice(2);
if (!command || !repoArgument) {
  usage();
}

const repoRoot = path.resolve(repoArgument);

if (command === 'fingerprint') {
  process.stdout.write(`${fingerprint(repoRoot)}\n`);
} else if (command === 'status') {
  if (!target) usage();
  const result = currentCheckpoint(repoRoot, target);
  if (!result.valid) fail(result.reason);
  process.stdout.write(`${JSON.stringify(result.checkpoint, null, 2)}\n`);
} else if (command === 'has') {
  if (!target || rest.length === 0) usage();
  const result = currentCheckpoint(repoRoot, target);
  if (!result.valid) fail(result.reason);
  const missing = rest.filter((gate) => !result.checkpoint.gates?.[gate]);
  if (missing.length > 0) fail(`missing gates: ${missing.join(', ')}`);
  process.stdout.write(`validation-checkpoint: recorded gates: ${rest.join(', ')}\n`);
} else if (command === 'record') {
  const [gate, evidence = ''] = rest;
  if (!target || !gate) usage();
  const currentFingerprint = fingerprint(repoRoot);
  const existing = readCheckpoint(repoRoot);
  const reusable =
    existing?.schemaVersion === schemaVersion &&
    existing.target === target &&
    existing.fingerprint === currentFingerprint;
  const checkpoint = reusable
    ? existing
    : {
        schemaVersion,
        target,
        fingerprint: currentFingerprint,
        gates: {},
      };
  checkpoint.gates[gate] = {
    completedAt: new Date().toISOString(),
    evidence,
  };
  checkpoint.updatedAt = checkpoint.gates[gate].completedAt;
  writeCheckpoint(repoRoot, checkpoint);
  process.stdout.write(`validation-checkpoint: recorded ${gate}\n`);
} else {
  usage();
}
