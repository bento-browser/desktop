# Manual Browser Session Merge

Part of the [technical notes index](../core-functionality-technical.md).

Manual browser-session merge is a runtime additive import, separate from the
startup Firefox/Zen profile-copy migrator. The user opens it from one of three
places, and all of them end in the mount script's `showMergePalette()`
(`src/browser/base/content/bento-shell-mount.js`):

- the command palette's "Merge browser session" command (Actions group), which
  writes `BENTO_OPEN_MERGE_PALETTE_<timestamp>` into the palette overlay
  document's title; the palette frame's title handler routes it to
  `showMergePalette()`, which dismisses the command palette first, and the
  palette's own close title that follows only hides an already hidden overlay;
- the "Merge browser session" row in the "Backup and data" group of the Settings
  palette (hidden in private windows like the other backup rows): its document
  writes `BENTO_OPEN_MERGE_PALETTE_<timestamp>` and the Settings frame's title handler
  routes it to `showMergePalette()`, which dismisses the Settings palette; and the
  button of the same name on the native Bento Settings page (patch 15, still
  reachable by URL, hidden in private windows like the neighbouring backup buttons),
  which dispatches a `BentoOpenMergePalette` `CustomEvent` on
  `window.browsingContext.topChromeWindow`, read at click time because a Settings
  tab keeps its document when moved to another window. The mount script of that
  window listens for the event, so the palette opens over the window that holds
  the tab. No observer is registered, so there is nothing to remove on window
  close;
- the sidebar merge progress card (see "Sidebar progress card"), which signals the
  same `BENTO_OPEN_MERGE_PALETTE_<timestamp>` title from the shell frame to
  reopen the progress view. The footer has no merge button, idle or running.

Chrome shows the
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
read; a second `preparing` event follows once the session is read and normalized,
and every progress event from then on carries `sourceName` (the browser, from the
normalized session) for documents that never listed the sources. Once
`ExternalMergeExecutor` has built its filtered import plans, progress
events carry the real workspace and tab totals, processed counts
(`completedTabs`, every tab the import has looked at, including ones it skipped or
that failed), `importedTabs` (the tabs it actually opened, the executor's
`summary.tabsOpened` at that moment; typed optional only because the archived rollback
tools, which `pnpm run rollback:check` type-checks against the live shared protocol,
predate it, and the shell then falls back to `completedTabs`), the current workspace
name, and optional workspace/site activity. The shell store accepts
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
work and avoids activating/focusing the partial import as a completed merge. A tab
being created when the cancel lands still finishes and is reported by the next
progress event, which the handler forwards after the `cancelled` error (tested in
`protocol-handler.test.ts`); the shell's cancelled count depends on that event.

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

Native and overlay backup operations run in `SettingsDomainService` (see
[privacy-search.md](privacy-search.md)); the ordinary `backup/*` shell-port
handlers remain until the native pane is removed, but nothing dispatches them and
they lack the coordinator, size bounds, operation records and private-caller
check. The service enforces the contract bounds (`backupFileBytes` for a file or
an export in UTF-8 bytes, `workspaceCount` and `sourceIdCodeUnits` for the ids
of a partial export) and answers `payload_too_large`, `schema_invalid` and
`token_invalid`. A validation token is bound to the document and window that
previewed the file, expires after five minutes, is single use, and a document
keeps one at a time (a new preview replaces its earlier token; expired tokens
are pruned on each preview). `importValidated` and `restore` consume the token or
read the stored backup only after the operation is reserved, so retrying with the
same operation id replays the retained result even when the token was spent or the
backup has since been deleted. An import or restore stays `partial`, with the
failed components in the retained result, when its privacy or search effect did
not apply. If the process dies mid-import, `GraphOperationRecovery` rolls back
before publication or finishes after it, and always clears the journal and the
cached source file once it has recorded the outcome, so a later import is never
refused with `graph_reserved`. Regression checks: restore a backup, delete it, and
retry the same operation id (it replays); import a file whose settings carry a
privacy level while the privacy API is failing (the operation is `partial`);
kill the background mid-import and confirm the next import starts.

