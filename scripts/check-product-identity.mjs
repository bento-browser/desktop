#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const competitor = 'ze' + 'n';
const competitorName = `${competitor[0].toUpperCase()}${competitor.slice(1)}`;

export const FORBIDDEN_IDENTITIES = [
  `${competitor}-browser.app`,
  ['github.com', `${competitor}-browser`, 'desktop'].join('/'),
  `${competitorName} Browser contributors`,
  `Bento Browser fork of ${competitorName}`,
  'built using Surfer',
  'built on Surfer',
  `@bento-browser/${'sur' + 'fer'}`,
];

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function walk(root, boundary, seen = new Set()) {
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink()) {
    let target;
    try {
      target = fs.realpathSync(root);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    return isWithin(boundary, target) ? walk(target, boundary, seen) : [];
  }
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];

  const real = fs.realpathSync(root);
  if (seen.has(real)) return [];
  seen.add(real);

  return fs
    .readdirSync(root, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => walk(path.join(root, entry.name), boundary, seen));
}

function utf16le(value) {
  return Buffer.from(value, 'utf16le');
}

function utf16be(value) {
  const bytes = utf16le(value);
  for (let index = 0; index < bytes.length; index += 2) {
    const first = bytes[index];
    bytes[index] = bytes[index + 1];
    bytes[index + 1] = first;
  }
  return bytes;
}

export function scanProductIdentity(roots, options = {}) {
  const cwd = options.cwd || process.cwd();
  const failures = [];

  for (const requestedRoot of roots) {
    const root = path.resolve(cwd, requestedRoot);
    if (!fs.existsSync(root)) {
      throw new Error(`product-identity: path does not exist: ${requestedRoot}`);
    }

    for (const file of walk(root, path.resolve(cwd))) {
      const data = fs.readFileSync(file);
      for (const identity of FORBIDDEN_IDENTITIES) {
        const encodings = [Buffer.from(identity, 'utf8'), utf16le(identity), utf16be(identity)];
        if (encodings.some((needle) => data.indexOf(needle) !== -1)) {
          failures.push(`${path.relative(cwd, file)} contains forbidden identity: ${identity}`);
        }
      }
    }
  }

  return failures;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    process.stderr.write('usage: node scripts/check-product-identity.mjs <path> [path...]\n');
    return 2;
  }

  const failures = scanProductIdentity(argv);
  if (failures.length > 0) {
    process.stderr.write(`${failures.join('\n')}\n`);
    return 1;
  }

  process.stdout.write(`product-identity: checked ${argv.length} path(s)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
