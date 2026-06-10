#!/usr/bin/env bash
# Update Bento's Firefox engine to the latest upstream release known to Surfer,
# re-apply Bento patches, and run a build so patch drift is caught immediately.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

current_version="$(node -p "require('./surfer.json').version.version")"
latest_version="$(
  node <<'NODE'
const targets = {
  firefox: 'LATEST_FIREFOX_VERSION',
  'firefox-beta': 'LATEST_FIREFOX_DEVEL_VERSION',
  'firefox-devedition': 'FIREFOX_DEVEDITION',
  'firefox-esr': 'FIREFOX_ESR',
  'firefox-nightly': 'FIREFOX_NIGHTLY',
};

async function main() {
  const config = require('./surfer.json');
  const product = config.version.product || 'firefox';
  const target = targets[product];

  if (!target) {
    throw new Error(`unsupported Firefox product: ${product}`);
  }

  const response = await fetch('https://product-details.mozilla.org/1.0/firefox_versions.json');
  if (!response.ok) {
    throw new Error(`Mozilla version lookup failed with HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data[target]) {
    throw new Error(`Mozilla version response did not include ${target}`);
  }

  process.stdout.write(data[target]);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
NODE
)"

echo "firefox:sync: current Firefox version is ${current_version}"
echo "firefox:sync: latest upstream Firefox version is ${latest_version}"

if [ "$latest_version" = "$current_version" ]; then
  if [ -d "engine/toolkit" ]; then
    echo "firefox:sync: already current; keeping existing engine"
  else
    echo "firefox:sync: already current, but engine/ is missing; downloading configured Firefox source"
    bash scripts/surfer-env.sh download
  fi
else
  echo "firefox:sync: updating engine through Surfer"
  bash scripts/surfer-env.sh update
fi

next_version="$(node -p "require('./surfer.json').version.version")"

if [ "$next_version" != "$latest_version" ]; then
  echo "firefox:sync: expected surfer.json to track ${latest_version}, got ${next_version}" >&2
  exit 1
fi

node <<'NODE'
const fs = require('node:fs');

const surfer = JSON.parse(fs.readFileSync('surfer.json', 'utf8'));
const versionsPath = 'config/firefox-versions.json';
const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
const release = versions.channels.find(channel => channel.channel === 'release');

if (!release) {
  throw new Error('config/firefox-versions.json has no release channel');
}

// Surfer builds non-"release" brands from version.candidate when it differs
// from version.version. Bento's active dev brand is "bento", so keep candidate
// aligned with release during this sync unless a future workflow explicitly
// opts into candidate builds.
surfer.version.candidate = surfer.version.version;
surfer.version.candidateBuild = 1;
fs.writeFileSync('surfer.json', `${JSON.stringify(surfer, null, 2)}\n`);

release.version = surfer.version.version;
release.surferConfig = 'surfer.json';
fs.writeFileSync(versionsPath, `${JSON.stringify(versions, null, 2)}\n`);
NODE

echo "firefox:sync: synced config/firefox-versions.json to ${next_version}"
echo "firefox:sync: building extensions before import"
pnpm run ext:build

echo "firefox:sync: importing Bento source, prefs, extensions, and patches"
pnpm run import

echo "firefox:sync: building Firefox with Bento patches applied"
bash scripts/surfer-env.sh build
bash scripts/sync-builtin-addon-symlinks.sh

echo "firefox:sync: finished at Firefox ${next_version}"
echo "firefox:sync: review docs/firefox-core-touchpoints.md and run the listed manual regression checks before landing"
