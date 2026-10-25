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

A light/dark flip fades every colour of every Bento-owned document together on the
`state` motion pair (`--muxui-semantic-motion-state-transition`, 120 ms `ease`). The pair is
forced on every element whatever timing it had (Mux components on `interaction`, Bento surfaces
on `state`, and the many that had no colour transition and used to snap), and every document
starts it at one scheduled instant (see "Scheduled flip" below), whenever it received the mode.
Workspace theme id changes are not part of it and still switch at once.

- Mechanism: a transient root attribute `data-bento-mode-fade`, present only while a flip
  fades. It is set in the same task as `data-color-mode`, so one style recalculation starts
  every transition, and it is removed by `afterMotion` once the motion has ended. Removing it
  earlier drops the rule and cancels the running transitions, so nothing else clears it. A
  second flip during a fade keeps the attribute and waits again (it restarts the fade from the
  current colours).
- No fade for: the first mode application in a document (boot, settings hydration and the
  startup veil are still up), an unchanged resolved mode, `prefers-reduced-motion: reduce`, and
  a hidden document. These just write the attributes.
- Scheduled flip: every change of the saved `uiColorMode` carries a time, `flipAt` on the
  `ColorStamp` (`Date.now()` of tools plus `COLOR_FLIP_LEAD_MS`, `settings/SettingsStore.ts`), and
  each document waits for it before it writes the mode and sets the fade attribute, so the
  documents, which receive the change 10 to 150 ms apart, start the fade together. Every Bento
  process reads the same system clock, so the epoch time compares across them. The lead is the
  price of this: the flip starts that long after the click, plus the 10 to 30 ms tools needs to
  persist the change and stamp it (120 ms, chosen below). A document that hears of the change at or after
  `flipAt` applies at once, and a stamp without `flipAt` (the state a run starts with, so every
  snapshot, an older build) applies at once, which is why a document that loads late is not
  affected. The waiting rules: the first application in a document, an unchanged mode and a
  hidden document apply at once (a hidden document gets no animation frames); reduced motion
  still waits, because a synchronised snap beats a staggered one; any later call replaces the
  waiting change (a newer stamp, a flip back before `flipAt`, an OS appearance change under
  Auto, which is never scheduled), so the newest state always wins.
- Auto resolves when the flip applies. In the shell the mode to show is a `resolve` callback
  (`applyModeWithFade(resolve, write, flipAt)`), asked once on receipt to decide whether to wait
  and again when the wait ends; `write` gets the mode it applied, and the resolved mode that is
  stored (`resolved-color-mode`) and published to the window's overlays is that one. A value
  captured on receipt could go stale: the OS appearance listeners of an Auto choice are
  installed by an effect that only runs after React has rendered the Auto pref, so an OS
  change in that gap is never heard, and a waiting flip would then apply and publish the old
  value at `flipAt`. Chrome registers its `matchMedia` listener at load and a heard OS change
  replaces the waiting flip (`setChromeColorMode('system')`), so it needs no re-resolution.
  Not covered: an Auto choice that applies at once (it resolves to the mode already shown, so
  nothing waits) and an OS change inside the same render gap. That window is one React render
  long and existed before the scheduled flip.
- The wait ends in an animation frame, not on a timer. A timer was tried first and left the
  documents 20 to 45 ms apart even with a 200 ms lead: the shell's documents share one process
  thread, and the rendering update of the first document that applied (about 15 to 20 ms for a
  first fade frame) has priority over the second document's timer, so the second applied a
  frame or more later. Frame times, in contrast, come from one vsync for every document of a
  tick, and a transition starts from its frame's time. The document therefore wakes by a timer
  shortly before `flipAt` and takes the first `requestAnimationFrame` whose time is at or after
  the deadline (`runAtFlip` in `theme/modeFade.ts`; `runAtChromeFlip` in the mount script).
  Documents of the process take the same frame and their fades start from the same time even
  though one renders after the other, and the chrome window, in the parent process, takes the
  frame of the same vsync period.
