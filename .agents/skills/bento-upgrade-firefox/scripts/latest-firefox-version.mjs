#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRODUCT_TARGETS = Object.freeze({
  firefox: 'LATEST_FIREFOX_VERSION',
  'firefox-beta': 'LATEST_FIREFOX_DEVEL_VERSION',
  'firefox-esr': 'FIREFOX_ESR',
  'firefox-nightly': 'FIREFOX_NIGHTLY',
});

const ENDPOINT = 'https://product-details.mozilla.org/1.0/firefox_versions.json';

export function readBentoConfig(repoRoot) {
  const file = path.join(path.resolve(repoRoot), 'bento.json');
  let config;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read bento.json: ${error.message}`);
  }
  if (!config.firefox?.product) throw new Error('bento.json must define firefox.product');
  return config;
}

export function productTarget(config) {
  const product = config.firefox.product;
  const target = PRODUCT_TARGETS[product];
  if (!target) throw new Error(`unsupported Firefox product: ${product}`);
  return target;
}

export async function latestFirefoxVersion(repoRoot = process.cwd(), fetchImpl = fetch) {
  const config = readBentoConfig(repoRoot);
  const target = productTarget(config);
  let response;
  try {
    response = await fetchImpl(ENDPOINT);
  } catch (error) {
    throw new Error(`Mozilla version lookup failed: ${error.message}`);
  }
  if (!response.ok) throw new Error(`Mozilla version lookup failed with HTTP ${response.status}`);
  let versions;
  try {
    versions = await response.json();
  } catch (error) {
    throw new Error(`Mozilla version response was invalid: ${error.message}`);
  }
  if (!versions[target]) throw new Error(`Mozilla version response did not include ${target}`);
  return versions[target];
}

async function main() {
  process.stdout.write(
    `${await latestFirefoxVersion(path.resolve(process.argv[2] ?? process.cwd()))}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`latest-firefox-version: ${error.message}\n`);
    process.exitCode = 1;
  });
}
