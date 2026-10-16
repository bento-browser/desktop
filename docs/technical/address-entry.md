# Address Entry Implementation

Part of the [technical notes index](../core-functionality-technical.md).

`src/browser/base/content/bento-shell-mount.js` owns address-entry routing.
`Cmd/Ctrl+L`, `Cmd/Ctrl+E`, `Cmd/Ctrl+T`, the sidebar `New tab` action,
content-process BentoKey actor events, and native top-urlbar fallback focus
open the centered floating overlay hosted at `address-bar.html`. Direct
activation of the expanded-sidebar URL row opens the same overlay with a
sidebar anchor so it appears below the row and can extend over the panel strip
and main content.

The workspace switcher trigger is mounted above the persistent sidebar address
row, and both are mounted above `TabList`.
In expanded mode, `.bento-tab-list-pane__scroller` owns a `--space-3xs` top
padding matching the address row's top padding below the workspace switcher.
Keeping the lower gap inside the native scroller makes it visible at scroll
position zero and lets it scroll away so tab content becomes flush with the
address row edge. Collapsed mode resets that top padding to zero because the
address row is hidden.
`extensions/bento-shell/src/state/sidebarAddress.ts` stores the last
chrome-owned snapshot, edit mode, draft value, and pending bookmark-toggle key.
`extensions/bento-shell/src/bridge/useSidebarAddress.ts`
subscribes to `BroadcastChannel('bento-sidebar-address-bus')`, but applies only
messages whose chrome-stamped `windowId` and per-frame
`bentoSidebarAddressBridgeToken` match the shell frame hash. Missing or
mismatched tokens are ignored so same-origin BroadcastChannel delivery cannot
cross-update another Bento window.

Chrome generates the sidebar bridge token in `bento-shell-mount.js`, stamps it
into `#bento-shell-frame`'s hash beside `bentoWindowId`, and sends sidebar
snapshots through a frame script plus `messageManager`, not document-title IPC.
Snapshots include tab id, full URL, display URL, title,
loading state, Firefox-derived security state, regular bookmark state, and a
monotonic snapshot token. Snapshot emission is coalesced with
`requestAnimationFrame` and listens to tab selection/attribute/restored events,
selected-browser progress location/security/state changes, and Places bookmark
change events. Empty new-tab opens carry the same chrome-validated clipboard web
URL suggestion as the centered overlay.

Activating the expanded-sidebar row opens the shared address/search overlay
with a sidebar anchor instead of rendering suggestions inside the sidebar
iframe. `SidebarAddressBar` sends `BENTO_OPEN_ADDRBAR` with the row's
frame-local rect. Chrome converts that rect through the live
`#bento-shell-frame` and `#browser` geometry, shows `#bento-addrbar-host` as a
full `#browser` overlay, and passes the computed popup placement to
`address-bar.html` over the existing `BentoAddrbarOpen` frame script. Anchored
placements start below the sidebar row, not over it. The overlay owns the
focused input, result list, and search-engine picker, so the popup can extend
over the panel strip or main content without asking the sidebar iframe to
overpaint its chrome bounds. Sidebar-anchored placements use a smaller
512px-by-378px cap so the row-local picker reads as attached to the sidebar,
while shortcut, new-tab, and top-urlbar fallback opens omit the anchor and
therefore keep the original centered overlay size and position.
The persistent row intentionally has no `:focus-within` accent override: focus
must not replace its neutral border with a workspace `--color-60` outline.

Firefox remains the source of truth for address semantics. The sidebar submit
path and the floating overlay submit path both call the same chrome helper,
which resolves optional one-shot search engine submissions through Firefox
`SearchService`, falls back to Firefox URI fixup, navigates the selected main
browser in current-tab mode, dispatches `tab/openUrl` in new-tab mode for
ordinary web loads, and uses Firefox chrome's trusted-tab path for privileged
new-tab `about:`/`chrome:` loads that the WebExtension tabs API rejects.
Successful submissions still reveal the main content slot.

All content navigation created by the Bento address entry uses
`LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL` with an explicit chrome triggering
principal, and rejects script-like address schemes before URI fixup or load.
Both the React address input and the chrome-hosted panel input strip leading
`javascript:` prefixes on paste. Keep the chrome-side validation even when the
UI sanitizes input: content navigation must not depend on an extension-frame
check for principal isolation.

