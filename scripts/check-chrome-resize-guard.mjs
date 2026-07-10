#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(relativePath) {
  const fullPath = path.join(repoRoot, relativePath);
  try {
    return fs.readFileSync(fullPath, 'utf8');
  } catch (err) {
    throw new Error(`could not read ${relativePath}: ${err.message}`);
  }
}

const chromeMountPath = 'src/browser/base/content/bento-shell-mount.js';
const chromeTokensPath = 'src/browser/base/content/bento-chrome-tokens.css';
const chromeMount = readRepoFile(chromeMountPath);
const chromeTokens = readRepoFile(chromeTokensPath);

const normalPanelShadow =
  /--bento-panel-frame-shadow:\s*var\(--bento-panel-frame-outline-shadow\),\s*var\(--shadow-l\);/;
const liveResizeOutlineShadow =
  /:root\[bento-window-resizing='true'\]\s*,\s*:root\[bento-sidebar-resizing='true'\]\s*\{[^}]*--bento-panel-frame-shadow:\s*var\(--bento-panel-frame-outline-shadow\);/s;
const generatedShadowToken = /--shadow-l:\s*[^;]+;/;

const failures = [];

if (!normalPanelShadow.test(chromeMount)) {
  failures.push(
    `${chromeMountPath} must define normal panel frames with ` +
      '`--bento-panel-frame-outline-shadow, var(--shadow-l)`.',
  );
}

if (!liveResizeOutlineShadow.test(chromeMount)) {
  failures.push(
    `${chromeMountPath} must override --bento-panel-frame-shadow to ` +
      'outline-only for both bento-window-resizing and bento-sidebar-resizing.',
  );
}

if (!generatedShadowToken.test(chromeTokens)) {
  failures.push(
    `${chromeTokensPath} is missing --shadow-l; run pnpm run import to regenerate chrome tokens.`,
  );
}

if (failures.length > 0) {
  console.error('Chrome resize guard failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Chrome resize guard passed.');
