#!/usr/bin/env bash
# Launch Bento for local dev without turning browser/devtools shutdown into a
# pnpm lifecycle failure. Missing build products still fail before launch.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit

# Launch the app in the object directory the build driver selects (BENTO_OBJDIR,
# else engine/obj-bento, else a single legacy engine/obj-*). It exits with an
# error when the choice is ambiguous; with no object directory yet, the
# missing-executable check below reports it.
if [ -z "${BENTO_BIN:-}" ]; then
  OBJ_DIR="$(node "$REPO_ROOT/scripts/bento-build.mjs" objdir --allow-missing)" || exit 1
  BENTO_BIN="${OBJ_DIR:+$OBJ_DIR/dist/Bento.app/Contents/MacOS/bento}"
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
  echo "dev-launch: missing executable ${BENTO_BIN:-in engine/obj-bento}; run a full build first" >&2
  exit 1
fi

start_seconds="$(date +%s)"

launch_args=(--new-instance)
if [ "${BENTO_JSDEBUGGER:-0}" = "1" ]; then
  launch_args+=(--jsdebugger)
fi
launch_args+=("$@" --profile "$PROFILE")

MOZ_PURGE_CACHES="${MOZ_PURGE_CACHES:-1}" "$BENTO_BIN" \
  "${launch_args[@]}"
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