The sidebar security control reads the native identity block state from
Firefox chrome and opens Firefox's native identity popup through
`gIdentityHandler`/`PanelMultiView` anchored to a temporary chrome-owned element
positioned over the sidebar button. Bento does not implement certificate or TLS
details in React. The sidebar bookmark star uses chrome-side Places helpers and
normal Firefox bookmarks only; the managed "Saved panels" folder is excluded
from regular bookmark fill/removal. Toggle payloads must match the current
window token, selected WebExtension tab id, selected main-tab URL, and latest
snapshot token before and after async Places reads; duplicate toggles for the
same tab/URL are ignored while one is in flight.
The sidebar Copy URL button uses the same scoped title-IPC channel and must
match the current window token, selected WebExtension tab id, selected main-tab
URL, and latest snapshot token before chrome writes the URL to the global
clipboard via Firefox's native clipboard helper. After a successful write,
chrome sends a scoped `copy-result` message back over the sidebar address bus so
the shell can show the `Copied` tooltip. This keeps clipboard writes out of the
extension page permission surface and prevents stale sidebar frames from copying
a URL after navigation.

The native top URL/search container is hidden by
`bento-chrome-theme.css` under `:root[bento-sidebar-addressbar='true']`. The
capture-phase native-urlbar listener remains as a fallback for Firefox internals
that still try to focus the hidden native urlbar; it opens the centered
address/search overlay instead of routing through the sidebar row. Bento does
not enable Firefox's native `sidebar.verticalTabs`. `bento-shell-mount.js`
measures `#bento-shell-host`, `#nav-bar-customization-target`, and the native
Back/Forward/Stop-Reload controls, then writes `--bento-toolbar-nav-offset` so
the native navigation cluster tracks the sidebar's right edge while the sidebar
is resized. It also writes `--bento-tab-strip-width-min-effective` from the same
metrics, using
`max(--bento-tab-strip-width-min, targetLeft - sidebarLeft + edgeInset + nativeNavGroupWidth)`.
That is the exact sidebar width where `--bento-toolbar-nav-offset` clamps to
zero. The expanded sidebar min width must use this computed value, not only the
static token min, otherwise the sidebar divider can keep moving left after
Back/Forward/Reload have reached their leftmost position and appear underneath
those buttons. During manual drag, compute and write that effective min width
before the live resize loop, then reuse the cached value for every drag frame;
writing `--bento-tab-strip-width-min-effective` on `:root` from
`syncToolbarNavigationForSidebarWidth()` reintroduces layout-wide invalidation
and makes sidebar/window resize choppy. In the same sidebar-addressbar mode,
Bento collapses native
`toolbarspring` children in `#nav-bar-customization-target` so the top-toolbar
panel navigator sits flush with the sidebar divider after Reload/Stop. Bento
marks the first browser extension toolbar child with
`data-bento-extension-toolbar-anchor='true'` and gives it
`margin-inline-start: auto` so the extension cluster aligns to the right side of
the top bar instead of staying adjacent to the navigator. It also hides
`#nav-bar > .titlebar-spacer[type='post-tabs']`; otherwise Firefox keeps a 40px
native titlebar spacer after the extension buttons and creates an empty right
edge gap. `attachBookmarksToolbarAlignment()` measures `#bento-strip-container`
and writes `--bento-bookmarks-toolbar-offset` on `#PersonalToolbar` so Firefox's
native bookmarks toolbar starts at the panel-strip edge instead of spanning over
the sidebar. It also measures `#PersonalToolbar` height and writes
`--bento-bookmarks-toolbar-height` so `#bento-shell-host`,
`#bento-shell-splitter`, `#bento-shell-splitter-affordance`, `#sidebar-container`,
`#sidebar-launcher-splitter`, `#sidebar-box`, and `#sidebar-splitter`
counter-offset that height; otherwise Firefox pushes the entire `#browser` row
down and leaves a blank gap above Bento's sidebar address field or Firefox's
native Bookmarks sidebar search field whenever the bookmarks toolbar is
visible. Observe `#PersonalToolbar` `collapsed`/`hidden` mutations and update
the height synchronously before the next paint; relying only on ResizeObserver
lets Cmd+Shift+B show/hide animation shift the sidebar first and correct it
after the animation settles. Also override Firefox's native
`#PersonalToolbar` vertical slide transition in Bento mode and collapse
visibility immediately when `[collapsed]`; otherwise Firefox presents
intermediate toolbar heights that move sidebars before the compensation can
settle. During manual sidebar resize, cache the strip-to-sidebar inset before
the live resize loop and update the bookmark offset from the drag width; do not
read strip geometry every drag frame. `attachNativeSidebarSplitterFeedback()`
takes over Firefox's `#sidebar-splitter` in the same mode so native sidebars
such as Bookmarks can be resized independently of the Bento sidebar. It uses the
same pointer-capture, rAF-batched width writer pattern, persists `#sidebar-box`
width through XUL store, and gives the native splitter a Bento-sized hover
target; leaving Firefox's narrow transparent XUL splitter alone makes the
Bookmarks panel feel fixed next to Bento's larger sidebar handle.
`#bento-shell-host` keeps a width transition for sidebar
collapse/expand (the Mux `reveal` motion role, the same one the shell's collapse
transitions use, so the rail and its host move together), but
`attachSidebarSplitterFeedback()` must add
`bento-shell-sidebar-resizing` during manual splitter drag so that transition is
disabled while drag writes live `width` values; otherwise the handle feels
smoothed or laggy instead of tracking the pointer. The same splitter setup must
set the native `#bento-shell-splitter` to `resizebefore="none"` and
`resizeafter="none"` so Firefox's XUL splitter does not compete with Bento's
manual width writer. During drag, compute the affordance position from the
starting splitter left plus width delta instead of calling
`getBoundingClientRect()` after every width write; live rect reads in that loop
make the sidebar resize choppy and unstable. Batch live drag writes through a
single `requestAnimationFrame` callback and persist the XUL `width` attribute
only on mouseup; writing style, affordance position, divider position, toolbar
offset, and persisted width for every raw `mousemove` can still stutter even
after the native splitter path is disabled. Use pointer events with
`setPointerCapture`, matching Bento's panel splitters; window-level
`mousemove` is more prone to jitter when the cursor crosses remote browser
surfaces. While dragging, disable pointer events on `#bento-shell-frame`, move
the native nav buttons and `#bento-panel-nav` with the same transform instead of
live margin layout, and set `--bento-toolbar-nav-offset` on
`#nav-bar-customization-target` rather than `:root` so each frame invalidates
less chrome CSS. The panel navigator transform is required because it sits after
Reload; moving only Back/Forward/Reload leaves the navigator behind until
mouseup, when the settled margin layout jumps into place. Do not transform the
browser extension buttons in this path: the extension anchor's auto margin keeps
that cluster pinned to the right side of the top bar while the navigator follows
the sidebar divider. Sidebar chrome that follows the edge
(`#bento-sidebar-chrome-divider` and
`--bento-toolbar-nav-offset`) and the split top-toolbar background
(`--bento-toolbar-divider-x`) must use the same cached start-of-drag geometry
plus live width delta; its `ResizeObserver` callbacks must ignore
`bento-sidebar-resizing`.
Manual verification for this path should compare sidebar-handle drag against
panel-splitter drag: both should track the pointer without visible stutter, while
sidebar collapse/expand still uses the normal width transition. Also drag the
expanded sidebar to its minimum width and verify the divider stops at the same
point as Back/Forward/Reload instead of sliding underneath them. Keep
`#bento-shell-host` width/min-width/max-width transitions disabled under both
`:root[bento-sidebar-resizing='true']` and
`:root[bento-window-resizing='true']`; otherwise a collapsed-width change can
make live sidebar or window resize inherit the collapse animation path and become
choppy. Panel-view and no-side-panels main-frame shadows stay at the normal
outline plus drop-shadow during live sidebar, window, and panel resize; do not
use a live-resize selector to replace `--bento-panel-frame-shadow` or the native
`.browserSidebarContainer` shadow with the outline-only value. `about:preferences` and
`about:settings` are the exceptional expensive content: their layout work can
make window, Bento-sidebar, or panel-splitter resize choppy even when the settings
page is open in a background tab. At the start of each live resize,
`bento-shell-mount.js` finds every settings about-page browser in
`gBrowser.browsers`, fixes the embedded browser's width and height to its
pre-gesture viewport, applies strict containment, preserves its layers, and
temporarily deactivates its docshell. Deactivating the docshell alone is not
enough: Firefox still propagates each parent-frame size to the embedded native
Settings viewport and repeatedly lays it out. A shared depth counter restores
the browser's prior inline geometry, render-layer, and docshell-active state
only after all overlapping resize gestures settle. Keep this freeze URL-scoped
to settings about pages so ordinary web tabs and panel shadows stay on the
normal path. The bottom panel-strip scrollbar
derives `--bento-scrollbar-thickness`
from twice `--bento-splitter-indicator-radius` and uses
`--bento-strip-scrollbar-gap` for both its bottom inset and the reserved
clearance above it; this keeps the scrollbar visually as thin as the splitter
handles and centered between the panels and the bottom window edge.
`bento-chrome-theme.css` keeps the native top toolbar tokenized with the rest
of Bento chrome, and `bento-shell-mount.js` explicitly removes Firefox's
toolbox bottom border so no separator line appears between the top toolbar and
content area. `attachSidebarChromeDivider()` overlays a fixed one-pixel divider
at `#bento-shell-host`'s right edge from the top of the chrome viewport
downward, then stamps the measured split as both `--bento-toolbar-divider-x`
and an explicit gradient on the native toolbar surfaces so they stay neutral-5
over the sidebar and switch to neutral-14 over the main content and panel strip
when panels are visible. `setNoSidePanelsMode(true)` mirrors a
`bento-no-side-panels='true'` attribute onto the chrome root; in that state
`--bento-toolbar-main-bg` resolves to neutral-5, so the native top toolbar,
fallback chrome surfaces, moved tabbox backing, and no-panel main background
stay on the sidebar surface, and `#bento-sidebar-chrome-divider` is hidden.
The sidebar iframe mirrors the active workspace's panel set and adds
`.bento-shell-app--no-side-panels` when hydrated with zero panels so its own
right border becomes transparent. Removing the root/class state restores the
neutral-14 main-side toolbar/panel-strip colour and the divider for panel view.
Regression pitfall: setting the split only through stylesheet rules or only on
`#nav-bar` can leave the right side of the top chrome on the sidebar colour,
because Firefox may paint the visible strip from `#navigator-toolbox` or
`#TabsToolbar`, and an unset split variable falls back to a full-width
neutral-5 toolbar. Keep the explicit gradient stamping on all three toolbar
surfaces (`#navigator-toolbox`, `#TabsToolbar`, and `#nav-bar`) from the same
divider measurement. The root `--bento-toolbar-divider-x` is also written from
the same measured viewport coordinate so fallback surfaces can use the identical
split: `body`, macOS's `body::after` titlebar pseudo-element, `#browser`, and
`#appcontent` all paint the same split gradient. This prevents clipped or
transparent toolbar pixels from leaking Firefox's neutral-5/native titlebar
background above the panel strip. `#bento-toolbar-main-backdrop` is an explicit
first child of `#navigator-toolbox`; it paints the main-side neutral-14 toolbar
backdrop from the sidebar divider to the right edge while `#toolbar-menubar`,
`#TabsToolbar`, `#nav-bar`, and `#PersonalToolbar` are lifted above it with
`z-index: 1`, so native/titlebar paint cannot show through behind the panel
navigator or extension buttons. The panel strip uses
`--bento-panel-strip-bg: var(--bento-toolbar-main-bg)` for its container, host,
split scrollport backdrop, add-panel trailer, flat-layout extent, and split-view
panel frame backplates. The core strip/tabbox/trailer overrides must stay inside
the `bento.chrome-theme` cascade layer because `bento-chrome-theme.css` paints
`#browser`, `#appcontent`, `#tabbrowser-tabbox`, and `#tabbrowser-tabpanels`
neutral-5 with layered `!important` declarations; unlayered runtime CSS can
lose to those declarations on the panel path. Direct panel frame backplates
also set `--bento-panel-strip-bg` with `!important`, but stay in the normal
runtime rule group so later subdivision-specific transparent-frame exceptions
can still win. The actual browser content and neutral-5 panel headers still own
their own surfaces, but any exposed panel-strip/backplate pixels must resolve to
the same neutral-14 value as the main side of the toolbar. Regression pitfall: the
no-panel view and split-panel view expose different chrome layers.
In no-panel mode the moved `#tabbrowser-tabbox` mostly exposes the strip
container and the main `browserSidebarContainer`; in split-panel mode
`#tabbrowser-tabpanels.bento-split-active` is the visible horizontal scrollport,
and its parent `#tabbrowser-tabbox` can leak Firefox's default neutral-5
background around the deck. Keep explicit `background-color` and
`background-image: none` resets on the strip container, side-panel host, split
scrollport, and split scrollport parent so the panels path matches the main
side of the top toolbar. No-panel mode is the deliberate exception: those same
tokenized backing layers resolve to neutral-5 and the divider is hidden so the
main-only view reads as one continuous sidebar-coloured surface behind the
rounded main content slot. Regression signature in the default light theme:
the toolbar over the panel navigator/extensions samples as the configured
main-side token, currently neutral-14, while the panel strip samples as
neutral-5 (`#F8F6F4`). That means
one of the split-panel scrollport, parent tabbox, trailer, extent, or direct
panel-frame rules is missing from the main-side strip path or has fallen out of
the `bento.chrome-theme` layer where it needs to beat the static chrome theme.
Do not fix this by changing panel headers; panel headers are separate surfaces.
The same chrome theme keeps Firefox's native Bookmarks
sidebar visually aligned with Bento by sizing the native `#sidebar-title` with
Mux UI `label-l` typography, vertically centering the header icon/title/chevron,
and replacing the legacy Places
`moz-input-search` search box with a native HTML search input through
`syncNativeBookmarksSearchInput()`. The replacement keeps the `search-box` ID
and calls the sidebar's existing bookmark filtering path, while the chrome CSS
can style the visible input directly with the same height, border, radius,
typography, icon spacing, and focus-ring tokens as the Bento sidebar address
field. Use a 32px fallback for this native chrome search field rather than
`2rem`: the native chrome document can resolve `rem` from Firefox's smaller
chrome font size, while the Bento sidebar address field is designed as a 32px
row. History and Synced Tabs sidebar search fields are inside Lit component
shadow roots, so `syncBentoChromeThemeShadowRoots()` injects the generated
Bento token/theme links into the native sidebar component roots and lets
`moz-input-search` consume the same inherited input variables as Bookmarks.
Firefox's sidebar switcher header and menupopup are styled in
`bento-chrome-theme.css` so Bookmarks, History, Synced Tabs, Passwords, and
extension rows share the same Mux UI label, shortcut, hover, and selected
colors. The visible header button is `#sidebar-switcher-target` in
`browser-box.inc.xhtml`; styling only `#sidebarMenu-popup` changes the dropdown
menu, not the title shown at the top of the sidebar.