Native Settings observer envelopes cross from Firefox chrome into the tools
experiment, so the experiment normalizes the data-only envelope into its own
realm before applying strict plain-object validation. Privileged Settings pages
can reject `sessionStorage` writes; in that case the resumable session tuple is
stored as serialized data on the owning tab's browser element, which preserves
per-tab reload identity without sharing it with another Settings tab. A resumed
hello rotates the token and resets that new document generation's replay
sequence before authenticated requests begin. The tools service binds each
session to the browser window it was issued for and answers a request from
another window with `invalid_session`. A Settings tab torn out or dragged to
another window keeps its document and the session it holds in memory, but the
document's top chrome window changes, so every later request was refused and the
page never recovered. `BentoNativeModel.ensureSession` therefore remembers the
window its live session was issued in (`hostChromeWindowId`) and says hello
again, before sending, whenever the document's window differs; the service
answers a hello that names another window with a fresh session for the same
client, so operations the client owns stay reachable. A hello answers for the
window it was sent from, and the tab can move while one is in flight (requests
share the pending hello), so `ensureSession` checks the window again after each
hello and repeats it, up to `MAX_HELLO_ATTEMPTS`, before it sends anything. When
the attempts run out it rejects with `invalid_session` instead of sending a
token the service would refuse. Do not reuse a session across windows by
relaxing the service's window check. `scripts/native-preferences-model.test.mjs`
runs the model extracted from patch 15 against a fake service with that window
binding.

When `replaceExisting` is enabled, import must create the replacement workspaces
and tabs before removing old workspace tabs. Removing old tabs first can close
the only browser window during `pnpm run dev`, terminating the running Bento
browser before the import can repopulate it. If a replacement export contains an
empty workspace with no imported tabs or panels, create an `about:blank` tab in
that imported workspace before removing old tabs so Firefox never observes an
empty window.

## Sidebar progress card

`components/MergeProgressCard` (a layer-2 component, with its Ladle stories) shows a
running merge and its outcome in the sidebar. `components/SidebarCards` holds it:
a bottom-aligned container laid over the end of the tab list inside
`.bento-shell-app__list-region` (`App.tsx`), above the footer rail. The container
measures its cards (a `ResizeObserver` in `cardsInset.ts`) and writes the reach,
card height plus the offset above the footer and the gap below the last row, to
`useSidebarCardsStore.inset`. `TabList` passes it to the virtualizer as `paddingEnd`
and `scrollPaddingEnd`, so the last rows scroll clear of the card and a row scrolled
into view stops above it; with no card the inset is 0. The card keeps one minimum
height for every state, so the list does not move when the third line appears.

Source of truth is tools, and the card reads the shell's `externalMerge` mirror. The
mirror gains two fields only for display: `activeSourceName` (the browser name,
from the optional `sourceName` that tools adds to every `externalMerge/progress`
event once it has read the session, because the sidebar document never lists the
sources) and `result`, a small snapshot of how the merge ended (`done` with the tab
and space counts, `cancelled` with the tabs added and how far it got, `failed` with
one sanitized line). A cancelled merge's "N tabs added" is the last event's
`importedTabs`, never `completedTabs`: a cancel reports as an error with no summary,
and the processed count overstates what was added whenever duplicates or unsupported
URLs were skipped. Tools emits the cancel at once so the card responds immediately,
but a tab already in flight still opens, and the executor reports it with a progress
event (with the settled `importedTabs`) that tools forwards after the `cancelled`
error. The cancelled result remembers its `operationId`, and `applyProgress` lets a
later event for exactly that operation raise `tabsAdded`, never lower it; events for
any other operation or window are ignored, and the in-flight tab never shows as a
missing count or "No tabs added". `applyComplete` and `applyError` write the result
before they clear `progress`; `startMerge` and `applyStarted` clear it, so a new merge
replaces a lingering result and a late event for the old one finds nothing to raise;
`dismissResult()` clears it too; closing or reopening the palette leaves it alone. It
is transient shell state, lost on a shell reload.

