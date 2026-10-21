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
per-site exception UI. `browser.safebrowsing.downloads.remote.enabled` is
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
  lives here because this experiment is present in every shipped tools manifest,
  including the rollback variants.

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

Native Bento Settings is registered by
`patches/core-ui/15-bento-native-preferences.patch`. Its config module uses
Firefox `SettingGroupManager` controls and a generated observer protocol to the
tools-owned `browser.bentoNativePreferences` experiment. The canonical contract
is `extensions/_shared/native-preferences-contract.json`; generated TypeScript,
raw-script, Firefox ESM, and fixture artifacts must pass
`pnpm native-protocol:check:all`. The experiment derives the source window and
private state from the system-principal Settings document, and the tools service
binds each resumable session to that window, audience, contract hash, and direct
parent-process attestation. Settings persistence is awaited before publication.
Setting-group Fluent messages must provide a `.label` attribute rather than a
message value. `moz-fieldset` localizes `label`, `description`, and `ariaLabel`;
a message value makes Fluent replace its light-DOM contents and deletes every
rendered `setting-control`, leaving a correctly titled but empty card.
The pane title message provides both a value for the native navigation button
and a `.heading` attribute for `moz-page-header`; omitting `.heading` leaves the
page icon visible with an empty heading.
All Bento dropdowns remain `moz-select` controls but opt into its Firefox-owned
`panel-list` rendering path with `force-panel-list`. This bypasses the macOS
native select picker, which does not open reliably for these controls when the
Settings document is hosted in Bento's panel layout, while preserving the
standard `moz-select` value/change API used by the custom Bento settings model.
The `bento-range-control`, `bento-size-list`, `bento-backup-manager`, and
`bento-shortcut-list` elements remain Bento controller boundaries, but their
visible controls are composed from Firefox `moz-slider`, `moz-input-number`,
`moz-button`, `moz-input-search`, `moz-box-group`, and `moz-box-item`
components. Bento owns value synchronization, persistence, filtering, backup
operations, and stable occurrence identities; Firefox owns the rendered form,
list, focus, action, and reorder affordances. Native component labels use
Fluent `.label` attributes, while dynamic row text is assigned through the
component properties. Chrome-bound title signals must not be written twice in
one synchronous handler because the later title replaces the earlier one
before the shell-frame title handler reads it.

`bento-size-list` names its native `moz-box-group[type="reorderable-list"]`
with a `label[is="moz-label"]`. Firefox supplies drag reordering and
Ctrl+Shift+ArrowUp/ArrowDown keyboard reordering through that group. Each row
contains a `moz-input-number` and one `moz-button[type="destructive"]` Remove
action. Rows intentionally have no numbered `moz-box-item` label because their
position changes when reordered; each number input keeps the unnumbered
accessible name “Panel size.” Separate Move up and Move down buttons would
duplicate the native list affordance and must not be added back.

The main `setting-pane[data-category="paneBento"]` is substantially longer than
Firefox's other native panes. Keep its native `setting-group` cards continuously
rendered. Applying `content-visibility: auto` to these groups causes Gecko to
show large blank regions while scrolling before the skipped cards are painted.
Do not restore that containment optimization; scrolling must preserve section
visibility even if all native groups participate in layout and paint.

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

The native Keyboard shortcuts control is a read-only searchable catalogue. The
Keyboard shortcuts group also writes
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
- Do not add arbitrary prefs to the experiment API. Additions must be explicit
  in both `privacy-levels.ts` and `experiments/bento-privacy/api.js`.
- Do not auto-apply Standard on every boot. That would overwrite users who
  changed Firefox privacy prefs outside Bento before Bento had stored an
  explicit level.
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
- Do not accept blob URLs other than `blob:system/<uuid>`, and do not widen the
  other schemes to make an icon appear: the experiment runs with the system
  principal, so what it fetches has to stay an explicit list.
- The icon URL form is Firefox's choice (configured engines: `blob:system/<uuid>`;
  user-added and add-on engines: `data:` or `moz-extension:`). After a Firefox
  update, run the runtime check above; `scripts/firefox-compat-registry.mjs` lists
  `SearchEngine.getIconURL` and `IconHandler.createIconURL` for the engine check.
