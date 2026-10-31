# Privacy And Search Implementation

Part of the [technical notes index](../core-functionality-technical.md).

Privacy preset metadata, selectable level ids, browser privacy values, and
allowlisted pref maps live in
`extensions/_shared/privacy-levels.ts`. The wire contract lives in
`extensions/_shared/protocol.ts`: `privacy/setProtectionLevel`,
`privacy/setAdvanced`, `privacy/setDefaultSearchEngine`, and
`privacy/snapshot`.

`extensions/bento-tools/src/privacy/ProtectionLevels.ts` is the tools-side
runtime implementation. It applies preset `browser.privacy.*` values through the
standard WebExtension privacy API and applies non-WebExtension prefs through the
privileged `browser.bentoPrivacy` experiment. It reads the live browser snapshot,
compares it with the preset maps, and reports `custom` when any preset value
differs. Advanced settings dispatch the same path and then emit a fresh
`privacy/snapshot`.

Standard sets both `network.httpsOnlyMode='always'` and Firefox's underlying
HTTPS-only prefs; Firefox continues to own the HTTP exception interstitial and
per-site exception UI. The `network.httpsOnlyMode` write is a no-op (the setting
is read-only to extensions); the prefs are what take effect, and the HTTPS-only
advanced choice writes the same two prefs (`HTTPS_ONLY_MODE_PREFS`) and reads the
mode back through the `browser.privacy` getter.

Shutdown clearing is `SHUTDOWN_CLEAR_PREFS` in `privacy-levels.ts`: the master
`privacy.sanitize.sanitizeOnShutdown`, the `privacy.clearOnShutdown_v2.*` item
prefs (cookies and storage, cache on; history and downloads, form data, site
settings off) and `privacy.sanitize.clearOnShutdown.hasMigratedToNewPrefs3`.
Hardened includes it as a whole and the advanced switch writes it when turned on;
turning the switch off, Standard and Enhanced write only the master pref `false`.
Hardened also sets `network.http.referer.XOriginPolicy` 2 and
`dom.security.https_only_mode_send_http_background_request` false; Standard and
Enhanced write Firefox's defaults (0 and true) so a step down undoes them, and
detection reads all of them.

The switch and the HTTPS-only choice change several prefs together, so
`applyAdvancedSetting` writes them with `writePrefsVerified` (read every pref back)
and `PrivacyMutationService.setAdvanced` takes `snapshotAdvancedPrefs(key)` before
the write and restores it on any failure.

There is no migration for profiles that turned the switch on under the old build.
They keep Firefox's broader clearing (history, downloads and form data as well as
cookies, site data and cache) until the switch is turned off and on once, which
writes the whole bundle. A profile on Hardened is fixed by the boot apply: with a
stored `privacyProtectionLevel` override, `background.ts` re-applies that preset
at every boot, and Hardened's preset includes `SHUTDOWN_CLEAR_PREFS`. A one-time
startup repair was tried and removed: it could not tell the old switch's leftovers
from a custom setup without reading the legacy `privacy.clearOnShutdown.*` prefs
too, and a locked migration flag made a failed repair look complete.

A fresh profile starts on Standard: `seedBootPrivacyLevel` (`BootPrivacyDefault.ts`)
applies the stored default on a profile's first launch only, the launch where
`WorkspaceStore.init()` found nothing persisted (`workspaces.firstLaunch`), and only
when `privacyProtectionLevel` has no override. That launch persists the first
workspace (after a 500 ms debounce), so no later launch seeds again and no flag is
needed. The seed runs in the `privacy` lane of the mutation coordinator, the lane a
pick in onboarding (`setProtectionLevel`) uses, so a pick queues behind the seed and
wins, and it re-reads the choice when its turn comes, so a stored pick is never
overwritten. A stored choice is applied by the existing boot apply.
`browser.safebrowsing.downloads.remote.enabled` is
allowlisted and exposed as `remoteSafeBrowsingEnabled`, but deliberately stays
outside every preset map. This keeps remote download reputation independently
user-controlled: applying or detecting Standard, Enhanced, or Hardened neither
resets the remote choice nor changes a matching preset to Custom.
Local Safe Browsing phishing, malware, and download-list checks remain enabled
in all three presets; Hardened no longer trades away that protection.

`extensions/bento-tools/experiments/bento-privacy/` exposes the minimal
privileged surface that normal WebExtension APIs cannot provide:

- allowlisted pref reads/writes/clears;
- visible Firefox search engine discovery, each engine with an `iconUrl`
  (below);
- default search engine reads/writes through Firefox `SearchService`;
- `consumeAddPanelGrant(tabId, token)`, the single-use check for the Add panel
  handshake (see "Add-panel grant" below). It is not a privacy operation; it
  lives here because this experiment is present in every shipped tools manifest.

The experiment rejects prefs outside its static allowlist. Search writes use
`SearchService.getEngineById`, `SearchService.setDefault(..., USER)`, and also
set the private default to the same engine when separate private search is not
enabled. Search provider ids, ordering, availability, and display names come
from Firefox `SearchService.getVisibleEngines()`.

Engine icons reach the shell as `SearchEngineChoice.iconUrl`, a `data:image/` URL
that the experiment builds in `getEngineIconUrl`. It asks Firefox for the icon at
16, 32 and 64 px and unsized (`SearchEngine.getIconURL`), converts the first URL
it can use, and otherwise reads Bento's bundled copy under
`experiments/bento-privacy/search-icons/` (Bing, DuckDuckGo, eBay, Google,
Perplexity, Wikipedia). `iconUrlToDataUrl` handles each form of URL as follows;
any other scheme, including `http:` and `file:`, is refused:

- `data:image/…`: passed through unchanged when the URL string is at most 699,307
  characters (`MAX_SEARCH_ICON_DATA_URL_CHARS`, the base64 length of 512 KiB plus
  256). Only the string length is checked; the payload is neither decoded nor
  sniffed.
