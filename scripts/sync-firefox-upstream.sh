#!/usr/bin/env bash
# Update Bento's Firefox engine to the latest upstream release published by
# Mozilla, re-apply Bento patches, and run a build so patch drift is caught.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

current_version="$(node -p "require('./bento.json').firefox.version")"
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
  const config = require('./bento.json');
  const product = config.firefox.product || 'firefox';
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
  echo "firefox:sync: already current; adopting or downloading configured Firefox source"
  bash scripts/bento-env.sh download
else
  echo "firefox:sync: updating engine through Bento build tooling"
  bash scripts/bento-env.sh update
fi

next_version="$(node -p "require('./bento.json').firefox.version")"

if [ "$next_version" != "$latest_version" ]; then
  echo "firefox:sync: expected bento.json to track ${latest_version}, got ${next_version}" >&2
  exit 1
fi

echo "firefox:sync: synced config/firefox-versions.json to ${next_version}"

if ! patch_check_output="$(node scripts/firefox-patch-stack.mjs check --for-import 2>&1)"; then
  echo "$patch_check_output" >&2
  echo "firefox:sync: Firefox patch stack is stale" >&2
  echo "firefox:sync: current patch base: $(node -p "require('./patches/series.json').base.version")" >&2
  echo "firefox:sync: target Firefox version: ${next_version}" >&2
  echo "firefox:sync: run: pnpm run firefox:patches:rebase" >&2
  echo "firefox:sync: then: pnpm run import" >&2
  exit 1
fi

echo "firefox:sync: building extensions before import"
pnpm run ext:build

echo "firefox:sync: importing Bento source, prefs, extensions, and patches"
pnpm run import

echo "firefox:sync: building Firefox with Bento patches applied"
bash scripts/bento-env.sh build
bash scripts/sync-builtin-addon-symlinks.sh

echo "firefox:sync: finished at Firefox ${next_version}"
echo "firefox:sync: review docs/firefox-core-touchpoints.md and run the listed manual regression checks before landing"