The Passwords sidebar surface is Firefox's
`chrome://global/content/megalist/megalist.html`, not a Bento React panel.
`patches/core-ui/14-theme-megalist-passwords.patch` loads
`bento-chrome-tokens.css` into that document and maps the megalist's semantic
variables (`--background-color-*`, `--text-color`, `--button-*`,
`--input-text-*`, link/icon/warning variables, panel shadows, and sidebar card
variables) to light neutral Mux UI/Bento tokens. The Passwords documents set
`data-color-mode="light"` and `color-scheme: light` deliberately so macOS or
browser dark mode cannot flip `--neutral-5`, `--neutral-10`, and `--neutral-90`
back to dark surfaces and light text. The full-page Passwords manager and
import report remain `about:logins` documents;
`patches/core-ui/13-theme-about-logins.patch` loads the same token sheet there,
and `aboutlogins/common.css` maps their semantic in-content variables. Keep
those mappings in shared Firefox component stylesheets because they are loaded
by the root documents and shadow-DOM component templates.

The floating overlay remains implemented by
`extensions/bento-shell/src/address-bar/main.tsx` and
`components/AddressBar/AddressBar.tsx`. It is now the collapsed-sidebar fallback
and still receives open requests through `bento-addrbar-bus`.

The React entry in `extensions/bento-shell/src/address-bar/main.tsx` stores that
initial query and clipboard URL with the open version and passes them to
`components/AddressBar/AddressBar.tsx`, which controls Mux UI's
`CommandPalette` input with the query state and keys the palette content by open
version so selected text resets predictably. The entry dispatches
`searchEngines/requestSnapshot` and `savedPanels/requestSnapshot` on mount and on
every open; `bento-tools` answers with `searchEngines/snapshot`, which
`extensions/bento-shell/src/state/searchEngines.ts` mirrors for the address
palette only, and `savedPanels/snapshot`, which
`extensions/bento-shell/src/state/savedPanels.ts` mirrors globally. This path
does not use `privacy/setDefaultSearchEngine` and never mutates Bento Settings
or Firefox's default search engine.
`extensions/bento-tools/src/search/AddressSearch.ts` treats an empty query as a
new-tab top-sites request using `browser.topSites.get({ newtab: true })`, with
recent history as a fallback if the top-sites API is unavailable or not ready.
The address palette uses Mux UI's standard opaque `CommandPalette` popup with
an explicit `var(--neutral-5)` background. Its `CommandPalette.Backdrop` is a
non-painting wrapper used only for React Aria modal context, and the chrome
address overlay frame is sized around the popup plus transparent shadow gutters
instead of covering the full browser window. The bottom gutter is intentionally
larger than the top gutter so Mux UI's long popup shadow is not clipped by the
chrome `<browser>` frame. The browser content, sidebar, and toolbar do not
receive a modal scrim when the palette opens. It does not use the translucent
CommandPalette recipe, local `backdrop-filter`, or a chrome-side frosted bitmap
capture before opening.

