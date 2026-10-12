# Manual Browser Session Merge

Part of the [technical notes index](../core-functionality-technical.md).

Manual browser-session merge is a runtime additive import, separate from the
startup Firefox/Zen profile-copy migrator. The user opens it from the sidebar
footer, which signals `BENTO_OPEN_MERGE_PALETTE_<timestamp>` to
`src/browser/base/content/bento-shell-mount.js`. Chrome shows the
`bento-merge-palette-host` overlay, creates `merge-palette.html` on the first
open (see "Overlay documents") and keeps it mounted between opens, and sends an
open nonce, once the document is ready, into the extension frame with
`messageManager.sendAsyncMessage("BentoMergePaletteLifecycle", ...)`. The frame
script posts that nonce on `BroadcastChannel("bento-merge-palette")`, and the
React entry dispatches a fresh `externalMerge/requestSources` for every open.
React mount is not the refresh boundary. The palette search row also exposes a
refresh button that dispatches a new `externalMerge/requestSources` request
through the same store path while keeping the current source rows visible until
the replacement response arrives; refresh is disabled while a merge operation is
active. While `activeOperationId` is set, the shell renders an opaque absolute
overlay inside the Mux UI command palette popup. The overlay covers the search,
source rows, footer, and close control, names the source being imported, and
shows an indeterminate `ProgressBar` plus Close and Cancel buttons. The Close
button hides the palette without cancelling the active import, and the Cancel
button dispatches `externalMerge/cancel` for the active `operationId`. Backdrop
dismissal and `onOpenChange` close handling are disabled while that in-palette
merge overlay is active.
`externalMerge/started` is followed by `externalMerge/progress` events. The
first progress event uses the `preparing` stage while the privileged snapshot is
read. Once `ExternalMergeExecutor` has built its filtered import plans, progress
events carry the real workspace and tab totals, processed counts, the current
workspace name, and optional workspace/site activity. The shell store accepts
only progress for its active operation, retains the latest progress snapshot,
and keeps the latest 100 activity entries. The overlay switches its Mux UI
`ProgressBar` to a determinate percentage, shows completed/total spaces and
sites, and auto-scrolls an accessible activity log containing imported site
titles and hostnames. Completion, cancellation, error, and a new operation clear
the progress snapshot and log.
The source list renders source cards instead of selectable command rows: source
cards start collapsed and expose Import all plus expandable target cards for
native spaces or windows. Target cards also start with their tab previews
collapsed; expanding them shows up to 10 tab previews and an "X more tabs"
overflow line, and their Import button dispatches `externalMerge/merge` with
`targetIds`. Merge completion does not start an auto-close timer; only the Close
button, backdrop dismissal, or chrome close lifecycle should hide the palette.

`extensions/bento-tools/experiments/bento-external-sessions/` is the privileged
source reader. It discovers Firefox profiles from the Mozilla Firefox
`profiles.ini`, Zen profiles from macOS `~/Library/Application Support/zen`, and
Chromium-family profile roots for Chrome, Chromium, Brave, Edge, Opera, and
Vivaldi. Firefox and Zen discovery must also scan both the profile root and its
`Profiles/` child directly. macOS app/privacy behavior can make registry-based
discovery differ from direct directory reads, and both Firefox and Zen store real
profiles below `Profiles/<profile-id>`. It returns opaque source ids,
browser/profile labels, and modified times only. It reads Firefox/Zen `jsonlz4`
snapshots as decoded JSON strings and Chromium session files as base64 bytes. It
does not return absolute paths, and unreadable or stale source ids produce
sanitized errors.