- One clock after receipt. `flipAt` is wall-clock (`Date.now()` of tools) but frame times are on
  the document's monotonic clock, and the system clock can be stepped (NTP, a manual change)
  after the document opened. Comparing `performance.timeOrigin + timestamp` with `flipAt`
  waited by the size of the step (a +60 s step delayed the flip by about 60 s). The caller now
  turns `flipAt` into a wait once, on receipt (`flipAt - Date.now()`, both read from the system
  clock at that moment), and the deadline is `performance.now() + wait`; the timer delay and
  the frame comparison (`timestamp >= deadline`) both use it, so the two clocks are never mixed
  and a step during the wait changes nothing. Documents that hear of the change on either side
  of a step still agree only as far as their receipt times do, which is the unavoidable part.
- Shell documents (sidebar and every overlay entry): `theme/modeFade.ts`
  (`applyModeWithFade`, `MODE_FADE_ATTRIBUTE`) wraps the attribute writes in
  `useFirefoxTheme`'s `applyMode`. That one function serves the settings change, an OS
  change in Auto, and the `BroadcastChannel` and `storage` paths of overlays, and every entry
  with a mode (all `main.tsx` entries, the sidebar included) already calls
  `useFirefoxTheme`, so no entry has its own path. The hook applies a pref from
  `useSettingsStore.subscribe`, which runs inside the store's own `set()` when the port
  message lands (the store keeps the event's `flipAt` in the same `set()` as `colorFlipAt`, and
  the subscriber passes it to `applyModeWithFade`), not from a `useEffect` keyed on the pref: that effect ran only after React
  had rendered the whole document and flushed its passive effects (a frame or more, longer in
  a heavy document). The first effect run applies the initial pref (boot hydration is
  unchanged), the subscription skips a pref the hook has already applied, so a later render
  neither applies, announces nor fades it again, and the Auto listeners (OS change,
  `BroadcastChannel`, `storage`) stay in an effect keyed on the pref. The style read that
  waits for the end of the motion (`afterMotion` calls `getComputedStyle`, which flushes the
  document's styles) is deferred to the next animation frame: read inside the message handler
  it made every document wait for the style flush of the documents handled before it in the
  same process. `panel-newtab` runs no script and always
  shows the Default light look. The rule is in `theme/document-base.css`, which every entry
  imports.
- Chrome window: `applyChromeColorMode` in `bento-shell-mount.js` does the same with the
  mount script's own `afterMotion` (`BENTO_MODE_FADE_ATTR`), and `bento-chrome-theme.css`
  holds the rule. Chrome has two legs into it. The direct leg: when the saved `uiColorMode`
  changes, `bento-tools` calls `browser.bentoPrivacy.notifyUiColorMode(pref, stamp)` first thing in
  its `settings.onChange` handler (`settings/ChromeColorModeSignal.ts`, once per change), the
  experiment fires a `bento-ui-color-mode-set` window event (`detail` is `{ mode, stamp }`) at every
  browser window, and the mount script's `handleUiColorModeSet` calls
  `applyChromeColorMode(mode, stamp)` (Auto is resolved in chrome, as before; the stamp's `flipAt`
  makes `setChromeColorMode` wait for it, `acceptChromeColorStamp` records only `{ run, seq }`). The backstop: the
  `BENTO_PANELS` payload still carries `uiColorMode` (with `uiColorModeStamp`) and calls the same
  function; it arrives 60 to 100 ms later, finds the mode already applied and returns before the
  fade, so a payload that agrees neither restarts nor doubles it. The first application in a
  window never fades, whichever leg delivers it.
- Ordering of the two legs (the stamp `{ run, seq }`): a `BENTO_PANELS` payload is serialised
  when the sidebar forwards it, so one built before a flip can reach chrome after the direct
  event and would reverse the fade. Every message that carries a mode therefore carries a
  stamp, a pair made by `SettingsStore`: `run` is an id minted when the store is constructed (one
  per tools run), `seq` starts at 1 and rises by one with every change of the saved
  `uiColorMode`, before the listeners run. The store makes the stamp from construction, so even the
  initial snapshot is ordered (seq 1); there is no "no stamp yet" state in a run. No clock is
  involved and nothing is persisted. Tools puts the current stamp on the direct event and on every
  `settings/snapshot` and `settings/changed` event (`colorStamp`); the sidebar keeps the newest
  (`followColorStamp`: the same run keeps the higher `seq`; another run replaces it, because
  a new run is by definition the producer's present, and a surviving sidebar thereby follows
  tools after a restart) and writes it into every payload it builds (`uiColorModeStamp`).
- The rule chrome applies (`acceptChromeColorStamp`, record `chromeColorStamp`): with nothing
  recorded, any message applies. A valid stamp of another run than the recorded one applies and
  becomes the record, whatever its `seq` (so tools restarting, with or without the clock stepping
  back, never leaves chrome rejecting); in the same run it applies unless its `seq` is lower
  than the record, and a lower one is dropped, so a stale payload can neither reverse the fade
  nor start a third. An equal `seq` passes and the equal-mode check makes it a no-op. A message
  with no valid stamp (the legacy title, a build that predates the stamp) applies only while
  nothing is recorded, and once a stamp is recorded it is dropped: it cannot be ordered, and
  a queued initial payload with the old mode must not undo a newer direct event. The OS
  appearance listener under Auto (`handleChromeDarkQueryChange`) is not a stamped message: it
  re-resolves the recorded preference and so always applies. A new window starts with nothing
  recorded. A private window's payload carries the global stamp with its own mode: nothing in it
  is out of order (the window gets no direct event), and its own flips change no stamp.
- Restart, what is and is not guaranteed: in one tools run the order above holds. Across a
  restart of tools with chrome windows open, the first message of the new run applies and
  replaces the record; a message of the previous run that still arrives after it is not
  ordered against the new run (the runs have no common order) and is applied, which can
  show the old mode until the next message of the new run corrects it (the sidebar's next
  payload, after it has followed the new run's stamp). That residual window is the cost of
  choosing a run id over persisting the sequence, which would order restarts too but costs a
  storage write per flip and a read before the first message.
- A hidden window that is waiting applies at once. A hidden document gets no animation frames,
  so the frame wait would run only when it is next shown and then fade visibly. The shell
  scheduler listens for `visibilitychange` and applies a waiting flip when the document hides
  (no fade); the chrome scheduler (`runAtChromeFlip`) does the same. The listener is removed
  when the flip applies and when a newer call cancels the wait.
- A change that does not fade (hidden document, reduced motion) ends a fade that is running:
  the pending wait is cancelled and the attribute removed before the mode is written, in the
  shell (`modeFade.ts`) and in chrome (`writeChromeColorMode`), because the rule would
  otherwise keep every transition forced on until the document resumes. This is only for a
  change of the mode; an unchanged value (a backstop delivery that agrees) leaves a running
  fade alone. A window whose mount script has
  not run when the event fires misses it and takes the mode from the payload. A private window
  ignores the event (`isWindowPrivate` in the handler): it keeps its own in-memory mode, which
  reaches it through its own sidebar and `BENTO_PANELS`, never through tools' saved value. The embedded import host (`bento-migration-host.js`) reads its mode once from
  its URL when it loads and has no live flip path, so it has nothing to fade (a flip while
  it is open shows on its next open).
- The rule is one unlayered `!important` `transition` list on `:root[data-bento-mode-fade]`,
  its descendants and their `::before` and `::after` (`:is()` cannot take pseudo-elements, so
  they are listed separately): `background-color`, `color`, `border-color`, `fill`, `stroke`,
  `box-shadow`, `outline-color`, `text-decoration-color`, plus the registered `<color>`
  properties that paint. It replaces the element's whole `transition` for the moment, so a
  non-colour transition that happens to be running (a hover opacity, say) ends at once.
  Important is what out-ranks the component rules; among important declarations an earlier
  layer beats a later one and a layered one beats an unlayered one, so the rail
  choreography's own `transition: none !important` (`sidebar/railTransition.css`, layered)
  and the chrome rules listed below win over it.
- Registered colours: gradients and `var()` chains over unregistered custom properties cannot
  interpolate, so a colour that paints through one is registered as `<color>` and listed in
  the rule. Shell: none. The sidebar footer's `--bento-footer-fill` (`app.css`, registered for
  the rail choreography's backdrop) is deliberately not transitioned by the flip: a recording
  showed the footer starting 25 to 30 ms after the rest of the sidebar when the registered
  property transitioned (its transitions started in the same frame, but `background-color`, which
  reads it, painted one rendering update later), and with `background-color` fading through the
  catch-all like everything else the footer and the sidebar start together. A flip that lands
  inside the rail choreography, whose backdrop reads the fill, snaps that backdrop. Chrome:
  `--bento-toolbar-left-bg` and `--bento-toolbar-right-bg` (`bento-shell-mount.css`, not
  inherited), the two gradient stops of the toolbars and of the window, body, `#browser`
  surfaces in sidebar address bar mode; the inline gradient the mount script writes on the
  toolbars reads the same two properties.

Exceptions and limits (documented, not fixed):

- Web content, shadow-DOM internals of Firefox custom elements (`moz-card`, menus, the
  notification bars' internals) and OS-native menus and window frames do not fade. A gradient
  over an unregistered property still switches at once (the shell's pinned-panels corner
  radial gradient, for one).
- `about:preferences` (patch 12) follows the mode through the `bento-ui-color-mode` observer
  topic and is left out: the attribute copy, a removal timer and a rule are more than the
  roughly 15 lines the patch can take without growing, and most of that page's colour lives in
  `moz-*` shadow DOM, which the rule cannot reach, so only its page backgrounds would fade.
  It switches at once, and so ahead of a scheduled flip (the page follows the observer topic
  that chrome fires when its own flip applies, so it changes at the flip, not the click).
- Chrome `transition: none !important` rules in `bento-shell-mount.css` that out-rank the rule
  by specificity: the import host during the onboarding handoff, `#bento-shell-host` during a
  live sidebar or window resize, and the strip, panels and navigator during a workspace
  switch. All are transient states (a flip landing inside one of them snaps those surfaces).
  `#PersonalToolbar` has a persistent one in sidebar address bar mode, so its selector is
  listed in the chrome rule with enough specificity to win.
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

Checks: a flip starts `flipAt` after the trigger, so probe timestamps (a `MutationObserver` on
`data-color-mode`) should cluster at that time in every document, and the BroadcastChannel
arrival of `settings/changed` (the stamp's `flipAt` is in the event) is the delivery time to
compare with it. Flip the mode in a running build and read `document.getAnimations()` in each document
during the first frames (every CSSTransition should report 120 ms `ease`); a
`MutationObserver` on `data-bento-mode-fade` timestamps the start per document; to watch a
fade, set `updatePlaybackRate(0.05)` on the transitions as they start and keep the attribute
(re-add it when it is removed) while taking a screenshot.

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
  mount sheet and the shell's rail look), `--bento-rail-band-fill` and
  `--bento-rail-square-base` (neutral-18) are declared once in `bento-tokens.css` from
  public Mux semantic neutrals, so every theme, mode and contrast follows. A window with
  no side panels resets them (neutral-5, neutral-12, neutral-5): chrome under
  `:root[bento-no-side-panels]` for the main colour, the shell on
  `.bento-shell-app--no-side-panels`. The rail's `--bento-brand-bg` is re-pointed on
  `.bento-shell-app` in the rail look, not at `:root`; the document background keeps the
  brand colour.
- Known limit: the dev server (`pnpm --filter @bento/shell dev`) does not
  serve `assets/panel-newtab.css`; preview the page from a built `dist/`.

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
