#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <path-to-built-bento-binary>" >&2
  exit 2
fi

browser=$1
if [[ ! -x "$browser" ]]; then
  echo "headless-smoke: browser is not executable: $browser" >&2
  exit 2
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/bento-firefox-smoke.XXXXXX")
trap 'rm -rf "$tmp_dir"' EXIT

profile_dir="$tmp_dir/profile"
screenshot="$tmp_dir/smoke.png"
log="$tmp_dir/browser.log"
url='data:text/html,<meta charset=utf-8><title>Bento smoke</title><body>Bento%20Firefox%20upgrade%20smoke</body>'

if ! "$browser" \
  --headless \
  --no-remote \
  --profile "$profile_dir" \
  --window-size 800,600 \
  --screenshot "$screenshot" \
  "$url" >"$log" 2>&1; then
  cat "$log" >&2
  echo "headless-smoke: browser exited unsuccessfully" >&2
  exit 1
fi

if [[ ! -s "$screenshot" ]]; then
  cat "$log" >&2
  echo "headless-smoke: browser did not produce a screenshot" >&2
  exit 1
fi

echo "headless-smoke: passed (800x600 render)"
