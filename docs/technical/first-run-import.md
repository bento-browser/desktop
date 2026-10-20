# First-run import and onboarding

Part of the [technical notes index](../core-functionality-technical.md).

First-run browser-data import is handled from Bento's onboarding experience. The
welcome overlay (`welcome.html`, source under
`extensions/bento-shell/src/welcome/`) is a seven-step centered Mux `Dialog`
with one topic per step, and browser-data import is the third step. The persisted
step value is the index below.

| #   | Step id      | Behaviour                                                                                                                                    | State and messages                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `welcome`    | Introduction and Get started.                                                                                                                | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 1   | `appearance` | Light, Dark, and Auto tiles, applied at once.                                                                                                | `settings/update { uiColorMode }` on every selection; the selected tile is the stored value, else `light`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2   | `import`     | Non-interactive list of supported sources, Skip, and Import browser data.                                                                    | Skip is a plain step change to 3. Import browser data stores step 3 and signals chrome (below).                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | `privacy`    | One row per `PRIVACY_LEVELS` entry (label and one-line summary), Standard tagged Recommended.                                                | `privacy/setProtectionLevel` on selection; Continue re-dispatches the current level (the stored one, else `standard`).                                                                                                                                                                                                                                                                                                                                                                                                |
| 4   | `search`     | Firefox's visible engines in two columns, a Private tag on privacy-oriented ones, "Loading Firefox search engines…" while the list is empty. | `privacy/setDefaultSearchEngine` (optimistic) from `privacy.availableSearchEngines`; default `ddg`.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 5   | `tour`       | Workspaces, panels, and command palette tiles with shortcuts.                                                                                | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 6   | `ready`      | Summary of Appearance, Privacy, and Search with Change actions, and Start browsing.                                                          | Appearance and Privacy read `uiColorMode` and `privacyProtectionLevel` from the settings snapshot. Search reads `defaultSearchEngine` from the privacy snapshot (falling back to the settings value, then `ddg`) and shows the engine name from `availableSearchEngines`. Until that list loads it shows Firefox's name for a known default id (`ddg` as DuckDuckGo, and `google`, `bing`, `wikipedia`, `ebay`, `perplexity`), else the id itself. Change jumps to step 1, 3, or 4. Start browsing closes onboarding. |

Steps 1 to 6 show "Step N of 6"; every step after Welcome has a Back action.
Back, Continue, Skip, and Change are all ordinary step changes, so each one
stores the new index like any other (see the resume paragraph below), and focus
moves to the new step's heading after every change but the first render. `bento-tools` stays
the source of truth: the shell only dispatches the port messages above and reads
the resulting snapshots.

The Appearance step writes `BentoSettings.uiColorMode` from its Light, Dark, and
Auto tiles; Auto is stored as `system` and resolved by the theme/chrome flows
(see [theming.md](theming.md)). Fresh profiles default `uiColorMode` to `light`.
The write happens on selection, not on Continue, so the dialog and the browser
repaint while the step is still open. The Privacy and Search steps dispatch the
same actions as Settings (see [privacy-search.md](privacy-search.md)) and leave
`welcomeSeen=false`.

