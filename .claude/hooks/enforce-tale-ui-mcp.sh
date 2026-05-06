#!/usr/bin/env bash
# Bento Browser — Tale UI MCP enforcement hook (PreToolUse on Write|Edit)
#
# Blocks any Write/Edit on a Tale UI surface unless an mcp__tale-ui__* tool
# has been called at least once in the current Claude Code session.
#
# A "Tale UI surface" is either:
#   1. a source file inside extensions/bento-shell/src/{components,features,theme}, OR
#   2. any source file (tsx/ts/jsx/js/mjs/css/html) whose new content imports from @tale-ui/*.
#
# Non-source extensions (md, json, patch, sh, etc.) are always allowed — this
# avoids false positives on docs that mention @tale-ui imports as examples.
#
# Hook input is JSON on stdin (PreToolUse schema).

set -uo pipefail

INPUT=$(cat)

# If jq is missing, allow rather than block — broken hook shouldn't brick edits.
if ! command -v jq >/dev/null 2>&1; then
  echo "enforce-tale-ui-mcp.sh: jq not found on PATH; allowing without check" >&2
  exit 0
fi

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""')
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""')

# Defensive: matcher should already restrict to Write|Edit
case "$TOOL_NAME" in
  Write|Edit) ;;
  *) exit 0 ;;
esac

# Only enforce on source-code extensions
case "$FILE_PATH" in
  *.tsx|*.ts|*.jsx|*.js|*.mjs|*.css|*.html) ;;
  *) exit 0 ;;
esac

# Get the new content for content-based detection
# Write uses tool_input.content, Edit uses tool_input.new_string
NEW_CONTENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // ""')

# Decide whether this is a Tale UI surface
is_ui=0
case "$FILE_PATH" in
  */extensions/bento-shell/src/components/*) is_ui=1 ;;
  */extensions/bento-shell/src/features/*)   is_ui=1 ;;
  */extensions/bento-shell/src/theme/*)      is_ui=1 ;;
esac

if [[ $is_ui -eq 0 ]]; then
  if printf '%s' "$NEW_CONTENT" \
       | grep -qE "^[[:space:]]*(import|from)[[:space:]]+.*['\"]@tale-ui/"; then
    is_ui=1
  fi
fi

# Not a Tale UI surface — allow
if [[ $is_ui -eq 0 ]]; then
  exit 0
fi

# Has any mcp__tale-ui__* tool been called in this session?
# We intentionally use plain `grep` (not `grep -q`) and read the result into
# a variable: `grep -q` exits early on first match, which delivers SIGPIPE
# to `jq`. With `set -o pipefail` enabled, that turns the pipeline's exit
# status non-zero — and `if` then sees the check as failure even though a
# match WAS found. Reading all of grep's output into a variable lets jq
# finish naturally, regardless of how many matches the transcript holds.
mcp_called=0
if [[ -n "$TRANSCRIPT_PATH" && -f "$TRANSCRIPT_PATH" ]]; then
  matches=$(jq -rc '
        select(.message.content? // [] | any(.type == "tool_use"))
        | .message.content[]
        | select(.type == "tool_use")
        | .name
      ' "$TRANSCRIPT_PATH" 2>/dev/null | grep -E '^mcp__tale-ui__' || true)
  if [[ -n "$matches" ]]; then
    mcp_called=1
  fi
fi

if [[ $mcp_called -eq 1 ]]; then
  exit 0
fi

# Block with an actionable error
jq -nc --arg path "$FILE_PATH" '
{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: (
      "Bento UI rule: this Write/Edit on " + $path
      + " touches a Tale UI surface, but no mcp__tale-ui__* tool has been called in this session.\n\n"
      + "You MUST consult the Tale UI MCP first:\n\n"
      + "  1. Call ToolSearch with query \"select:mcp__tale-ui__plan_ui,mcp__tale-ui__get_component\" to load the tool schemas (mcp__tale-ui__* tools are deferred — schemas must be loaded before invoking).\n"
      + "  2. Call mcp__tale-ui__plan_ui with a description of the UI you intend to build — it returns the right components, the matching recipe (if any), and key pitfalls.\n"
      + "  3. For each Tale UI component you intend to use, call mcp__tale-ui__get_component to fetch exact props (allowedValues arrays for variants, sizes, etc.).\n\n"
      + "Then retry this Write/Edit. After one successful mcp__tale-ui__* call this session, the hook stops enforcing. See CLAUDE.md § \"UI Components (@tale-ui/react)\" for the full workflow."
    )
  }
}'
exit 0