`TabSnapshot.url` is part of the shared tab wire payload. `TabRegistry`
populates it from `tab.url` or `pendingUrl`, emits URL update deltas, and emits
URL-clearing deltas when Firefox no longer exposes a usable URL for the tab. The
address helpers do not build open tab/panel rows while `query.trim()` is empty.
For empty floating new-tab opens, a validated clipboard URL row is prepended
ahead of saved-panel and top-site rows. Saved-panel rows are built from the
global saved-panel mirror and dispatch `panel/openAt` with `position: 'end'`, so
they append as side panels instead of opening as main tabs. These default rows
are removed as soon as the user types. After typing,
`components/AddressBar/openRows.ts` matches active
workspace rows by `customTitle || title || 'Untitled'` and normalized URL text
with protocol and leading `www.` removed, restricts rows to the source window,
classifies panels from `panelsByWorkspace.get(activeWorkspaceId)` only, ranks
prefix matches before substring matches, preserves tab order within equal rank,
and caps combined open-tab/open-panel rows to eight.

The one-shot search-engine picker is local UI state. Each open resets selection
to the latest mirrored default and clears the dirty flag. A late
`searchEngines/snapshot` updates the selection only while the current open is
still clean; after the user chooses an engine, later snapshots for that open
must not overwrite the choice. Selecting the default engine after a non-default
choice clears the effective override because navigation sends an engine id only
when the selected id differs from the current default. The narrow
`browser.bentoPrivacy.getSearchEngines()` bridge returns Firefox's visible
engine icon as a data URL when `SearchService` exposes one; the bridge converts
blob/chrome/resource icon URLs before handing them to React. The sidebar uses
that icon in the closed picker and shows full engine names only inside the
opened menu.