`mergeProgressCardModel` (pure, tested) maps the store to the card: preparing ("Preparing
import", the source as detail, a still ring at 0), importing ("Importing from
<browser>", "<space>, X of Y tabs", the last site's hostname), finalizing ("Finishing
import"), done ("Imported N tabs", "From <browser>, M spaces"), cancelled ("Import
cancelled", "N tabs added", a muted partial ring) and failed ("Import failed", the
reason). The ring is a Mux `ProgressCircle` with a value, never the indeterminate
spinner. The percentage sits inside it while the ring is partial. The card shows in
the windows where the store sees the merge, which are the window that started it
(events carry its window id; an event without one reaches every window).

The whole card is one Mux `Button` (Enter and Space activate it, and a click anywhere
opens the merge palette); the dismiss `IconButton` ("Dismiss", shown for a finished
merge) is its sibling, not nested in it. The button is named by the title and
described by the detail and host lines, so a screen reader reads the counts when the
card is focused. A visually hidden `role="status"` region announces the stage or the
outcome and carries no counts, so it speaks on a stage change and not on each tab.
The card enters on the `reveal` role and leaves on `dismiss` (`useCardPresence` waits
for the fade with `afterMotion`); reduced motion keeps the fade and drops the slide.

In the narrow rail the card is a 36 px round ring button above the footer. The text
and the dismiss button are hidden, and activating a finished card opens the merge
palette and clears the card. Its title and detail show in the chrome-side panel
navigator tooltip overlay beside the ring, on hover (after the overlay's 400 ms
delay) and on keyboard focus (at once), through a `BENTO_RAIL_TOOLTIP` title (see
"Tooltip document" in [overlay-documents.md](overlay-documents.md)). A Mux `Tooltip`
cannot render in the shell instead: the rail's frame is about 52 px wide and the
tooltip wraps to the frame, one word per line. The card carries no native `title`.

The card is drawn in the opposite colour scheme to the sidebar: a dark card on a light
sidebar, a light card on a dark one. `MergeProgressCard` spreads
`useInvertedThemeScope()` (`theme/useInvertedThemeScope.ts`) on its root, which is
`getThemeScopeAttributes(<active workspace theme>, <opposite of useResolvedColorScheme()>)`
and registers the theme's sheet, so `data-muxui-theme`, `data-muxui-color-scheme` and
`data-muxui-contrast` sit together on the card and Mux semantic tokens resolve in the
inverted scheme for everything inside it. It flips live with the colour mode, Auto
included (the hook watches `data-color-mode` on `<html>`). The card's stylesheet
reads only Mux semantic tokens (`surface-raised`, `content-default`, `content-muted`
for the detail and the hostname, `content-strong` for the finished check,
`border-default`, `color-color-60` for the ring, `status-warning` for a failed one);
`--bento-merge-card-ring-color` is declared on the card's own `data-kind` selector, and
the former `--bento-merge-card-failed-color` on `:root` is gone because a `:root`
declaration would have kept the page's colour. Shadows are the exception: they are
resolved on the page-scope `.bento-sidebar-cards` container
(`--bento-sidebar-card-shadow*`) so they stay the page's. Mux's elevation shadows are
the same translucent black in both schemes, so the light card on the dark sidebar
casts an effectively invisible shadow and the dark card on the light sidebar a soft
one. The tooltip is a separate overlay document and stays in the page's mode. Measured
contrast against the card surface: title 11.2:1 on the dark card and 10.3:1 on the
light one; detail and hostname 7.1:1 and 5.8:1 (the hostname was `content-faint`, which
is 4.3:1 on the light card, and is now `content-muted`). Graphics: the accent ring arc is
4.1:1 on the dark card and 7.4:1 on the light one; a failed ring and icon
(`status-warning`) is 6.2:1 on the dark card and 2.1:1 on the light card, below the 3:1
a graphic wants. The text beside it names the state, and `feedback-invalid` (Mux's
mode-aware red) is the available swap if that needs raising.

While a card shows, the sidebar search results list is padded by the same inset (see
[workspaces.md](workspaces.md)), so its last result scrolls clear of the card too.