- `https:`, `moz-extension:` and `blob:system/<uuid>`: fetched with no
  credentials or referrer and a 5 s timer that aborts the request. The body is
  capped at 512 KiB three ways: the declared `Content-Length`, a running count
  while it streams (the read stops and is cancelled at the first chunk past the
  cap), and a final length check. A request that fails, answers with a status
  that is not ok, or breaks the cap cancels the unread body and aborts the
  request, so the connection closes instead of Firefox buffering the rest.
- `chrome:`, `resource:` and `moz-icon:`: read through `SearchUtils.fetchIcon`.
  Firefox reads the whole icon first; the experiment then rejects it when it is
  empty or over 512 KiB.

Bytes from the last two forms must sniff as an image, or arrive with an
`image/*` type, or the engine gets no icon. Firefox 158 makes the icons of its
configured engines as `blob:system/<uuid>` object URLs
(`IconHandler.createIconURL`), so that form carries the common case. The blob
rule matches the system origin and a UUID and nothing else: a page's blob URL, a
`blob:null/` one or any other suffix is refused without a fetch. The address
bar's engine picker and onboarding's Search step draw `iconUrl` as is; an engine
without one shows a search glyph.

`SettingsStore` is version 2. Defaults include
`privacyProtectionLevel: 'standard'`, `defaultSearchEngine: 'ddg'`,
`sidebarHidden: false`, and `sidebarShortcutBehavior: 'collapse'`.
Migrated v1 profiles receive those default fields in the settings snapshot but
do not have an explicit stored override. On tools boot, `background.ts` applies
the stored privacy preset only when `hasOverride('privacyProtectionLevel')`
says the user explicitly stored it, so fresh-profile privacy defaults come from
`prefs/bento.js` rather than an unconditional startup rewrite.

The default search engine does not work that way. Neither `prefs/bento.js` nor
the search config dumps choose it: Firefox's `search-config-v2.json`
`globalDefault` is `google`, so a profile with no explicit apply stays on Google.
`applyBootDefaultSearchEngine` (`src/privacy/BootSearchDefault.ts`, called from
`bootReady` in `background.ts`) is the only thing that moves a fresh profile to
DuckDuckGo. It decides from `SettingsStore`:

- a stored `defaultSearchEngine` override: apply it;
- no override and `welcomeSeen` false (onboarding unfinished): apply the Bento
  default, `ddg`, and log `seeding default search engine: ddg`;
- no override and `welcomeSeen` true: apply nothing. Firefox's saved default
  stands, so a profile that finished onboarding on Google (or any engine chosen
  natively) is not migrated.