Chromium discovery and Chromium snapshot reads are intentionally separate
operations. Discovery uses directory traversal plus `IOUtils.stat()` to find
`Sessions/Session_*` and `Sessions/Tabs_*` files and compute the "saved x
minutes ago" age from file metadata. Snapshot loading later calls
`IOUtils.read()` for the file bytes, with an `nsIFileInputStream`/`NetUtil`
fallback for Chromium session files. On macOS those can fail independently:
Bento can see that Chrome session files exist and have fresh mtimes while still
being denied byte reads for every file. In that case the source remains visible
as disabled with "Session files visible, but unreadable"; when the parent reader
can classify the failure, a sanitized category such as "permission denied",
"file locked", or "file missing" is appended without exposing local paths. If
the error does not map to a known category, the row may show sanitized Gecko
error names/results such as `NotAllowedError:0x80520015`; these tokens are for
debugging and must not include local paths. Do not interpret the fresh saved age
as proof that the manual merge reader can parse Chrome.
Chromium session payloads are binary; encode them with code that runs in the
privileged parent-extension context rather than relying on DOM globals such as
`btoa`, which may be absent even though the same code path can list and read
the files.

Parsing is bundled in `extensions/bento-tools/src/externalMerge/`, not in the
experiment parent script. `normalizeExternalSession()` converts raw snapshots to
a browser-neutral shape of source metadata, optional native workspaces, windows,
tabs, and tab groups. Firefox normalization imports only open `windows`, selects
only each tab's current `entries[index - 1]` entry, and excludes private/hidden
tabs and windows. Zen normalization maps spaces to native workspaces and applies
the same live visible-tab filtering. Zen tab folder membership can appear as
Firefox-style `extData.tabGroupId`, object-shaped `group` / `folder` fields,
numeric ids, keyed `folders`/`tabFolders` object maps, folder-owned member lists
such as `tabs`/`children`, or Zen-specific folder fields, so the reader must
preserve those fields and the parser must normalize them to the same string id
used by the group definition.
Confirmed Zen folder import regression fix, 2026-06-24: if the manual Zen merge
shows group/folder counts but imported Bento workspaces contain only ungrouped
tabs, the Zen session probably stores folder membership on the folder object
instead of each tab. Keep the reader preserving keyed folder maps and member
lists, and keep the parser's fallback from tab ids/uuids to folder membership
maps before creating Bento folders.
Confirmed Zen folder import regression fix, 2026-06-24: if Zen folder children
import as normal pinned Bento tabs instead of Bento folder members, check whether
the Zen session marks those folder children with `pinned: true`. The Zen parser
must prefer resolved folder membership over generic pinned state so those tabs
remain eligible for `TabFolderStore` folder creation; only `zenEssential` tabs
stay pinned when they also carry Zen's pinned flag. Chromium normalization uses
a dedicated persisted-session parser. For modern `SNSS` session files, it
reconstructs live tabs from Chromium session commands, using `SetTabWindow`,
tab/window close, selected-navigation, and navigation-update records; it must
not count every URL string in
`Session_*` or `Tabs_*` files, because those files also contain history entries,
stale rotated records, and closed tab data. When grouped Chromium metadata is
detected but cannot be safely mapped, the source is reported as an unsupported
session rather than silently importing grouped tabs as ungrouped.
Confirmed Chrome tab-count regression fix, 2026-06-24: if Chrome shows a source
such as "1 window - 164 tabs" while the visible Chrome profile has only a small
number of live tabs, the parser is probably counting raw URL strings from
`Tabs_*`/rotated session files instead of reconstructing live tabs from `SNSS`
commands. Keep the explicit parser regression test that feeds stale URL strings
beside a newer `Session_*` command log; the expected count is one selected live
navigation per surviving live tab, not one tab per URL string.

`loadExternalMergeSources()` calls the experiment's `listCandidates()`, reads
each candidate snapshot, normalizes it in bundled tools code, and derives the
shell-visible `ExternalMergeSource` counts from importable live windows, tabs,
and groups. It also derives source target metadata from the same normalized
session: native workspaces/spaces become `workspace:<id>` targets, otherwise
windows become `window:<id>` targets. Each target carries tab/group/window
counts and the first 10 importable tab previews for the shell; tools does not
send every tab title for large sessions. Empty, corrupt, unreadable,
private-only, or unsupported candidates remain visible as disabled source rows
with a sanitized reason, even when other sources are mergeable. Do not drop
failed candidates only because a readable Firefox or Zen source exists; users
still need to see that Chrome was found but could not be read. Confirmed
mixed-result regression fix, 2026-06-24: the merge palette must show mergeable
Firefox/Zen rows and a disabled Chrome row together when Chromium session
discovery succeeds but session file reads fail.

