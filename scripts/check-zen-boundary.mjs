#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = 'config/allowed-zen-references.json';
const REFERENCE = /\bzen\b|zen-browser|zen_|github\.com\/zen-browser|zen-browser\.app/i;
const ANCESTRY = /\b(?:built|based|derived|inspired)\s+(?:on|from|by)\s+zen\b|\bzen[- ]style\b/i;
const competitor = 'ze' + 'n';
const ALWAYS_FORBIDDEN = new RegExp(
  `${competitor}-browser\\.app|github\\.com/${competitor}-browser/desktop|${competitor} Browser contributors`,
  'i',
);

function pathPattern(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', '\0')
    .replaceAll('*', '[^/]*')
    .replaceAll('\0', '.*');
  return new RegExp(`^${escaped}$`);
}

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function isText(buffer) {
  return !buffer.subarray(0, 8192).includes(0);
}

function loadAllowlist() {
  const config = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, CONFIG_PATH), 'utf8'));
  if (config.schemaVersion !== 1 || !Array.isArray(config.entries)) {
    throw new Error(`${CONFIG_PATH} must have schemaVersion 1 and an entries array`);
  }
  return config.entries.map((entry, index) => {
    if (
      !entry ||
      typeof entry.path !== 'string' ||
      typeof entry.pattern !== 'string' ||
      !['build-tool', 'import-compatibility'].includes(entry.category) ||
      typeof entry.reason !== 'string' ||
      entry.reason.trim() === ''
    ) {
      throw new Error(`${CONFIG_PATH} entry ${index + 1} is invalid`);
    }
    return {
      ...entry,
      pathRegex: pathPattern(entry.path),
      lineRegex: new RegExp(entry.pattern, 'i'),
      matches: 0,
    };
  });
}

export function checkZenBoundary() {
  const entries = loadAllowlist();
  const errors = [];

  for (const relative of trackedFiles()) {
    // The allowlist is control data, and uBlock's maintained filter data may
    // independently contain unrelated products or domains containing "zen".
    if (relative === CONFIG_PATH || relative.startsWith('extensions/ublock-origin/')) continue;

    const absolute = path.join(REPO_ROOT, relative);
    if (!fs.existsSync(absolute)) continue;
    const buffer = fs.readFileSync(absolute);
    if (!isText(buffer)) continue;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!REFERENCE.test(line)) continue;

      const location = `${relative}:${index + 1}`;
      if (
        relative === 'NOTICE' ||
        relative === 'README.md' ||
        relative.startsWith('bentobrowser-site/') ||
        ALWAYS_FORBIDDEN.test(line) ||
        ANCESTRY.test(line)
      ) {
        errors.push(`${location}: prohibited Zen product/ancestry reference`);
        continue;
      }

      const matches = entries.filter(
        (entry) => entry.pathRegex.test(relative) && entry.lineRegex.test(line),
      );
      if (matches.length === 0) {
        errors.push(`${location}: unlisted Zen reference: ${line.trim()}`);
      } else {
        for (const entry of matches) entry.matches += 1;
      }
    }
  }

  for (const entry of entries) {
    if (entry.matches === 0) {
      errors.push(`${CONFIG_PATH}: stale entry for ${entry.path} /${entry.pattern}/`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Zen reference boundary failed:\n${errors.join('\n')}`);
  }
  return entries.reduce((total, entry) => total + entry.matches, 0);
}

try {
  const count = checkZenBoundary();
  process.stdout.write(`check-zen-boundary: ${count} permitted lines matched\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