Shared row shaping for tools results, synthetic open/search rows, saved-panel
defaults, URL-like detection, row text, and one-shot engine payload selection
lives in `components/AddressBar/addressRows.ts`. Both the sidebar row and
floating fallback use those helpers so autocomplete behavior does not drift.

## Address Entry Pitfalls

- Keep native top-urlbar interception in chrome, not in the extension frame; the
  Firefox suggestions popup is created by parent chrome urlbar code before the
  remote Bento UI can react.
- Intercept native top-urlbar pointer/focus at chrome window capture, not only
  on `#urlbar-input`. Firefox 152 can open the native `urlbarView` before an
  input-local listener runs, producing a brief autosuggest flash. Keep the
  short `bento-native-urlbar-intercepting` chrome attribute and CSS suppression
  as a backstop while the Bento address entry opens.
- Keep sidebar address snapshots/focus scoped by both `windowId` and
  `bridgeToken`. `messageManager` targets the frame, but the frame script then
  rebroadcasts on a same-origin BroadcastChannel shared by every Bento window.
- Do not mutate Places from a sidebar bookmark command unless the command's tab
  id, URL, bridge token, and snapshot token still match the selected main tab
  immediately before mutation.
- Do not copy a sidebar URL unless the command's tab id, URL, bridge token, and
  snapshot token still match the selected main tab immediately before the
  clipboard write.
