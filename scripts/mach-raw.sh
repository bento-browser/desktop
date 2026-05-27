#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=scripts/mach-env.sh
. "$REPO_ROOT/scripts/mach-env.sh"
bento_setup_mach_env

cd "$REPO_ROOT/engine"
exec ./mach "$@"