Merge execution lives in
`extensions/bento-tools/src/externalMerge/ExternalMergeExecutor.ts`. It builds a
normalized URL set from Bento-owned tabs plus panel tab ids, using live URLs from
`browser.tabs.query({})`. URL normalization lowercases protocol/host, removes
default ports, preserves path/query/hash, recognizes source new-tab URLs as
`about:newtab`, and rejects invalid, `javascript:`, `data:`, and unsupported
browser-internal schemes. Merge planning omits recognized new-tab pages because
Firefox cannot create `about:` pages already discarded; importing an empty
source new tab is not worth waking content during a bulk merge. Duplicates are
skipped against existing Bento state
and earlier tabs in the same merge. If filtering leaves no importable tabs, the
executor throws `ExternalMergeError("no-importable-tabs", ...)` before creating
workspaces so duplicate-only sources produce a visible no-op message instead of
an apparent hung import. Tab creation is also bounded by a timeout; if Firefox
or another source produces a valid plan but WebExtension tab creation never
resolves, the executor removes the temporary empty workspace and reports a
visible no-op failure instead of leaving the palette in a permanent merging
state.
Confirmed Firefox manual-merge hang fix, 2026-06-24: a Firefox source can list
and normalize correctly but leave the merge palette open if a WebExtension tab
operation never resolves. Do not await the final imported-tab focus update, and
keep the timeout around `browser.tabs.create()` so valid Firefox snapshots either
finish with a visible summary or fail with a visible no-op error.

The executor creates a Bento workspace only when at least one source tab
survives filtering. Native source workspaces/spaces become one Bento workspace
each; otherwise each source window becomes one workspace. Workspace names use
`<Browser>: <Workspace name>` or `<Browser>: <Profile name> Window <n>` and the
same collision behavior as backup import (`name`, `name (imported)`, then
numeric suffix). When `externalMerge/merge` carries `targetIds`, `buildPlans()`
applies the same source-space/window grouping but keeps only matching target ids;
omitting `targetIds` imports the full source as before. Workspaces are created
with `{ activate: false }` and are not activated when the merge completes. Tabs
are created with `{ active: false, discarded: true }` in the requesting window
when known, so Firefox records their URL and source title without loading site
content. They remain asleep until the user explicitly activates the imported
space/tab. The tabs are assigned to the workspace through
`TabRegistry.assignWorkspaceEagerly`, and source-pinned tabs are pinned afterward
with `browser.tabs.update` because Firefox rejects creating a tab as both pinned
and discarded. Source tab titles are not written to
`TabRegistry.rename()` / `bento.customTitle`; imported tabs must keep using the
live Firefox tab title so later navigation through links or the floating
address bar updates the sidebar text normally. The
executor must await the eager assignment's `browser.sessions.setTabValue`
completion before counting a tab as imported; if the workspace marker cannot be
persisted, the created tab is removed and the temporary workspace is discarded
when no other tabs imported. This keeps imported workspaces from relaunching as
empty workspaces containing only a fallback new tab. Source tab groups become
`TabFolderStore` folders only for non-pinned imported members; pinned group
members stay pinned and un-foldered after source-specific parser normalization.
For Zen specifically, folder membership must be normalized before pinned status
so sidebar folder children are not misclassified as pinned members. Folder
metadata for imported groups is created with `collapsed: true` so newly imported
source folders start closed in Bento. Folder assignment uses
`TabRegistry.assignFolderEagerly()` rather than `setFolder()` because
`browser.tabs.create()` can resolve before `tabs.onCreated` has populated the
registry. If no member can persist the folder marker, the empty imported folder
is deleted. Do not focus an imported tab or activate an imported workspace at
the end of the merge: either action wakes at least one imported site and defeats
the bulk-import sleeping guarantee.
Confirmed restart-persistence regression fix, 2026-06-24: if workspaces created
by manual Chrome/Firefox/Zen merge survive a dev relaunch but their imported
tabs disappear and each workspace contains only a new tab, the merge executor is
probably reporting success before `bento.workspaceId` session values are
durable. Keep `TabRegistry.assignWorkspaceEagerly()` returning an awaitable
persistence result and keep the executor's wait before incrementing
`tabsOpened`.
Confirmed restart-persistence regression fix, 2026-06-24: if the executor waits
for `assignWorkspaceEagerly()` but imported workspaces still relaunch empty,
check the boot backfill path. `background.ts` must not call persistent
`TabRegistry.assignWorkspace()` before SessionStore tab extData settles; that
can overwrite a restored imported tab's saved `bento.workspaceId` with the
currently active workspace. Boot-time fallback assignment after
`hydrateWorkspaceIds()` must stay in-memory only, and `hydrateWorkspaceIds()`
must retry delayed session reads before that fallback runs.
Cancellation is cooperative and operation-scoped. `protocol-handler.ts` owns the
single in-flight `AbortController`, reports `ExternalMergeError("cancelled",
...)` immediately when `externalMerge/cancel` matches the active operation, and
passes the signal into `executeExternalMerge()`. The executor checks that signal
before creating new workspaces and between tab creations. It does not roll back
tabs already opened and assigned to a workspace; cancellation stops remaining
work and avoids activating/focusing the partial import as a completed merge.

