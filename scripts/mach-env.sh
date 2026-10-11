#!/usr/bin/env bash

# Puts a Python for mach first on PATH. BENTO_MACH_PYTHON (a python3 binary or
# its directory) wins; otherwise python3.12 from PATH if present; otherwise mach
# uses whatever python3 PATH resolves (mach needs Python 3.9 or newer).
bento_setup_mach_env() {
  local python_hint="${BENTO_MACH_PYTHON:-}"
  local python_bin_dir=""

  if [ -n "$python_hint" ]; then
    if [ -d "$python_hint" ]; then
      python_bin_dir="$python_hint"
    else
      python_bin_dir="$(dirname "$python_hint")"
    fi
  elif command -v python3.12 >/dev/null 2>&1; then
    python_bin_dir="$(dirname "$(command -v python3.12)")"
  fi

  if [ -n "$python_bin_dir" ]; then
    export PATH="$python_bin_dir:$PATH"
  fi

  unset CLAUDECODE CODEX_SANDBOX GEMINI_CLI OPENCODE
}
