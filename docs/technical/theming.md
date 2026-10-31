# Theming and color mode

Part of the [technical notes index](../core-functionality-technical.md).

Workspace theme metadata is stored as `Workspace.themeId`.

Shell theme flow:

- `scripts/sync-theme-presets.mjs` reads public `@muxui/react/themes`
  metadata, its `themes.css` rules, and its `styles.css` projection. All reading
  of Mux's CSS shape and theme list lives in `scripts/mux-css.mjs`, which
  `scripts/generate-chrome-tokens.mjs` shares; it derives the theme list from the
  package (no fixed count) and fails with a message naming the file and block
  when a rule, token or color-scheme pair is missing. It emits
  the shared `theme/presets/index.ts` registry (canonical ids, legacy
  monochromatic aliases), `theme/presets/index.css` (the Default theme and the
  legacy token bridge, imported by every entry), and one sheet per other theme,
  `extensions/bento-shell/public/themes/<id>.css`. Canonical sheets hold that
  theme's `data-muxui-theme` rules inside `@layer muxui`; repo-local custom
  themes are unlayered. All of these are tracked generated files.
- `extensions/bento-shell/src/theme/themeSheets.ts` attaches a theme's sheet as
  a `<link>` (`./themes/<id>.css`) only in documents that show the theme.
  `useWorkspaceTheme.ts` calls `applyRootTheme.ts`, which asks for the active
  workspace theme's sheet and writes `<html data-bento-theme>` (and the other
  scope attributes) once it has loaded,
  so the previous theme stays on screen until the new one can paint and a sheet
  that fails to load falls back to Default. Only an owner's latest request applies:
  a request a newer one replaced resolves `'superseded'` and neither sets
  attributes nor lets the displayed sheet be pruned (A, B, C with B loading first
  keeps A until C applies or fails). Default is inline, so the boot.js attributes
  paint it on the first frame exactly as before. Every component that renders a
  theme scope other than the document's own registers that theme for as long as it
  renders it (`useThemeSheet` / `useThemeSheets`): `PinnedPanels` (each pin uses its
  own workspace's theme), `WorkspaceSwitcher` (the avatar), `WorkspaceThemePicker`
  (the trigger and all 16 swatches) and the `workspace-switcher` overlay (one avatar
  per workspace), and `useInvertedThemeScope` (the floating sidebar cards, which
  render the sidebar's own theme in the opposite colour scheme).
  `themeScopeSheets.test.ts` fails when a file calls `getThemeScopeAttributes`
  without registering.
- Early sheet request (new windows). The workspace snapshot reaches a new
  window after its theme sheet could already have loaded, so the request starts
  before React mounts:
  - Source: `bento-tools` still owns `Workspace.themeId`. `applyRootTheme.ts`
    mirrors the theme it applied to localStorage `workspace-theme`, beside
    `color-mode` and `resolved-color-mode` (`writeThemeHint` in `themeSheets.ts`).
    It stores the resolved id (an alias or unknown id never reaches it; Default
    is stored as `default`) and writes only once the active workspace has
    reached the document and its sheet has loaded or failed (a failure stores
    `default`). The key is shared by every window of the profile, so the last
    writer wins.
  - Request: `public/boot.js` reads the hint and, for a value that matches
    `^[a-z0-9]+(-[a-z0-9]+)*$` (at most 64 characters, not `default`), inserts
    `<link rel="stylesheet" href="./themes/<id>.css">` into `<head>`, marked
    `data-bento-theme-sheet=<id>` and `data-bento-boot-sheet=loading`. Its own
    `load` and `error` listeners flip the marker to `loaded` or `failed`. The
    root theme attributes stay Default: the sheet may not have loaded by first
    paint. Membership in the theme list is not checked there (boot.js cannot
    import it); a well-formed id with no sheet costs one failed request.
    `public/panel-newtab.html` loads boot.js with `data-bento-no-theme-sheet`
    because it always shows Default and loads no shared stylesheet. Every other
    shell entry HTML loads `boot.js` and calls `useWorkspaceTheme`.
  - Adoption: the first `setThemeSheets` call in a document looks for that link
    and joins it to the normal bookkeeping (one link per theme, owner refcounts).
    A marker of `loaded`, or a sheet whose `cssRules` can be read, counts as
    loaded without waiting for an event that may already have fired. A link still
    loading is awaited through the same `load`/`error` listeners as any other.
    A `failed` link, an id that is not a registered sheet, and `default` are
    removed; the next request for that theme creates a fresh link (the retry).
  - Hold: a synthetic `boot` owner (`BOOT_THEME_OWNER`) keeps the adopted
    sheet, so the empty requests other owners make while the snapshot is still
    pending cannot prune it. `applyRootTheme` releases it as soon as the
    workspace is known: the root request has by then adopted the sheet when the
    theme matches, and a sheet for any other theme is pruned like any
    unreferenced sheet.
  - Cascade: the boot link precedes the shared stylesheet in document order
    (adopted sheets are never moved, because moving a link reloads it). Rule
    precedence does not depend on that: the `muxui` layer is first in either
    order (`theme/muxui.css` and each sheet only append to it, the shared sheet
    still declares `@layer muxui, bento;`), and every theme rule matches with
    three attribute selectors, above the `:root` and `[data-muxui-color-scheme]`
    rules in the shared sheet that set the same custom properties.
    Re-check this when a theme rule gets lower specificity (for example
    `:where()`) or the shared sheet gains a rule of equal specificity for a
    theme property.
- `useToolsPort.ts` includes the active workspace theme id in the active
  `BENTO_PANELS` payload.
- `bento-shell-mount.js` mirrors that payload's theme id to the chrome window
  root through `applyChromeThemeToDocument`, which attaches
  `chrome://browser/content/bento-chrome-themes/<id>.css` and sets
  `data-bento-theme` once it has loaded (see [chrome-tokens.md](../chrome-tokens.md)).

UI color mode flow:

- `BentoSettings.uiColorMode` is the source for shell and chrome UI mode. It
  accepts `light`, `dark`, and `system`; `system` is the user-facing Auto mode.
  A private window has its own mode, held in memory and never saved (see
  [Window-local sidebar state](shell-chrome-bridge.md#private-windows-the-bentoshellbus-relay));
  `useFirefoxTheme` therefore scopes the resolved-mode broadcast and its
  `resolved-color-mode` storage key to the window in a private window.
- `useFirefoxTheme.ts` resolves `system` against
  `(prefers-color-scheme: dark)`, updates shell `<html data-color-mode>` with
  the resolved `light`/`dark` value, and mirrors the stored preference to
  localStorage for pre-React boot. `theme/document-base.css` sets every shell
  page's `color-scheme` from that attribute, so native scrollbars and form
  controls match the UI mode instead of the page's `prefers-color-scheme`,
  which can follow the content color mode (a dark content mode drew the light
  sidebar's scrollbar with the faint dark-scheme thumb).
- `public/boot.js` reads that localStorage value before CSS loads. Explicit
  `light`/`dark` values paint directly; `system` paints from the current OS
  preference; missing values paint the fresh-profile Light default. It reads
  `workspace-theme` the same way (see the early sheet request above).
- Chrome receives `uiColorMode` through `BENTO_PANELS`, resolves `system`
  against the same media query, and applies explicit `data-color-mode` to the
  chrome root. If the settings mirror has not hydrated when the first targeted
  panel sync arrives, the shell forwards the pre-React boot value from
  `data-bento-color-mode-pref` / `data-color-mode`.
- The native Settings page (`about:preferences`) is its own document and links
  `bento-chrome-tokens.css`. Its root carries `data-bento-theme="default"`
  statically and `data-color-mode`, which `preferences.js` copies from the root of
  the window hosting the page (`patches/core-ui/12-center-native-preferences.patch`).
  `applyChromeColorMode` announces every change on the `bento-ui-color-mode`
  observer topic and the page re-reads its host window then, so a Settings tab
  moved to another window (a docshell swap keeps the document) keeps following
  instead of watching the window it first loaded in. A move into a window whose
  mode already differs announces nothing, so the page also re-reads when it
  becomes visible (`visibilitychange`) and on window `focus`. `preferences.css` sets
  `color-scheme` from that attribute so Firefox's own `light-dark()` tokens agree.
  The page's `prefers-color-scheme` does not follow `uiColorMode` (measured: it
  stays light with UI mode dark); it follows the content color mode and the OS.
- `bento-shell-mount.js` seeds chrome `<window data-color-mode="light">` before
  injecting chrome token/theme stylesheets. This matches Bento's fresh-profile
  default and prevents OS-dark chrome from flashing behind the light sidebar
  before the first `BENTO_PANELS` payload arrives.
- During that same startup interval, chrome sets `bento-startup-loading="true"`
  on the root, hides the native navigator toolbox, and shows a chrome-owned
  startup skeleton over the browser area. The skeleton is dismissed after the
  first `BENTO_PANELS` payload applies theme/color/sidebar state, with a timeout
  fallback so a failed sync cannot leave the window covered.
- Auto UI mode must resolve from chrome/sidebar state, not from ordinary
  content tabs. Bento's content color-scheme override can make
  `matchMedia('(prefers-color-scheme: dark)')` return the content preference,
  while chrome resolves Auto against the actual browser/OS theme.
  `useFirefoxTheme` writes `resolved-color-mode` from authoritative shell
  contexts, and the Settings palette consumes the same durable preference.

Content color mode is separate: `BentoSettings.contentColorMode` is applied by
`bento-tools` through Firefox's content color-scheme browser setting.

Theme authoring and import workflow is documented in [themes.md](../themes.md).

## Mode flip fade

Hosted Bento UI uses one presentation per native browser window. Native chrome,
the sidebar and presented overlays commit their final colours under an opaque
old-root image, then that image fades on the computed Mux `state` duration and
easing. The live new root remains opaque underneath. Webpage pixels are excluded
from the old image's clip and keep rendering and accepting input. This source
implementation still requires the integrated dev, dev:mux and genuine production
pixel/input checks; the earlier capture-kernel proof is not product validation.

### Mechanism

`BentoModePresentation.sys.mjs` owns the transaction. The mount registers one
presenter with `BentoShellBusHub` per actual native window. Hosted shell documents
have `bentoNativeMode=1` in their existing hash; the local bridge installs its
writer before React hooks run. Settings, media, storage, broadcast, direct native
notifications, same-mode notices and the panels backstop request the parent before
mutating colour attributes or publishing caches. Standalone previews retain
`modeFade.ts`'s local fallback.

The parent reads authoritative state through `requestModeState(actualWindow)`.
The hub supplies privacy, window/session identity and a nonce, and binds the read
to that actual window and the current background registration. Replacement,
disconnect and close reject pending reads; capture-critical reads never enter the
ordinary bus backlog. Regular windows use a correlated `snapshot/get` of the
settings service, which samples `uiColorMode` and its full `ColorStamp` without
an intervening await. Private windows read `PrivateWindowSettings` directly:
its ephemeral run/sequence belongs to the background/window owner, advances only
for an actual private mode preference change, survives document reload, and is
forgotten on native-window close. Global settings copies do not overwrite it.
The parent resolves Auto using the native window's current media query.

The renderer captures only `root`, with every non-root element unnamed. It sets
`data-bento-mode-presentation="theme"`, validates a safe clip before starting,
and calls `startViewTransition()` without an update callback. The old pseudo is
hidden until the ready reaction synchronously owns a finite paused opacity
animation and validates its clip, blend and pointer behaviour. The parent then
reveals it, submits `updateLayerTree()` and fences with `syncFlushCompositor()`
before announcing `ready` or issuing any native/remote colour commit. Setting
the visibility attribute alone does not establish the opaque cover. The
new-root pseudo stays live, opaque and below the old;
all view-transition pseudos have `pointer-events:none`.

Current, presented WindowGlobals with installed writers form the participant
set. A commit applies the granted preference AND resolved mode, never an old
closure. The child synchronously updates nested theme subscriptions inside
ReactDOM `flushSync`, flushes style while settle is installed, and calls
`windowUtils.updateLayerTree()` before ACK. That native method waits for the
transaction's receipt (`WaitOnTransactionProcessed`). After all current-document
ACKs, the parent submits its own layer tree and calls `syncFlushCompositor()`
once more before opacity playback. These are two one-shot boundary fences:
cover before commits, then final colours before play. There is no per-frame
polling, flush or timing compensation. Reduced motion
uses the same hold/barrier and then releases immediately.

### Scheduled flip

Hosted documents no longer schedule local colour transitions from `flipAt`.
The stamp remains owner ordering metadata; it does not establish presentation
readiness. Independent style, paint and compositor paths cannot be synchronized
by matching clocks alone. The standalone preview fallback retains its existing
local scheduler where the native bridge is absent.

### Requests: identity, deadline and supersession

Coordinator generation, actor document id, local request sequence, document nonce
and overlay host generation are separate identities. The parent derives routing
from the actual actor context, never supplied window ids. Navigation and stale
ACKs cannot submit or reveal replacement documents. Hidden/startup hosts settle
instantly; their readiness waits for a grant and reveal re-reads the owner before
unhiding. No hidden host waits for an animation frame.

A reversal reuses the same old image and opacity effect at its current progress.
At the old-opaque endpoint the finished reaction pauses synchronously before
awaiting the old target's underlying commit. Same-resolved preference changes
update metadata without another capture. Ordinary activity may settle the
presentation immediately; footer and Settings mode controls carry an owned
`data-bento-mode-control` marker so continuous reversal remains possible.
Transaction listeners/observers are removed on completion, cancellation or close.
Resize, host hide/reveal/navigation, panel membership/focus/geometry and workspace
theme changes retire an unsafe image. Capture waits for known host/panel motion,
native-popup dismissal and drag completion; unrelated icon/progress animations
do not gate it. Unknown geometry fails explicitly to an instant final commit,
without ever exposing a full stale webpage image.

### Stamp order

The authoritative owner supplies `{run, seq}` and optional `flipAt`. Native
notices are hints to re-read that owner, including a duplicate or same-mode
notice. A background replacement rejects its older pending reads; an older
coordinator read cannot overwrite a newer grant. Private stamps are per-window
and per-background-instance, rather than a copied global settings stamp.

### The CSS

The normal local fade and distinct `data-bento-mode-fade="settle"` rules share
`scripts/fade-twins.mjs`. Settle installs BEFORE any mode write. Every explicit
colour/carrier duration AND delay is `calc(Mux state duration * 0)`; the caller
flushes styles before removing it. Explicit colour entries follow any retained
`all`, preserving CSS's last-matching-entry semantics. Generated twins retain
geometry, opacity and other non-colour entries, including the palette highlight's
125 ms geometry, 250 ms opacity, rail spring and overlay motion. The footer's
`--bento-footer-fill` settles here while its normal rail choreography retains its
own spring outside the commit.

The native root's view-transition CSS is outside the generated twin block. Its
finite paused unit hold keeps the capture alive even at zero visual duration;
visible playback receives only the computed Mux state duration/easing. There is
no new motion token, per-element scan, duration compensation or colour rewrite.

### Registered colour carriers

Existing registered colour carriers for native gradients, shadows, borders and
shell footer fill remain. Native inline toolbar token writers are flushed while
settle is active, before parent submission. An asynchronous workspace theme-sheet
completion reads the fresh hosted root scheme so a previously captured argument
cannot restore an old mode after ACK. Existing theme-sheet ownership and
supersession remain unchanged.

### Hosted overlay presentation

Native overlays retain their explicit host presentation contract: initial hidden,
ready, current-mode grant, acknowledged `presented=true`, then reveal/focus. The
hash hints preserve other URL/hash data and browsing-context-group behaviour.
False is committed only after exit opacity completes or an immediate hide. The
workspace switcher disables input at hide-start and preserves owned focus return;
menu and null-tooltip hides are immediate. Reload-before-reveal replaces the
address bar's pending reveal id and timers and resends its intended open payload.
Sidebar visibility and docshell activity/priority remain unchanged.

Presented shell documents report only the small public opaque Mux surface union
(command palette, dialog, alert dialog, menu BODY, popover and tooltip). Transparent
wrappers, scrims and shadows remain live. The parent maps fractional quads and
corner radii through the native host. Page holes come from actual rendered native
browser content quads, their rounded clipping owners and shared scrollport; a
visible docked DevTools frame is also live. Negative holes are disjoint and
deduplicated; positive corners and opaque native focus-ring footprints restore UI
using nonzero winding. Rounded-edge antialiasing fidelity is a required physical
runtime check, not established by geometry unit tests.

Page-to-footer focus can leave a native panel's `::after` ring in a partial-alpha
border-colour transition during preparation. Before clip collection, the
presenter finishes only that owned pseudo's running four border-colour
`CSSTransition` longhands to their intended endpoints and resolves its style.
Gecko's explicit `getAnimations({pseudoElement:'::after'})` query avoids a
descendant scan or another full state-duration wait. Other colour, geometry and
opacity animations are untouched. A steady unsupported translucent ring still
rejects capture; the live-page mask guard is unchanged.

### Native browser background paint policy

The earlier patch 17 background-compositor eligibility restriction has been
removed. Instant colour commits under one old-opacity image no longer require
changing background promotion. Global compositor preferences and ordinary page
eligibility remain upstream defaults. Patches 18 and 19 supply the scoped native
no-scroll root capture and theme-only capture-stage input preservation; both
require the own system-principal `navigator:browser` document. Rendering
suppression remains unchanged. Patch 19 opts in only for a same-document,
no-callback, explicitly marked, root-only capture and revalidates new membership.

### What does not fade, and why

Web pages, including their videos, animation and input, stay live through page
holes. Native OS menus/window controls remain system-owned. Invariant transparent
scrims and shadows remain live rather than being replaced with opaque masks.
Workspace theme/layout changes are separate activity and may settle an active
mode presentation. Standalone previews use their local fade; they are not proof
of native-window synchronization.

### Pitfalls

Do not restore per-document hosted deadlines, a global compositor preference,
a full-window webpage crossfade fallback, docshell inactivity, a named-control
transition, callback capture waits, or per-frame flushes. Do not ACK before known
nested theme-scope updates or let a late stylesheet continuation rewrite the old
scheme. Do not remove the opaque hold before a reversal's underlying commit.
Keep actual-window ownership and current-WindowGlobal checks at every actor await.

Keep `bento-add-panel-trailer` out of `modePageFrames()`'s active slots. Its
`split-view-panel-active` class enables painting, but its saved-panel grid and
interior fill are Bento UI covered by the shared old image. Treating that frame
as a live page hole exposes final colours before the surrounding fade completes
in either direction. Keep its native-mode registration and settle/ACK path intact.
`scripts/mount-motion.test.mjs` exercises the actual frame selection function;
verify both flip directions in the native panels view with the trailer visible.

### Measurements

The following records describe the superseded per-document fade, not acceptance
of the shared presenter above. Retained as diagnostic history.

Two kinds of evidence sit behind the design. The screen recordings below (2026-10-25, a test app with
a visible window) are from earlier rounds; they are the only on-screen evidence and were not repeated
since. The headless results after them (2026-10-26) are from the integrated tree and are the current
numbers.

#### Screen recordings (2026-10-25)

- Delivery is per document (unscheduled, the state before `flipAt`): the documents started the
  fade when they received the mode. Measured in a test app on 2026-10-25 (the flip sent through
  the tools store; start of the attribute in each document, `performance.timeOrigin + now()`,
  medians of 12 flips, 3 cold first flips). Before the direct chrome leg, chrome was the slowest
  document (tools, `emitPanelsSync`, `browser.tabs.get` per visible panel, the `BENTO_PANELS`
  title IPC, `applyChromeColorMode`); with it chrome starts with the lightest overlays:

  | Case                                            | Chrome start  | Sidebar start | Spread                   | Slowest document              |
  | ----------------------------------------------- | ------------- | ------------- | ------------------------ | ----------------------------- |
  | Warm, before                                    | 63 to 73 ms   | 13 to 21 ms   | 60 to 70 ms              | chrome                        |
  | Warm, direct leg                                | 9 to 12 ms    | 25 to 31 ms   | 22 to 27 ms              | sidebar                       |
  | Settings palette open, before                   | 99 to 105 ms  | 13 to 27 ms   | 92 to 99 ms              | chrome                        |
  | Settings palette open, direct leg               | 7 to 10 ms    | 19 to 29 ms   | 49 to 73 ms              | Settings palette              |
  | Warm, direct leg + store subscribe + frame read | 7 to 12 ms    | 12 to 19 ms   | 12 to 15 ms (median 13)  | sidebar                       |
  | Settings palette open, same                     | 8 to 12 ms    | 13 to 19 ms   | 43 to 113 ms (median 50) | Settings palette, 44 to 65 ms |

  Attribute times understate what is painted: a screen recording of the window (below) showed
  the fade starting 25 to 30 ms after the titlebar in the sidebar and 55 to 60 ms in the Settings
  palette (spread of the 50% times 61 to 72 ms, 129 ms for the first flip of a run), and the
  sidebar footer 25 to 30 ms after the rest of the sidebar, which is how the scheduled flip and
  the footer change below came about.

- Recording method (2026-10-25, a test app on a fresh profile, window frontmost and unoccluded on
  the primary display, `screencapture -v -V <s> -R x,y,w,h`, 60 fps, 1280 x 1040): mean luma of
  7 regions per frame (titlebar, sidebar background, tab row, sidebar footer, palette body, header
  and footer; `ffmpeg ... crop, signalstats`), the 5, 10, 50 and 95% crossings of each region's
  change per flip (linearly interpolated), the video clock aligned to the wall clock with a
  magenta 8 px marker the rig inserts in the chrome window 200 ms before each trigger, and
  in-document probes (a `MutationObserver` on `data-bento-mode-fade` and `data-color-mode`,
  `transitionrun`, a run of `requestAnimationFrame` times, BroadcastChannel arrivals). The
  Settings palette was opened at the colour mode list (`BENTO_OPEN_SETTING:setting:uiColorMode`
  title from the command palette frame), the choice made with ArrowDown or ArrowUp and Enter sent
  as trusted key events; the sidebar sun button was focused and activated with Enter (this
  Firefox has no `windowUtils.sendMouseEvent`); it cycles light, dark and Auto, and Auto resolves
  to the OS appearance, so every second press changes nothing and was not counted. Load: four
  `yes` loops, or one per logical CPU (18) with https://x.com in the tab.

  Scheduled flip, 120 ms lead, medians per flip (ms after the trigger; the trigger is the Enter
  key, or the focused button activation):

  | Case                         | Flips | Trigger to titlebar 10% | Spread of 50% times: median / max | Within 1 frame + 8 ms (24.7) |
  | ---------------------------- | ----- | ----------------------- | --------------------------------- | ---------------------------- |
  | Before: palette, no schedule | 6     | 23 to 50                | 68 / 129                          | 0 of 6                       |
  | Palette, idle                | 12    | 149 to 177              | 9.5 / 45.3                        | 11 of 12                     |
  | Palette, idle (second run)   | 12    | 148 to 192              | 8.7 / 37.9                        | 10 of 12                     |
  | Palette, 4 busy loops        | 8     | 147 to 168              | 5.3 / 18.0                        | 8 of 8                       |
  | Palette, 18 loops and x.com  | 8     | 153 to 201              | 10.5 / 52.5                       | 6 of 8                       |
  | Sidebar button, idle         | 8     | 127 to 151              | 3.8 / 7.8                         | 8 of 8                       |
  | Sidebar button, 4 loops      | 8     | 132 to 157              | 3.8 / 6.8                         | 8 of 8                       |
  | Sidebar button, 18 loops     | 8     | 138 to 169              | 6.0 / 26.2                        | 7 of 8                       |

  The click-to-flip delay is the lead plus tools' persist and stamp time (15 to 40 ms after the
  Enter key, through the relay) and the chrome window's frame. The fade then runs 120 ms.
  Per region in the idle palette runs (medians): the titlebar and the palette fade over about 80
  ms (5 to 95%); the sidebar background, tab row and footer over about 55 ms, because their first
  painted frame comes 25 to 30 ms after the others (the extension process renders the palette
  and the sidebar one after the other) while the fade itself is on the shared clock and ends with
  the others (95% within 2 ms), so the sidebar's visible fade is shorter by the late first frame
  and not by its duration. The sidebar footer and the rest of the sidebar are now the same
  (identical onsets). Tools' lead sweep, idle palette flips with the fade start more than one
  frame plus 8 ms apart: 80 ms 1 of 8, 100 ms 1 of 12, 120 ms 1 of 12 and 2 of 12, 160 ms 2 of 16.
  Left over, with no lead that fixes it: now and then (about one flip in ten) the extension
  process stalls for 60 to 140 ms around `flipAt` (the sidebar and the palette apply late, chrome
  on time) and the sidebar's first painted frame follows the palette's; under full CPU load the
  chrome window's own frames also drop, which shows as a slower titlebar fade, not a late start.

Many tabs (2026-10-25, after the scheduled flip). With a few hundred tabs the chrome titlebar
and toolbars stepped to the new colours in one frame, 60 to 125 ms after the sidebar started
to fade. Three causes, fixed in this order:

1. The chrome's fade rule had started about 3000 transitions (the collapsed native tab strip and
   the panel container of every background tab, none of them painted), each fade frame took 25
   to 60 ms, and the titlebar showed two or three frames of it. Those subtrees now take
   `transition: none !important` ("Cost, and what the rule leaves out"); a 208 tab window starts
   194 chrome transitions.
2. The rule lost to `transition: none !important` rules and the scoped schemes and root hooks
   rendered late ("Why it is layered", "Scoped colour schemes follow the root in the same task",
   "Nothing high in the tree may hold the mode in React state").
3. What was left was the sidebar's first fade frame: in a 208 tab sidebar the style
   recalculation and the creation of about 1000 transitions came after the deadline, so the
   first frame with a visible change was 10 to 60 ms behind the titlebar's in the flips that
   failed, however the rest was tuned (fewer transitions are possible, the elements still
   animate each frame). "Prepare, then show" moves that work into the lead window. A
   transition-event stopper and a catch-all without `color` (which cuts the first animation
   frame from 76 to 97 ms to 50 to 55 ms but changes what fades) were tried and are not in the
   tree.

Measured with the recording method above (a test app on a fresh profile, Andrew's layout with
the monochrome-teal theme, the window frontmost, 16 flips per row; "within" counts flips whose
spread of the 50% times across titlebar, sidebar, rail, footer and, for the palette rows, the
palette is at most 24.7 ms, one frame plus 8 ms; cells are within / spread median, max):

| State                              | origin/main      | Prepare then show, dev build | Prepare then show, release build |
| ---------------------------------- | ---------------- | ---------------------------- | -------------------------------- |
| Plain, sun button                  | 8 of 8 / 3, 5 ms (8 flips) | 16 of 16 / 1, 18 ms | 16 of 16 / 1, 5 ms |
| Plain, palette                     | 16 of 16 / 4, 13 ms | 16 of 16 / 1, 6 ms        | not run                          |
| Andrew's layout, sun button        | 16 of 16 / 4, 12 ms | 16 of 16 / 3, 7 ms        | 16 of 16 / 4, 7 ms               |
| Andrew's layout, palette           | 8 of 8 / 10, 18 ms (8 flips) | 16 of 16 / 4, 9 ms | 16 of 16 / 6, 11 ms              |
| Andrew's layout, 208 tabs, sun     | 5 of 16 / 33, 94 ms | 16 of 16 / 7, 10 ms (a)   | 16 of 16 / 7, 12 ms                  |
| Andrew's layout, 208 tabs, palette | 1 of 16 / 51, 80 ms | 16 of 16 / 9, 14 ms (a)   | 16 of 16 / 8, 11 ms                  |
| Andrew's layout, 400 tabs, sun     | 4 of 16 / 56, 111 ms | 16 of 16 / 7, 12 ms (a)  | 16 of 16 / 8, 12 ms                  |
| Andrew's layout, 400 tabs, palette | 0 of 16 / 111, 166 ms | 14 of 16 / 11, 34 ms    | 16 of 16 / 10, 18 ms                  |
| standard-blueprint, sun button     | not run          | 16 of 16 / 10, 15 ms         | not run                          |
| standard-violet-dusk, palette      | not run          | 16 of 16 / 10, 15 ms         | not run                          |

(a) Measured on the final dev build. The other dev cells were measured on the build before the
last edits to the property lists (`accent-color`, `scrollbar-color` and `text-shadow` were still
listed, then removed) and the splitter accent, and were not repeated. The release column is the
final build.

In the release rows the titlebar's median 50% point is 2 to 9 ms after the sidebar's (158 vs 156
ms plain, 160 vs 155 at 208 tabs, 165 vs 156 at 400 tabs, 181 vs 175 for the palette at 400
tabs), well inside the frame.

With 208 tabs on origin/main the titlebar faded over a median 31 ms (a step) and with 400 tabs
over 22 ms; it now fades over a median 75 to 81 ms in every row, the 120 ms ease measuring
70 to 80 ms when nothing stalls the window. The longer fades seen in the previous batch (a
median 152 ms at 208 tabs) went with the change: the parent process handled the settings change
(the `BENTO_PANELS` payload, its tab bookkeeping) during the fade then, and does so in the
lead window now, which is consistent with the measurement but was not isolated.

Cold first flips (the first flip after a fresh launch, rich state: 35 tabs, 3 pinned, two
folders, two side panels): 6 launches, 3 on the sun button and 3 through the palette. In
all six the fade attribute went on and off in chrome, the sidebar and (for the palette) the
palette, the sidebar's 10 to 95% span was 63 to 73 ms (a snap would be one frame), and 5 of 6
were within 24.7 ms (spreads 8, 20, 9, 15, 26 and 17 ms). The audit anomaly of the previous
batch (a first flip with no fade in the collector run) did not recur with these probes, and
was not explained: the collector run arms a snapshot of every element in both documents just
before the flip and these runs do not, which is the one known difference.

The release build matches the dev build's CSS byte for byte (hash-compared) and differs in the
JS only by dropped `console` calls.

#### Headless method

The recording method above needs a screen. These checks run in a test app launched with
`MOZ_HEADLESS=1 --headless` on a fresh profile (no window, no display), driven over Marionette through
the settings action (the path of the footer button), by the tools in the lane C and validator scratch
directories (`flip_capture.py`, `analyze.py`, `matrix.py`, `realtime.py`; they are not in the repository):

- Element progress. Each document observes `data-bento-mode-fade`; when it appears, every
  CSSTransition is paused at `currentTime = delay`. The driver then sets `currentTime = delay + t`
  for t = 0, 20, 40, 60, 80, 100, 120 and 140 ms in every document and reads the computed colours
  of every element, shadow roots and `::before`/`::after` included. A (element, property) that
  changes must follow the eased progress at that t (within 0.1 of the change); one that already
  left its old value at t = 0 without a transition changed at preparation, not at the show time.
- Pixels. At each paused t, `canvas.drawWindow` for the chrome window and
  `WindowGlobalParent.drawSnapshot` for each visible remote frame (composed at its rectangle),
  then 10 px cells over the window with web content masked: in step (within 0.2 of the curve at
  every t), snap (a jump over 0.6 in one step where the curve moves less than 0.35), early
  (over 0.2 ahead of the curve), late (over 0.2 behind it), no change. The pixel and element tools
  read the prepare state in real time, so they need a long lead (the tools bundle's lead set to
  5000 ms in the git-ignored `dist`, never in the repository); with the shipped 120 ms they report
  `prepOk: false`, and every number below that used them says `prepOk` held.
- Start times. At the shipped lead, without pausing, `startTime + delay` of every transition per
  document. The probe waits for the first frame: forcing a style flush in the observer would create the
  transitions of scoped elements (workspace-themed buttons) before React has updated their scheme
  attributes, and show them as a second, later group that does not exist in real use.
- Frame gaps. A `requestAnimationFrame` loop per document, for the frame at `flipAt` and the
  frames of the lead window.

What headless cannot show: real vsync and compositor paint alignment across processes (the model
replays each document's own recorded start; it proves every document scheduled the same instant with
the same timing, not that the compositor shows each first frame in the same display refresh), frame
pacing on a screen, a real hide and show of a window (the headless app cannot hide one, so the
hide-time cleanup is covered by the unit tests of both runtimes and by a simulated `document.hidden`),
native widgets and the OS appearance, and compositor-only effects (`drawWindow` and `drawSnapshot` do
not use WebRender). The paused-time samples are what the style system computes at a chosen time, not
what a display shows; Andrew's own recording of the dev browser is the final visual check.

#### Headless results (2026-10-26, integrated tree, dev build)

Pixel grid and element audit, Andrew's layout (monochrome-teal) except the plain row, 8 flips per row
(4 to dark, 4 to light), long lead (`prepOk` true in every flip, prepare read 4.5 s before `flipAt`).
Every flip of a row gave the same counts. "Footer" is the settings action through the bus, the path of
the footer button; "Settings open" is the same with the Settings palette open and visible.

| State | Trigger | Flips | Cells in step | Early | Snap, late | No change | Cancels before `flipAt` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Plain (one tab) | footer | 8 | 3657 | 2 | 0, 0 | 1 | 0 |
| Andrew's layout | footer | 8 | 3466 | 2 | 0, 0 | 2 | 1 (flip 0, below) |
| Andrew's layout, 208 tabs | footer | 8 | 3459 | 9 | 0, 0 | 2 | 0 |
| Andrew's layout, 400 tabs | footer | 8 | 3462 | 6 | 0, 0 | 2 | 0 |

What the early cells are, in every row (the same cells in every flip):

- 2 cells at (190, 960): the footer colour button swapping its moon and sun glyph when the pref arrives
  (a React state change, the click's own feedback; not a colour).
- The tab list scroller's native scrollbar thumb at the sidebar's right edge (x 290 to 299; 7 cells at
  208 tabs, 4 at 400, none in the other rows because the list does not scroll): it follows the used
  `color-scheme`, which changes at prepare.
- The Settings palette rows below.
- Element level, chrome: 13 (element, property) rows changed at prepare with no transition in every state
  (4 x 20 px scroll-button icons of the two `arrowscrollbox` elements of the hidden native tab strip, a
  hidden tab's icon and the strip's periphery; all inside the hidden strip, painted nowhere). In the plain
  row two of the 13 are instead the single panel container's background (behind the page, 926 x 952), in place of the two pinned-tabs arrows. No fading
  property is off the curve in any row (snap 0, late 0), and no transition was cancelled before `flipAt`
  except the first flip of the Andrew row: the `::after` `color` of the selected panel container, cancelled
  by the panel reconcile at the prepare, with no painted cell changing.

With the Settings palette open (the same flips with the palette visible and the list scrollable; the
palette and the sidebar are separate documents that must agree):

| State | Trigger | Flips | Cells in step | Early | Outlier cells | No change | Cancels before `flipAt` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Plain | Settings open | 8 | 6762 | 21 | 1 (snap or slow) | 5616 | 0 |
| Andrew's layout | Settings open | 8 | 7179 to 7181 | 21 | 1 to 3 | 5197 | 0 |
| Andrew's layout, 208 tabs | Settings open | 8 | 7172 to 7174 | 28 | 1 to 3 | 5197 | 0 |
| Andrew's layout, 400 tabs | Settings open | 8 | 7175 to 7177 | 25 | 1 to 3 | 5197 | 0 |

The Settings rows' early cells: 17 are the palette list's native scrollbar (x 900 to 919, y 250 to 349;
it follows the used `color-scheme`), 3 are the value text of the Settings row for the colour mode
(content that swaps with the preference), 1 is the footer glyph, plus the sidebar scroller thumb at 208
and 400 tabs (7 and 4). The outlier cells are 1 to 3 single 10 px cells on the palette's heading row
(x 340 to 440, y 300 to 310), `snap` in one direction and `slow` in the other, every flip, with a net
luma change of 10 to 20 (an ordinary changed cell has more than 100). They sit on the heading text over a
background that fades the opposite way, which is the grid's blind spot ("Residuals of the fade"): every
element behind them is in step in the audit. Not isolated further, and not reproduced outside the
Settings palette.

The real Settings palette trigger (the colour option list; the value row goes pending) is not a pixel
row: the grid's baseline sample precedes the list opening, so it reads the list as early cells. That path
is covered by the cold first flips and the mutation census below (palette trigger) and by the value probe.

Start times at the shipped 120 ms lead (`realtime.py`, 8 flips per row, footer path; "start deviation" is
`startTime + delay - flipAt` of every transition, so the sync claim is about when the fade starts, not
when the attributes were written):

| State | Document | Transitions | Start deviation from `flipAt`, all flips | Delay given at the prepare | Late, pending, cancelled before `flipAt` |
| --- | --- | --- | --- | --- | --- |
| Andrew's layout | chrome | 260 | -0.4 to 0.4 ms | 116.2 to 119.8 ms | 0, 0, 0 |
| | sidebar | 201 | -1.0 to 0.0 ms | 95 to 112 ms | 0, 0, 0 |
| 208 tabs | chrome | 260 | -1.1 to -0.3 ms | 116.3 to 120.6 ms | 0, 0, 0 |
| | sidebar | 983 | -1.0 to 1.0 ms | 111.3 to 119.9 ms | 0, 0, 0 |
| 400 tabs | chrome | 260 | -1.1 to -0.2 ms | 116.5 to 120.3 ms | 0, 0, 0 |
| | sidebar | 983 | -1.0 to 0.0 ms | 93 to 113.2 ms | 0, 0, 0 |

Within a document every transition has the same start (spread 0.0 ms in every flip). The two documents
differ by at most 1.2 ms (Andrew), 1.6 ms (208 tabs) and 1.1 ms (400 tabs) in any flip. The sidebar
prepares up to 27 ms later than chrome in some flips (a delay of 93 against 120 ms), which the
deadline absorbs. The sidebar's transition count is the mounted rows (the list is virtualized), not the
tab count.

Probes at the shipped 120 ms lead (validator repros re-run on the integrated tree, one Marionette client
at a time):

- A flip that lands in a workspace switch (four workspaces; the switch fades `#tabbrowser-tabpanels`,
  `#bento-strip-container` and `#bento-panel-nav` out and in on opacity): flips submitted 0, 30, 60 and
  100 ms into the switch gave no `transitioncancel` and the same `run, end, run, end` as the no-flip
  control in chrome and the sidebar (fade frames 10 to 19, frames with both motions 6 to 16). Without the
  twins every delay cancelled all three elements about 1.3 to 1.5 ms after the prepare.
- A flip back inside the lead (a second request for the other mode 30, 60, 90 and 110 ms after the first,
  both directions) and a triple flip (requests 43 and 91 ms, 39 and 83 ms after the first): the final
  computed styles of chrome, the sidebar and the palette equal the settled styles of the last mode, and
  the attribute and the delay are gone.
- Late stamp (the event arrives 1, 30, 60 and 61 ms after `flipAt`) and then a hide: chrome's delays were
  -1, -30, -60 and 0 ms (a stamp later than 60 ms fades from the start); the sidebar's -2, 0, 0 and 0
  (it hears of the event later than chrome by the bus transport). In every case hiding the document
  dropped the attribute and the delay, the hidden document settled on the new mode, and showing it again
  resumed nothing.
- Six cold first flips (the first flip after a launch, three from the footer button and three through
  the Settings palette): the fade attribute went on and off in chrome, the sidebar and the palette, and
  the transitions of the documents started within 0.0 to 1.2 ms of each other (median per flip 1.0,
  0.2, 0.0, 1.1, 1.2, 0.05 ms) with 0.0 ms inside each document.
- DOM mutation census, the first 300 ms after the direct event (8 and 400 tabs, footer button and
  Settings palette): chrome 65 to 69 mutations (4 in the 400-tab palette run), nearly all the panel
  reconcile rewriting value-identical inline styles and classes; the sidebar 22 to 25; the Settings
  palette 0 to 69 (React Aria input attributes). Child-list changes: 1 node added and 1 removed in chrome
  (a header button's icon), 3 in the sidebar (the footer glyph and the title); nothing in
  the navigator strip, the flat layout overlays or the panel headers is removed and inserted again.
  `transitioncancel` events on painted elements: none, apart from the footer button's own press
  `background-color` transition (started 7 ms after the click, before the prepare), which the flip's
  transition replaces in both footer-trigger runs.
- Placeholders (`placeholder_probe.py`: computed `::placeholder` colour of every input of the chrome,
  the sidebar and each overlay, light and dark, at rest, focused and disabled): 66 rows, 36 with a
  placeholder text, 0 transparent; the colour equals the carrier in every row.
- The Settings row's value text while its row is pending (`value_probe.py`: pending cleared 20, 60, 100
  and 140 ms after the palette prepared). No shipped theme is asymmetric (in all fifteen the light
  neutral-50 equals the dark neutral-60), so the case that can show the dim colour was injected: the
  dark settled colour of the value set to a colour that differs from every light one. New rule: one
  `color` transition per flip (120 ms, delay 63, 88, 82 and 63 ms), monotone from the light dim colour
  to the dark one, in all four timings. The old rule (the dim also applied under the fade): two
  `color` transitions in all four. In monochrome-teal the colour does not change at all through the flip
  (dim light equals settled dark), so there is no transition on the value.

Frame gaps (`requestAnimationFrame` gap of the frame that contains `flipAt` and of the next one, 8 flips,
shipped 120 ms lead, no hover probe, Andrew's layout), against the same measurement on the frozen
batch (round 5, ms):

| Tabs | Document | Frame at `flipAt`: before | Frame at `flipAt`: now | Next frame: before | Next frame: now |
| --- | --- | --- | --- | --- | --- |
| 400 | sidebar | 29 to 92 (median 44) | 20 to 96 (median 33) | 17 to 83 (median 21) | 12 to 30 (median 17) |
| 400 | chrome | 29 to 50 (median 34) | 16 to 29 (median 17) | 8 to 34 (median 21) | 17 to 34 (median 29) |
| 208 | sidebar | 25 to 58 (median 27) | 20 to 33 (median 25) | 12 to 71 (median 12) | 12 to 34 (median 17) |
| 208 | chrome | 17 to 33 (median 29) | 25 to 38 (median 29) | 17 (all 8) | 12 to 21 (median 17) |

The first flip of a run is the slow one at 400 tabs (96 ms now, 92 before); the join rules, the hide
watch and the twins add no work to the frame at `flipAt`.

Release build (`BENTO_RELEASE=1 ext:build`, minified bundles, the tools bundle's lead set to 5000 ms in
the git-ignored `dist` for the pixel run, 6 flips per row, `prepOk` true), the same counts as the dev
build in every row:

| State | Trigger | Cells in step | Early | Outlier cells | No change | Cancels before `flipAt` |
| --- | --- | --- | --- | --- | --- | --- |
| Andrew's layout | footer | 3466 | 2 | 0 | 2 | 1 (flip 0, same `::after` as dev) |
| Andrew's layout | Settings open | 7180 to 7181 | 21 | 1 to 2 | 5197 | 0 |
| Andrew's layout, 208 tabs | footer | 3460 | 9 | 0 | 1 | 0 |
| Andrew's layout, 208 tabs | Settings open | 7172 to 7174 | 28 | 1 to 3 | 5197 | 0 |

The 208-tab footer row differs from dev by one cell (3460 in step and 1 unchanged, against 3459 and 2).
The release and dev stylesheets are the same source files; the bundles differ by minification and by
the `console` calls dropped from the JS.

### Residuals of the fade

Historical limitations of the earlier local-transition implementation follow.
They do not describe or validate the shared native presenter.

What a flip still does outside the fade, with the reason and the measurement behind each decision
(headless test app, Andrew's layout; the frame numbers are the sidebar document's
`requestAnimationFrame` gap at the frame that contains `flipAt`, 8 flips per row):

- A hover or focus change within about 240 ms of a flip (from the prepare to the end of the fade) waits
  as long as the flip did: the delay stays on `<html>` until the fade ends. A hover that began 48 to 76 ms
  after the flip waited 49.9 to 119 ms. A transition that is still waiting or running when the fade ends
  snaps to its end colour at cleanup, and one retargeted during the lead starts again with the full delay.
  Resetting the delay at `flipAt` was built and rejected (numbers in "The CSS"); a hover carrier was not
  built (a second attribute and a selector set per runtime for a residual of a few hundred milliseconds).
- The used `color-scheme` changes at prepare, up to the lead (120 ms) before the fade. In the headless grid
  the only early cells it causes are the tab list scroller's native scrollbar thumb at the sidebar's right
  edge (7 cells at 208 tabs, 4 at 400 tabs; x 290 to 299) and the scrollbars of an open palette's list
  (17 cells in the Settings palette). Holding it until `flipAt` was built twice and rejected. The root's
  `color-scheme` is inherited, so changing it at `flipAt` restyles the whole tree in the frame the fade
  starts: a discrete zero-length transition on the root (`color-scheme calc(<state duration> * 0)
  var(--bento-mode-fade-delay) allow-discrete`), and the same through a registered `--bento-color-scheme`
  variable, gave 400 tabs 54 to 108 and 62 to 108 ms (median about 100; the next frame up to 191 ms)
  against 29 to 92 ms (median 42), and 208 tabs 46 to 79 and 21 to 75 ms against 25 to 29 ms. At 100 ms
  the first painted frame of the 120 ms ease is about 98% done, which reads as a snap on a heavy sidebar.
  A third build held the root's variable and pinned the tab list's rows to the current scheme, so the
  rows do not inherit the change. The Gecko profiler's Styles markers counted the same work as without
  the hold (271, 263, 271 elements styled in the first restyle at `flipAt`, 400 tabs, against 251, 259,
  251; 926 without the pin), yet the sidebar's frame at `flipAt` was slower: 400 tabs median 92 ms, max
  142 (without the hold: 38 and 117; 16 flips each, fresh sessions in alternating order), 208 tabs
  median 48 ms, max 92 (29 and 138), and at 400 tabs the next frame had a median of 48 ms against 29.
  Elements styled does not predict the frame cost of a `color-scheme` change; it was not built into the
  tree.
- Text and glyph swaps that are content, not colour: the footer colour button's moon and sun and the
  Settings row's value text change with the preference, at prepare (the click's own feedback). Two early
  cells in every state, three more in the Settings palette.
- `accent-color` changes at prepare (chrome root; native checkboxes only, none visible). The other
  properties left out of the colour list are in "The CSS".
- Non-colour motion that Bento does not own is replaced while the fade is present: Mux popups, tooltips,
  backdrops, the switch thumb, the select arrow and progress fills that are entering or leaving at the
  moment of a flip jump to their end state, and an inline `style.transition` of the mount script (panel
  resize, drag release, sidebar hide) inside the 240 ms window ends at once. Bento's own non-colour
  transitions are kept by the generated twins.
- Rendered, not carried: a selected standalone `ToggleButton` hovered (Welcome only), the icon picker's
  `Tabs` overflow edge buttons hovered or pressed, and the Mux components Bento does not render. The
  native sidebar documents' placeholders and `about:logins`/passwords are not part of the fade.
- Hidden-strip elements: the 13 chrome (element, property) rows that change at prepare with no transition
  (scroll-button icons, a hidden tab's icon, the strip periphery) are painted nowhere. With the native
  strip shown, only `#tabbrowser-arrowscrollbox`'s arrows are carried; `#pinned-tabs-container`'s were not
  measured shown.
- Real display behaviour is not verified: vsync and compositor alignment across processes, the extension
  process stalling now and then (about one flip in ten, 60 to 140 ms around `flipAt`: the sidebar and
  the palette apply late and the chrome on time), and, under full CPU load, the chrome window's own
  frames dropping, which shows as a slower titlebar fade and not a late start. A real hide and show of a
  window is covered by unit tests and a simulated `document.hidden`.
- Other clock and ordering cases: an OS appearance change under Auto is never scheduled, so the
  documents apply it when they hear it (14 to 45 ms apart); reduced motion snaps in each document's own
  rendering update (up to a frame apart, 12 ms for dark and 2 ms for light measured); documents that hear
  of a change on either side of a system clock step agree only as far as their receipt times do; a
  message of the previous tools run that arrives after the first message of a restarted run can show
  the old mode until
  the next message; a private window's flips are not scheduled with the other windows'; a same-mode
  request keeps the earlier deadline by design.
- A write that is still pending when the fade ends dims the Settings value at that moment (one step,
  rare).
- `about:preferences` (patch 12) has not run in a real build (no engine here); the first build after the
  merge must check it. The native tab strip's other arrowscrollbox elements and the shadow DOM of
  future Firefox custom elements are listed under "What does not fade".
- The grid's blind spot: a 10 px cell holds the mean of its pixels, so a change that brightens one part
  of a cell while darkening another (a text glyph on a background that fades the other way: the
  Settings heading cell at (340, 300) reads `snap` in one direction and `slow` in the other with a net
  luma change of 13, while every element behind it is in step), or a thin glyph inside a large cell, can
  pass as "no change" or "in step" or as an outlier that is not one. The element audit (every element's
  computed colours at the paused times) covers what the grid averages out, and the grid covers images,
  gradients and native parts that computed styles cannot show.

## Shell bundle and stylesheet

- Source of truth: `extensions/bento-shell/vite.config.ts`. All React entries
  share one `style.css` (`cssCodeSplit: false`, Default theme only; the other
  themes are `dist/themes/<id>.css`) and chunk by Rollup's default
  rules. There is no `manualChunks`; `module-identity-guard.ts` fails the build
  when React, React Aria, or `@internationalized` would be bundled from two
  install paths (the cause of the `SubmenuTriggerContext` "is null" defect).
  Keep the `resolve.alias` entries and run the menu/submenu check below after
  any change to chunking or to the Mux, React Aria, or React versions.
- Fonts ship as WOFF2. `woff2-fonts.ts` converts the six TrueType files the Mux
  stylesheet makes Vite emit (2.74 MB) into WOFF2 (1.22 MB) and rewrites the
  `@font-face` sources; `@font-face` stays a local file under `assets/`. It runs
  before `panelNewtabCss`, whose Inter reference is `./Inter_opsz_wght_.woff2`.
  Brotli at maximum
  quality takes about 5 s for all six fonts, so results are cached under
  `extensions/bento-shell/node_modules/.cache/bento-woff2`. Do not point
  `@font-face` at a remote font.
- `mux-css-prune.ts` removes Mux component rules for families the finished bundle
  never names (`MUX_UNUSED_COMPONENT_CLASSES`: calendar, date pickers, radio,
  switch, slider, toast, tree, multi-select, and similar). See
  [mux-ui-component-customisations.md](../mux-ui-component-customisations.md#pruning-mux-component-css)
  before adding a family. A used family is never pruned, so adding a component to
  Bento needs no change.
- The build targets `firefox150` (`gecko.strict_min_version`) and disables the
  modulepreload polyfill. Sourcemaps stay `mode !== 'production'`; the package
  scripts always build in production mode, so none are emitted.
- Contrast is fixed to `standard`. The shell build strips every rule that
  requires `data-muxui-contrast='more'` (`contrast-more.mjs`, a PostCSS plugin),
  and the theme sync and chrome token generators do not emit them. Do not add
  `contrast='more'` CSS to Bento files while that is true. The plugin leaves
  rules with nested rules alone and turns an emptied `@layer name { }` block into
  `@layer name;`; deleting either would change the cascade for `standard`.
- `public/panel-newtab.html` is a plain page: no script, no Mux stylesheet. The
  `panelNewtabCss` plugin (`panel-newtab-css.ts`) bundles
  `src/panel-newtab/panel-newtab.css` into `assets/panel-newtab.css` with
  esbuild. Its heading keeps Inter through a
  page-local `@font-face` (weight 650) that points at the Inter file the Mux
  stylesheet makes the build emit into `assets/`; the Vite plugin fails the
  build if that file name stops existing. A hashed or renamed Inter file would
  otherwise silently fall back to the system font.
- `theme/document-base.css` holds the `html`/`body` defaults every entry
  inherits. They used to sit in `panel-newtab.css`, which the shared sheet
  carried into every document, so removing that file's global rules changed the
  sidebar background, the tooltip font, and the root color. When moving or
  deleting CSS that reaches the shared sheet, diff `html` and `body` computed
  styles for every entry in light and dark before accepting the change.
- `shell-document.css` holds the shell page's `html`/`body`/`#root` sizing
  (full height and width, no margin or padding, in `@layer bento.app`). It was
  part of `app.css`; `main.tsx` imports it right before `app.css`, and it still
  reaches every entry's document through the shared `style.css`. `app.css` now
  holds only selectors scoped to the shell's own classes, so Ladle loads it
  from `App.stories.tsx` (only the App stories render the shell layout; where
  the import sits no longer changes the layer order, see the next bullet) and
  never loads `shell-document.css`.
- CSS layer order is declared once, in `theme/muxui.css`: `@layer muxui, bento;`
  and then `@layer bento.tokens, bento.fonts, bento.components, bento.app;`.
  Later layers win, so the shell layout (`bento.app`) outranks the component
  rules (`bento.components`). Every entry's `main.tsx` and the Ladle provider
  import `muxui.css` before any other Bento stylesheet, so the statement is the
  first layer rule in every document. That includes component modules that
  import their own CSS: `components/primitives` loads `BentoStack.css`, so
  `muxui.css` goes above it. A new `bento.*` layer goes in that list;
  without it the layer ranks by whichever file declares it first, which differs
  between the dev server (one `<style>` per CSS module in import order), the
  build (one `style.css` concatenated in chunk order) and Ladle (story load
  order). `pnpm run lint:tokens` fails when a shell stylesheet uses a `bento.*`
  layer missing from that list. It reads each sheet's PostCSS tree (the shell's
  own `postcss` devDependency), so declaration values, strings and comments never
  count as layers. Only a root-level `@layer a, b;` statement in `muxui.css`
  counts as the list, not one inside `@media` or another block, and a statement
  with any invalid name orders nothing. The check rejects layer CSS it cannot read
  instead of guessing: a sheet PostCSS cannot parse, an escape in an at-rule name
  or in `@import` params (`@l\61yer`), an anonymous `@layer { }` block, a layer
  name that is not plain dotted identifiers (an escape or a string can spell
  `bento`), and an `@import ... layer(bento...)`. Keywords match in any case,
  layer names do not, and nested blocks (also through `@media`, `@supports`,
  `@container` and style rules) qualify the names inside them. Chrome CSS under
  `src/browser` is not scanned.
  `panel-newtab.css` does not import `muxui.css` and declares only
  `bento.tokens`.
- Rail colours (see "Rail colour" in [workspaces.md](workspaces.md#sidebar-collapse-and-expand)):
  `--bento-toolbar-main-bg` (the toolbar's main surface, neutral-14, shared by chrome's
  mount sheet and the shell's rail look) and `--bento-rail-band-fill` (neutral-18) are
  declared once in `bento-tokens.css` from public Mux semantic neutrals, so every theme,
  mode and contrast follows. A window with no side panels resets them (neutral-5,
  neutral-12): chrome under
  `:root[bento-no-side-panels]` for the main colour, the shell on
  `.bento-shell-app--no-side-panels`. The rail's `--bento-brand-bg` is re-pointed on
  `.bento-shell-app` in the rail look, not at `:root`; the document background keeps the
  brand colour.
- Known limit: the dev server (`pnpm --filter @bento/shell dev`) does not
  serve `assets/panel-newtab.css`; preview the page from a built `dist/`.

## Tab appearance preferences

`bento-tools` owns `BentoSettings.tabStateTintsEnabled` and
`customTabStateIconsEnabled`, both defaulting to `true` in `SettingsStore`.
The existing profile-wide `bento.settings` sparse overrides persist either `false`
value without a storage version change. The shared export schema and editable
settings rules accept booleans; reset, backup export/import and Settings snapshots
use the same store. The existing settings transport and shell mirror deliver updates;
no chrome bridge or Firefox state is added.

Every build exposes the Tab appearance category between Appearance and Performance,
including its command-palette search targets, in regular and private windows. The two
preferences are independent. `TabRow` resolves the row's state with `tabStateOf`
(`components/TabRow/tabState.ts`), a pure function of the tools-owned
`TabSnapshot` fields `url`, `loading`, `discarded`, `favIconUrl` and `pageError`. First
match wins:

1. `pageError === 'crashed'`: `crashed`.
2. `loading`: no state (the Mux progress circle stays, with no tint).
3. `discarded`: `sleeping`.
4. Any other `pageError` (`unavailable`, `certificate-warning`, `blocked`): that state.
5. `about:config` or `about:preferences`, with any `#section` or query:
   `internal-settings`.
6. No `favIconUrl`: `default`.
7. Otherwise no state, and the website favicon shows.

`tabStateTintsEnabled` controls only the row's `data-tab-state` attribute, set for
`unavailable`, `certificate-warning`, `blocked`, `crashed` and `internal-settings`.
`customTabStateIconsEnabled` controls only `TabStateIcon`, which replaces the favicon
slot for any state. With custom icons off, the loading indicator, real favicon and
placeholder branch is today's. Actual discarded styling and loading/sleeping titles
remain tools-driven.

`pageError` is read by `bento-tools` from the document the tab's browser shows (the
`bentoTabState` experiment; the mapping, the events and the pitfalls are in
[shell-chrome-bridge.md](shell-chrome-bridge.md#page-error-signal-chrome-to-tools)). The
shell never infers an error page from the favicon or the URL. Pitfall: a website can
declare a `chrome://global/skin/icons/warning.svg`, `info.svg` or `blocked.svg` favicon
(the `global` package is content accessible and `FaviconLoader.sys.mjs` accepts it), so a
favicon matching Firefox's error stand-ins proves nothing, and a heuristic that trusted
it showed a normal HTTPS page as a certificate warning. An error page also keeps the
failed address as the tab URL, and `about:restricted` keeps the website URL and uses
`warning.svg`, so the URL alone cannot identify one either. States come from the document.
A website with such a favicon shows it as an ordinary favicon (covered in `tabState.test.ts`
and `TabRow.test.tsx`).

Quiet status backgrounds are `color-mix` of one Mux color token at 10% in light mode
and 14% in resolved dark mode (`--bento-tab-row-state-tint`). They sit at one-class
specificity before the active and selected rules, which therefore win. Default and
sleeping are untinted.

The state icons are the SVG masters in `components/TabRow/assets/`. `TabStateIcon`
imports them with `?no-inline`, so the ordinary build emits each as
`dist/assets/tab-state-<state>.svg` and the shell chunk refers to it with
`new URL(..., import.meta.url)`; Vite would otherwise inline those under its 4 KB limit as
`data:` URIs. The extension CSP (`script-src 'self'; object-src 'none'; frame-ancestors
'none'`) sets no `img-src`, so the files load as same-extension images with no
`web_accessible_resources` entry. Keep the SVG files byte-identical to the masters.

Verify in a built app: switch each control separately in Settings, compare all four
combinations on tabs in each state (a site that does not resolve, an expired
certificate, a blocked-site test page, a crashed tab, `about:preferences#privacy`,
`about:config`, a sleeping tab and a page with a favicon, including one that declares
`chrome://global/skin/icons/warning.svg`, which must keep that favicon), and relaunch the
same profile to confirm persistence. Reset restores both to On.

## Theme pitfalls

- The dev server (`pnpm --filter @bento/shell dev`) once ranked `bento.app`
  below `bento.components` while the build ranked it above. `main.tsx` imports
  `shell-document.css` and `app.css` (both `bento.app`) before `App` pulls in
  the component sheets, and the dev server injects CSS in that import order, so
  `.bento-stack[data-bento-layout='row'] { justify-content: flex-start }` beat
  the footer's `justify-content: flex-end` and the footer icons sat on the left
  in dev only. The build concatenates component chunks first, which hid it.
  Found 2026-10-18; the order statement in `theme/muxui.css` fixes all three
  environments. To check one, walk `document.styleSheets` for
  `CSSLayerStatementRule` and `CSSLayerBlockRule` names in first-declared order
  (expect `bento.tokens`, `bento.fonts`, `bento.components`, `bento.app`), or read
  the first `@layer` declarations of each built CSS asset.
- Every native document that links `bento-chrome-tokens.css` needs
  `data-bento-theme` and `data-color-mode` on its root. The legacy aliases
  (`--neutral-*`, `--color-*`, `--radius-*`, `--shadow-*`, `--space-2xs`) and the
  Mux mode blocks are declared only for elements with those attributes, so an
  attribute-less document computes every alias to nothing. On `about:preferences`
  that left `--background-color-box`, `--border-radius-circle` and every other
  token patch 12 maps onto an alias empty, and the unscoped
  `:root { --space-large: var(--space-2xs) }` (also `--space-medium`, `-small`,
  `-xsmall`, `-xxsmall`) emptied those five Firefox spacing tokens, so cards had
  no fill or radius and every rule that spaces with one of the five lost it.
  `moz-card` padding comes from `--card-padding-*` (`--space-xlarge`), which the
  bridge does not touch, so card padding was unaffected. It came in with the Tale
  to Mux migration, which moved the aliases from `:root` to the attribute scope;
  found 2026-10-12. Disabling the sheet does not show the cause: the aliases
  vanish with it.
- Do not add standalone theme title writes on shell mount. Theme and
  `uiColorMode` must ride together inside `BENTO_PANELS`; otherwise a
  theme-only title can overwrite the first panel sync before chrome reads it.
- Keep Auto mode resolved to explicit `light`/`dark` on DOM roots. Mux UI's
  runtime styling expects `data-color-mode` to carry the rendered mode; the
  stored user preference is mirrored separately as `data-bento-color-mode-pref`.
- Workspace themes are static scoped CSS in per-theme sheets. Do not generate
  runtime style elements for theme switching; attach or swap the sheet.
- Never set a non-Default `data-bento-theme` / `data-muxui-theme` on a root before
  that theme's sheet has loaded: the scope would match no theme rules and paint
  the unscoped Mux palette for a frame. `useWorkspaceTheme` and
  `applyChromeThemeToDocument` set the attribute from the sheet's `load` event.
  A nested scope (avatar, pin, picker swatch) cannot wait, so the component that
  renders it registers its theme (`useThemeSheet`); a new component that renders
  another workspace's theme needs the same, in the component and not only in the
  document entry. Registering only the active workspace's theme leaves a pin from
  another workspace unthemed and lets a workspace switch prune its sheet.
- A nested scope in the opposite colour scheme (the floating sidebar cards) keeps the
  page's colour for any token declared on `:root` that reads a colour, because the value
  is computed at the root and inherited. Mux semantic tokens and the tokens in the
  `[data-bento-theme]` re-link rule follow the scope. Read a Mux token, or declare the
  component's colour on its scoped selector, and resolve anything that must stay the
  page's (shadows) on a page-scope ancestor. The recipe and a check are in
  [mux-ui-component-customisations.md](../mux-ui-component-customisations.md#inverted-scope-for-floating-cards).
- Waiting for the theme sheet without requesting it early delays the first
  themed paint in new windows. Measured at cold start with a persisted
  non-Default theme, requesting the sheet only after the workspace snapshot
  arrived left the sidebar on Default for 9 to 107 ms after chrome lifted its
  launch veil in 4 of 8 new windows (sheet load 11 to 159 ms). The single
  stylesheet it replaced themed the sidebar 40 to 99 ms before the lift in all 10
  windows measured. Keep the `boot.js` request and the adoption in
  `themeSheets.ts`; do not move the request back behind `useWorkspaceTheme`.
- `boot.js` must not apply the hinted theme's attributes. Only the sheet request
  starts early; the attributes still wait for the sheet through `applyRootTheme`.
  The hint can be stale (another window wrote it last, the theme was removed, the
  workspace theme changed offline), so it must never decide the presentation.
- Do not write the hint or release the `boot` owner before the active workspace
  has reached the document. `useWorkspaceTheme` first runs with a placeholder
  Default; writing `default` then erases the hint for the next document, and
  releasing then lets that placeholder request prune the sheet still loading.
  `useThemeSheet(s)` callers with an empty list prune the same way, which is why
  the hold is an owner and not a flag on the root request.
- Do not wait for the boot link's `load` event alone. It can fire before React
  adopts the link; boot.js's `data-bento-boot-sheet` marker and a readable
  `cssRules` record that. Firefox may expose `link.sheet` while the sheet is still
  loading, so a non-null `sheet` is not proof of a finished load.
- Do not unload a theme sheet before its replacement has loaded, and do not
  remove one an owner still needs. `themeSheets.ts` keeps one link per theme
  while any owner (`root`, or a `useThemeSheet(s)` caller) names it, and keeps an
  owner's displayed sheet until that owner's latest request has loaded. Never
  prune in response to a superseded request finishing: with A shown, B and C
  requested, B finishing first would otherwise drop A while C still loads.
- Canonical sheets keep their rules in `@layer muxui`, after the layer order
  declared in `theme/muxui.css`. An unlayered theme rule would beat Bento's
  component layers. `scripts/mux-css.mjs` (called by `sync-theme-presets.mjs`)
  fails on any `themes.css` rule it cannot assign to one canonical theme and on a
  theme that lacks a light or dark rule.
- Chrome token updates require regenerating/importing the chrome stylesheets
  (`bento-chrome-tokens.css` and `bento-chrome-themes/`); the shell CSS bundle
  alone is not enough. A new Bento theme needs `pnpm run theme:sync` (shell
  sheet) and `pnpm run import` (chrome sheet).
- A rem token is a different length in chrome (system UI font, 11 px on macOS) and
  the shell (`--font-size-root`, 16 px). The generator pins the rem tokens chrome
  sizes shell-laid-out geometry from (`SHELL_SIZED_TOKENS`: the collapsed rail width
  and the add-panel trailer's button, gap, padding and select widths) in px in the
  chrome sheet; see
  [Shell-sized lengths](../chrome-tokens.md#shell-sized-lengths), the rail
  pitfall in [workspaces.md](workspaces.md#workspace-pitfalls), and the trailer
  pitfall in [panel-widgets.md](panel-widgets.md#widget-pitfalls).
- Mux's rem typography tokens render at 11/16 of their shell size when a chrome
  rule uses them directly: `--muxui-semantic-typography-text-m-font-size` is `1rem`,
  11 px in chrome and 16 px in the shell, and `text-s` is 9.1 px in chrome and
  13.3 px in the shell. The panel header URL field (`.bento-panel-header-url`) first
  used `text-s` (commit eb27adcf) and read as 9.1 px text. It now reads
  `--bento-panel-url-font-size`, an alias of `text-s` that `SHELL_SIZED_TOKENS`
  pins at 13.3 px (`text-m`, 16 px, read too large in the 24 px field). The panel
  navigator menu items (`.bento-panel-nav-menu__item`) read
  `--bento-panel-nav-menu-font-size`, an alias of `text-s` pinned at 13.3 px; the
  item's 24 px `min-height` (`--bento-control-size-sm`) holds the line. Do the same
  for any chrome text that should show a Mux type size at the shell's scale; check
  the pinned value in `bento-chrome-tokens.css` after a change. Chrome rules that
  use rem font tokens directly still render at chrome's rem; that is the existing
  look until a rule is moved to a pinned token.
- Firefox notification bars (`notification-message`, including the popup-blocked
  banner) are `moz-message-bar`/infobar custom elements with shadow-root CSS.
  `bento-chrome-theme.css` can theme their host and inherited custom properties,
  but it cannot directly remove the default left gradient stripe inside
  `infobar.css`. Keep `patches/core-ui/10-bento-infobar-accent-token.patch` in
  place: it makes the stripe read `--info-bar-accent-background`, and Bento sets
  that token to `none` while using an inverted neutral scheme
  (`--neutral-90` background, `--neutral-5` text/icon, light neutral action
  buttons) so notification bars pop against both light and dark chrome.
- A colour that reaches the paint through an unregistered custom property inside a gradient
  does not fade with the mode flip, and it looks like a bug in the rule, not in the surface.
  The chrome toolbars wrote their gradient inline from the mount script with
  `var(--bento-toolbar-main-bg)` as the right stop, so the window's right half of the title
  strip snapped to the new colour while the sidebar half and the sidebar faded
  (`getComputedStyle` of the toolbar's `background-image` showed the final rgb in the stop; the
  element's own `background-color` and the registered left stop read the in-between colour).
  Register the colour and read it in every gradient writer, CSS and script
  (`--bento-toolbar-right-bg`). When a surface looks wrong mid-fade, read its computed
  `background-image`, not only `background-color`. Found 2026-10-25.
- Do not write `:is(*, *::before, *::after)` to reach pseudo-elements: pseudo-elements are
  not valid inside `:is()` and match nothing. List the four selectors.
- A direct leg must not follow the saved mode into a private window: tools never sees a private
  window's own mode, and the saved value is not that window's. The experiment tells every browser
  window and the mount script's `handleUiColorModeSet` drops the event in a private one, so the
  rule lives in the one file that already knows its window's privacy. Tools must not filter by
  `incognito` instead, because the window event is the only thing a private window must not act
  on; its `BENTO_PANELS` payload (built from the window-local entry) stays its source.
- Do not read a document's computed style inside a message handler that starts a fade: it
  flushes the styles of the whole document there and then, and every other document of the
  process handles the same message after it (measured: sidebar 21 ms after the trigger with the
  read in the handler, 14 ms with it on the next frame). `applyModeWithFade` writes the
  attributes and leaves the `afterMotion` read to `requestAnimationFrame`.
- Do not apply the mode from an effect keyed on the pref and rely on that for timing: the
  passive effect runs after React has rendered the document. `useFirefoxTheme` applies from
  `useSettingsStore.subscribe`; a subscriber that throws would stop the store's other
  subscribers and the port handler, so it catches and logs.
- Two routes into one setting need an order. Before the stamp, a `BENTO_PANELS` payload that the
  sidebar had serialised before a flip, then held in `sendChromeTitle`'s queue, reached chrome
  after the direct event: `applyChromeColorMode` applied its old mode (reversing the fade) and
  the next payload started a third. The equal-mode check only covers a copy that agrees. Do not
  add another route for a setting without a stamp that every route carries. Two ways the first
  stamp designs failed: a stamp that was 0 until the first change let an initial payload (old
  mode, no stamp) pass the check and undo the first flip (dark, light, dark: three fades), so the
  store stamps from construction and chrome drops an unstamped message once it has recorded a
  stamp; and a clock-based stamp could go backwards over a restart (a clock correction), so
  chrome rejected the legitimate changes of the new run while a surviving sidebar kept sending
  its old stamp. The stamp is a run id plus a sequence for that reason; never compare stamps
  of different runs.