All merge protocol events carry correlation fields. Source-list replies echo
`requestId` and `windowId`; merge lifecycle replies echo `operationId`,
`windowId`, and source metadata where needed. `bento-shell` filters events for
other windows and stale request/operation ids before mutating
`state/externalMerge.ts`. `protocol-handler.ts` also has a module-scoped global
in-flight guard that rejects duplicate or cross-window merge attempts with
`code: "busy"` before any `readSnapshot()` or executor work starts.

Confirmed Firefox/Zen import regression fix, 2026-06-09: if the wizard shows
blank Firefox/Zen icons, offers disabled `default` profile rows, or completes
with a warning next to `Windows and tabs` while Bento opens into only the empty
first-run `Personal` workspace, keep the fix in three places. First,
`FirefoxProfileMigrator.getSourceProfiles()` must filter profile registry rows
with `getMigrateData(profile)` so empty profile folders never become selectable
wizard options. Second, Firefox and Zen `brandImage` values must resolve to
installed macOS app bundle icons through `moz-icon://` URLs built from
`nsIFileProtocolHandler.getURLSpecFromActualFile()`, and the migration wizard
must quote those URLs when assigning `style.content` or `backgroundImage`.
Third, the Zen `SESSION` resource must write the converted Firefox session with
`IOUtils.writeJSON(targetPath, bentoState, { compress: true })` and then call
`SessionStore.setBrowserState(JSON.stringify(bentoState))` for live restore.
Using the non-exported `SessionMigration.writeState()` helper is the known
failure mode behind the `Windows and tabs` warning. The Bento extension side
must also keep the restored session markers: `bento.importedWorkspaces` for Zen
spaces, `bento.workspaceId` for tab ownership, `bento.isPanel` for essentials,
`bento.isPanel.pinnedPanel` and `bento.importPinnedPanel` so essential tabs
become pinned panels after `background.ts` consumes the restored marker. Boot
must scan existing marker-bearing tabs before clearing stale markers; relying
only on `tabs.onCreated` misses live-restored import tabs when `SessionStore`
creates them before the background script is ready. That scan must batch retry
all candidate tabs per attempt; do not call `readPanelMarkerWithRetries()` once
per tab in series. A large Zen profile can have hundreds of tabs, and serialized
per-tab retry waits block `bootReady`, leaving the sidebar stuck at
`Connecting...` while content tabs are already visible.