- Keep the security popup native. React may show the security label/icon, but
  certificate, permission, and identity details must remain Firefox's
  `identity-popup` content.
- Chrome-mounted shell pages must remain present in the packaged extension
  runtime. Navigate those chrome `<browser>` frames through `loadURI()` with a
  system principal before falling back to `src`. Firefox 152 tightened this
  path; a missing entry or principal can show Firefox's "Problem loading page"
  in the sidebar or leave chrome-mounted overlays such as the address bar
  blank. These privileged mount entries do not need to be web-accessible pages.
- Do not create a blank tab for native-urlbar clicks. They are current-tab
  edits; only explicit new-tab mode should defer tab creation until commit.
- When an empty workspace is created from `workspace-palette.html`, the
  activation-created new tab can focus Firefox's native urlbar and open the
  floating address palette. Keep `#bento-addrbar-host` stacked below
  `#bento-workspace-palette-host`, pass `suppressFocus` through the
  `bento-addrbar-bus` open payload, and leave the workspace palette frame
  focused so workspace management remains the active context.
- Keep the address palette on the standard opaque CommandPalette recipe. Do not
  re-add a painting/full-window `CommandPalette.Backdrop`,
  `muxui-command-palette__popup--translucent`,
  `muxui-command-palette__backdrop--transparent`, `backdrop-filter`, or
  chrome-side `drawSnapshot`/frost capture before open. Those paths delay
  shortcut-to-visible latency, dim the page behind the palette, or recreate the
  invisible full-window hit target that blocks scrolling.
