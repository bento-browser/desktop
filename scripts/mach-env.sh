#!/usr/bin/env bash

bento_setup_mach_env() {
  local python_hint="${BENTO_MACH_PYTHON:-}"
  local python_bin_dir=""

  if [ -n "$python_hint" ]; then
    if [ -d "$python_hint" ]; then
      python_bin_dir="$python_hint"
    else
      python_bin_dir="$(dirname "$python_hint")"
    fi
  elif [ -x "/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3" ]; then
    python_bin_dir="/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin"
  elif command -v python3.12 >/dev/null 2>&1; then
    python_bin_dir="$(dirname "$(command -v python3.12)")"
  fi

  if [ -n "$python_bin_dir" ]; then
    export PATH="$python_bin_dir:$PATH"
  fi

  unset CLAUDECODE CODEX_SANDBOX GEMINI_CLI OPENCODE
}