Confirmed welcome resume regression fix, 2026-06-09: after a successful Zen
startup import, Bento can restore the Zen tabs/workspaces correctly while the
welcome overlay still opens on the first "Welcome to Bento" step. The failed
approach was storage-only resume (`localStorage`, then `browser.storage.local`):
Firefox's startup migrator can change or invalidate the extension origin/storage
seen by the post-migration welcome frame. Keep all three resume layers. First,
`welcome/main.tsx` stores `bento-welcome-step` and sends
`BENTO_IMPORT_BROWSER_DATA_<nextStep>_<ts>` so chrome knows the exact next step.
Second, `bento-shell-mount.js` copies that step into `BENTO_WELCOME_STEP` before
`Services.startup.quit(... eRestart)`. Third, after restart, chrome consumes
`BENTO_WELCOME_STEP`, clears it, and loads the welcome frame with
`#bentoWelcomeStep=<nextStep>`. The welcome page must read that hash before
extension storage and persist it back into storage for later non-restart
navigation. Do not remove the hash path just because `browser.storage.local`
exists; the hash is the piece that survived the confirmed `pnpm run dev:fresh`
Zen import path.

Backup export/import uses schema v2 in
`extensions/bento-tools/src/backup/BackupStore.ts`,
`ImportExecutor.ts`, and the shared `extensions/_shared/export-schema.ts`
validator re-exported by both shell and tools. Manual imports are limited to
10 MB before `FileReader` allocation. The shared validator caps collection and
string sizes, validates the complete panel-layout tree and references, permits
only supported navigation URL schemes, and rejects unknown or out-of-range
settings. `SettingsStore` also rejects invalid stored or runtime settings
patches so import validation cannot be bypassed through another action path.
Every imported normal, panel, and fallback tab is created explicitly in the
authenticated Settings session's target window. Snapshot collection filters
incognito tabs before building normal-tab, panel-layout, and pinned-panel
records. New automatic backups are tagged `private-filtered-v1`; untagged or
unrecognized version-one entries are surfaced as `legacy-unknown`.
A workspace export must include the
same panel state that `PanelStore` persists for restart:

- `panels[]` with durable `panelKey`, URL, and root panel `widthPx`;
- `panelLayout` with panel keys instead of tab ids, preserving root order,
  vertical groups, horizontal split groups, chooser nodes, and clamped ratios;
- `mainWidthPx` for the workspace-scoped main content slot width;
- `stripScrollLeft` for the workspace-scoped panel-strip scroll position;
- pinned panel references by `panelKey` with URL fallback.

Import creates fresh tabs, maps exported panel keys to the new tab ids, restores
the persisted layout tree through `PanelStore.restorePersistedLayout`, and then
applies main width, strip scroll, panel widths, and pinned-panel bindings to the
new workspace. Do not export or import runtime tab ids; they are not durable
across profiles or sessions. Do not treat `panelLayout` alone as the complete
layout snapshot; workspace-level main width and strip scroll are separate
`PanelStore` state and must travel with the backup payload.

The native `#bentoBackups` subpane owns export, validation/import, restore, and
delete affordances. File selection stays in privileged Firefox UI, import files
are capped at 10 MiB, and destructive/reset actions require native confirmation.
Private sessions reject backup operations before storage lookup.

Native Settings observer envelopes cross from Firefox chrome into the tools
experiment, so the experiment normalizes the data-only envelope into its own
realm before applying strict plain-object validation. Privileged Settings pages
can reject `sessionStorage` writes; in that case the resumable session tuple is
stored as serialized data on the owning tab's browser element, which preserves
per-tab reload identity without sharing it with another Settings tab. A resumed
hello rotates the token and resets that new document generation's replay
sequence before authenticated requests begin.

When `replaceExisting` is enabled, import must create the replacement workspaces
and tabs before removing old workspace tabs. Removing old tabs first can close
the only browser window during `pnpm run dev`, terminating the running Bento
browser before the import can repopulate it. If a replacement export contains an
empty workspace with no imported tabs or panels, create an `about:blank` tab in
that imported workspace before removing old tabs so Firefox never observes an
empty window.
