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
| 2   | `import`     | One button per browser found (Chrome, Safari, Edge, Brave, Vivaldi, Opera), a Firefox or Zen button, Skip, and Other sources.                | Browser buttons and Other sources store step 3 and signal chrome (below); Firefox or Zen stores step 3 and asks chrome to restart; Skip is a plain step change to 3. See [Import sources](#import-sources).                                                                                                                                                                                                                                                                                                           |
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
the user continues onboarding after import closes (while the dialog is cut out
for the wizard, see [Import handoff](#import-handoff)). The shell always sends
the real next step in that title (`3` after Import, so
`BENTO_IMPORT_BROWSER_DATA_3_<ts>`, followed by the dialog geometry when it can
morph and `_s-<migrator key>` when a browser tile chose one), and chrome carries
exactly that value into the restart handoff below. The localStorage mirror is
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

Welcome dialog pitfall: transformed entry animations count toward scrollable
overflow. The content column (`overflow-y: auto`) showed a scrollbar for the length
of every step change because the stage and tiles start offset by
`--muxui-semantic-layout-inset-tiny`; reserve room (`padding-block-end` of that
token on `.bento-welcome > .muxui-dialog-content`) instead of clipping.

## Import handoff

Opening the wizard (a browser tile, Other sources, or the fallback's Import browser data)
and the wizard's Cancel or Done read as one card: the
onboarding dialog reshapes into the wizard card and back. The wizard is
Firefox's own `<migration-wizard>`, which must live in an in-process chrome page
(`#bento-embedded-import-frame`, non-remote, in `#bento-embedded-import-host`);
the dialog is an extension page in `#bento-welcome-frame` (remote). They share no
DOM and no process, so lockstep animation of two surfaces drifts. Only the import
card travels. The dialog is cut out (`visibility: hidden`, the scrim stays) at a
moment when the card sits at the dialog's exact rectangle with the dialog's
surface, and cut back in the same way on return, so the swap is invisible. Both
hosts fill `#browser`, so a rectangle in one document is the same rectangle in
the other.

Source of truth: none (view state only; the resume step is persisted as before).
Renderer path: `bento-migration-host.{html,css,js}` own the card
(`html[data-bento-morph]` states `from`, `open`, `shown`, `close`, the measured
rectangles as `--bento-morph-*` custom properties, `window.bentoImportMorph`);
`bento-shell-mount.js` (the "Onboarding to import-wizard handoff" section) owns
the sequence and waits with `afterMotion`; the welcome page
(`welcome/importHandoff.ts`, `welcome/useImportHandoff.ts`, `welcome.css`) owns
the dialog's states.

Messages (every title keeps its timestamp suffix; the token is the click's ts):

| From to                | Message                                                                          | Meaning                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| welcome page to chrome | `BENTO_IMPORT_BROWSER_DATA_<step>_<token>_<x>_<y>_<w>_<h>_<r>_<vw>_<vh>_s-<key>` | Open the wizard. The dialog's rectangle, radius and viewport (px) follow when it can morph; absent or malformed means the plain fade. `_s-<key>` (last, optional) names the migrator to select, see [Import sources](#import-sources). |
| welcome page to chrome | `BENTO_WELCOME_HANDOFF_READY_<token>`                                            | The dialog's content has faded out (sent after the import title).                                                                                                                                                                      |
| welcome page to chrome | `BENTO_WELCOME_HANDOFF_HIDDEN_<token>`, `..._RESTORED_<token>`                   | `hide` or `restore` landed and was painted (two frames).                                                                                                                                                                               |
| host page to chrome    | `BENTO_EMBEDDED_IMPORT_READY_<hostTs>`                                           | The wizard left its loading skeleton (`#wizard-deck` `selected-view`) and has been laid out; `hostTs` is the `ts` chrome put in the host URL.                                                                                          |
| chrome to host page    | URL `?source=welcome&mode=<m>&ts=<hostTs>&dialog=x,y,w,h,r&migrator=<key>`       | The dialog's rectangle for the card; the migrator the wizard should select (see [Import sources](#import-sources)).                                                                                                                    |
| chrome to host page    | `window.bentoImportMorph.prepare/open/close/settle/cancel()`                     | Card states. Chrome calls `prepare` when it shows the page, so a page it gave up on never pins itself. `open` and `close` take a `started` callback and change state on the host's next frame.                                         |
| chrome to welcome page | frame script `BentoWelcomeHandoff`, `content.postMessage`                        | `{ kind: 'bento-welcome-handoff', phase, token }` with phase `hide`, `restore`, `reveal`, `fade-out`, `fade-in` or `reset`.                                                                                                            |

Sequence. Out: the click fades the dialog's content out (Mux `dismiss`), sends the
import title, and sends READY when the fade has ended. Chrome loads the host
hidden (`opacity: 0`, `display: flex` so it lays out; no fade for this open), and
when the host is ready and READY has arrived it calls `prepare()` (card pinned at
the dialog rectangle, content hidden), shows the host, and posts `hide`. The
dialog cuts itself out and sends HIDDEN; chrome calls `open()`: the card moves to
its centred rectangle on the geometry role while the wizard content fades in on
`modal`, starting at 40% of the geometry duration. When the geometry and the
content fade have both ended (two `afterMotion` waits, because the fade outlasts
the move) chrome calls `settle()` and the card is back in normal flow. The dialog
shows the next step (Privacy) while it is cut out. Back (`MigrationWizard:Close`):
chrome calls `close()` (the card pins at its current rectangle, then moves to the
dialog rectangle while its content fades out on `dismiss`), posts `restore` when
the waits end, the dialog cuts itself in with its content hidden and sends
RESTORED, chrome hides the host at once and posts `reveal`, and the dialog fades
its content in on `modal` and focuses its heading. The scrim is never touched.
Esc and backdrop clicks stay inert throughout: chrome consumes Esc while either
host is shown, and the host page suppresses it too.

Surface match. At the dialog rectangle the card has the dialog's computed
surface: fill `--muxui-semantic-surface-raised`, border
`--muxui-semantic-border-subtle` (dark mode:
`--muxui-semantic-color-neutral-default-90`, because Mux's dark scope overrides
the dialog's border), the measured radius (16 px), and the modal elevation, which
is the same `--shadow-l` value as the card's own, so the shadow needs no
animation. The card's sheen (the top gradient) is a layer of its own that fades in
with the move; the radius falls to `--radius-m` (8 px) and the border to the
wizard's. In the morph states the card drops its resting `min-height` (21.25rem),
because a dialog shorter than that, as in a window about 320 px tall, would otherwise
leave the card taller than the rectangle it has to match; the resting centred card keeps
the rule. `prepare()` reads the card's rectangle back and returns false when it differs
from the dialog's by half a pixel or more, and chrome then takes the crossfade. The
geometry runs on the Mux `reveal` role in one block of
`bento-migration-host.css`. `lint:motion` forbids an indirect `var()` in a
transition, so switching to `content-resize` means changing the duration and easing
tokens in that block and the duration inside the 40% delay (three names).

Dialog states (`bento-welcome--<state>`, `welcome.css`): `out` (content faded,
`dismiss`), `hidden` (cut out, instant), `restoring` (cut in, content hidden; it
fades in when the class goes), `faded` (crossfade: the whole dialog at opacity 0
on `modal`). The dialog takes no pointer input in any of them, and
`startBrowserDataImport` ignores a second activation.

Fallbacks. Every wait has a ceiling and ends in the behaviour from before the
handoff: the host fades in or out on `modal` over a dialog restored with `reset`.
Chrome's ceiling is `IMPORT_HANDOFF_CEILING_MS` (1.5 s) on each of: both pages
ready (host ready and READY), HIDDEN after `hide`, RESTORED after `restore`. A
missing rectangle, a missing frame script manager, a missing host page API, a failed
`open()`, or the wizard closing mid-motion also abandons the choreography
(`abandonImportHandoff`, `hideEmbeddedBrowserImport`). A `prepare()` that reports the card
cannot match the dialog takes the crossfade instead (see Resize). The page has its own
one-shot recovery, `HANDOFF_STALL_MS` (3 s): a dialog still in `out` or
`restoring` returns to idle, shows the pending step and takes focus, so a lost
message cannot leave it invisible; `hidden` and `faded` last as long as the
wizard is up and are ended by chrome. `restartToBrowserImportFromWelcome` calls
`hideEmbeddedBrowserImport()` then `hideWelcome()`, and
`hideEmbeddedBrowserImport` drops the whole handoff (timers, motion waits, the
`data-bento-import-handoff` attribute that makes the host's opacity instant, the
card state), so the Firefox/Zen restart path resets every piece. `unload` drops
it too.

Resize. The rectangles the morph uses are measured once (the dialog's, at the click;
the card's centred one, when each motion starts), and a resize changes both: the
dialog recentres by itself, so a card travelling to or from the recorded rectangle
would show a position or size jump at the swap. `showEmbeddedBrowserImportFromWelcome`
adds one `resize` listener on the chrome window for a morph and `dropImportHandoff`
removes it. `invalidateImportMorph` compares the host frame's viewport with the one
recorded at the click, on every resize and also right before each swap (the `hide`
after the pages are ready, the `open`, the `restore` at the end of the way back, and
Cancel), because a resize event can trail the layout the swap would use. A change
switches the handoff to the crossfade (`takeImportCrossfade`), by phase:

| Phase when the resize lands            | Result                                                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waiting` (wizard loading)             | The card is never shown. The host fades in on `modal`, the dialog gets `fade-out` and fades out with it (the reduced-motion path).                                         |
| `hiding`, `opening`                    | The card's motion and waits are cancelled; it falls to normal flow, centred in the new size, with the dialog already cut out. Closing is the crossfade.                    |
| `open`                                 | Nothing moves; closing is the crossfade (no return morph).                                                                                                                 |
| `closing` (return morph, after Cancel) | Motion and waits are cancelled, `hideEmbeddedBrowserImport` runs with the crossfade mode: the card falls to centre and the host fades out while the dialog gets `fade-in`. |
| `restoring`                            | Not handled (accepted): the dialog recentres while the card stays on the old rectangle until RESTORED, about two frames later, then the card hides at once. Ends correct.  |

The crossfade ends in the plain states: the dialog `idle` and focused on the step it
resumes on, the host hidden. A resize that puts the window back at its recorded size
does not undo the switch.

Reduced motion (`prefers-reduced-motion: reduce`, read by both sides): no
geometry and no slide. The host fades in on `modal` as before and chrome posts
`fade-out`, so the whole dialog, surface included, fades out with it, and back in
on the way back (`fade-in`). The same crossfade is used when the window is resized
(above).

Pitfalls:

- The body's `min-height: 100%` needs a definite root height: with an auto-height
  `html` the grid collapsed to its content and the card sat at the top. The host
  sets `html { block-size: 100% }`; the card's centred rectangle depends on it.
- The 40% delay and the geometry duration are written as Mux tokens in the
  transition, not through a custom property (`lint:motion`).
- `measure()` in the host page removes `data-bento-morph` to read the in-flow
  rectangle and must flush style after restoring it, or the next change starts
  from the in-flow style and nothing moves.
- Chrome reads the host document through `frame.contentWindow.bentoImportMorph`
  only after the READY title for this open's `ts`: the previous open's document is
  still loaded until the new URL replaces it.
- `open()` and `close()` change the card state inside a host `requestAnimationFrame`
  callback, and chrome starts its `afterMotion` waits from `started`. The host page
  is idle while the wizard is up, and the compositor-driven fades (opacity) of a
  transition started from an idle page took the clock of its last frame (up to
  about a second old) as their start, so they ran that far ahead of the card's
  geometry: the content was already gone when the card began to move. A frame
  callback reads a current clock.
- The content fade outlasts the geometry (40% delay plus `modal`): wait for both
  before `settle()`, or the fade is cut.
- The frame script relay is loaded before every post: it installs once per frame
  script global, and a replaced global has no listener.
- `pointer-events: none` on the card during the morph keeps a click from reaching
  the wizard mid-move; a close arriving mid-motion takes the abandon path.
- The card and the dialog are both visible for about one frame around each swap
  (the host is shown, then the dialog is cut; the reverse on return) and their
  shadows add: measured on 2x captures, the overlap frame differs from the lone
  dialog by up to 26 channel levels at the edge and 22 in the shadow band, while
  the dialog against the lone card (the state either side of the swap) differs by
  at most 3 and not at all inside. The other order leaves an empty scrim frame,
  which is worse.
- After a crossfade back from a morph the dialog goes `hidden`, `faded`, `idle`
  across two frames so the fade starts from opacity 0; the heading takes focus
  only after the commit that shows the dialog (`focus()` fails on
  `visibility: hidden`).
- A morph that checks the viewport only when the wizard closes (the first version)
  missed every resize before that: during loading or the out motion the card
  travelled from the click-time rectangle while the dialog had recentred, and a resize
  during the return morph left it heading for a stale rectangle. Invalidate on the
  `resize` event for every phase and re-check right before each swap (Resize above).
- `cancel()` removes the card's state attribute, but a running transition whose end
  value equals the in-flow value (the width and radius when the card was heading to
  its centred rectangle, the content's opacity) is not cancelled by the style change:
  it played on in normal flow, so the card wobbled in place after a resize. Left
  and top (end value `auto` in flow) did snap. `cancel()` therefore ends the card's
  animations (`getAnimations({ subtree: true })`) as well.
- The card's `min-height: 21.25rem` is a resting rule. Left on in the morph states it
  beat the measured `height` for any dialog shorter than 340 px, so the card could not
  match the dialog on either swap in a window about 320 px tall.

## Import sources

The Import step is a set of real buttons, not a description of what the wizard
supports. Chrome finds out which browsers the import wizard can list, the page
renders one tile per browser, and a tile opens the wizard with that browser
already selected. Source of truth: Firefox's migrators (nothing is persisted;
the resume step is stored as before). Renderer path: `welcome/importSources.ts`
(parsing, tile list, copy, grid spans), `welcome/useImportSources.ts` (the report
and its ceiling), `ImportSources` in `WelcomeSurfaces.tsx`, `welcome.css`; chrome
side, the "Import sources" section of `bento-shell-mount.js` and
`preselectMigrator` in `bento-migration-host.js`.

### Messages

| From to                | Message                                                                                    | Meaning                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| chrome to welcome page | `{ kind: 'bento-import-sources', status: 'ready', browsers: [{ key, logo }], firefoxZen }` | The report. `key` is a Firefox migrator key, `logo` a PNG data URL (48 px) or null, `firefoxZen` true when a Mozilla Firefox or Zen profile is registered. Sent when onboarding opens (`showWelcome`, from the overlay's ready signal), again on every request. |
| chrome to welcome page | `{ kind: 'bento-import-sources', status: 'failed' }`                                       | The detection threw, or did not answer within `IMPORT_SOURCES_CEILING_MS` (3 s) in chrome.                                                                                                                                                                      |
| welcome page to chrome | `BENTO_IMPORT_SOURCES_REQUEST_<ts>`                                                        | The page reached the Import step with no report (it reloaded, or chrome was still detecting). Chrome answers with the cached report.                                                                                                                            |
| welcome page to chrome | `BENTO_IMPORT_FIREFOX_ZEN_<step>_<ts>`                                                     | The Firefox or Zen tile. The page stored `<step>` (3) first. Chrome sets the resume step and calls `restartToBrowserImportFromWelcome(true)`.                                                                                                                   |
| welcome page to chrome | `BENTO_IMPORT_BROWSER_DATA_<step>_<token>[_geometry]_s-<key>`                              | A browser tile; the morph is unchanged (the tile is not its origin: the card still starts at the dialog's rectangle).                                                                                                                                           |

The reports travel on the same frame-script relay as the handoff phases
(`BentoWelcomeHandoff`, `postToWelcomePage`): the relay now forwards whatever
object chrome sends and the page tells messages apart by `kind`. The page parses
a report strictly (`parseImportSourcesMessage`): an unknown key is dropped, a
logo that is not a PNG data URL becomes null (the tile shows a globe), anything
else on `window` is ignored. The shell's CSP has no `img-src` restriction, so
data URLs render; chrome:// URLs cannot be loaded by a moz-extension page, which
is why chrome re-encodes each logo (`readImportBrandLogo`: decode the migrator's
`brandImage`, draw it at 48 px on a canvas, `toDataURL`).

### Availability

A tile for a browser means the wizard would list it. `MigrationUtils.getMigrator(key)`
is not that test: it returns a migrator when `isSourceAvailable()` or when
`!hasPermissions() && migrator.canGetPermissions()`, and the second call is not
awaited, so a Promise (always truthy) makes it return every Chromium browser whose
data folder exists without a readable `Local State`. On a Mac with a password
manager, `~/Library/Application Support/<Browser>/NativeMessagingHosts` is enough
for Edge, Brave, Vivaldi and Opera to come back from `getMigrator` while
`MigrationWizardParent.#getMigratorAndProfiles` does not list them. Detection
therefore applies the wizard's own rule on top (`wizardListsMigrator`): the
migrator is `enabled`, and either `hasPermissions()` is false and
`canGetPermissions()` (awaited) is truthy, or `getSourceProfiles()` is null (a source
without a profile list, such as Safari) or non-empty. Safari has no way to know in
advance whether the user will grant access, so it is offered whenever `~/Library/Safari`
exists, as the wizard does.

Firefox and Zen are startup-only migrators: `getMigrator` is always null for them in
a running window, and their `getSourceProfiles` reads
`MigrationUtils.profileStartup.directory`, which only a startup migration has. Chrome
code therefore instantiates `FirefoxProfileMigrator` and `ZenProfileMigrator`
(Bento's patch core-ui/09) and asks `getAllProfiles()`, the profile registry
(`profiles.ini`), for any readable profile. A registered profile with no
migratable data still shows the tile; the startup wizard then lists nothing for it.
Each registry is asked inside its own `try`: one that throws (logged as a warning in
the Browser Console) must not hide a profile in the other, so the tile appears when
either has one. `getResourcesInternal` is not used to check for data: it clears
`MOZ_RESET_PROFILE_SESSION` as a side effect.

The detection makes upstream log `No permissions for local state folder.` to the
Browser Console once per Chromium browser whose folder exists without a `Local
State` (the wizard logs the same when it opens).

### Preselection

`<migration-wizard>` selects `state.migratorKey` on its selection page, but its
public `MigrationWizard:RequestState` event cannot carry one. The wizard's actor
delivers every state with `Cu.waiveXrays(wizardEl).setState(clone)`, so
`preselectMigrator` in the host page replaces the instance's `setState` once, adds
`migratorKey` to the first selection state and restores the prototype method. The
key comes from the host URL (`migrator=<key>`), which chrome takes from the
`_s-<key>` part of the import title. It is added only when `state.migrators` lists
it: the wizard calls `#onBrowserProfileSelectionChanged(null)` for an unlisted key,
which throws before `selected-view` leaves `page-loading`, so the wizard would stay on its
loading skeleton (never pass an unchecked key; an earlier note that it falls back to
the first entry was wrong). The page imports the selection page id from
`migration-wizard-constants.mjs` (the module the wizard already loaded) and passes
nothing on any failure, which leaves the wizard on its own first entry. The key
is validated as `[a-z0-9-]{1,32}` in chrome and in the host.

### Firefox or Zen tile

The tile has no logo (Firefox ships none for either) and the restart glyph
(`rotate-ccw`). The page stores step 3, sends `BENTO_IMPORT_FIREFOX_ZEN_3_<ts>`, and chrome
runs the path the wizard's own Firefox or Zen action runs:
`BENTO_RESTART_TO_MIGRATION=1`, `BENTO_MIGRATION_SCOPE=firefox-zen`,
`BENTO_WELCOME_STEP=3`, restart. No Firefox core patch is involved.

### States and fallbacks

| State     | When                                                                  | Step shows                                                                                                                                                          |
| --------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| detecting | No report yet                                                         | Four static placeholder tiles (`aria-busy`, no loop), the normal description; Skip and Other sources work.                                                          |
| tiles     | A browser or Firefox or Zen was found                                 | The grid (four columns, two when compact); Firefox or Zen takes the columns left in its row (`firefoxZenSpan`: 2 on a new row when full, the whole row when alone). |
| none      | Report ready with nothing                                             | "No other browsers found on this Mac.", the file-import description, Other sources primary.                                                                         |
| fallback  | `failed` report, or no report after `IMPORT_SOURCES_CEILING_MS` (4 s) | No grid, today's description, one primary Import browser data action. A report arriving later still replaces it with the tiles.                                     |

The page's ceiling is longer than chrome's (3 s) so a normal failure reaches the page
as a `failed` report; the page ceiling only covers a lost message. The step is never
dead: Skip and the opening action are always there.

Pitfalls:

- Do not trust `getMigrator` alone (above); the wizard's list is the contract.
- Chrome-side images are not reachable from the page; never pass a chrome:// URL.
- A key the wizard does not list must never reach `migratorKey` (above).
- A throw from `FirefoxProfileMigrator.getAllProfiles()` must not skip the Zen check:
  the loop over both migrators catches per migrator, not around the loop.
- `Row` and `Column` render divs, which a `<button>` cannot contain; the tile body is
  spans laid out by `welcome.css` (see [Mux customisations](../mux-ui-component-customisations.md)).
- The frame script that relays to the page installs once per frame-script global and
  is loaded before every post; a message sent before the page subscribed is lost, so
  the page subscribes before it announces the overlay ready (`useImportSources` is
  called before `useOverlayReadySignal`).
- Under the test harness the restarted copy does not respawn (an `eRestart` of an
  unregistered app bundle only quits). Relaunch it by hand with the three
  environment variables above to reach the startup wizard.

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
5. Bento window, Import: confirm one button per browser installed on the machine
   (Chrome, Safari, and the others only when they have data), each with its logo,
   name and chevron, and a Firefox or Zen button marked "Restarts Bento" when a
   Firefox or Zen profile exists; the footer reads Back, Skip, Other sources. Press
   Tab: focus visits each tile with a visible ring, then the footer. Compare the
   tiles with the browsers the wizard lists (step 6, Other sources): they match.
   Click Skip and confirm Privacy opens with no scrollbar drawn while its content
   slides in (repeat on Search, Tour and Ready); click Back once to return to Import.
6. Bento window, Import: click a browser tile. The wizard opens with that browser
   selected (check the selector label), not the first entry; click Cancel. Click
   Other sources: the wizard opens with its first entry selected. The rest of this
   step applies to both. The dialog's content fades
   out, then one card reshapes from the dialog's rectangle into the centred
   wizard card and the wizard content fades in; no second dialog is ever visible
   and the scrim does not change. Press Esc and click the scrim during the
   wizard and during the motion: nothing happens. Click Cancel and confirm the
   card reshapes back, the dialog's content fades in on Privacy (step 3, "Pick a
   protection level", not Import), and its heading has focus. Repeat three times
   in one session, in Light and Dark. Then resize the window while the wizard is
   open and click Cancel: the dialog and the card cross-fade and the dialog is
   centred in the new size. Repeat with the resize while the wizard is still
   loading (right after clicking Import), during the card's move, and during the
   return move after Cancel: each ends with the wizard card centred (or the dialog
   showing again on Privacy), no jump between the dialog and the card, and a dialog
   that is never left hidden. In a window about 320 px tall the card still matches
   the dialog at both swaps, or the two cross-fade. Launch another fresh profile with
   `user_pref("ui.prefersReducedMotion", 1);` in `user.js`: the dialog and the
   card cross-fade with no movement. To watch the motion slowly, raise
   `--muxui-semantic-motion-reveal-duration`, `-modal-enter-duration` and
   `-exit-duration` on the root of the host document and of the welcome page
   (keep the exit duration under 1.5 s: it is part of the READY wait). Repeat the
   Import click, but choose the Firefox or Zen tile (it needs a Firefox or Zen
   profile on the machine) and let Bento restart: after the startup migration
   finishes, onboarding must reopen on Privacy. The `#bentoWelcomeStep=3` hash is
   the authoritative resume source on this path; for Zen, imported workspaces and
   tabs must also be present.
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