The call goes through the same `setDefaultSearchEngine` as a pick, which waits for
`SearchService.promiseInitialized`. It never throws: when `ddg` is missing (the
experiment's `getEngine` throws `Search engine is not available`) it logs a warning
and leaves Firefox's default. The seed is issued from `bootReady`, before the shell
port is served, and a later pick waits on the same initialisation behind it, so a
pick made during onboarding is always applied last. The onboarding Search step
preselects Firefox's live default, so it shows DuckDuckGo because of that seed.
Picking DuckDuckGo stores no override (it equals the default) and needs none:
Firefox persists the choice, and once Start browsing sets `welcomeSeen` nothing is
applied at boot. `settings/reset` applies `ddg` unconditionally and returns
`welcomeSeen` to false, so a reset profile matches a fresh one.

Settings, privacy, search and backup operations run in one transport-free
service, `extensions/bento-tools/src/settings-domain/SettingsDomainService.ts`.
It owns payload validation, the private-window policy, serialization through
`BentoMutationCoordinator`, the durable operation records
(`OperationRegistry`, key `bento.nativeOperations.v1`), the graph journal for
imports and restores (`GraphOperationJournal`, keys `bento.graphOperation.v1`,
`bento.graphOperation.sources.v1`), import
validation tokens, the revision counter, and the change notices. Two callers
share it, so a change cannot behave differently by the way it arrived:

- The overlay transport (`settings-domain/SettingsClientTransport.ts`) accepts
  `settings-client/request` messages (`extensions/_shared/settings-client-protocol.ts`)
  that the shell background relays on the authenticated tools port. The
  `caller` block (`documentId`, `windowId`, `isPrivate`) is derived in chrome,
  never by the document; tools only checks that the window exists
  (`caller_unbound` otherwise). The answer is a `settings/result` posted on that
  port only, never through the broadcast set. The shell background sends these
  requests for the Settings palette (`bridge/settingsRelay.ts`, see
  [shell-chrome-bridge.md](shell-chrome-bridge.md#private-windows-the-bentoshellbus-relay)).
- The ordinary shell-port handlers (`settings/update`, `settings/reset`,
  `privacy/setProtectionLevel`, `privacy/setAdvanced`,
  `privacy/setDefaultSearchEngine`) call the service's typed mutations. A reset
  from that port gets a registry record owned by `shell-port`.

Two entry points validate settings differently on purpose. The overlay
`settings/update` accepts exactly the editable inventory
(`validateSettingsChanges` over `EDITABLE_SETTING_RULES` in
`extensions/_shared/settings-rules.ts`, which also holds the advanced privacy rules
and the request limits), while the ordinary action keeps the full shell set
that welcome (`welcomeSeen`) and the sidebar (`sidebarHidden`,
`sidebarCollapsed`) write. Both call the same `updateSettings`, which takes the
`settings` slot of the coordinator and writes through `SettingsStore`.

After any privacy, search, reset or settings-applying import, the service
broadcasts `privacy/changed` (a full `PrivacySettings`) and
`searchEngines/changed` to every shell document. Settings changes keep their
existing `settings/changed` broadcast from `SettingsStore`.

Durable operations (`settings/reset`, `backup/importValidated`,
`backup/restore`, `backup/delete`) follow one lifecycle in `#runOperation`:
reserve (ownership, kind and payload hash are checked, and a repeat of the same
operation id replays the retained result), then run the effect once. Sources an
effect needs, the import validation token and the stored backup, are resolved
inside the effect, so a replay never reads them. The record ends `succeeded`,
`partial` (a live effect failed: privacy or search for a reset, an import or a
recovered import; `components` names the failed ones and `reconcileComponents`
lists them) or `failed` (every component failed). `components` is final for
every kind; `phase` is the progress indicator while it runs.

Ownership of a durable operation is the caller's `ownerId`. For the overlay it is
the browser session id and the window id (`window:<sessionId>:<windowId>`). Chrome
supplies both in the `caller` block: the BentoShellBus hub mints the session id (a
UUID) when its parent-process module loads and stamps it on every upward record, so
it survives a reload of the tools or shell extensions and changes only when the
browser restarts. A reloaded Settings document, or a reloaded tools background, in
the same window therefore reads its predecessor's status, and `snapshot/get` lists
the window's running and recently finished operations (`pendingOperations`, ten
minutes; `noticeAcknowledged: true` once a document reported the end) for it to
resume polling. Records of another owner, such as the `shell-port` reset, are never
readable through the overlay. Window ids repeat across browser sessions, which is why
the session id is part of the key. `recoveredOperationNotices` lists only records
recovery or startup settlement closed (`recovered: true`) and not yet acknowledged.

Backup operations, `recovery/acknowledgeNotice` and `settings/reset` are refused
to a private caller (`private_window_forbidden`; `isPrivateForbiddenOperation`),
`snapshot/get` omits the backup domain and the notices for one, and
`operation/status` hides backup records from it. A private caller's
`settings/update` keeps its other keys but drops the window-local ones
(`WINDOW_LOCAL_SETTING_KEYS`): the private window's colour mode lives in the shell
background and is never saved. The UI hiding of those rows is presentation only.

Manual verification surface: the Settings palette (app menu, Bento Settings: change a
setting and a protection level, export, import, reset). The domain's behavior is
covered by `settings-domain/*.test.ts`. At startup tools also deletes the retired
`bento.nativeSessions.v1` and `bento.graphPublication.v1` keys (`retiredStorage.ts`);
`bento.nativeOperations.v1` keeps its name because stored records live there.

### Settings palette (shell side)

The Settings palette is Bento's only settings surface (it replaced the native
`about:preferences#bento` pane). Chrome hosts it as the
`settings-palette` overlay ([overlay-documents.md](overlay-documents.md)); the app
menu, the command palette's Open Settings and Privacy commands and the welcome Open
Settings button open it. It is a staged quick pick on the public Mux `CommandPalette`
parts, and it is split so each piece is testable without the browser:

- `extensions/bento-shell/src/components/SettingsPalette/` is presentational. It takes a
  `SettingsPaletteView` (loading, error or a `SettingsPaletteModel`) and a
  `SettingsPaletteActions` object and keeps only navigation state: a stack of stages
  (`stageStack.ts`), the typed value of an editor stage (`useStageEditor.ts`) and the
  search text. `settingsCatalog.ts` holds labels, groups, bounds and presets (a test
  compares the bounds with `_shared/settings-rules.ts`), `settingsCopy.ts` all page and option
  copy (below), `categories.ts` category labels and descriptions, and `rows.ts` turns the
  model and a stage into rows, each carrying an intent, so what every stage shows is
  asserted in `rows.test.ts` and the component only renders and dispatches them.
  `rootRows` contains only described category openers; `controlRows` retains the flat
  controls for global search and command-index parity. Category stages filter those
  controls by stable category ids. Shortcuts opens its existing reference directly.
  Tab appearance shows in regular and private windows, Backup and Reset keep their private-window gate,
  and Privacy and search requires both hydrated models. `categories.ts` shares category
  ancestry between command targets and root-search drilldowns, adding Advanced privacy
  before its enum pages. Its opener map seeds return focus for inserted ancestors and deep
  links, so Back to the unfiltered root focuses the category rather than a missing control.
  Category stage keys include their id, remounting the list on moves between categories.
- Page descriptions and control option lines. Copy lives in `settingsCopy.ts`, typed by the
  catalog's keys (`NUMBER_DESCRIPTIONS`, `ENUM_DESCRIPTIONS`, `ENUM_OPTION_DESCRIPTIONS`,
  `ADVANCED_DESCRIPTIONS`, whose two choices reuse their page's text) plus
  `STAGE_DESCRIPTIONS`, `CONFIRM_DESCRIPTIONS`, `SIZE_ACTION_DESCRIPTIONS`,
  `BACKUP_ROW_DESCRIPTIONS` and `CUSTOM_PROTECTION_DESCRIPTION`. It is a module of its own so
  the catalog stays labels, keys and bounds; only `rows.ts` imports it. The protection levels' second
  line is `summary` from `_shared/privacy-levels.ts` (not copied), and their `detail` is only
  benefits and caveats. `pageDescription(stage)` in `rows.ts` returns the page text (null on
  the root, category control lists and the shortcuts); the component renders it as `CommandPalette.Description` between
  the nav row and the field row, outside the list so it does not scroll, and the search field
  and input carry `aria-describedby` to it. An option's `PaletteRow.description` renders as
  `CommandPalette.ItemDescription`, a flex-wrapped second line under the row. The Mux item
  parts register no description slot with React Aria and the item forwards no
  `aria-describedby`, so `describeOptions` (`SettingsPalette.tsx`, a `MutationObserver` on the
  list) sets each option's `aria-describedby` to its line (and the protection detail) on the
  rendered element, and `rowAriaLabel` names such a row by its label, note and value only. The root
  search results drop the advanced rows' lines, and a confirmation's explanation is its page
  description (its rows are only Cancel and the action). `rows.test.ts` asserts that every
  stage where a value or option changes has a description and that the listed rows carry
  lines, and `settingsCopy.test.ts` that the copy covers the catalog exactly and has no em
  dashes. When a setting's behaviour changes in tools or chrome, change its line in
  `settingsCopy.ts` in the same change.
- Field row. `showsFieldRow(stage, listRowCount, query)` (`rows.ts`) keeps the field on the
  root, in editors, on lists of more than four rows (counted before any filter) and while a
  filter is typed (a model update can shrink a filtered list to four rows, and its Clear
  button must not become an invisible tab stop), and drops it on a shorter list (the choices,
  protection level, small categories, a stored backup, size actions, a confirmation). The `Input` is not removed: it holds the focus and carries Up, Down, Enter,
  Esc and Backspace for the list (React Aria drives the virtual focus from it), so the field
  gets `data-hidden` (visually hidden, still in the tab order and read, labelled with the
  page name) and the input `readOnly`; `onFieldChange` ignores typing there, so a list never
  filters invisibly.
- `extensions/bento-shell/src/settings-palette/settingsClient.ts` is the request client
  over an injected `SettingsTransport` (`send`, `onMessage`). It correlates results by
  `requestId`, rejects a non-durable request after 15 s, and follows a durable operation
  (`settings/reset`, `backup/importValidated`, `backup/restore`, `backup/delete`) by its
  own result and by polling `operation/status`. A status record tools does not know
  means the request was lost on the way, so the original is sent again under the same
  operation id (tools replays it). `resume` follows the `pendingOperations` of a
  `snapshot/get` so a reloaded document finds what a previous one left running.
- `settingsStore.ts` is the store over that client: `snapshot/get` for every domain on
  each show, `settings/changed`, `privacy/changed` and `searchEngines/changed` applied
  as they arrive, one `pending` count per write key with the on/off a switch write asked
  for (`pendingTargets`), a `notice` for the latest failure and the import preview. The private-window state is read from the snapshot: tools
  omits the `backup` domain for a private caller, so `isPrivate` is `backup ===
undefined`, and the palette then shows no backup rows or automatic-backup
  preferences. A backup file is refused before sending (`That file is too large to
import.`) when it is over `SETTINGS_LIMITS.backupFileBytes` (10 MiB) or when, escaped
  into the request message, it is longer than the relay actor carries
  (`RELAY_UP_MAX_CHARS` in `settings-palette/relayLimit.ts`, 22 MiB, equal to `MAX_MESSAGE_CHARS` in
  `BentoShellBusChild.sys.mjs`; a test keeps the two equal). The actor limit counts the
  serialized message, in which JSON escaping doubles a pretty-printed backup, so the
  limit is sized for two times the backup limit. An export travels the other way, which
  has no limit.
- Published values (`settings`, `privacy`, `search`) are applied by ticket. Every write
  and every snapshot takes the next ticket when it is sent, a change notice counts as
  the newest ticket sent so far, and an answer applies only to the fields it is newer
  than. A snapshot collected before a write or notice therefore cannot replace the newer
  value, a stale write answer cannot replace a notice, and the answers of two quick
  writes arriving out of order leave the one sent last. A reset takes its ticket when it
  is sent and applies the state it returns through it, so a change that landed while it
  ran is kept. A change notice that arrives before the first snapshot has made a model is
  buffered with the ticket count it arrived at, and the first snapshot yields to the
  notices that came in after it was asked for.
- Operations that ended while the document could not see them are reported once. After
  each snapshot the store takes the `pendingOperations` that are finished and not
  `noticeAcknowledged`, plus the `recoveredOperationNotices`, reads each with
  `operation/status`, shows the outcome in the footer notice ("The import did not
  finish. Bento restarted first. ..." or "The restore finished.") and sends
  `recovery/acknowledgeNotice`. An operation this document ran itself is concluded the
  same way when its run ends (shown only when it did not succeed), and nothing is
  reported while the document has a durable run of its own in flight.
- An outcome is acknowledged only once it was on screen. The store is told when the
  palette is shown or hidden (`actions.setVisible`, called from the show and hide events
  ahead of React, and `false` when the document loads: it loads hidden). An outcome that
  ends while hidden, a failure or a success, is kept unacknowledged and shown ("The
  import finished.", "The restore did not finish. ...") by the next show, which first
  clears the old notice itself: the palette component no longer clears it on a show, since
  that ran after the store had reported and erased it. A document reloaded before that
  show finds the unacknowledged operation again in its snapshot.
- `relayTransport.ts` is the only file that knows how Settings traffic is shaped on the
  BentoShellBus relay (`bento-bus-up` and `bento-bus-down` events carrying JSON
  strings, built on `bridge/shellBus.ts`). It sends `settings-hello` until acknowledged,
  holds requests until then (for at most the client deadline) and posts each request as
  `{kind: 'settings-request', request}`; results arrive as `settings-result`, change
  notices as `event`. The background side is `bridge/settingsRelay.ts`.
- `useShowSignal.ts` listens for chrome's `bento-settings-show` and `bento-settings-hide`
  events (see overlay-documents.md). A show also carries who opened Settings (`origin`
  'palette' for the command palette): `main.tsx` then gives the palette `onBackToPalette`,
  and its path starts with "Command palette". A hide bumps `hideToken`, which makes the palette put
  back an unfinished number edit and stop its live-apply timer at once (chrome hides the
  overlay when another overlay opens, on Esc and on an outside click, and the document
  stays loaded; waiting for the next show would let that revert overwrite a value saved
  meanwhile from another window). Each show bumps `openToken` (the palette returns to the stages
  and search text `resolveSettingsTarget` gives for the show's `target`, including category ancestry: the root, the
  protection level list for the privacy link, or the setting a command palette result
  named) and refreshes the snapshot. `main.tsx` announces readiness after that listener exists,
  so the first show is never lost.

Editor stages (a number typed in the search field) behave as follows. A valid number applies live after 180 ms without typing (and at once for an
arrow-key preset), Enter keeps it, Esc and dismissal put back the value the stage
started with, and an invalid draft is shown with its reason and never sent. They do not
share the main palette's Enter-runs-the-first-result or select-on-focus behaviour,
because the field holds the value being typed.

A number whose range is at most `SLIDER_MAX_SPAN` (50) wide is a slider page instead
(`usesSlider` and `sliderSpecFor`; today Keep alive per workspace, Panel corner radius,
Panel gap and splitter size, Backups to retain), decided by the range alone in
`settingsCatalog.ts`. The page renders `RangeSlider`, a native range input (step 1,
`aria-label` the setting's label, `aria-describedby` the page description, `aria-valuetext` the
value with its unit) drawn with our own track, fill and thumb, and no search field or list, so no
hidden input competes for the focus or the keys. The input is focused on open (and again on a
new show or when the window regains focus); arrows, Page keys, Home and End are the browser's.
Its `keydown` keeps the value on Enter (`editor.commit`), and Esc, Back, Close and a hide go
through the same `editor.revert` as the field pages. Slider changes go through
`EditorSession.slide`, a leading-and-trailing throttle (`LIVE_SLIDE_INTERVAL_MS`, 100 ms): the
first change is sent at once and the latest follows every interval, so a drag across 36 steps is
about six `settings/update` writes, and the value written last is always the one shown. Esc after
a drag drops the waiting write and writes the opening value back once (nothing, if nothing was
sent). The footer reads "←→ adjust", "Home End min max", "Enter keep", "Esc cancel" with the
"Live preview" status; the field pages keep their own hints. Tab order: Back, the path, Close,
the slider. Why native, and how the drawn thumb glides, are in the recorded exception in
[mux-ui-component-customisations.md](../mux-ui-component-customisations.md).

Manual verification: in Ladle (`pnpm --filter @bento/shell ladle:serve`, stories under
"Settings palette") each mock step renders in dark and light. In Bento: open Settings
from the app menu, the command palette (Open Settings, and Privacy for the protection
level list) and the welcome dialog; the keyboard model works (first row focused on
open, arrows move, Enter runs, Esc goes back one stage and closes from the first list; with
an import preview showing, the first Esc dismisses the preview and the second leaves
Backups);
a number edit applies live and reverts on Esc; a change in one window shows in another
window's open palette. In a private window the palette has no backup, merge or reset
rows, the Bento color mode row changes only that window and is not saved, and other
settings save for the profile. Reset closes the palette and onboarding opens again.
Export lands in the download directory; Import shows what the file holds before it
changes anything.

The About pane's `updates` setting group is hidden whenever
`AppConstants.MOZ_UPDATER` is false, which is every Bento build while
`bento.json` `updates.enabled` is `false` (`--disable-updater`). The source of
truth is the configure option; `patches/core-ui/16-hide-updates-group-without-updater.patch`
sets `hidden: !AppConstants.MOZ_UPDATER` and
`hiddenFromSearch: !AppConstants.MOZ_UPDATER` on the group's config in
`about-firefox.mjs`, and `setting-group` applies them as
`data-hidden-by-setting-group` (CSS hiding) and `data-hidden-from-search`.
Both are needed: `findInPage.js` skips a `hidden` group in its per-group search
pass, but the whole-pane fallback searches the group's text unless it carries
`data-hidden-from-search`, so searching "update" would otherwise surface the
invisible group. Upstream otherwise shows the group's "Updates are managed by
your operating system" message bar for every build without an updater, which is
false for Bento.
The group-level flag is used instead of per-control `visible` callbacks so the
result does not depend on the order of the controls' `visibility-change` events.
The version line lives in the group's `updateApp` box and is hidden without an
updater, as upstream. Manual check: open `about:preferences#about` in a dev build,
confirm only the support group renders and that searching "update" shows no
Updates text; see the "About Pane Updates Group" entry in
`docs/firefox-core-touchpoints.md`.

The Keyboard shortcuts list of the Settings palette is a read-only searchable
catalogue. The sidebar shortcut behavior row writes
`BentoSettings.sidebarShortcutBehavior` through `settings/update`; chrome reads
that value from the `BENTO_PANELS` title payload to decide whether Cmd/Ctrl+S
targets the collapsed rail or the hidden sidebar state with edge-hover reveal.

The address palette reads the same visible-engine data through the narrow
`searchEngines/requestSnapshot` / `searchEngines/snapshot` protocol. That mirror
exists only for the one-shot search picker and never dispatches
`privacy/setDefaultSearchEngine`.

Onboarding in `extensions/bento-shell/src/welcome/` adds privacy and search
steps after browser-data import. Those steps dispatch the same privacy actions
as Settings (`privacy/setProtectionLevel` on selection and again on Continue,
`privacy/setDefaultSearchEngine` optimistically on selection). The Privacy step
shows each `PRIVACY_LEVELS` entry's label and one-line `summary` with a
Recommended tag on Standard; the Search step lists the visible engines and tags
the ones that match a small built-in list of privacy-oriented providers as
Private, each with its engine icon before its name, and preselects Firefox's
live default (DuckDuckGo on a fresh profile because of the boot seed above).
Both leave `welcomeSeen=false` until the final Start browsing action.

uBlock Origin is bundled as a third built-in extension under
`extensions/ublock-origin/`. Its provenance and update notes are recorded in
that folder's README. `.bento-runtime-entries.json` lists the extra top-level
uBO runtime folders/files that Bento's add-on installer must copy; the default Bento extension copy
filter is still used for extensions without that file.

### Checking engine icons at runtime

Use a dev build on a throwaway profile; the tools extension must be running.

1. Terminal: add `user_pref("marionette.port", 2829);` to the profile's `user.js`,
   then launch the dev build:

   ```sh
   <Bento binary> --new-instance --marionette --remote-allow-system-access --profile <dir>
   ```

2. Marionette client, chrome context (`Marionette:SetContext chrome`): run an
   async script that reaches the tools background and calls the API directly:

   ```js
   return (async () => {
     const { ExtensionParent } = ChromeUtils.importESModule(
       'resource://gre/modules/ExtensionParent.sys.mjs',
     );
     const ext = ExtensionParent.GlobalManager.getExtension('bento-tools@bento.app');
     const bg = [...ext.views].find((view) => view.viewType === 'background');
     const engines = await bg.apiCan.root.bentoPrivacy.getSearchEngines();
     return engines.map((e) => [e.id, e.iconUrl?.slice(0, 24) ?? null]);
   })();
   ```

3. Every configured engine must report a `data:image/...` prefix. A `null` for
   an engine that Firefox ships an icon for means the pipeline failed silently
   (see the pitfalls below).

## Settings Palette Pitfalls

- Mux `CommandPalette.Input` runs its own `onKeyDown` first and skips the list's
  arrow and Enter handling when the event is default-prevented. The palette uses that
  for editor stages (arrows step presets, Enter keeps the value). Escape is not handled
  there but by a capturing `keydown` listener on the window (`preventDefault` and
  `stopPropagation`), because the focus can be on Back, a path button, Close or Clear, and
  the modal's own Escape would close the whole palette instead of going back one stage.
  Chrome must not consume that key first: see "Esc: chrome sees the key first" in
  [palettes-and-address-bar.md](palettes-and-address-bar.md#esc-chrome-sees-the-key-first).
- Tab never left the field because the SearchField gives every button inside it
  `tabindex="-1"` (React Aria's `excludeFromTabOrder` through its button context), Clear
  and Close included, and its press-start focuses the input, which also stopped Enter and
  Space from activating such a button (focus left it before the key-up). In Settings, Back,
  the path and Close live in a nav row above the field, outside it, and Clear stays in the
  field. The command palette keeps Clear and Close in its field. Both use `IN_TAB_ORDER`
  (`components/primitives/inTabOrder.ts`) on the buttons inside the field:
  `excludeFromTabOrder: false` and an `onPressStart` that keeps the focus on the button for a
  key press. The tab order is the DOM order: in Settings Back (disabled at the first list), the
  path buttons, Close, the field, Clear; in the command palette the field, Clear, Close.
- A switch row shows its state while a write is pending from the target the toggle asked
  for (`pendingTargets`, kept until the write settles), not from the inverse of the stored
  value: a `settings/changed` broadcast can update the stored value before the write's reply,
  and inverting it then flipped the switch back for a moment. A failed write drops the target,
  so the row returns to the stored value.
- The On/Off switch inside a row is `aria-hidden` and inert, so the row's accessible name does
  not include it. `rowAriaLabel` (`rows.ts`) sets the option's `aria-label` to the label and
  the shown state ("Sleep idle tabs, On"), following the pending target. `textValue` only
  drives type-ahead.
- In a number stage a click on a preset keeps the value and leaves the stage
  (`useStageEditor.keep`); the arrow keys only preview it (Esc puts the starting value back),
  and Enter in the field commits the typed value.
- Do not use the Mux `Slider` for these pages: it sits in the `collections` module, so the Settings
  entry's cold-start JS grew by about 109 KB gzip and every entry that loads the chunk by about
  16 KB; a lazy import left the 16 KB (one module, one chunk), and a `manualChunks` rule cannot
  split it. The native range input costs nothing and announces the unit.
- The drawn thumb and the native thumb must stay on the same travel. The native thumb is the
  drawn thumb's size and its centre runs from half a thumb to the width less half a thumb; the
  drawn one is `translateX((100cqw - thumb) * ratio)` from the left edge. Change the size or the
  travel in one and the hit area parts from what the eye follows. The transition is on only
  after `data-settled`, or a page that opens on its value would slide in from the default.
- The drawn thumb must not transition while the handle is dragged: every input step would
  restart the 120 ms transition, the drawn thumb would trail the native one by tens of pixels in
  a fast sweep, and a quick re-grab at the drawn thumb could set the value backward. A press that
  travels past the slop sets `data-dragging` (no transition), so a click on the track still
  glides.
- The drawn thumb and fill are direction-aware (`--bento-slider-direction`, `:dir(rtl)`),
  because Gecko inverts a native range in RTL; a logical start anchor with an always-positive
  translation moved the drawn thumb the wrong way and out of its hit area.
- A list opens on a chosen row (the row that opened the page when going back, the current
  choice of a list of choices) by mounting with that row selected: React Aria focuses the
  first selected row on mount. `StageList` drops the selection a frame later; leaving it would
  stop `onAction` from running on press (a toggle-mode list with a selection makes a press a
  selection change).
- A path button's click moves the DOM focus to the button and blurs the field, which clears
  the list's virtual focus; `goToDepth` puts the focus back on the field.
- Esc is one step (`escapeOutcome` in `stageStack.ts`): it clears a search, else dismisses
  an import preview, else goes back one stage, else closes from the root. An import
  preview is a state of the Backups stage, not a pushed stage, so a plain "pop" left
  Backups for the root and dropped the preview's file; `escapeNavigation.test.ts`
  walks every stack the rows can push and expects one stage per Esc. A new pushed
  stage needs no change there; new in-stage state that Esc should leave first does.
- The popup is the command palette's size (37.5rem by 30rem, fixed height). The list is a
  flex column under it, so a row with
  `min-block-size: 0` shrinks instead of letting the list scroll, and the focused
  protection level's detail text (312 px for Standard) is drawn over the rows below it
  (a 256 px row seen in Bento, with the dialog at 482 px). Rows and sections keep
  `flex-shrink: 0`, so the list scrolls instead.
- The Mux `ListBox` forwards its props to the React Aria list box, whose `autoFocus`
  takes `'first'`; the DOM attribute type only has a boolean, so it is passed as a plain
  props object (`FOCUS_FIRST_ROW`). Without it nothing is focused on open, Enter does
  nothing, and the main palette's Enter-runs-the-first-result workaround would be
  needed. The list is remounted per stage and per show (`StageList`, keyed by the show,
  the view and `stageKey`), so focus starts on the first row unless the stage names one (see
  the selection seeding above).
- A replayed durable request that is still running answers with the status record, not
  the final result. The client reads `state` and keeps polling instead of treating any
  `ok` result as done (`readDurableOutcome`).
- Static rows (explanations, the Custom protection level) are `disabled` Mux items, so
  keyboard navigation skips them; the palette restyles `[data-info]` so they do not
  look disabled.
- An intent of type `confirm` runs its operation at once (the last row of the confirm stage
  carries it); a row that should ask first must `push` the confirm stage. The stored
  backup's Restore and Delete rows once carried `confirm` and restored on the first
  click, which only a runtime pass showed (`rows.test.ts` now asserts the push).
- The overlay is created on first use, so the first show happens on the readiness
  announcement: `useOverlayReadySignal('settings-palette')` must stay after the effect
  that listens for `bento-settings-show` (`useShowSignal`), or chrome's first show is
  sent to nobody and the palette opens on a stale first list.
- A private window's Settings document must not edit the saved colour mode: tools
  drops `uiColorMode` from a private caller's update and the shell background keeps the
  window's own value (`bridge/settingsRelay.ts`). Reading the snapshot without that
  projection would show the saved value in the row.
- Mux has no `--muxui-semantic-color-error-N` token (only `-fg`). Danger text uses
  `--muxui-semantic-action-danger-foreground` and invalid text
  `--muxui-semantic-feedback-invalid-content`.

## Privacy Pitfalls

- `SettingsStore` stores only deltas from its defaults (`#persistAndPublish`
  drops a value equal to its default), so a default never reaches Firefox unless
  something applies it explicitly, and "no override" never means "the user has not
  chosen". `defaultSearchEngine: 'ddg'` was once documented as the fresh-profile
  default while nothing applied it: Firefox stayed on Google and onboarding, which
  preselects the live default, showed Google. A new Bento default that must be
  live needs an explicit seed like `BootSearchDefault.ts`, gated on `welcomeSeen`
  rather than on the missing override. Check it at runtime with
  `SearchService.defaultEngine.id` and `SearchService.appDefaultEngine.id` in the
  Browser Toolbox Console (a seeded profile reports `ddg` and Firefox's own
  `google`).
- Shutdown clearing needs Firefox 158's prefs, not Bento-named ones. Bento wrote
  `privacy.sanitize.clearOnShutdown.{cache,cookies,offlineApps}`, which nothing
  reads, so the switch only set the master pref and a quit cleared history, form
  history, cookies, site data and cache (measured on a fresh profile; Firefox's
  default also selects downloads).
  Firefox clears what `privacy.clearOnShutdown_v2.*` selects (`Sanitizer.items`
  names with a `true` v2 pref). `Sanitizer.maybeMigratePrefs("clearOnShutdown")` runs
  on every shutdown, master pref on or off, until
  `privacy.sanitize.clearOnShutdown.hasMigratedToNewPrefs3` is true, and rewrites
  the v2 prefs from the legacy `privacy.clearOnShutdown.*` defaults (history and
  form data on). Writing the v2 prefs without that flag is silently undone at the
  first quit (measured: history and form history were cleared). The switch, the
  Hardened preset and the allowlist in `api.js` all use `SHUTDOWN_CLEAR_PREFS`;
  `scripts/bento-privacy-security.test.mjs` fails when a preset pref is missing
  from the allowlist.
- `browser.privacy.network.httpsOnlyMode` is `readOnly`: `set()` resolves `false`
  without changing a pref and without throwing. Using it for the HTTPS-only
  choice made Off a read-back mismatch, so `PrivacyMutationService.setAdvanced`
  reverted and the palette said "Saved, but Firefox did not apply it yet." Write
  `dom.security.https_only_mode` and `dom.security.https_only_mode_pbm` through
  `bentoPrivacy.setPrefs`; the getter still reports `never`, `private_browsing` or
  `always` from them.
- A failed change to a pref group must restore the raw values, not replay the old
  boolean or mode. Rollback by replaying `applyAdvancedSetting(key, true)` wrote
  the whole shutdown bundle over a user's own v2 item choices (or `always` over a
  main/private split). `snapshotAdvancedPrefs` captures the effective values first
  and writes them back; writing a value equal to the default drops the user
  value, so that also restores "no user value" (checked at runtime).
- A write to a locked pref (enterprise policy `Preferences` with `Status: locked`)
  does not throw and does not change the effective value (checked at runtime), so
  verifying only the master pref reported success while a locked
  `privacy.clearOnShutdown_v2.browsingHistoryAndDownloads=true` still cleared
  history. Read back every pref of the group and treat any difference as a failed
  change. Firefox does not drop the write: `Pref::SetUserValue`
  (`modules/libpref/Preferences.cpp:922`) still stores or clears the user value,
  and `GetValue` (`:1284`) returns the default while the pref is locked.
- Known limitation: `snapshotAdvancedPrefs` snapshots effective values, so undoing
  a failed change can lose a user value that is hidden under a locked pref. The undo
  writes the effective (default) value back, and a write equal to the default
  clears the hidden user value (checked at runtime: a user `false` under a locked
  default `true` was gone after a write of `true` and an unlock). Bento ships no
  enterprise policies, so only a policy the user installed can lock these prefs;
  recording the hidden value would need a user-value read in the experiment.
- A default stored as "no override" never reaches Firefox. `SettingsStore` keeps
  only deltas, so the default `privacyProtectionLevel: 'standard'` was never
  applied to a fresh profile: Firefox's own prefs are not Standard (tracking
  protection only in private windows, Discovery Stream on,
  `privacy.resistFingerprinting.letterboxing` absent, which `getPrefs` returns as
  `''`), so detection returned `custom` and the Settings palette marked no level
  current until onboarding's privacy step applied one. Seed it once, on the first
  launch. Gating it on `welcomeSeen` (like `BootSearchDefault.ts`) re-applied
  Standard at every launch until onboarding finished, so a switch changed before
  finishing reverted on relaunch, and an older profile with no stored `welcomeSeen`
  got Standard forced; `WorkspaceStore` finding no persisted workspaces is the
  once-only signal. Automation hides this on a
  Marionette profile too: `--marionette` turns the three local Safe Browsing prefs
  off (`remote/shared/RecommendedPreferences.sys.mjs`), so check a fresh profile
  with `user_pref("remote.prefs.recommended", false);` in `user.js`.
- A preset that raises a pref above Firefox's default (Hardened's Referer policy
  and HTTPS-only background request) must be matched by the lower presets writing
  the default, or stepping down keeps it and detection still reads the lower
  level.
- Do not add arbitrary prefs to the experiment API. Additions must be explicit
  in both `privacy-levels.ts` and `experiments/bento-privacy/api.js`.
- Do not auto-apply Standard on every boot. That would overwrite users who
  changed Firefox privacy prefs outside Bento before Bento had stored an
  explicit level. The boot seed is limited to a profile's first launch.
- Do not reintroduce a Bento search engine allowlist unless Bento intentionally
  returns to a curated-provider model. Settings and onboarding should follow
  Firefox's visible search engine list.
- Do not lock uBlock Origin with enterprise policy. Bento ships it enabled but
  user-disableable/removable.
- Do not move experiment files under `src/`; the add-on installer copies only top-level
  `experiments/` into the built-in extension.
- An experiment's scope is not a window: it has no `fetch`, `AbortController`,
  `TextDecoder`, `btoa`, `URL`, `TextEncoder` or `setTimeout`/`clearTimeout`.
  The icon pipeline's `catch` blocks turn the resulting `ReferenceError` into
  "no icon" and nothing else, so on Firefox 158 no engine had an `iconUrl` and
  the UI quietly showed the glyph. `api.js` requests the globals it uses with
  `Cu.importGlobalProperties([...])` and takes the timers from
  `resource://gre/modules/Timer.sys.mjs`. When the file starts using another web
  global, add it to that list; `scripts/bento-privacy-security.test.mjs` loads
  `api.js` in a scope that has only what the file imports, so a missing one fails
  the icon tests.
- Do not send the ordinary `settings/update` through the editable-inventory
  validator: welcome writes `welcomeSeen` and the sidebar controls write
  `sidebarHidden` and `sidebarCollapsed`, none of which the Settings surface
  edits. Share `SettingsDomainService.updateSettings`, not the validator.
- A durable operation resolves nothing before it is reserved. The validation token
  was once deleted before the reservation (and a stored backup read before it), so
  a retry with the same operation id, the normal answer to a lost reply, failed
  with an internal error or `not_found` instead of replaying. Keep ownership, the
  payload-hash check and the replay lookup ahead of any source lookup.
- Map failures to the shared catalogue (`SettingsError`). Oversize files and
  exports, unreadable or invalid files, and bad or spent tokens used to reach the
  client as `internal_error` because the service matched error text against a
  list that did not contain them. `conflict` (same operation id, different
  payload) stays in the catalogue as non-retryable.
- A live effect that does not stick makes the operation `partial`, never
  `succeeded`. `executeImport` reports the failed privacy or search components
  through `onLiveEffectFailures` (it used to fold them into
  `summary.settingsApplied=false`, and the wrapper still recorded `succeeded`), and
  the recovery path in `GraphOperationJournal.ts` does the same when it re-applies
  settings after a restart.
- Settle what a restart cut off. A reservation is persisted before the effect
  runs and before the journal exists, so a restart can leave a `reserved` or
  `running` record of any kind (a reset, a delete, an import that never reached its
  journal) that nothing would ever finish. `SettingsDomainService` calls
  `OperationRegistry.settleInterrupted` once startup recovery has run; it fails them
  as `backend_restarted` and leaves the record a surviving journal still covers
  to `GraphOperationRecovery`.
- When recovery can only record a `partial` outcome it must release the journal.
  The terminal record used to stay, and `GraphOperationJournal.begin` then refused
  every other import or restore with `graph_reserved`, also after restarts. A
  terminal journal an earlier build left behind is cleared on the next startup.
- Window ids are unique only within one browser session. Never key a retained
  operation on the window id alone; the overlay owner key includes the browser session
  id the BentoShellBus hub mints. It was once a UUID drawn per tools run, so a reload of
  tools during an import changed the owner while the window survived: the document got
  `operation_not_owned` and a snapshot could not rediscover its record.
- The relay actor's limit counts the serialized message. A limit on the raw file text
  once let a 7.1 million character backup through the UI check as a 14 million
  character message that the actor dropped without an answer, and exports between about
  8 and 10 MiB could not be imported. Keep `RELAY_UP_MAX_CHARS` at twice the backup
  limit plus headroom, and size any new upward payload by its escaped length.
- A size list action (Move up, Move down, Remove) keeps the stage on its entry until
  tools saved the new order (`sizeIntents.ts`): moving the stage first left the actions
  on the neighbour after a refused move, so Remove could delete it, and a second press
  before the answer reordered a stale list. A second action while one waits is dropped,
  and so is anything that names an entry while the list is saved (`Edit size`, opening an
  entry's actions): Edit size entered during a move, saved as 340, once rewrote the
  neighbour that landed on its index. A size edited live counts as saving the list too.
- Show and Hide are sent to the Settings document in order. A message the frame could not
  take yet is retried, and a retry of an older one is dropped once a newer Show or Hide
  was sent (`settingsLifecycleSeq` in the mount script): a delayed Hide landed after the
  Show that came later and cancelled the editor session it had just begun.
- Do not accept blob URLs other than `blob:system/<uuid>`, and do not widen the
  other schemes to make an icon appear: the experiment runs with the system
  principal, so what it fetches has to stay an explicit list.
- The icon URL form is Firefox's choice (configured engines: `blob:system/<uuid>`;
  user-added and add-on engines: `data:` or `moz-extension:`). After a Firefox
  update, run the runtime check above; `scripts/firefox-compat-registry.mjs` lists
  `SearchEngine.getIconURL` and `IconHandler.createIconURL` for the engine check.
