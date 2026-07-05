#!/usr/bin/env bash
# scripts/dev-profile-clean.sh
#
# Make .bento-dev-profile look "fresh" to Firefox on every launch
# while preserving the files that hold real user data. Solves the
# long tail of stale-state issues (background pages cached in
# lazy mode, ExtensionsUI observers not re-subscribed, etc.) that
# otherwise make `pnpm run dev` behave differently from
# `pnpm run dev:fresh`.
#
# Strategy: hardcoded allowlist of files/dirs to keep. Everything
# else under .bento-dev-profile/ gets deleted before each launch.
# Firefox then re-creates extension caches, observer wiring, etc.
# from scratch — same path `dev:fresh` takes — but the allowlist
# carries forward bookmarks, history, sessions, passwords, and
# extension storage.
#
# To preserve more state, add a glob to KEEP. To force a wipe of
# something currently kept, remove it from KEEP.

set -euo pipefail

PROFILE="${BENTO_DEV_PROFILE:-.bento-dev-profile}"

if [ ! -d "$PROFILE" ]; then
  mkdir -p "$PROFILE"
  exit 0
fi

PROFILE_LOCK="$PROFILE/.parentlock"
if { [ -e "$PROFILE_LOCK" ] || [ -L "$PROFILE_LOCK" ]; } &&
  command -v lsof >/dev/null 2>&1 &&
  lsof "$PROFILE_LOCK" >/dev/null 2>&1; then
  echo "dev-profile-clean: $PROFILE appears to still be in use" >&2
  echo "dev-profile-clean: quit Bento and wait for it to exit before running pnpm run dev again" >&2
  exit 1
fi

# User data we WANT to persist between launches.
KEEP=(
  # Browser identity / certs / passwords
  "key4.db"
  "cert9.db"
  "logins.json"
  "logins-backup.json"
  # History + bookmarks
  "places.sqlite"
  "places.sqlite-wal"
  "places.sqlite-shm"
  "favicons.sqlite"
  "favicons.sqlite-wal"
  "favicons.sqlite-shm"
  "bookmarkbackups"
  # Tabs / sessions
  "sessionstore.jsonlz4"
  "sessionstore-backups" # runtime crash-recovery files are pruned below
  "sessionCheckpoints.json"
  # Cookies + permissions
  "cookies.sqlite"
  "cookies.sqlite-wal"
  "cookies.sqlite-shm"
  "permissions.sqlite"
  "permissions.sqlite-wal"
  "permissions.sqlite-shm"
  "content-prefs.sqlite"
  "content-prefs.sqlite-wal"
  # Containers / search
  "containers.json"
  "search.json.mozlz4"
  "handlers.json"
  # User prefs
  "prefs.js"
  "user.js"
  # Extension storage (Bento workspace data + any installed addon's storage)
  "storage"
  "storage.sqlite"
  "storage.sqlite-wal"
  "storage.sqlite-shm"
  "storage-sync-v2.sqlite"
  "storage-sync-v2.sqlite-wal"
  "storage-sync-v2.sqlite-shm"
  "browser-extension-data"
  # Saved web form data
  "formhistory.sqlite"
  "formhistory.sqlite-wal"
  "autofill-profiles.json"
  # Installed addons + the metadata that records which are enabled and
  # what permissions they've been granted. Bento's panel layout lives in
  # bento-tools' storage.local (IDB under storage/default/moz-extension+++<UUID>),
  # and the UUID-to-extension binding lives in these registration files.
  # Wiping them de-associates the IDB from the extension, so panels lose
  # their persisted state. The "Connecting..." + AMO popup bugs that
  # originally motivated wiping these are now handled at chrome boot by
  # ensureBentoExtensionsAlive() and ensureExtensionsUIObservers() in
  # src/browser/base/content/bento-shell-mount.js — so it's safe to keep.
  "extensions"
  "extensions.json"
  "extension-preferences.json"
  "extension-settings"
  "extension-settings.json"
  "extension-store"
  "extension-store-menus"
  # NOT kept: "addonStartup.json.lz4", "addons.json".
  # These are runtime caches (pre-resolved manifest, addon discovery list).
  # When pnpm run import rewrites bento-{shell,tools}/dist/background.js
  # without bumping manifest version, the cached startup info points at
  # stale internal state and the bg load races to:
  #   "Message manager was disconnected before receiving
  #    Extension:BackgroundViewLoaded"
  # Wiping the cache forces Firefox to re-resolve from disk (extensions.json
  # is the canonical DB and is preserved, so addon UUIDs + grants survive).
  # Chrome window state — sidebar widths, window position, toolbar
  # customization. Without this, every launch resets window geometry.
  "xulstore.json"
  # Newer logins DB (Firefox is mid-migration from logins.json).
  "logins.db"
  # Network / security state worth keeping across launches.
  "AlternateServices.bin"
  "SiteSecurityServiceState.bin"
  "pkcs11.txt"
  # Tracking-protection + bounce-tracking state.
  "protections.sqlite"
  "protections.sqlite-wal"
  "protections.sqlite-shm"
  "bounce-tracking-protection.sqlite"
  "bounce-tracking-protection.sqlite-wal"
  "bounce-tracking-protection.sqlite-shm"
)

# Build a find-prune expression: "! -path PROFILE -path P1 -path P2 ..."
FIND_PRUNE_ARGS=("$PROFILE")
for k in "${KEEP[@]}"; do
  FIND_PRUNE_ARGS+=("-path" "$PROFILE/$k" "-prune" "-o")
done

# Walk the profile, skipping anything under the kept paths, and snapshot the
# delete list before removing anything. Deleting while find is still traversing
# the same tree can make find race with rm and exit nonzero under pipefail.
DELETE_LIST="$(mktemp)"
trap 'rm -f "$DELETE_LIST"' EXIT

if ! find "${FIND_PRUNE_ARGS[@]}" -mindepth 1 -print0 >"$DELETE_LIST"; then
  echo "dev-profile-clean: failed to scan $PROFILE" >&2
  exit 1
fi

while IFS= read -r -d '' f; do
  rm -rf "$f"
done <"$DELETE_LIST"

# Fresh marker: Firefox uses .startup-incomplete to detect crash
# recovery. Always remove it so we don't get the "didn't quit
# properly" prompt from a previous Ctrl+C.
rm -f "$PROFILE/.startup-incomplete"
rm -f "$PROFILE/.parentlock"

# Runtime recovery files are crash snapshots. This script clears crash markers,
# so keeping those snapshots can replay stale tabs on each dev launch. Clean
# shutdown sessions still restore from sessionstore.jsonlz4.
rm -f "$PROFILE/sessionstore-backups/recovery.jsonlz4"
rm -f "$PROFILE/sessionstore-backups/recovery.baklz4"

# If there is no clean shutdown session, do not fall back to an older backup.
# That old backup can keep resurrecting tabs the user already removed during a
# later interrupted dev run.
if [ ! -f "$PROFILE/sessionstore.jsonlz4" ]; then
  rm -f "$PROFILE/sessionstore-backups/previous.jsonlz4"
  rm -f "$PROFILE/sessionCheckpoints.json"
fi

echo "dev-profile-clean: kept ${#KEEP[@]} entries, wiped the rest from $PROFILE"