The sidebar frame and hidden welcome frame both request the overlay when the
settings snapshot reports `welcomeSeen=false`; chrome treats `BENTO_OPEN_WELCOME`
from either frame as an idempotent show request so cold-start title races do not
suppress onboarding. The React dialog is controlled open, disables backdrop and
keyboard dismissal, and has no dismiss or skip-onboarding action (the Import
step's Skip only advances to Privacy); chrome also consumes Esc while welcome is
visible without hiding it. Only the final `Start browsing` action sets
`welcomeSeen=true`.
When import is selected, the welcome page stores the next onboarding step in
`browser.storage.local` as `bento-welcome-step` without setting
`settings.welcomeSeen=true`, waits for that write before signaling
`BENTO_IMPORT_BROWSER_DATA_<nextStep>_<ts>`, and advances its own step state so
the user continues onboarding after import closes. The shell always sends the
real next step in that title (`3` after Import, so
`BENTO_IMPORT_BROWSER_DATA_3_<ts>`), and chrome carries exactly that value into
the restart handoff below. The localStorage mirror is
only a development fallback because the extension `moz-extension://` origin can
change across the restart-to-startup-migration path. The chrome frame loader also
carries the next step through `BENTO_WELCOME_STEP` during the native restart and
passes it back to `welcome.html` as the `#bentoWelcomeStep` hash value, so the
post-import step survives Firefox's startup migrator even if extension-origin
storage was invalidated. `bento-shell-mount.js` responds by
opening `#bento-embedded-import-frame`, an in-process chrome `browser` that loads
`chrome://browser/content/bento-migration-host.html`. That static Bento host lives
under `src/browser/base/content/bento-migration-host.{html,css,js}`, embeds
Firefox's reusable `<migration-wizard>` component, loads Bento's generated
chrome public Mux token stylesheet, maps Firefox in-content wizard variables to those
tokens, installs `bento-migration-wizard-bridge.css` into the wizard's open
shadow root so the native selector, buttons, cards, and lists follow Mux-compatible
BEM styling, mirrors the resolved chrome light/dark mode through the iframe URL,
suppresses Esc, and signals close/restart back to chrome through
`BENTO_CLOSE_EMBEDDED_IMPORT` and `BENTO_RESTART_EMBEDDED_IMPORT` title
sentinels.
The host's `html` and `body` must stay transparent against Firefox's in-content
`:root` canvas rule so the onboarding dialog and its scrim remain visible around
the card in both color modes
([overlay-documents.md](overlay-documents.md#chrome-overlay-transparency)).
Regular Chrome/Chromium imports in this embedded wizard use Firefox's native
runtime migrators and are separate from Bento's manual browser-session merge.
Those migrators import supported browser data through Firefox's migration layer;
they do not depend on `bentoExternalSessions` or Bento's Chromium persisted
session-file parser. A Chrome row marked unavailable in the manual merge palette
therefore does not by itself indicate that the settings/onboarding Chrome import
is unavailable.
`bento-shell-mount.js` imports `MigrationUtils.sys.mjs` before showing the host
so Firefox registers the `MigrationWizard` JSWindowActor. The core patch adds
`chrome://browser/content/bento-migration-host.html` to that actor's allowlist.
The same patch also filters `startupOnlyMigrator` entries out of
`MigrationWizardParent` when `MigrationUtils.isStartupMigration` is false; the
embedded wizard must not offer Firefox/Zen as ordinary in-window imports because
their resources copy live profile databases.
For full Firefox/Zen profile copy, the embedded host exposes an explicit
Firefox/Zen action that signals `BENTO_RESTART_EMBEDDED_IMPORT`.
`bento-shell-mount.js` (`restartToBrowserImportFromWelcome`) then sets
`BENTO_RESTART_TO_MIGRATION=1`, `BENTO_MIGRATION_SCOPE=firefox-zen`, and
`BENTO_WELCOME_STEP=<nextStep>` and restarts Bento.
`patches/core-ui/09-bento-firefox-profile-first-run-import.patch` consumes the
one-time `BENTO_RESTART_TO_MIGRATION` flag in `nsAppRunner.cpp` and enters
Firefox's native startup migration path before user prefs and the fresh profile
are initialized. The same patch makes
`MigrationWizardParent.#getMigratorAndProfiles` honor `BENTO_MIGRATION_SCOPE`:
while `MigrationUtils.isStartupMigration` is true and the scope is `firefox-zen`,
it returns null for any migrator key other than `firefox`/`zen`, so the startup
wizard is scoped to Firefox/Zen and lands preselected on them (the wizard
default-selects the first list entry) instead of defaulting to Chrome and
re-listing the runtime browsers. The generic fallback path
(`restartToBrowserImportFromWelcome()` with no argument, used when the embedded
runtime wizard cannot open) sets the scope empty so the startup wizard still
offers every browser. After migration, onboarding opens again because
`welcomeSeen` is still false and continues from the stored step. For the
startup-migration path, the authoritative resume source is the
`#bentoWelcomeStep` hash that chrome stamps onto the welcome frame after reading
`BENTO_WELCOME_STEP`; `browser.storage.local` and localStorage are secondary
resume stores. Final dismiss paths clear the stored step, set `welcomeSeen=true`,
and close the overlay. A stored or hashed value outside 0 to 6 is ignored; with
no valid resume source onboarding starts at Welcome.
Chrome's fallback constant `BENTO_WELCOME_POST_IMPORT_STEP = '2'` in
`bento-shell-mount.js` seeds `__bentoPendingWelcomeResumeStep` and is returned by
`parseWelcomeImportResumeStep` when an import title cannot be parsed. In the
seven-step flow index 2 is the Import step, so a fallback now lands on Import
instead of the step after it. This is harmless because the shell always sends
the real next step (3) and the fallback is not reached on the normal path; it is
left for a later chrome change.
For local development, `scripts/sync-builtin-addon-symlinks.sh` must refresh
every built `engine/obj-*` app bundle because `scripts/dev-launch.sh` chooses
the newest `Bento.app`; otherwise `pnpm run dev:fresh` can launch a stale bundle
whose built-in welcome assets do not match the current source. The sync script
links built-in addon `dist/` directories and privileged addon `experiments/`
directories; keep both paths synced because Bento Tools experiment APIs and
bundled experiment assets are outside the Vite-built `dist/` tree.
`scripts/dev-profile-clean.sh` preserves `xulstore.json` so window geometry and
sidebar width survive repeated `pnpm run dev` launches, but it must not wipe a
live profile lock. Both `dev-profile-clean.sh` and `dev-launch.sh` check
`.parentlock` with `lsof` and abort when the previous Bento instance still has
the dev profile open; otherwise a fast second launch can put two parent
processes on the same profile and make chrome/sidebar resize behavior
intermittently choppy. A stale, unopened `.parentlock` from an already-exited
instance remains cleanable. Because the cleaner recursively removes every
non-allowlisted entry, it also resolves the configured profile path and refuses
to clean the repository root, a symlink target outside the checkout, or any
other path outside the Bento repository. Inside the checkout it refuses a path
that contains git-tracked files (`git ls-files`), whose first component below
the root is a tracked top-level entry, `.git`, `engine`, `node_modules`, or
`.bento` (compared case-insensitively), or that cannot be checked because git
fails. It cleans an existing directory only if that directory is empty, holds
the `.bento-dev-profile-marker` file the script writes on first use, or already
has `times.json` or `prefs.js` (profiles from before the marker). A missing
directory is created and marked. The marker is in the `KEEP` allowlist. Session
recovery files (`recovery.jsonlz4`, `recovery.baklz4`) are still deleted on
purpose. `scripts/dev-profile-clean.test.mjs` exercises these rules against
temporary git repositories.
The welcome overlay browser stays mounted under `#browser` so its title-IPC
open/close signals stay reliable. Bento modal overlays also share a separate
`bento-overlay-toolbar-scrim` for the native toolbar/urlbar strip, which
otherwise paints above in-document overlays so an in-document `Dialog.Backdrop`
can only dim the content area. The scrim is a `div` with `popover="manual"`
appended to `<body>`; its UA popover layout is overridden into a top strip
(`position: fixed; top:0; left:0; right:0; bottom:auto`) with its `height` set
on show from the live toolbar rect (the gap above `#browser`), so it dims
exactly the toolbar strip and never overlaps the content backdrop. Its dim is
`background-color: var(--scrim)` — the SAME token Mux UI's `Dialog.Backdrop`
uses (`--modal-backdrop-bg: var(--scrim)`), so the toolbar dim matches the
content dim exactly. The popover background represents the first active modal;
when a modal is stacked over another modal, `bento-shell-mount.js` adds matching
fading child scrim layers so the toolbar/urlbar receives the same compounded
dim as the content-area `Dialog.Backdrop` stack. `showPopover()` /
`hidePopover()` control top-layer membership; opacity drives the fade (Mux `modal`
role; the popover is hidden once the measured fade has ended, and a re-show cancels
that wait); a
`resize` listener keeps the height aligned. Ownership is reference-counted by
overlay id (`palette`, `confirm`, `edit-workspace`, `merge-palette`,
`workspace-palette`, `welcome`) so a stacked modal can close without removing
the toolbar scrim that another still-visible modal needs. The floating address
bar does not own this toolbar scrim; its in-frame backdrop is transparent
modal context only, and only the opaque neutral-5 popup paints over the browser
content.

Why a popover and nothing else works — the critical pitfall: `#urlbar` is
declared with `popover="manual"` (navigator-toolbox.inc.xhtml), so the megabar
lifts it into the **CSS top layer**. Top-layer content paints above ALL
normal-flow content regardless of z-index, so any ordinary scrim (any
`z-index`, whether parented in `#navigator-toolbox` or on `<body>`) dims the
rest of the toolbar but leaves the address-bar pill bright on top. The scrim
must itself be in the top layer; top-layer paint order is show order, so a
popover shown when any Bento modal opens stacks above `#urlbar` and finally
covers it. `popover="manual"` is required (an `auto` popover would
light-dismiss and would not coexist with the urlbar's popover).

Earlier failed approaches (do NOT reintroduce): (1) a XUL `<panel>` — a native
popup window whose `level="top"` floated the dim over OTHER windows and whose
macOS vibrancy material stacked with the CSS dim into a too-dark band; (2) a
plain `div` in `#navigator-toolbox` and (3) a plain `div` on `<body>` with a
high `z-index` — both left the urlbar pill bright because z-index can't reach
the top layer.

Because Bento has a separate profile registry, the patch also makes
`FirefoxProfileMigrator.sys.mjs` enumerate Mozilla Firefox profile registries
directly when `AppConstants.MOZ_APP_NAME == "bento"`:

- Windows: `%AppData%/Mozilla/Firefox/profiles.ini`;
- macOS: `~/Library/Application Support/Firefox/profiles.ini`;
- Linux: `~/.mozilla/firefox/profiles.ini`.

On macOS, the same patch registers a Zen Browser migrator that reuses Firefox's
startup-only profile-copy resources and reads
`~/Library/Application Support/zen/profiles.ini`.

The Firefox/Zen startup handoff uses Firefox's startup-only, profile-copy
migrator. It can copy the source profile's Places database, favicons, cookies,
passwords, form history, bookmark backups, dictionary, sync metadata, telemetry
migration flags, and optionally session data according to Firefox's migrator
resources. For Zen specifically, Bento adds a `SESSION` migration resource that
reads `zen-sessions.jsonlz4` (falling back to
`zen-sessions-backup/clean.jsonlz4`), converts Zen `spaces` to Bento workspace
metadata, writes a fresh compressed `sessionstore.jsonlz4` in the target profile
with `IOUtils.writeJSON(..., { compress: true })`, and, when a browser window is
already open, calls `SessionStore.setBrowserState()` so the tabs appear
immediately after the wizard finishes instead of waiting for a second restart.
Do not call `SessionMigration.writeState()` for this path; Firefox's
`SessionMigration.sys.mjs` does not export that helper and the session resource
will fail with a warning in the import results.
Converted tabs carry Bento's WebExtension session keys:
`extension:bento-tools@bento.app:bento.workspaceId` on each tab,
`extension:bento-tools@bento.app:bento.activeWorkspaceId` on the restored
window, and `extension:bento-tools@bento.app:bento.importedWorkspaces` on the
window. `WorkspaceStore` consumes `bento.importedWorkspaces` at boot and can
adopt it later from live restored window session data; when the only existing
workspace is the untouched first-run "Personal" default, the imported Zen spaces
replace that default before being persisted through normal `bento.workspaces`
storage. `background.ts` retries WebExtension session-value reads for
session-restored tabs before assigning workspace fallback state, because
`tabs.onCreated` can fire before restored `extData` is readable. Zen `pinned`
tabs are imported as pinned Bento tabs. Zen `zenEssential` tabs are imported as
panel tabs by writing `extension:bento-tools@bento.app:bento.isPanel` plus
`extension:bento-tools@bento.app:bento.importPinnedPanel` on the restored tab;
the `bento.isPanel` marker also carries `pinnedPanel: true` so pinning does not
depend on a second session key racing in. `background.ts` consumes that marker
when `readPanelMarkerWithRetries()` restores the panel and immediately adds the
tab to `PinnedPanelsStore`. It also scans already-present tabs with
`bento.isPanel` markers during boot before the stale-marker sweep, because a
live `SessionStore.setBrowserState()` import can create tabs before
`bento-tools` has registered its `tabs.onCreated` listener. The same migrator
overrides
Firefox/Zen `brandImage` while running as Bento to use macOS `moz-icon://`
URLs for installed app bundles (`/Applications` and `~/Applications`) instead
of Bento's own `chrome://branding` icon. The migration wizard must quote those
dynamic URLs when assigning CSS `url(...)` values for the dropdown and selected
source icons; unquoted `moz-icon://file:///...?...` values can render as blank
icons. `FirefoxProfileMigrator.getSourceProfiles()` also filters the enumerated
Firefox/Zen profiles through `getMigrateData()` before returning them so empty
registry entries such as unused `default` profiles are not shown as disabled
dead selections. Do not open the Firefox/Zen handoff
automatically at process start and do not route it through Bento's Settings
backup/import code; that code is additive workspace JSON import and has
different data-loss semantics.

## Manual verification

Use a dev build with a throwaway profile, never a daily-driver profile.

1. Terminal: build the app (`pnpm run build`, or `pnpm run shell:sync` after a
   shell-only change), then launch a fresh profile, for example with the dev
   build and `--new-instance --profile $(mktemp -d)`. Note the directory if you
   need to relaunch the same profile in step 8.
2. Bento window: confirm the centered welcome dialog opens on Welcome with no
   "Step N of 6" text. Press Esc and click the scrim; the dialog must stay open.
3. Bento window: click Get started, then step through to Ready. Confirm
   "Step N of 6" counts 1 to 6, Back is present on every step after Welcome, and
   Back returns to the previous step.
4. Bento window, Appearance: click Dark, then Light, then Auto. The dialog and
   the browser chrome repaint immediately on each click, without pressing
   Continue.
5. Bento window, Import: confirm the source list is not clickable and the
   Firefox and Zen note is visible. Click Skip and confirm Privacy opens; click
   Back once to return to Import.
6. Bento window, Import: click Import browser data. The embedded import host
   opens above the dialog. Close it and confirm the dialog is on Privacy
   (step 3), not Import. Repeat, but choose the Firefox/Zen action (it needs a
   Firefox or Zen profile on the machine) and let Bento restart: after the
   startup migration finishes, onboarding must reopen on Privacy. The
   `#bentoWelcomeStep=3` hash is the authoritative resume source on this path;
   for Zen, imported workspaces and tabs must also be present.
7. Bento window, Privacy and Search: select a level and an engine, then open
   Ready and confirm both appear in the summary. Click each Change action and
   confirm it jumps to Appearance, Privacy, or Search, and that Continue walks
   forward through the later steps. Confirm DuckDuckGo is preselected on a fresh
   profile and privacy-oriented engines carry a Private tag.
8. Terminal: quit Bento from a mid-flow step and relaunch with the same
   `--profile` path. Confirm onboarding reopens on that step, not on Welcome.
9. Bento window: click Start browsing. Confirm the dialog closes and does not
   reopen after another quit and relaunch (`welcomeSeen` is true and
   `bento-welcome-step` is cleared).
