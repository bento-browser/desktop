#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const configPath = path.join(root, 'rust-toolchain.toml');
const config = fs.readFileSync(configPath, 'utf8');
const channel = config.match(/^\s*channel\s*=\s*["']([^"']+)["']\s*$/m)?.[1];

if (!channel) {
  throw new Error(`${path.relative(root, configPath)} must declare a channel`);
}

execFileSync('rustup', ['toolchain', 'install', channel, '--profile', 'minimal'], {
  cwd: root,
  stdio: 'inherit',
});

const active = execFileSync('rustup', ['show', 'active-toolchain'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const activeChannel = active.split(/\s+/)[0];
if (activeChannel !== channel && !activeChannel.startsWith(`${channel}-`)) {
  throw new Error(`rustup selected ${activeChannel || 'no toolchain'}, expected ${channel}`);
}

const rustc = execFileSync('rustc', ['--version'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
if (!rustc.startsWith(`rustc ${channel} `)) {
  throw new Error(`rustc reported ${rustc || 'no version'}, expected ${channel}`);
}

console.log(`rust-toolchain: ${channel} (${rustc})`);