- Keep the chrome address overlay frame larger than the popup itself. The extra
  transparent gutters are what let the neutral popup shadow render without a
  hard clipped edge while still avoiding a full-window input blocker.
- Keep `#bento-addrbar-host` hidden until the address frame acknowledges the
  current `openId`. On cold opens, revealing the host before the frame applies
  the new placement shows the previous/default centered popup for a frame before
  it moves.
- When switching an already-open address palette from centered to anchored, set
  host opacity to `0` with transitions disabled before changing host geometry.
  Otherwise the previous centered popup can briefly paint in the full-window
  anchored host at top center.
- Keep the address `CommandPalette` animation opacity-only. Mux UI's default
  command-palette transform transition causes visible movement when switching
  between anchored sidebar opens and centered shortcut/new-tab opens.
- The address bar host fades on the Mux `modal` role
  (`ADDRBAR_HOST_TRANSITION = 'opacity var(--muxui-semantic-motion-modal-transition)'`).
  `hideAddrbar` sets opacity 0 and `hideOverlayHostAfterFade` commits `display: none`
  from the host's computed transition; do not put a duration back in script, and a
  reopen during the fade must keep the host (`prepareAddrbarHostForOpen` cancels the
  pending hide).
- Keep the address popup and search-engine picker popover on `var(--neutral-5)`
  surfaces so the palette reads as a traditional neutral command palette in
  light and dark modes.
- Keep the nested search-engine `Select.Popover` non-modal. React Aria's
  default select underlay catches clicks meant for the command palette and can
  turn a provider-menu dismissal into a full address-palette dismissal.
- Search provider icons come from Firefox `SearchService` engines. Native
  Firefox chrome can use the `SearchEngine.getIconURL()` result directly,
  including `ConfigSearchEngine` object URLs backed by the `search-config-icons`
  remote-settings collection. Bento must convert those URLs to `data:image/*`
  in the privileged `bentoPrivacy.getSearchEngines()` bridge before sending
  them to the extension frame. Keep the small bundled Firefox search-config
  icon fallback under `extensions/bento-tools/experiments/bento-privacy` for
  default engines whose native object URL cannot be converted during early
  startup.
- Privileged search-icon conversion accepts only bounded `https:`,
  `moz-extension:`, `chrome:`, `resource:`, and `moz-icon:` sources. Network
  reads omit credentials and referrers, time out after five seconds, and stop at
  512 KiB; engine conversion is limited to four concurrent tasks. Do not add
  `http:`, `file:`, or unbounded response reads to this bridge.
- Keep expanded-sidebar address editing in the shared address overlay. A
  sidebar-frame popover cannot reliably paint over the panel strip/main content
  because the sidebar is a chrome-hosted iframe with its own paint bounds.
- Keep the sidebar-anchored address overlay smaller than the centered shortcut
  overlay. The anchored cap is 80% of the standard width and 90% of the
  standard height; shortcut/new-tab/top-urlbar opens keep the standard centered
  dimensions.
- Do not route shortcut, new-tab, or top-urlbar fallback opens through sidebar
  row focus. Those entry points must keep the centered address/search overlay;
  only direct activation of the sidebar URL row should pass an anchor.
- Keep address-palette search-engine state separate from privacy settings. The
  picker is a one-shot override for submitted non-URL searches only.
- Keep the picker dirty flag tied to `openVersion`. Late search-engine snapshots
  must not reset a user-selected engine before submit, and each new open must
  reset to Firefox's current default.
