#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
case "${1:-}" in
  help|-h|--help|--version) ;;
  *) node "$REPO_ROOT/scripts/bento-build.mjs" preflight ;;
esac

# shellcheck source=scripts/mach-env.sh
# shellcheck disable=SC1091
. "$REPO_ROOT/scripts/mach-env.sh"
bento_setup_mach_env

cd "$REPO_ROOT/engine"
exec ./mach "$@"
