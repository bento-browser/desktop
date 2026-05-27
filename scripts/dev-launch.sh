#!/usr/bin/env bash
# Launch Bento for local dev without turning browser/devtools shutdown into a
# pnpm lifecycle failure. Missing build products still fail before launch.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit

BENTO_BIN="${BENTO_BIN:-engine/obj-aarch64-apple-darwin25.4.0/dist/Bento.app/Contents/MacOS/bento}"
PROFILE="${1:-${BENTO_DEV_PROFILE:-.bento-dev-profile}}"

if [ ! -x "$BENTO_BIN" ]; then
  echo "dev-launch: missing executable $BENTO_BIN; run a full build first" >&2
  exit 1
fi

start_seconds="$(date +%s)"

MOZ_PURGE_CACHES="${MOZ_PURGE_CACHES:-1}" "$BENTO_BIN" \
  --new-instance \
  --jsdebugger \
  --profile "$PROFILE"
status=$?

end_seconds="$(date +%s)"
elapsed_seconds=$((end_seconds - start_seconds))

case "$status" in
  0)
    exit 0
    ;;
  130|143)
    echo "dev-launch: Bento stopped by signal after ${elapsed_seconds}s"
    exit 0
    ;;
esac

echo "dev-launch: Bento exited with status $status after ${elapsed_seconds}s; treating as dev shutdown"
exit 0
