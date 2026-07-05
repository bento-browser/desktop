#!/usr/bin/env bash
# Launch Bento for local dev without turning browser/devtools shutdown into a
# pnpm lifecycle failure. Missing build products still fail before launch.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit

if [ -z "${BENTO_BIN:-}" ]; then
  BENTO_BIN="$(
    find "$REPO_ROOT/engine" -maxdepth 6 \
      -path "$REPO_ROOT/engine/obj-*/dist/Bento.app/Contents/MacOS/bento" \
      -type f -perm -111 -print 2>/dev/null |
      while IFS= read -r candidate; do
        printf '%s\t%s\n' "$(stat -f '%m' "$candidate")" "$candidate"
      done |
      sort -nr |
      head -n1 |
      cut -f2-
  )"
fi
PROFILE="${1:-${BENTO_DEV_PROFILE:-.bento-dev-profile}}"
if [ "$#" -gt 0 ]; then
  shift
fi

PROFILE_LOCK="$PROFILE/.parentlock"
if { [ -e "$PROFILE_LOCK" ] || [ -L "$PROFILE_LOCK" ]; } &&
  command -v lsof >/dev/null 2>&1 &&
  lsof "$PROFILE_LOCK" >/dev/null 2>&1; then
  echo "dev-launch: $PROFILE appears to still be in use" >&2
  echo "dev-launch: quit Bento and wait for it to exit before launching another dev instance" >&2
  exit 1
fi

if [ ! -x "$BENTO_BIN" ]; then
  echo "dev-launch: missing executable $BENTO_BIN; run a full build first" >&2
  exit 1
fi

start_seconds="$(date +%s)"

MOZ_PURGE_CACHES="${MOZ_PURGE_CACHES:-1}" "$BENTO_BIN" \
  --new-instance \
  --jsdebugger \
  "$@" \
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
