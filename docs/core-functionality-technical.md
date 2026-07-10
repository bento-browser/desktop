# Bento Browser core functionality technical notes

This document is the technical companion to
[core-functionality.md](core-functionality.md). It records how Bento's working
workspace, panel, layout, traversal, and theme behavior is achieved today, and
the implementation pitfalls that have already caused regressions.

Keep this document factual. If a future implementation changes the behavior,
update this file in the same change.

## Architecture summary

Bento's core browsing model is split across three layers:

- `bento-tools` is the source of truth for persisted state. It owns workspace
  metadata, tab assignment, panel layout, panel persistence, pinned panels,
  saved panels, settings, backups, and privacy actions.
- `bento-shell` is the React UI mirror. It renders sidebar controls, workspace
  switcher, tab list, pinned panels, settings, edit-workspace, and the
  panel-trailer React app. It does not directly mutate persisted state.
- `bento-shell-mount.js` is the chrome process reconciler. It receives
  title-IPC sentinels from the shell and mutates Firefox chrome UI, including
  `gBrowser`, `tabpanels.splitViewPanels`, panel headers, splitters, and chrome
  overlays.

The state contract is declared in `extensions/_shared/protocol.ts`. UI code
dispatches `Action` messages through `extensions/bento-shell/src/bridge/useToolsPort.ts`.
`bento-tools` mutates stores and broadcasts `Event` payloads back. Shell Zustand
stores are mirrors only.

## Native Tabs And Titlebar Controls

Bento hides Firefox's native horizontal tab strip through Firefox's own
hidden-tabs titlebar state. `prefs/bento.js` defaults
`bento.chrome.hideNativeTabs` to `true`, and
`patches/core-ui/02-hide-native-tabs.patch` makes
`TabBarVisibility.update()` include that pref in `hideTabsToolbar` for normal
browser windows. The patch does not enable `sidebar.verticalTabs`.

When the pref-driven branch is active, Firefox sets
`#navigator-toolbox[tabs-hidden]`, toggles `#nav-bar.browser-titlebar`, and
collapses `#TabsToolbar`. That keeps the native horizontal tab strip hidden
while reusing Firefox's existing titlebar/control markup and platform window
commands from the nav-bar titlebar copy. Bento shell owns the visible tab UI;
it does not render custom minimize, maximize, restore, or close controls.

Popup and taskbar-tab windows stay on Firefox's existing single-tab path because
the Bento condition is guarded by `!isSingleTabWindow`. If
`bento.chrome.hideNativeTabs` is set to `false` in a profile, Firefox falls back
to its default tabbar/titlebar behavior for that profile.

### Native Tabs And Titlebar Pitfalls

- Do not restore a CSS-only global `#TabsToolbar` collapse. It hides the
  tab-toolbar control copy without putting the nav bar into Firefox's native
  titlebar state.
- Do not enable or depend on `sidebar.verticalTabs`; Bento's visible tab UI is
  the `bento-shell` sidebar, not Firefox's native vertical-tabs/sidebar UI.
- Do not add window controls in `bento-shell`. The controls must remain
  Firefox's native titlebar controls and commands.

## DevTools In Panel Implementation

`src/browser/base/content/bento-shell-mount.js` installs Bento-specific
`Inspect in Panel` context-menu items beside Firefox's stock inspect items. The
stock items remain unchanged. The Bento items are visible only when Firefox's
corresponding stock item is visible, the right-click source is the main content
slot or a normal Bento panel, and the source is not already a DevTools panel.

Chrome creates the toolbox tab because WebExtension `tabs.create` cannot open
`about:devtools-toolbox` with the required system-principal owner. The chrome
helper registers a one-shot `DevToolsShim` `toolbox-ready` listener, opens
`about:devtools-toolbox?type=tab&id=<browserId>&tool=<tool>` with
`gBrowser.addTrustedTab`, then dispatches `panel/addDevtools` with the created
tab id, caller tab id (`null` for main content), and inspected tab id. When the
toolbox is ready, chrome selects the requested node by resolving
`gContextMenu.targetIdentifier` through the inspector front.

`extensions/bento-tools/src/panels/PanelStore.ts` is the source of truth for the
DevTools pairing. It keeps in-memory `DevtoolsLink` records per workspace and
never passes them to panel persistence. The pairing key is
`(callerTabId, inspectedTabId)`, so side-panel pairs and main-content pairs are
not conflated. `panels/sync` includes `devtoolsPairs`; the shell forwards that
field through `BENTO_PANELS`; chrome mirrors it into
`data-bento-devtools-for` attributes, pair lookup maps, paired focus rings, and
the always-visible connector splitter.

The connector is an inter-panel splitter with DevTools-specific paint, not a
separate overlay. The splitter element must remain full-height so the boundary
continues to resize normally. `syncInterPanelSplitters` keeps the full-height
hit target and writes `--bento-devtools-link-top` /
`--bento-devtools-link-height` CSS variables so only the visible horizontal
connector is short and centered. For callers inside a subdivided root,
`getViewportPanelRectForTabId` first reads the exact sub-panel DOM
`getBoundingClientRect()` before falling back to stored layout geometry; this is
what centers the connector on the linked sub-panel rather than on the containing
root panel. The splitter resize observer also watches linked caller sub-panels
so subdivision height changes recalculate the connector position.
Focus pairing deliberately uses a different resolver. Connector and adjacency
logic may resolve a sub-panel to its containing root because DevTools panels
live as root-level leaves, but focus rings must pair only the exact
`callerTabId` with its DevTools tab. `getDevtoolsFocusPartnerElement` handles
that exact match so focusing a sibling panel in the same subdivision does not
light the DevTools panel.

Normalization is tools-owned. `normalizeDevtoolsAdjacency` keeps a DevTools
panel as a root-level leaf immediately left or right of the caller's containing
root node. A valid immediate-left position is preserved; otherwise the panel is
snapped to the right of the caller. Main-content DevTools panels always snap to
root index 0. DevTools panels cannot be subdivided, split, moved into chooser
or horizontal group targets, or filled into subdivision choosers. Chrome drag
handling also suppresses chooser and horizontal drop targets while dragging a
DevTools panel, leaving only root-level drops; this prevents a DevTools panel
from being offered a non-root drop that tools will later reject.

Lifecycle cleanup is intentionally idempotent. Removing or demoting a caller
panel or closing the inspected tab makes `takeOrphanedDevtoolsTabs` return a
deduplicated `Set` of toolbox tab ids to close. Closing the DevTools panel itself
drops only its link and does not affect the caller. Session markers use
`bento.isDevtoolsPanel` separately from `bento.isPanel`; marker sync clears the
normal panel marker from DevTools tabs, and boot sweeps restored
`about:devtools-toolbox` tabs or tabs carrying the DevTools marker.
Pinned-panel bindings remain persistent for normal panels, but not for DevTools
panels. Chrome hides and guards the panel-header pin button for DevTools panels,
`pinnedPanel/add` refuses DevTools panel ids, DevTools close/sweep paths call
`PinnedPanelsStore.removeForTab`, and pinned-panel persistence filters
`about:devtools-toolbox` URLs on load and save so old bad pins do not survive a
restart.

### DevTools In Panel Pitfalls

- Do not resolve reuse by caller tab id alone. Main-content pairs use
  `callerTabId: null`, so `inspectedTabId` is required to avoid reusing a
  toolbox for the wrong main tab.
- Do not persist DevTools tab ids in panel snapshots, parked workspaces, pinned
  panel state, or normal panel session markers.
- Do not let chrome-only drag results be the authority for adjacency. Tools
  normalization must run after root-order mutations so all entry points converge.
- Do not attempt to open `about:devtools-toolbox` from `bento-tools`; only
  chrome can create the trusted tab.
- Do not shrink the actual inter-panel splitter to draw the DevTools connector.
  Use CSS variables to move the painted connector inside the full-height
  splitter; otherwise only the short indicator remains draggable and the
  boundary feels stuck.
- Do not center subdivided-panel connectors from root layout geometry. Use the
  linked caller sub-panel's live DOM rect when available, and observe that
  sub-panel for resizes.
- Do not reuse the root-level DevTools partner resolver for focus rings.
  Root-level matching is needed for adjacency across subdivided roots; focus
  indicators must match the exact linked caller tab id.
- Do not apply normal pinned-panel persistence semantics to DevTools panels.
  Normal pinned panels intentionally survive panel/tab closure; DevTools panels
  are ephemeral and their pinned bindings must be refused, removed on close, and
  filtered from storage.

## Address Entry Implementation

`src/browser/base/content/bento-shell-mount.js` owns address-entry routing.
`Cmd/Ctrl+L`, `Cmd/Ctrl+E`, `Cmd/Ctrl+T`, the sidebar `New tab` action,
content-process BentoKey actor events, and native top-urlbar fallback focus
open the centered floating overlay hosted at `address-bar.html`. Direct
activation of the expanded-sidebar URL row opens the same overlay with a
sidebar anchor so it appears below the row and can extend over the panel strip
and main content.

The persistent sidebar row is mounted above `TabList`; the workspace switcher
trigger is mounted below `TabList` and above the sidebar footer.
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

Firefox remains the source of truth for address semantics. The sidebar submit
path and the floating overlay submit path both call the same chrome helper,
which resolves optional one-shot search engine submissions through Firefox
`SearchService`, falls back to Firefox URI fixup, navigates the selected main
browser in current-tab mode, dispatches `tab/openUrl` in new-tab mode for
ordinary web loads, and uses Firefox chrome's trusted-tab path for privileged
new-tab `about:`/`chrome:` loads that the WebExtension tabs API rejects.
Successful submissions still reveal the main content slot.

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
`#bento-shell-splitter`, `#bento-shell-splitter-affordance`, `#sidebar-main`,
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
collapse/expand, but `attachSidebarSplitterFeedback()` must add
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
choppy. Panel-view frame shadows stay at the normal outline plus drop-shadow
during live sidebar, window, and panel resize; do not use a global
`--bento-panel-frame-shadow` live-resize override for panel view. The only
outline-only live resize frame is the no-side-panels
`.browserSidebarContainer` during window/sidebar resize. For panel splitters,
`about:preferences` and `about:settings` are the exceptional expensive content:
when a dragged panel or flat-layout group contains one of those browsers,
`bento-shell-mount.js` preserves its layers, temporarily deactivates that
browser's docshell during the drag, and restores it when `bento-resize-settled`
fires. Keep that freeze scoped to the resized panel/group so ordinary web panels
and panel shadows stay on the normal path. The bottom panel-strip scrollbar
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
Tale UI `label-l` typography, vertically centering the header icon/title/chevron,
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
extension rows share the same Tale UI label, shortcut, hover, and selected
colors. The visible header button is `#sidebar-switcher-target` in
`browser-box.inc.xhtml`; styling only `#sidebarMenu-popup` changes the dropdown
menu, not the title shown at the top of the sidebar.

The Passwords sidebar surface is Firefox's
`chrome://global/content/megalist/megalist.html`, not a Bento React panel.
`patches/core-ui/14-theme-megalist-passwords.patch` loads
`bento-chrome-tokens.css` into that document and maps the megalist's semantic
variables (`--background-color-*`, `--text-color`, `--button-*`,
`--input-text-*`, link/icon/warning variables, panel shadows, and sidebar card
variables) to light neutral Tale UI/Bento tokens. The Passwords documents set
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
`components/AddressBar/AddressBar.tsx`, which controls Tale UI's
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
The address palette uses Tale UI's standard opaque `CommandPalette` popup with
an explicit `var(--neutral-5)` background. Its `CommandPalette.Backdrop` is a
non-painting wrapper used only for React Aria modal context, and the chrome
address overlay frame is sized around the popup plus transparent shadow gutters
instead of covering the full browser window. The bottom gutter is intentionally
larger than the top gutter so Tale UI's long popup shadow is not clipped by the
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

### Address Entry Pitfalls

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
- Chrome-mounted shell pages must remain explicitly loadable from outside the
  extension page context. Keep every HTML entry loaded by
  `bento-shell-mount.js` in `bento-shell`'s `web_accessible_resources`, and
  navigate those chrome `<browser>` frames through `loadURI()` with a system
  principal before falling back to `src`. Firefox 152 tightened this path; a
  missing entry or principal can show Firefox's "Problem loading page" in the
  sidebar or leave chrome-mounted overlays such as the address bar blank.
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
  `tale-command-palette__popup--translucent`,
  `tale-command-palette__backdrop--transparent`, `backdrop-filter`, or
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
- Keep the address `CommandPalette` animation opacity-only. Tale UI's default
  command-palette transform transition causes visible movement when switching
  between anchored sidebar opens and centered shortcut/new-tab opens.
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

## Privacy And Search Implementation

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

`extensions/bento-tools/experiments/bento-privacy/` exposes the minimal
privileged surface that normal WebExtension APIs cannot provide:

- allowlisted pref reads/writes/clears;
- visible Firefox search engine discovery;
- default search engine reads/writes through Firefox `SearchService`.

The experiment rejects prefs outside its static allowlist. Search writes use
`SearchService.getEngineById`, `SearchService.setDefault(..., USER)`, and also
set the private default to the same engine when separate private search is not
enabled. Search provider ids, ordering, availability, and display names come
from Firefox `SearchService.getVisibleEngines()`.

`SettingsStore` is version 2. Defaults are
`privacyProtectionLevel: 'standard'` and `defaultSearchEngine: 'ddg'`.
Migrated v1 profiles receive those default fields in the settings snapshot but
do not have an explicit stored override. On tools boot, `background.ts` applies
the stored privacy preset or stored default search engine only when
`SettingsStore.hasOverride(...)` says the user explicitly stored that setting.
Fresh-profile browser defaults therefore come from `prefs/bento.js` and the
search config dumps rather than from an unconditional startup rewrite.

Settings UI in `extensions/bento-shell/src/features/Settings/Settings.tsx`
mirrors the live privacy snapshot. The level selector uses Tale UI
`ToggleButtonGroup` with `selectionMode`, `selectedKeys`, and
`onSelectionChange`. The search selector uses `Select.Root` with
`selectedKey/onSelectionChange`. Advanced controls use `Disclosure` and
settings-row `Switch.Root` controls. The full protection-level benefit/caveat
comparison rendered in Settings comes from `PRIVACY_LEVEL_DETAILS`. The
keyboard-shortcuts reference in
`extensions/bento-shell/src/features/Settings/ShortcutsDialog.tsx` is a
read-only Tale UI `CommandPalette` with static shortcut command records, local
`useCommandPalette` filtering, visible category section headers, command rows,
and `CommandPalette.Shortcut` key tokens. The shortcut rows use command-palette
item visuals but are display-only list rows, not selectable `CommandPalette.Item`
actions. The settings entrypoint imports `@tale-ui/react-styles/command-palette`
for that surface.

The address palette reads the same visible-engine data through the narrow
`searchEngines/requestSnapshot` / `searchEngines/snapshot` protocol. That mirror
exists only for the one-shot search picker and never dispatches
`privacy/setDefaultSearchEngine`.

Onboarding in `extensions/bento-shell/src/welcome/main.tsx` adds privacy and
search steps after browser-data import. Those steps dispatch the same privacy
actions as Settings, render compact selected-level benefit/caveat copy from
`PRIVACY_LEVEL_DETAILS`, and still leave `welcomeSeen=false` until final
onboarding completion.

uBlock Origin is bundled as a third built-in extension under
`extensions/ublock-origin/`. Its provenance and update notes are recorded in
that folder's README. `.bento-runtime-entries.json` lists the extra top-level
uBO runtime folders/files that Surfer must copy; the default Bento extension copy
filter is still used for extensions without that file.

### Privacy Pitfalls

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
- Do not move experiment files under `src/`; Surfer copies only top-level
  `experiments/` into the built-in extension.

## Workspace implementation

Workspace metadata lives in `extensions/bento-tools/src/workspaces/WorkspaceStore.ts`.
Each workspace has an `id`, `name`, optional `themeId`, optional `icon`, and
`createdAt` timestamp.

The store tracks two active-workspace concepts:

- `#lastGlobalActiveId`: persisted fallback for legacy or not-yet-window-scoped
  callers.
- `#activeIdByWindow`: per-window active workspace map, persisted via
  `browser.sessions.setWindowValue`.

`workspace/activate` is scoped to the requesting window when the shell dispatch
has a `__windowId`. In the single-window case, the activation also refreshes
`#lastGlobalActiveId` so `pnpm run dev` relaunches can fall back to the
workspace that was visible when the browser quit, even if Firefox does not
restore that window's SessionStore value. When more than one window is tracked,
per-window activation does not change the global fallback. Bento currently
enforces one workspace per window. If another window already owns a workspace,
activation returns `conflict` and the handler focuses the owning window instead
of rendering the same workspace in two windows.

Shell-side workspace state is mirrored in
`extensions/bento-shell/src/state/workspaces.ts`. Use
`selectActiveIdForWindow` or `useActiveWorkspaceIdForWindow`; do not assume the
global fallback is the active workspace for every window.
Single-workspace editing uses `edit-workspace.html`; all-workspace management
uses `workspace-palette.html`, opened from the workspace switcher through the
`useWorkspacePalette` title sentinel. Both surfaces use
`components/WorkspaceThemePicker/WorkspaceThemePicker.tsx`, which adapts Tale
UI's Emoji Picker recipe with `Popover` and `SearchField` over local
`BENTO_THEMES` metadata, then renders compact Tale UI `ToggleButton` options so
selected state fills the tile and each option can expose a full-name `Tooltip`
on hover/focus. Theme selection writes stable `Workspace.themeId` values:
`edit-workspace.html` keeps the choice in draft state until Save dispatches
`workspace/update`, while `workspace-palette.html` dispatches
`workspace/update` immediately for the edited row. Theme search text stays local
to the picker and is not persisted or sent over the bridge. When the theme
popover opens, focus moves into its `SearchField`; that field uses `slot={null}`
to opt out of any surrounding input context so typing there stays local to the
picker.

`edit-workspace.html` and `workspace-palette.html` re-icon workspaces with the
shared emoji picker in
`components/WorkspaceIconPicker/WorkspaceIconPicker.tsx`. The picker adapts
Tale UI's Emoji Picker recipe with `Popover`, `SearchField`, and `ListBox` over
`emojibase-data`'s English dataset. Vite emits `en/data.json` and
`en/messages.json` as local extension assets, and the picker fetches them only
when opened so the workspace editor cold-start JS budget does not absorb the
emoji collection. Bento flattens base emoji and skin-tone variants into the same
selectable grid, maps Emojibase categories to icon-only lucide tab buttons,
renders Emojibase subgroup sections inside the active category tab, and uses
the Emojibase group/subgroup messages for labels and search. The emoji grid and
category tab strip hide native scrollbars to prevent first-open
vertical/horizontal scrollbar flashes while preserving internal scrolling.
Selecting an icon from the picker or pressing the icon control's overlaid clear
button still writes `changes.icon`: `edit-workspace.html` keeps the value in
draft state until Save dispatches `workspace/update`, while
`workspace-palette.html` dispatches `workspace/update` immediately for the
edited row. The shared `Workspace.icon` schema remains an optional string stored
in `bento.workspaces`.
Existing non-emoji strings are not migrated or rejected: the picker trigger
displays them as legacy custom icons, the overlaid clear button can clear them,
and the picker can replace them with an emoji. The emoji search field uses
`slot={null}`, and the popover contains Escape so the first Escape closes only
the icon picker before a second Escape can close the workspace editor dialog.
Workspace avatars that render emoji icons set `data-bento-emoji-icon="true"` in
the sidebar trigger and workspace switcher menu, then override the themed avatar
background to persistent white in both color modes. Initials and legacy custom
strings keep the workspace theme background. The sidebar workspace switcher
trigger keeps Tale UI's neutral button shape but overrides that variant's
background, border, and text colors with `--color-*` tokens so the control
follows the active workspace brand instead of the neutral palette. The trigger
is rendered as a fixed bottom sidebar section between `TabList` and the footer,
so workspace switching remains reachable after scrolling long tab lists.

The workspace editor is a chrome-mounted `Dialog` frame that reads
`useWorkspacesStore`, dispatches `workspace/update`, `workspace/activate`,
`workspace/create`, and `workspace/delete`, and keeps non-empty delete
confirmation in the normal confirm overlay above the still-mounted manager.
The dialog title is visible as "Edit workspaces". The manager does not render a
custom corner close icon; it uses the default `Dialog.Close` affordance plus the
footer text Close button. The Add workspace action lives at the bottom of the
scrollable workspace list, after the existing workspace rows. Workspace rows
render the icon picker as the first column and do not duplicate that icon beside
the name input. Rows share the icon-column width as their control block size so
the name input, icon trigger, theme trigger, status button, and delete button
stay visually level.
Rows are unframed: no row padding, border, outline, shadow, or fill; the parent
list gap is the row separator.
Workspace name fields keep draft text in local `WorkspacePalette` state while
typing and only dispatch `workspace/update` from blur, with Enter blurring the
field.

Sidebar tab multi-selection lives in
`extensions/bento-shell/src/components/TabList/TabList.tsx`. Selection is UI
state scoped to the active rendered workspace: Cmd/Ctrl-click toggles a row,
Shift-click selects a contiguous range, plain click activates the tab and clears
selection, and workspace switches clear selection. The sidebar mirrors selected
tab ids through `BENTO_SELECTED_TABS` title IPC because Firefox's reserved
Cmd/Ctrl+W close command is handled by chrome before the sidebar iframe can
reliably intercept it; chrome closes the mirrored multi-selection before falling
back to single active-tab close behavior. The mirror must only emit when a
selection exists, or once to clear a previously mirrored selection; repeated
empty-selection title writes can stomp `BENTO_PANELS` before chrome polls it and
hide the panel strip. `TabRow` only receives a `selected` visual prop; tab
assignment remains tools-owned.
`TabList` also renders the visible `New tab` and `New panel` buttons above the
virtualized pane. `New tab` calls `signalAddrbarOpen('newTab')` from `App.tsx`
so the floating address/search bar opens and no blank tab is created until the
user commits. Indexed context-menu commands still dispatch `tab/create` with a
Firefox tab-strip `index` when a command needs a specific insertion point.
`New panel` dispatches `panel/openAt` with `about:newtab`,
`sourceTabId: null`, and `position: 'end'`. Tab and panel creation stay
tools-owned and use the same active-window and active-workspace assignment paths
as other entry points. Collapsed sidebar mode keeps the controls visible as
square icon-only buttons in separate virtual rows so they do not crowd the
collapsed rail. Each action row and each favicon-only tab row keeps the same
`--bento-tab-row-height` as expanded mode so toggling the sidebar keeps row
geometry predictable. The collapsed host width is
`--bento-tab-strip-width-collapsed`, which reserves the favicon-only control
width plus symmetric `--bento-sidebar-collapsed-inline-padding`; that collapsed
padding is intentionally larger than the expanded section padding so active
favicon buttons do not sit tight against the rail edges.
The workspace switcher is the exception to applying that padding on the section
wrapper: in collapsed mode `.bento-shell-app__workspace-switcher` must keep
`padding-inline: 0`, while `.bento-workspace-switcher__trigger` is locked to the
same square `--bento-tab-row-height` width/min/max/height as tab-row controls.
The rail breathing room comes from the host width, not from shrinking the
switcher wrapper's content box; adding left/right padding there makes the active
workspace avatar background look squeezed instead of square.
Keep the chrome host pinned directly to this token rather than layering on a
second chrome-local `calc()`/`max()` fallback; live sidebar/window resize relies
on a single collapsed-width path plus the `bento-sidebar-resizing` and
`bento-window-resizing` transition guards above.
Folder expand/collapse records the clicked folder row's offset inside the
virtualized scroller before dispatching `tabFolder/setCollapsed`, restores that
offset on the next row-model render, and suppresses the pane's one-shot
active-tab auto-scroll for that render. Without this anchor, collapsing a folder
that contains the active tab can move the active row to a peek slot and make the
sidebar jump away from the clicked folder.
The active/current sidebar tab row is styled in
`extensions/bento-shell/src/components/TabRow/TabRow.css` with Tale UI
`--color-60` and `--color-60-fg`, not neutral surface tokens, so the browser
current tab remains visually distinct from hover and multi-selection states.
The foreground override for active-row text and icons must stay unlayered
because Tale UI text, button, and icon utility styles are also unlayered; keeping
the override only inside `@layer bento.components` lets neutral utility colors
win.
Sidebar audio controls are driven by `TabSnapshot.audible` and
`TabSnapshot.muted` from `extensions/bento-tools/src/tabs/TabRegistry.ts`.
`TabRow` renders the speaker button when either flag is true and dispatches
`tab/toggleMuted`; `extensions/bento-tools/src/messaging/protocol-handler.ts`
applies the mutation with `browser.tabs.update({ muted })`. Keep muted separate
from audible because muted media tabs must remain unmutable from the sidebar
even after Firefox stops reporting them as audible.
Panel-header audio controls use the same source state and action path. Tools
adds `audible` and `muted` to each `panels/sync` panel entry and re-emits
`panels/sync` when a panel tab's audio state changes; the shell forwards that
through `BENTO_PANELS`, and `bento-shell-mount.js` mirrors it in
`currentPanelAudioByTabId` for the chrome-injected header button beside Reload.
The top-toolbar panel navigator also consumes the same panel metadata. Normal and
grouped side-panel nav buttons toggle `.bento-panel-nav__icon--audible` and
their Lucide music-note particle overlay when any contained panel is
`audible && !muted`; this must stay a metadata update on reused nav buttons,
not a navigator structural signature input. The emitter must stop creating new
notes when audio stops while letting already-emitted finite particles finish
their fade-out; do not remove the particle layer abruptly for normal audio-off
updates. The particle layer is parented to `#bento-panel-nav`, not inside each
favicon button or `.bento-panel-nav__list`, because the favicon list is a
horizontal scroll container and clips child overflow.
`extensions/bento-shell/src/components/TabList/TabList.tsx` inserts the New menu
row into the virtualized pane after pinned tabs and folder rows, before regular
tabs. That Tale UI menu exposes the New tab and New panel actions from the same
row in both expanded and collapsed sidebar modes. When the inserted New menu row
has any pinned tab or folder row above it, `TabListPane` marks it with
`bento-tab-list__row--after-pinned` for styling hooks, but no divider is painted
between pinned tabs/folders and the New menu. The New/Search controls shift down
by `--bento-tab-list-row-gap` in that state so their top inset matches the
pinned/folder section's bottom gap without changing the virtualizer row height.
The workspace-switcher header stays on the base neutral-5 sidebar surface, while
the pinned/folder region above the New menu is neutral-12: `TabListPane` exposes
the pre-New-row height to `TabList.css` so the tab-list viewport paints only
that upper region. When that height is zero, the neutral-12 pseudo-element is not
attached, so empty pinned/folder sections do not leave a colored strip above
New/Search.

Sidebar drag handling in `TabListPane` classifies tab drops before falling back
to anchor-based reordering. A drop in slot `0` or within the current pinned run
dispatches `tab/setPinned` with `pinned: true`; dropping a pinned tab outside
that run dispatches `tab/setPinned` with `pinned: false`. `bento-tools` owns the
actual mutation in `extensions/bento-tools/src/messaging/protocol-handler.ts`,
where `tab/setPinned` calls `browser.tabs.update({ pinned })` and clears any
stale `bento.folderId` membership through `TabRegistry.setFolder`.

The sidebar context menu is still rendered by chrome through
`BENTO_SIDEBAR_CONTEXT_MENU` in
`src/browser/base/content/bento-shell-mount.js`. When a selected row is
right-clicked, the shell payload includes `tabIds`; chrome dispatches
`tabs/reload` for "Reload X tabs", `tabs/moveToNewWorkspace` for the "Move
selected tabs to new workspace" item, or `tabs/assignWorkspace` for batch moves
to an existing workspace.
All sidebar context menus include "Reopen closed tab". Chrome dispatches
`tab/reopenClosed`, and bento-tools calls `browser.sessions.restore()` with no
session id so Firefox restores the most recent closed session entry. Existing
TabRegistry and panel-marker listeners classify the restored tab or panel after
SessionStore recreates it.
All sidebar context menus also include "Select all tabs". Chrome dispatches the
bus-only `ui/selectAllTabs` action; `TabList` consumes it directly and selects
the current `visualTabOrder`, so selection remains transient shell UI state and
continues to mirror through `BENTO_SELECTED_TABS`.
Right-clicking an unselected row does not mutate sidebar selection, because
doing so emits `BENTO_SELECTED_TABS` and can overwrite the context-menu title IPC
before chrome polls it.
For single rows, the shell includes "New tab below" with the clicked row's
`TabSnapshot.index`, includes "Mute tab" or "Unmute tab" from
`TabSnapshot.muted`, includes "Unload tab" disabled when `TabSnapshot.active` or
`TabSnapshot.discarded` is true, includes a "Close multiple tabs" submenu,
includes "Close tab", and includes "Convert to panel" only when the target row
is not the active tab. `TabList` passes its current `visualTabOrder` into the
context menu payload so "Close tabs above" and "Close tabs below" match the
visible sidebar order. "Close other tabs" precomputes every non-pinned tab
except the clicked tab. Chrome dispatches `tab/create` with `index + 1`,
`tab/toggleMuted`, `tab/unload`, `tabs/close`, `tab/close`, or `panel/add` for
those items. Bento-tools passes a valid `tab/create.index` to
`browser.tabs.create` while preserving the same source-window and eager
workspace assignment used by other blank-tab creation paths. `tab/unload`
re-reads the live Firefox tab and calls `browser.tabs.discard` only if the tab is
still inactive and not already discarded; the resulting `discarded` delta flows
back through `TabRegistry`.

Tab folders are workspace-scoped metadata in
`extensions/bento-tools/src/tabFolders/TabFolderStore.ts`, persisted through
`extensions/bento-tools/src/tabFolders/Persistence.ts` under
`browser.storage.local` key `bento.tabFolders` with a single backup slot.
Membership is stored on tabs with the `bento.folderId` sessions key in
`TabRegistry`, so closing a tab removes its membership without mutating folder
metadata. The wire protocol adds `TabSnapshot.folderId`, `TabFolder`,
`tabFolders/snapshot`, `tabFolders/changed`, `tabFolder/*` actions, and
`tabs/setFolder`. `TabFolderStore.create()` defaults folders to expanded for
user-created folders but accepts an explicit initial `collapsed` value for
system-created folders such as browser-session merge imports. Moving a tab to
another workspace clears folder membership in the same tab delta as the
workspace change. Moving a whole folder uses `tabFolder/assignWorkspace`: tools
updates each member tab's workspace while preserving that folder id, then moves
the folder metadata to the target workspace at the end of that workspace's
folder order.

Folder drops use the same `tabs/setFolder` action as the context menu. The shell
marks folder rows as drop targets and dispatches the folder id when a tab is
dropped on a folder row or into that folder's visible block. Tools validates the
folder workspace, demotes pinned sources with `browser.tabs.update({ pinned: false })`,
then writes `bento.folderId` through `TabRegistry.setFolder`. Dropping a folder
member outside its folder block dispatches `tabs/setFolder` with `folderId: null`.

The shell mirrors folder metadata in
`extensions/bento-shell/src/state/tabFolders.ts`. `TabList` builds a single
virtualized display-row list with
`extensions/bento-shell/src/components/TabList/displayRows.ts`: pinned tabs,
folder rows and visible folder members, action rows, then regular tabs. Stale or
foreign `folderId` values render as regular tabs because the row builder only
honors folder ids present in the active workspace's folder set. Collapsed
folders hide members except for the active member peek row. Sidebar selection,
Shift-range selection, close-selected, and the `BENTO_SELECTED_TABS` mirror use
the flattened visible tab order so hidden folder members cannot be acted on.

Folder and tab rename context-menu requests are `ui/renameRequest` bus actions
consumed by `extensions/bento-shell/src/state/ui.ts`; they must not be
forwarded to bento-tools. The shell background therefore treats `menu/open` and
all `ui/*` actions as bus-only. Chrome receives tab and folder context menus via
`BENTO_SIDEBAR_CONTEXT_MENU` in
`src/browser/base/content/bento-shell-mount.js`. Folder-only menu items must be
handled before the `hasTabId` guard because folder menus intentionally carry no
tab id. Rename requests initiated from the native chrome context menu must also
move focus back into the sidebar frame before broadcasting on
`bento-shell-bus`; `BENTO_SHELL_ACTION` frame script calls `content.focus()` for
`ui/*` actions so the shell's inline rename input can focus and select its text.
The folder row then retries `input.focus()`/`input.select()` briefly after
entering rename mode to cover React commit and browser focus timing.

Batch tab assignment is handled in
`extensions/bento-tools/src/messaging/protocol-handler.ts`. Tools creates the
new workspace through inactive `WorkspaceStore.create`, assigns each selected
tab through `TabRegistry.assignWorkspace`, activates the new workspace, removes
stale pinned-panel bindings, and runs the same empty-source-workspace cleanup
used by single-tab moves after the batch finishes. Creating the workspace
inactive prevents the activation orchestrator from seeing an empty workspace and
opening an unwanted blank tab before the moved tabs arrive.

### Workspace pitfalls

- Do not render the same workspace in two windows unless the panel architecture
  has been changed to support that. The current chrome reconciler resolves panel
  tabs against a single window's `gBrowser`.
- Do not bypass `workspace/activate`. Per-window active state, conflict policy,
  single-window restart fallback, and SessionStore persistence live in
  `WorkspaceStore`.
- Do not mutate `useWorkspacesStore` directly from React components. Dispatch a
  protocol action and let tools broadcast deltas.
- Do not persist sidebar selection in tools or shell stores. It is transient UI
  state for the currently rendered tab list, and hidden workspace selections
  would make batch context-menu actions unsafe.
- Do not reorder folders with `BENTO_TAB_MOVE`, `browser.tabs.move`, or
  Firefox tab-strip APIs. Folder order is storage-backed metadata and only moves
  through `tabFolder/reorder`.
- Do not implement sidebar pin/folder drag by mutating shell stores directly.
  Drops must dispatch `tab/setPinned` or `tabs/setFolder` so Firefox pinned state
  and `bento.folderId` session persistence remain authoritative.
- Do not treat a stale `bento.folderId` as authoritative in the renderer. If
  the folder metadata is absent from the current workspace, render the tab as a
  regular tab.
- Do not split workspace moves and folder clearing into separate tab deltas.
  Cross-workspace moves must clear folder membership atomically with the
  workspace change.
- Do not move folder member tabs with the default `tab/assignWorkspace` path.
  Folder moves must preserve `bento.folderId` while changing workspace id, then
  move the folder metadata to the target workspace.
- Do not handle folder context-menu actions after the chrome handler's
  `hasTabId` guard; folder menus have no tab id by design.
- Do not rely on the inline rename component alone for focus after native
  context-menu commands. Chrome can keep focus outside the sidebar frame, which
  leaves only a visual outline on the folder row and prevents immediate typing.
  Keep the chrome bridge's `content.focus()` handoff for `ui/*` actions and the
  shell-side retry/select logic together.

## Panel state and layout model

Panel state lives in `extensions/bento-tools/src/panels/PanelStore.ts`.
The data model is a workspace-scoped layout tree implemented in
`extensions/bento-tools/src/panels/PanelLayout.ts`.

The runtime layout supports:

- root panels: `{ kind: 'panel', tabId }`;
- vertical groups: top panel plus bottom node;
- horizontal groups inside the bottom slot;
- chooser nodes used while a subdivision is waiting for content;
- group ratios clamped to `0.2..0.8`.

Top-level panel order is the `layout.root` order. Reorder operations use stable
root node ids:

- plain panel roots use `panel:<tabId>`;
- grouped roots use the group id.

Panel persistence is versioned in `extensions/bento-tools/src/panels/Persistence.ts`.
Current persistence is version 5. It stores URL-backed `panelKey` entries plus
the layout tree. Panel keys are derived from visible layout order when writing
so URLs can be restored to fresh tab ids on next launch.

First-run browser-data import is handled from Bento's onboarding experience. The
welcome overlay is a multi-step Bento-motif setup flow, and browser-data import
is one step inside that flow. The intro step writes
`BentoSettings.uiColorMode` from its Light, Dark, and Auto selector; Auto is
stored as `system` and resolved by the theme/chrome flows below. Fresh profiles
default `uiColorMode` to `light`. The sidebar frame and hidden welcome frame both
request the overlay when the settings snapshot reports `welcomeSeen=false`;
chrome treats `BENTO_OPEN_WELCOME` from either frame as an idempotent show
request so cold-start title races do not suppress onboarding. The React dialog is
controlled open, disables backdrop and keyboard dismissal, and has no first-step
skip action; chrome also consumes Esc while welcome is visible without hiding it.
Only the final `Start browsing` action sets `welcomeSeen=true`.
When import is selected, the welcome page stores the next onboarding step in
`browser.storage.local` as `bento-welcome-step` without setting
`settings.welcomeSeen=true`, waits for that write before signaling
`BENTO_IMPORT_BROWSER_DATA_<nextStep>_<ts>`, and advances its own step state so
the user continues onboarding after import closes. The localStorage mirror is
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
chrome Tale token stylesheet, maps Firefox in-content wizard variables to those
tokens, installs `bento-migration-wizard-bridge.css` into the wizard's open
shadow root so the native selector, buttons, cards, and lists follow Tale-like
BEM styling, mirrors the resolved chrome light/dark mode through the iframe URL,
suppresses Esc, and signals close/restart back to chrome through
`BENTO_CLOSE_EMBEDDED_IMPORT` and `BENTO_RESTART_EMBEDDED_IMPORT` title
sentinels.
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
and close the overlay.
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
instance remains cleanable.
The welcome overlay browser stays mounted under `#browser` so its title-IPC
open/close signals stay reliable. Bento modal overlays also share a separate
`bento-overlay-toolbar-scrim` for the native toolbar/urlbar strip, which
otherwise paints above in-document overlays so an in-document `Dialog.Backdrop`
can only dim the content area. The scrim is a `div` with `popover="manual"`
appended to `<body>`; its UA popover layout is overridden into a top strip
(`position: fixed; top:0; left:0; right:0; bottom:auto`) with its `height` set
on show from the live toolbar rect (the gap above `#browser`), so it dims
exactly the toolbar strip and never overlaps the content backdrop. Its dim is
`background-color: var(--scrim)` — the SAME token Tale UI's `Dialog.Backdrop`
uses (`--modal-backdrop-bg: var(--scrim)`), so the toolbar dim matches the
content dim exactly. The popover background represents the first active modal;
when a modal is stacked over another modal, `bento-shell-mount.js` adds matching
fading child scrim layers so the toolbar/urlbar receives the same compounded
dim as the content-area `Dialog.Backdrop` stack. `showPopover()` /
`hidePopover()` control top-layer membership; opacity drives the fade; a
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

## Sidebar Native Firefox Surfaces

The sidebar footer's Firefox-menu button signals
`BENTO_OPEN_APP_MENU:<timestamp>:<base64-json>` to
`src/browser/base/content/bento-shell-mount.js` with the button's
iframe-local bounding rect. Chrome adds the `#bento-shell-frame` rect, positions
a temporary `#bento-sidebar-app-menu-anchor` in the chrome document, and opens
Firefox's native `#appMenu-popup` through `PanelMultiView.openPopup(PanelUI.panel, ...)`.
The popup uses Bento's shared sidebar footer panel position,
`topleft bottomleft`, so its left edge attaches to the trigger and it grows
rightward when Firefox has enough screen space. Before opening, Bento sets
`animate="false"` and a `bento-sidebar-footer-panel` marker on the native panel
so Firefox's arrow-panel transform does not slide the popup from the top or
bottom. The temporary anchor is removed and the previous `animate` state is
restored after `popuphidden`.

The sidebar footer's Downloads button signals
`BENTO_OPEN_DOWNLOADS:<timestamp>:<base64-json>` through the same title-IPC
path. Chrome positions `#bento-sidebar-downloads-anchor`, initializes
Firefox's native `DownloadsPanel`, waits for `DownloadsView` to finish its
initial load when needed, and opens the native downloads panel with
`PanelMultiView.openPopup(...)` above the footer button using the same
`topleft bottomleft` footer position and the same temporary `animate="false"`
suppression. Firefox may still shift the wider downloads panel left on narrow
windows to keep the panel on-screen. This path does not call
`DownloadsPanel.showPanel()` because that method forces Firefox's toolbar
`DownloadsButton` as the anchor. Chrome also patches `DownloadsButton.getAnchor`
and `DownloadsButton.releaseAnchor` in sidebar-addressbar mode so Firefox's
automatic `DownloadsPanel.showPanel()` paths use and clean up the same sidebar
fallback anchor instead of the hidden toolbar button.

Bento does not reimplement Firefox's app menu in React. The native menu keeps
owning sign-in state, update/menu-message banners, subviews, extension entries,
shortcuts, and Firefox command handlers. Bento also keeps the native downloads
panel as the source of truth for download item actions, blocked-download flows,
private-download prompts, and download history. Bento hides the stock
`#PanelUI-button`, `#downloads-button`, `#wrapper-downloads-button`, and
`#fxa-toolbar-menu-button` while Bento's sidebar-addressbar chrome mode is
active so the footer buttons are the visible app/download entry points and the
native Account menu does not occupy the top toolbar.

## Manual Browser Session Merge

Manual browser-session merge is a runtime additive import, separate from the
startup Firefox/Zen profile-copy migrator. The user opens it from the sidebar
footer, which signals `BENTO_OPEN_MERGE_PALETTE_<timestamp>` to
`src/browser/base/content/bento-shell-mount.js`. Chrome shows the
`bento-merge-palette-host` overlay, keeps `merge-palette.html` mounted between
opens, and sends an open nonce into the extension frame with
`messageManager.sendAsyncMessage("BentoMergePaletteLifecycle", ...)`. The frame
script posts that nonce on `BroadcastChannel("bento-merge-palette")`, and the
React entry dispatches a fresh `externalMerge/requestSources` for every open.
React mount is not the refresh boundary. The palette search row also exposes a
refresh button that dispatches a new `externalMerge/requestSources` request
through the same store path while keeping the current source rows visible until
the replacement response arrives; refresh is disabled while a merge operation is
active. While `activeOperationId` is set, the shell renders an opaque absolute
overlay inside the Tale UI command palette popup. The overlay covers the search,
source rows, footer, and close control, names the source being imported, and
shows an indeterminate `ProgressBar` plus Close and Cancel buttons. The Close
button hides the palette without cancelling the active import, and the Cancel
button dispatches `externalMerge/cancel` for the active `operationId`. Backdrop
dismissal and `onOpenChange` close handling are disabled while that in-palette
merge overlay is active.
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
default ports, preserves path/query/hash, maps supported source new-tab URLs to
`about:newtab`, and rejects invalid, `javascript:`, `data:`, and unsupported
browser-internal schemes. Duplicates are skipped against existing Bento state
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
with `{ activate: false }` until all tabs/folders are created. Tabs are opened
inactive in the requesting window when known, assigned to the workspace through
`TabRegistry.assignWorkspaceEagerly`, and pinned tabs are pinned with
`browser.tabs.update` as a backstop. Source tab titles are not written to
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
is deleted. At the end, the first imported workspace activates in the requesting
window and the first non-pinned imported tab receives focus, falling back to the
first imported tab.
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
`ImportExecutor.ts`, and `ExportSchema.ts`. A workspace export must include the
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

`extensions/bento-shell/src/features/Settings/BackupSection.tsx` owns the stored
backup action affordances. Restore and delete icon buttons use Tale UI
`Tooltip` labels and open a local `AlertDialog`; only the dialog confirmation
dispatches `backup/restore` or `backup/delete`.

When `replaceExisting` is enabled, import must create the replacement workspaces
and tabs before removing old workspace tabs. Removing old tabs first can close
the only browser window during `pnpm run dev`, terminating the running Bento
browser before the import can repopulate it. If a replacement export contains an
empty workspace with no imported tabs or panels, create an `about:blank` tab in
that imported workspace before removing old tabs so Firefox never observes an
empty window.

Panel session markers live in `extensions/bento-tools/src/panels/SessionMarker.ts`.
They use `browser.sessions.setTabValue` with workspace id and restore location
so a closed panel can be restored by Firefox's closed-tab flow and then
reinserted into Bento's layout.

### Panel actions

Core panel actions are handled in
`extensions/bento-tools/src/messaging/protocol-handler.ts`:

- `panel/add`: promotes an existing tab into the active workspace's panel
  layout, applies default panel width, syncs markers, and emits `panels/sync`.
- `panel/openAt`: creates a background tab and inserts it as a panel. With
  `position` set to `'end'`, it appends from the panel trailer; default or
  `'after'` inserts relative to a source panel or the main slot.
- `panel/remove`: removes the panel binding and closes descendant sub-panels
  when needed.
- `panels/clear`: removes all panels in the active workspace.
- `panelLayout/reorderRoot`: reorders top-level root nodes.
- `panelLayout/movePanel`: moves one visible panel leaf to a root slot, an
  eligible one-panel subdivision row, or an unconfigured subdivision chooser.
- `panelLayout/subdivide`, `fillChooser`, `breakOut`, `removeVerticalGroup`,
  and `setGroupRatio`: mutate the layout tree.
- `panel/setWidth`, `panel/setMainWidth`, and `panel/setStripScroll`: persist
  chrome-measured layout state without broadcasting an immediate
  `panels/sync`.
- `panel/setHeaderHidden`: persists a per-tabId side-panel or sub-panel header
  hidden flag without broadcasting an immediate `panels/sync`; chrome already
  toggled the live `data-bento-header-hidden` attribute.

`emitPanelsSync` in `extensions/bento-tools/src/background.ts` resolves live tab
ids to `{ tabId, url, favIconUrl, widthPx, headerHidden }`, includes `layout`,
`panelStatusByTabId`, workspace-scoped main width, strip scroll, pinned tab
ids, saved-panel count, and optional `scrollToPanelTabId`, then broadcasts
`panels/sync`.

### Panel state pitfalls

- Do not write shell stores as the source of truth. `PanelStore` owns layout and
  persistence.
- Do not emit `panels/sync` after every width write. Chrome already applied the
  live width inline; a sync round-trip can clobber an in-flight drag with stale
  persisted values.
- Do not emit `panels/sync` after every header-hidden write. Chrome already
  applied the live `data-bento-header-hidden` attribute; tools only persists,
  and later sync payloads carry `headerHidden` back.
- Do not use tab ids as durable storage identifiers. Persist URLs plus
  `panelKey`; tab ids are runtime-only.
- Keep panel markers synced after add, remove, reorder, and restore. Closed-tab
  restore depends on marker root indexes and containing root ids.
- Do not clear a panel's `bento.isPanel` marker in the `tab/close` path. Firefox
  needs that tab session value to survive into the closed-tab entry so
  `Cmd+Shift+T` can route the restored tab through
  `maybeRestorePanelFromMarker`. Clear the marker only when the tab stays open
  as a normal tab, such as `panel/remove` or explicit panel promotion.
- A user-restored tab can carry Bento's `bento.closingTab` marker from the
  original close path because Firefox preserves WebExtension session values
  through closed-tab restore. Clear that closing marker before assignment or
  panel insertion. Otherwise the created-tab workspace backfill guard treats the
  restored tab as still closing and removes it again. This applies to normal
  tabs as well as panels. `TabRegistry.unmarkClosing` must also suppress stale
  async hydration reads that may have observed the old marker before it was
  removed.
- Firefox activates the restored tab during `Cmd+Shift+T`. After restoring a
  marked panel, switch selection back to the captured prior non-panel tab, or to
  another non-panel tab in the same workspace/window if the captured value is
  missing. Chrome reconciliation must also reject any selected tab that is
  present in the Bento panel payload as the main slot. Otherwise the restored
  panel can be painted as both selected content and side-panel content, causing
  overlap behind adjacent panels.
- Restored panels often have no `widthPx` because `PanelStore.remove` drops
  width state when the tab leaves all panel layouts. When
  `maybeRestorePanelFromMarker` reinserts the tab, stamp
  `settings.snapshot().defaultPanelWidthPx` through `PanelStore.setWidth` before
  emitting `panels/sync`; `Cmd+Shift+T` restore should use the configured
  default new-panel width, not a stale browser/container width. In flat layout,
  do not clear inline width after the panel-enter animation. Absolute rects
  depend on inline `width`, `min-width`, and `flex`; clearing width lets the
  restored panel auto-size and overlap adjacent panels until a splitter drag
  rewrites sizing.
- Root-panel enter animation must start after chrome computes flat-layout
  geometry and calls `applyPanelLayoutRects`. Starting the animation while the
  restored panel still has Firefox's stale split-view dimensions lets
  `animatePanelEnter` measure the wrong final width and write that stale width
  back on the next animation frame, making the restored panel overlap until a
  splitter drag refreshes layout.
- Chrome's layout sanitizer must treat the `panels` payload as the authoritative
  visible panel set. If a `panels/sync` payload includes a tab id that is absent
  from the decoded layout tree, append it as a root before computing flat-layout
  geometry. Otherwise the panel is resolved and rendered, but receives no
  `panelRects` entry and overlaps until the next live layout refresh.
- In `bento-no-side-panels` mode, do not create the main-content gutter with
  padding on `#bento-side-panel-host` or with host pseudo-elements. macOS live
  window resize became choppy when no-panel host padding, rounded child
  clipping, or frame shadow were each tested in isolation. The working shape
  mirrors Zen Browser's simpler native structure: keep
  `#bento-side-panel-host` unpadded and `overflow: visible`, create the real
  gutter with margins on the direct `[data-bento-main-panel]`, and put the
  rounded clip plus frame paint on the native
  `#tabbrowser-tabpanels > .browserSidebarContainer`. The current no-panel
  frame uses `border-radius: var(--radius-xl)`,
  `box-shadow: var(--bento-panel-frame-shadow)`, and `overflow: clip` on that
  native container. The moved `#tabbrowser-tabbox` and its child
  `#tabbrowser-tabpanels` must paint `--bento-panel-strip-bg` in the
  `bento.chrome-theme` layer in no-panel mode; that token deliberately resolves
  to neutral-5 only while `bento-no-side-panels='true'`. Otherwise Firefox's
  static tabbox/tabpanels backing can show as a sharp square corner behind the
  rounded main-content clip. Because `browserSidebarContainer` owns the
  clip, neutralize the direct child `.browserContainer` radius/overflow in
  no-panel mode; otherwise the main page has two rounded clipping layers during
  window/sidebar resize, which reintroduces choppy live resizing. Exception:
  when Firefox sets
  `:root[inDOMFullscreen]`, the
  fullscreen override must clear the strip host and browser-wrapper radii so
  video fullscreen is not clipped by the normal main-content or panel frame.
  This CSS structure is necessary but not sufficient: live window/sidebar/panel resize
  must also keep chrome measurement observers and expensive frame paints out of
  the hot path. While `:root[bento-window-resizing='true']` or
  `:root[bento-sidebar-resizing='true']` or
  `:root[bento-panel-resizing='true']`, splitter-affordance, sidebar-divider,
  toolbar-navigation, and strip-scrollbar observers defer geometry reads until
  the `bento-resize-settled` event. Do not globally override
  `--bento-panel-frame-shadow` during live resize; panel-view frames should keep
  their normal elevation so panel-view window/sidebar resize can be evaluated
  independently from the no-panel performance path. In no-side-panels mode, keep
  a direct
  `box-shadow: var(--bento-panel-frame-outline-shadow)` override on the native
  `#tabbrowser-tabpanels > .browserSidebarContainer` frame while
  `bento-window-resizing` or `bento-sidebar-resizing` is set; that native frame
  is the resized, rounded main-content surface and is the documented choppy
  no-panel path. Privileged native about pages such as
  `about:preferences` and `about:settings` make this regression visible first.
  `pnpm run chrome:resize-check` enforces this guard after chrome token
  generation.
- When removing a parent panel with descendants, close or remove descendant
  sub-panel tabs intentionally. Do not leave orphaned tabs in the panel layout.
- `panelLayout/breakOut` promotes an existing child into the root layout and
  must not emit `scrollToPanelTabId`. Break-out is a layout normalization action,
  not a new-panel reveal; emitting an explicit scroll target left-aligns the
  promoted panel and loses the user's current strip context.
- Closing the active final regular tab while panels remain must route through
  `closeMainTabWithPanelPromotion`, even when the initiating action is the
  generic sidebar/command-palette `tab/close`. Promoting only from
  `browser.tabs.onRemoved` is too late: Firefox can briefly select a still-panel
  tab as the fallback, chrome reconciles against stale panel payload, and the
  workspace can stay blank until a workspace switch forces a fresh render.
  Promote the leftmost panel out of `PanelStore`, clear its panel marker,
  eagerly assign it to the workspace as a normal tab, activate it directly with
  `browser.tabs.update`, emit a window-scoped `panels/sync`, then remove the old
  main tab with the delayed close path. Do not rely on
  `TabRegistry.snapshot()` during this transition; native `tabs.onRemoved` and
  registry removal deltas can be ordered differently.
- Window-close teardown (`Cmd+Shift+W`) is not the same as deleting workspace
  contents. `TabRegistry` keeps a private URL cache and emits one
  `onWindowClosing` snapshot before it drops the closing window's tab ids.
  `background.ts` parks sidebar tabs in `bento.parkedWorkspaceTabs` and asks
  `PanelStore.parkWorkspaceWithResolvedUrls` to convert live panel tab ids into
  persisted URL/layout entries. Workspace activation restores parked sidebar tabs
  before the empty-workspace newtab fallback and restores parked panels through
  the normal `restorePanelsForWorkspace` path. Parked sidebar-tab restore must
  first consume matching session-restored workspace tabs by URL before creating
  tabs, otherwise every dev/browser relaunch can duplicate the parked tabs. Do
  not let removed-tab deltas or `emitPanelsSync` prune closing-window panel ids
  before this parking step runs.

## Shell to chrome bridge

Chrome-bound state travels through title IPC because WebExtension UI documents
cannot directly mutate Firefox chrome.

The main channel is `BENTO_PANELS:<ts>:<base64-json>`, written by
`useToolsPort.ts` when a `panels/sync` event matches the shell document's active
workspace for its window. The payload carries:

- workspace id and optional window id;
- panel array;
- layout tree and layout status map;
- workspace theme id;
- UI color mode;
- sidebar collapsed state;
- custom panel sizes, preserving the Settings-defined drag order for the panel
  header custom widths menu;
- default panel width, mirrored into the main content slot minimum width;
- panel cycle wraparound setting;
- panel shadow setting;
- persisted strip scroll;
- pinned panel tab ids for the active workspace;
- saved panel count;
- optional panel id to scroll into view.

The panel shadow setting toggles `bento-panel-shadows-disabled` on both
`gBrowser.tabpanels` and `#bento-strip-container`. Split-view panels read the
class from `tabpanels`; the no-side-panels, tabs-only main content slot reads it
from the strip container because its shadow is applied outside `tabpanels`.
The relevant chrome styles live in `src/browser/base/content/bento-shell-mount.js`
inside `injectChromeStyles()`. `:root` defines
`--bento-panel-frame-outline-shadow` and `--bento-panel-frame-shadow`; the
disabled class overrides `--bento-panel-frame-shadow` to the outline-only value.
Do not use live resize root attributes (`bento-window-resizing`,
`bento-sidebar-resizing`, or `bento-panel-resizing`) to override the shared
shadow token globally. Keep
`scripts/check-chrome-resize-guard.mjs` wired into token import paths so token
bumps cannot reintroduce full elevation shadows during live resize.
All panel-like chrome surfaces that should respect the setting must use
`var(--bento-panel-frame-shadow)` rather than `var(--shadow-l)` directly.
The no-side-panels main-content frame also has an explicit live window/sidebar
resize selector that sets its `.browserSidebarContainer` shadow to
`var(--bento-panel-frame-outline-shadow)` directly; keep that selector in sync
with the scoped no-panel resize guard.
This includes ordinary split-view panel frames, subdivided-panel descendants, and
the absolute layout chooser wrapper
`#bento-side-panel-host > .bento-layout-chooser`. The chooser wrapper is the
surface shown after `Subdivide panel`; if it uses `var(--shadow-l)` directly,
the bottom chooser area keeps a drop shadow even when Panel shadows is off.
The same chooser is focusable and participates in panel cycling. It receives the
same `bento-panel--focused` / `bento-panel--cycle-focused` classes as panel
containers and paints its ring through `.bento-subdivision-chooser::after`.
Flat-layout chooser overlays are stamped with `data-bento-chooser-id` and
`data-bento-owner-tab-id` so focus and the bottom navigator marker can map the
overlay back to its owning top-level panel.

Chooser cycling fix: Cmd/Ctrl+Shift+arrow cycling, Shift-wheel cycling, and the
content-key bridge all call `navigatePanels()`, which reads `getPanelCycleTargets()`. In
flat layout, that target list must be built from `currentPanelLayout` via
`getFlatLayoutPanelCycleTargets()` / `appendLayoutCycleTargets()` rather than
from `data-bento-subdivided`. Flat layout intentionally clears nested
subdivision DOM and renders choosers as absolute `.bento-layout-chooser`
overlays, so DOM subdivision attributes are not a reliable source for chooser
cycle targets. If this regresses, the visual focus ring may exist, but
Cmd/Ctrl+Shift+Left/Right and Shift-wheel will skip the chooser entirely.

Other title channels still exist for one-off chrome actions, such as opening
overlays, focusing a pinned panel, moving tabs, and scrolling back to main.

## Command Palette

`extensions/bento-shell/src/components/CommandPalette/CommandPalette.tsx` builds
its tab and panel results from the same tab and panel mirrors used by the
sidebar, then renders them through Tale UI's `CommandPalette` recipe and
`useCommandPalette` filtering/grouping hook. Panel tab ids from
`usePanelsStore.byWorkspace` are excluded from the Tabs section and listed in a
separate Panels section. Normal tab results dispatch `tab/activate`; the tools
handler activates the tab's owning workspace for the source window before
focusing the Firefox tab. Panel results dispatch `panel/focus`; tools activates
the panel's workspace and emits `panels/sync` with `scrollToPanelTabId` so chrome
scrolls/focuses the side panel in place.

Do not make palette panel results call `tab/activate`. A panel tab is still a
Firefox tab internally, but activating it as the selected browser tab demotes the
mental model: the content appears in the main slot or can be rejected by the
panel-marker bounce logic. Panel navigation must remain a panel-strip operation.

Do not return freshly-created object arrays directly from Zustand selectors in
the palette. The palette runs in a persistent chrome overlay frame; an unstable
external-store snapshot can spin the React tree or crash the palette frame before
the overlay paints. Subscribe to stable store references such as
`usePanelsStore((s) => s.byWorkspace)` and derive object arrays with `useMemo`.

Palette command records carry Tale UI `title`, `subtitle`, `keywords`, `group`,
`shortcut`, and `action` fields. The full command palette remains title-oriented
even though `TabSnapshot.url` exists for address autocomplete; do not add URL
matching here unless the command-palette UX is intentionally widened.

## Sidebar Tab And Panel Search

`extensions/bento-shell/src/components/TabList/TabList.tsx` owns the inline
sidebar search field shown from the action row beside `New tab` and `New panel`.
The result set is derived locally from the shell mirrors: `useTabsStore` provides
all tab snapshots, `usePanelsStore((s) => s.byWorkspace)` classifies panel tab
ids by workspace, and `useWorkspacesStore` supplies workspace order, icons, and
theme ids. The search is title-only by sidebar UX choice; do not add URL
matching here unless that surface is intentionally widened.

When `searchOpen` is true and the trimmed query is non-empty, `TabListPane`
skips rendering the normal virtualized display rows and renders only the search
field plus matching results. This avoids leaving tabs, folders, pinned sections,
or creation controls visible behind the filtering surface. The clear affordance
is a visible Tale UI ghost/sm `Button` labeled "Clear"; pressing it clears the
local query, refocuses the search input, and returns the pane to the normal
virtualized row path.

Selecting a regular-tab result calls `TabList`'s normal `onActivate` prop so it
uses the same tools dispatch and chrome scroll-to-main sentinel as a visible
sidebar tab row. Selecting a panel result dispatches `panel/focus` with the
result workspace id so the panel strip scroll/focus path stays the source of
truth. The result marker color comes from the generated workspace theme metadata in
`extensions/bento-shell/src/theme/presets/index.ts`; the active document theme
must not be mutated to preview search results.

Cross-workspace tab result activation depends on a tools-side preferred-tab
handoff. `protocol-handler.ts` records the explicitly requested tab through
`preferWorkspaceActivationTab()` after `WorkspaceStore.activate()` succeeds.
`background.ts` consumes that preference inside `handleWorkspaceActivation()`
before falling back to `lastActiveTabByWorkspace` or the first workspace tab.

Load-bearing pitfall: do not remove this handoff or replace sidebar-search tab
selection with a bare `tab/activate` dispatch that bypasses `TabList.onActivate`.
Cross-workspace activation emits a workspace `activated` delta, and the
background workspace-activation handler may run its "restore the workspace's
last visible tab" fallback in the same turn as the explicit tab activation. If
the search result is a tab inside a folder in another workspace, that fallback
can otherwise reactivate an unrelated non-folder tab from the destination
workspace, leaving the requested folder tab selected in state but not visible in
the main content slot. Regression check: put a tab inside a folder in workspace
B, search for it from workspace A, click the result, and confirm workspace B
opens with that exact folder member in the main content slot.

## Floating Address Bar

`extensions/bento-shell/src/components/AddressBar/AddressBar.tsx` is a separate
chrome overlay entry hosted at `address-bar.html`, mounted dynamically by
`ensureOverlayHost` in `src/browser/base/content/bento-shell-mount.js`. The
chrome keybinding intercepts `Cmd/Ctrl+L`, `Cmd/Ctrl+E`, and `Cmd/Ctrl+T` in
capture phase, opens the overlay, and sends the mode to the addrbar frame
through a frame script that posts on `BroadcastChannel('bento-addrbar-bus')`
from the content global. `Cmd/Ctrl+E` is also forwarded by the `BentoKey`
content actor so the current-tab address dialog opens while web content owns
focus. Empty new-tab opens read `text/plain` from the global clipboard in
chrome, sanitize it with Firefox URL bar paste handling when available, resolve
it through `Services.uriFixup`, reject keyword-search results, and forward only
`http`/`https` specs as `clipboardUrl`.

The overlay uses the same shell-to-tools port as the rest of Bento. Query
actions use `addrbar/query`; tools answers with `addrbar/results` and echoes the
query so the shell can discard stale async results. The tools search module
queries Firefox new-tab top sites for empty input, queries all history with
`browser.history.search({ startTime: 0 })` after typing, searches bookmarks with
`browser.bookmarks.search(query)`, filters bookmark folders out, dedupes by
normalized URL, and ranks host-prefix matches, history recency and visit count,
and bookmark matches. Favicons are best-effort: open tabs provide
`TabSnapshot.favIconUrl`, top-site rows can include `browser.topSites` favicons,
but history and bookmark APIs do not return favicons.
The React overlay renders typed-only active-workspace tab/panel rows, async
top-site/history/bookmark rows, an empty-new-tab clipboard URL row, and
synthetic search/open row through Tale UI's `CommandPalette` recipe and
`useCommandPalette` hook. Empty new-tab mode also renders saved-panel rows from
the saved-panel mirror and opens them through `panel/openAt`. Sorting is
disabled so the groups keep Bento's fixed order: clipboard when present, saved
panels, typed open tabs, typed panels, top sites or typed history/bookmarks, then
search/open. Empty query preserves top-site results but returns no
open-tab/open-panel autocomplete rows.

Navigation stays chrome-owned. For current-tab mode, the addrbar frame writes
one `BENTO_ADDRBAR_NAVIGATE_*` title sentinel with a UTF-8-safe base64 payload.
Legacy callers may still encode a plain string. New address-palette submissions
encode JSON shaped like `{ value, searchEngineId? }`; chrome decodes either
shape, validates `searchEngineId`, and resolves through `Services.uriFixup` with
`FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP | FIXUP_FLAG_FIX_SCHEME_TYPOS` by default. If
the payload carries an engine id and the value is not URL-like, chrome
initializes Firefox `SearchService`, calls
`SearchService.getEngineById(id).getSubmission(value).uri.spec`, and loads that
one URL without mutating the default search engine. Any import, lookup, or
submission failure falls back to the existing URI-fixup route. For new-tab mode,
chrome dispatches `tab/openUrl` with ordinary resolved specs so bento-tools
creates the tab in the source window and eagerly assigns it to the active
workspace. Resolved `about:` and `chrome:` specs instead use
`gBrowser.addTrustedTab()` from chrome, because WebExtension `tabs.create`
rejects privileged internal pages such as `about:preferences`; the existing
tabs-created listener still assigns the resulting tab to that window's active
workspace.
After a successful current-tab or new-tab submission, chrome schedules
`scrollPanelToLeftmost` for the main panel and clears restored-main auto-scroll
suppression so the panel strip reveals the main content slot even if the user
submitted while viewing side panels.

Load-bearing pitfalls:

- Submit writes exactly one navigate sentinel. Do not also write
  `BENTO_CLOSE_ADDRBAR_*` in the same tick; `document.title` is last-write-wins
  and chrome polling may only see the close sentinel.
- Do not remove the explicit main-slot reveal after submit. Current-tab address
  loads do not necessarily change `gBrowser.selectedTab`, so the reconcile-time
  selected-tab auto-scroll path may not run.
- Do not route privileged new-tab address submissions through WebExtension
  `tabs.create`. Firefox rejects internal pages such as `about:preferences`
  there; keep the chrome-owned trusted-tab path for resolved `about:`/`chrome:`
  specs.
- Do not rebuild open tab/panel rows for empty address input. Empty input should
  keep recent-history behavior but must not eagerly walk every open tab/panel to
  construct autocomplete rows.
- Do not drop `TabSnapshot.url` from normal snapshots/deltas without removing
  URL autocomplete from the address palette. URL-clearing deltas are required so
  blank/internal placeholder transitions do not leave stale URL matches.
- Open tab and panel rows must be filtered by `useActiveWorkspaceIdForWindow`
  and the source `windowId`. The full command palette can list cross-workspace
  tabs because it labels workspace context and `tab/activate` switches
  workspaces first; the floating address bar is a browser-surface replacement
  and should not show inactive workspace tabs as local open tabs.
- Panel classification must use only the active workspace panel id set. A tab id
  that is a panel in another workspace must still be treated as a normal tab for
  this workspace's address autocomplete.
- New-tab submissions must create the tab inactive, eagerly assign it to
  `ctx.workspaces.getActiveId(ctx.sourceWindowId)`, then activate it. Passing
  `active: true` directly to `browser.tabs.create` lets Firefox fire
  `tabs.onActivated` before Bento has written the workspace assignment, which
  can make the tab appear in another workspace.
- Panel rows must dispatch `panel/focus`, never `tab/activate`, for the same
  reason as command-palette panel rows.
- Do not route the one-shot address picker through
  `privacy/setDefaultSearchEngine`, `SettingsStore`, or any Firefox default
  search mutation. It only affects the submitted non-URL search.
- Do not rely on WebExtension `search` or `omnibox` APIs for live default-engine
  suggestions in this custom overlay. They can execute searches or provide
  extension-owned keyword suggestions, but they do not expose Firefox's live
  default-engine suggestion stream to an arbitrary React UI.

### Title IPC pitfalls

- `document.title` is last-write-wins. Do not reintroduce separate title writes
  for chrome-bound settings that can ride inside `BENTO_PANELS`.
- `BENTO_PANELS` is the canonical chrome state payload for panel visibility,
  layout, theme, color mode, sidebar collapsed state, and related active
  workspace chrome state. Any extra sidebar title channel must be sparse: emit
  only for a real event/state transition, never on ordinary renders, snapshots,
  or empty steady state. A harmless-looking repeated sentinel such as an empty
  selection payload can overwrite `BENTO_PANELS` before chrome's polling loop
  reads it, leaving the main content visible but hiding all side panels.
- If a title channel needs a clear/reset signal, send that reset only after the
  channel previously sent a non-empty/non-default value. Do not continuously
  announce "nothing selected", "closed", "default", or similar no-op state.
- `uiColorMode` intentionally rides inside `BENTO_PANELS`; separate
  `BENTO_COLOR_MODE` writes previously raced panel sync at boot.
- Only the sidebar entry should push workspace theme changes to chrome. Other
  shell entries share `document.title` for their own sentinels and can stomp the
  theme signal.
- The shell forwards `panels/sync` to chrome only for the active workspace in
  that window. Tools may broadcast panel state for every workspace so shell
  mirrors can filter tab lists during workspace transitions.
- Activation-triggered `panels/sync` may carry a target `windowId`. If the
  shell has not resolved an active workspace yet, it may accept that payload for
  the matching window even before its local workspace mirror has applied the
  activation delta; this keeps the first chrome theme/color payload from being
  dropped when a new window auto-creates a workspace because all existing
  workspaces are occupied.

### Chrome overlay transparency

Chrome-mounted menu overlays such as the workspace switcher cover the whole
browser window so their popovers can escape the sidebar iframe. The host and the
overlay document must both stay transparent; the popover itself is the only
opaque surface.

Load-bearing details:

- `ensureOverlayHost` creates JS-owned overlay hosts with transparent XUL
  `vbox` and `<browser>` backgrounds. Static or theme-owned overlay hosts must
  also be listed as transparent in `bento-chrome-theme.css`.
- Chrome overlay HTML entries, including `workspace-switcher.html`,
  `workspace-palette.html`, `palette.html`, `edit-workspace.html`,
  `confirm.html`, `welcome.html`, and `panel-trailer.html`, must force `html`,
  `body`, and `#root` to
  `background: transparent !important`. The shell build uses
  `cssCodeSplit: false`, so unrelated entry CSS such as `panel-newtab.css` can
  arrive later in the shared `style.css` bundle and otherwise override plain
  transparent background declarations.
- Sidebar-owned menus that need to overhang the collapsed rail must route
  through the chrome-mounted menu overlay, not an iframe-local `Menu.Popover`.
  The sidebar New menu uses `BENTO_SIDEBAR_CONTEXT_MENU` with
  `placement: 'bottom start'` for this reason.
- Do not add an app-wide surface to menu overlay roots. If an overlay needs a
  content-area scrim, it should be drawn by that overlay's dialog/backdrop
  component, not by the page or chrome host background. If it is a modal scrim,
  pair it with `showOverlayToolbarScrim(owner)` / `hideOverlayToolbarScrim(owner)`
  in `bento-shell-mount.js` so the native toolbar and urlbar are dimmed too.

## Chrome panel rendering

The working panel renderer is `reconcilePanelsSplitView` in
`src/browser/base/content/bento-shell-mount.js`.

Bento does not move a tab's `linkedBrowser` into a custom host. Earlier
docShell-swap and browser-reparent approaches broke WebExtensions and browser
identity. The current renderer drives Firefox's native split-view machinery:

1. Resolve `panels/sync` tab ids to real `gBrowser` tab elements with
   `ExtensionParent`'s tab tracker.
2. Materialize pending/lazy restored tabs with `gBrowser._insertBrowser(tab)`
   when needed.
3. Build the render list as `[gBrowser.selectedTab, ...workspacePanelTabs]`.
4. Assign a Bento `tab.splitview` marker to every tab that must stay active.
5. Dispatch `TabSplitViewDeactivate` for the previous marker and
   `TabSplitViewActivate` for the new marker.
6. Call `gBrowser.showSplitViewPanels(layoutTabsToRender)`.
7. Re-force `docShellIsActive = true` on every active split browser.
8. Inject per-panel headers into side panel notificationboxes.
9. Apply layout rects, splitters, panel trailer, nav state, focus state, and
   scroll restoration.

Every panel remains a normal Firefox tab whose `linkedBrowser` remains inside
`#tabbrowser-tabpanels`. This preserves content scripts, page state, history,
media, devtools, and extension identity.

### Required split-view compatibility shims

The following mechanisms are load-bearing:

- `tab.splitview` is defined with `Object.defineProperty`, not plain assignment.
  Firefox's native getter otherwise ignores the value.
- The marker must expose `.tabs`, `.activeTab`, `.before()`, and
  `.nextElementSibling`. Firefox progress listeners and tab insertion paths read
  these fields.
- `TabSplitViewActivate` must be dispatched so `gBrowser.activeSplitView`,
  `splitViewBrowsers`, and `shouldActivateDocShell` know Bento panel browsers are
  active.
- `preserveLayers(true)` must happen before deactivating departing panel
  browsers, or returning panels can paint blank for a frame.
- `.split-view-panel-active` must be removed from departing panels. Firefox's
  `removeTabsFromSplitview` removes `.split-view-panel` but can leave the active
  class behind, producing ghost overlays.
- `gBrowser.warmupTab(tab)` must run for active split tabs. Without an
  `AsyncTabSwitcher`, Firefox's visibility fallback can deactivate panel
  docShells.
- `gBrowser.on_visibilitychange` is overridden to no-op while split-view mode is
  active. This prevents minimized/restored windows and DevTools focus changes
  from blanking panels.
- Firefox's split-view auto-select listeners are removed from panel containers.
  Otherwise clicking a side panel sets it as `gBrowser.selectedTab`, which
  promotes the side panel into the main slot and reorders the strip.

### Chrome rendering pitfalls

- Do not call `gBrowser.hideTab(tab)` for active panel tabs. Smoke testing showed
  hidden tabs render as black or blank split-view slots.
- Do not move or swap a tab's `linkedBrowser`. Extension content scripts depend
  on stable tab/browser identity.
- Do not register nested sub-panels directly in `splitViewPanels`. Firefox
  assumes split-view panels are direct children of `tabpanels`.
- Do not put inter-panel splitter elements directly in `tabpanels`. XUL deck
  hit-testing ignores non-panel siblings. Splitters live in
  `#bento-side-panel-host` and are positioned over the panel boundaries.
- The add-panel trailer must be a XUL `vbox` with
  `.split-view-panel-active`, with the React trailer inside a chrome
  `<browser>`. HTML children in `tabpanels` do not reliably paint or receive
  hit testing.
- Keep materialization retries. Session restore can briefly expose pending tabs
  with no `linkedPanel` or no loaded browser.
- Keep cleanup broad when tearing down to main-only mode. Stale split-view
  classes, inline sizing, and data attributes can make the next main tab render
  at fractional width.
- The main-only "already torn down" fast path must first scan for stale Bento
  artifacts: `bento-flat-panel-layout`, the flat layout extent, overlay
  splitters/choosers, Bento data attributes, split-view classes, `column`, panel
  headers, loading overlays, and inline rect styles (`left`, `width`,
  `max-width`, `height`, `flex`, `display`, `position`, `visibility`, etc.). If
  any remain, run the full teardown.
  Otherwise a newly-created or newly-activated empty workspace can show its main
  tab at an old panel width with blank space beside it.
- When the final regular tab closes while panels remain, the promoted panel tab
  is immediately torn down into main-only mode. Regression symptom: the sidebar
  correctly shows the promoted panel as the sole workspace tab, but the content
  area is blank until switching away from the workspace and back. Cause: the
  promoted tab's notificationbox can retain flat-panel inline state
  (`display`, `position`, `visibility`, `opacity`, `pointer-events`, etc.) and
  browser paint flags (`blank` / `pendingpaint`) from its previous side-panel
  role. Fix: strip inline panel state before restoring
  `tabpanels.selectedPanel`, then force a selected-main browser repaint and
  clear `blank`/`pendingpaint`. The workspace-switch workaround appeared to
  fix the bug only because it ran a later full reconcile.
- DOM fullscreen depends on Bento yielding the chrome it adds around Firefox's
  browser deck. Firefox's stock fullscreen stylesheet hides `#navigator-toolbox`
  and native sidebar elements, but not `#bento-shell-host`,
  `#bento-shell-splitter`, `#bento-panel-nav`, `#bento-strip-scrollbar`,
  chrome-injected panel headers/loading overlays, the add-panel trailer, or
  flat-layout overlay splitters. Keep the
  `:root[inDOMFullscreen]` rules in `injectChromeStyles()` so the selected
  deck panel overrides stale flat-layout inline rects, loses rounded corners and
  shadows, suppresses Bento focus-ring pseudo-elements and loading overlays,
  hides non-selected panel slots, removes strip padding, clears the outer strip
  host radius, and lets video fullscreen cover the whole browser window.
  Panel-origin fullscreen needs one additional bridge: Firefox's
  `FullScreen.enterDomFullscreen` normally aborts when the requester is not
  `gBrowser.selectedBrowser`, so
  `patches/core-ui/11-dom-fullscreen-splitview-browser.patch` changes that
  check to use `gBrowser.selectedBrowsers`, which already includes active
  split-view browsers and calls `window.BentoShellDomFullscreen` with the exact
  requesting browser before Firefox sets `inDOMFullscreen`. Bento records that
  slot using `data-bento-dom-fullscreen-requester` plus the root
  `bento-dom-fullscreen-panel` attribute; fullscreen CSS expands that marked
  slot and hides every other split-view slot. The `MozDOMFullscreen:Entered`
  listener remains only as a fallback.
  Regression history: the first pass hid Bento chrome but left the browser UI
  around the video; the second pass left the main-slot focus pseudo-element
  visible at the video edge; the third pass still allowed the rounded outer
  strip host to clip the fullscreen browser; the fourth pass allowed panel
  requests but still needed requester-specific CSS so a side panel, not the
  deck-selected main slot, owns fullscreen; the fifth pass hid Bento's
  per-panel loading overlay so its neutral background and spinner cannot cover
  a fullscreen panel video; the sixth pass reset Firefox's stock
  `-moz-subtree-hidden-only-visually: 1` rule for the marked requester because
  side-panel requesters are not normally `.deck-selected`. Preserve all parts of
  the fix: hide Bento chrome/controls/overlays, accept visible split-view
  browsers as fullscreen requesters, mark the requesting panel slot from the
  exact `aBrowser`, keep that marked slot visually unhidden, suppress focus-ring
  pseudo-elements, and clear every panel/browser wrapper radius while
  `inDOMFullscreen` is active.

## Flat panel layout and subdivisions

The tools-side layout is a tree, but the current chrome renderer keeps all live
panel browser containers as direct `tabpanels` children. Chrome computes a flat
geometry for the tree in `computePanelLayoutGeometry`, then applies absolute
rects with `applyPanelLayoutRects` and `syncFlatLayoutOverlays`.

This avoids reparenting live browsers into nested subdivision containers. Nested
browser moves can detach browsing contexts and break Firefox progress listener
assumptions.

Flat layout overlays include:

- vertical and horizontal splitters for group ratios;
- chooser overlays for empty subdivisions;
- an extent element to maintain horizontal scroll width;
- rect assignment for main, root panels, sub-panels, split children, and the
  add-panel trailer.

### Verified flat layout fixes

Top-level panel resizing:

- Source of truth: `PanelStore` persists side-panel widths through
  `panel/setWidth`; the main slot width persists per workspace through
  `panel/setMainWidth`.
- Chrome bridge: `bento-shell-mount.js` dispatches the width action only after
  drag end. The live drag must not wait for a `panels/sync` echo.
- Main width scope: `panel/setMainWidth` resolves the active workspace for the
  dispatching window and stores the width in `mainWidthByWorkspace`. A
  `panels/sync` payload without `mainWidthPx` is authoritative for that
  workspace and chrome must clear `mainPanelWidth` to return to default flex
  sizing. That default flex sizing still uses `defaultPanelWidthPx` from Bento
  Settings as the main slot minimum width so fresh workspaces do not squeeze tab
  content below the normal panel size as panels are spawned. Do not use a global
  or profile-wide persisted main-width fallback for new workspaces.
- Renderer path: flat layout uses absolute rects from
  `computePanelLayoutGeometry`. During pointer movement,
  `refreshFlatPanelLayoutFromLiveState` recomputes geometry with the live width
  override, reapplies panel rects, resyncs root splitters, and updates the strip
  scrollbar.
- Menu preset width path: header "Custom panel widths" actions must use the
  same live flat-layout refresh as splitter drags after writing the target
  panel's inline width. Persisting `panel/setWidth` alone does not emit an
  immediate `panels/sync`; if chrome skips the live refresh, neighbouring panel
  rects, root splitters, and the strip scroll extent remain aligned to the old
  width until a later reconcile.
- Workspace height resize path: the `tabpanels` `ResizeObserver` and the
  settled window-resize path (`attachWindowResizePerfMode` ->
  `repaintSelectedBrowserAfterWindowResize`) must call
  `refreshFlatPanelLayoutFromLiveState`, not only `syncInterPanelSplitters`.
  Flat layout writes absolute inline heights to each panel; if the browser
  window shrinks, or chrome height changes because the bookmarks toolbar is
  toggled, and only splitters are resynced, panels keep their old
  `height/minHeight/maxHeight` and extend underneath the navigator or beyond
  the visible Bento window. Keep the selected-browser `docShellIsActive`
  false/true repaint poke after the resize gesture settles; running it during
  macOS live resize made no-panel resizing visibly rougher.
- Working solution: keep the flat-layout computed gap at `var(--space-2xs)`.
  Do not let `.bento-flat-panel-layout` compute `gap: 0`, because geometry reads
  that value and panels will visually touch. The add-panel trailer also needs an
  explicit width plus a `getTrailerLayoutWidth` measurement fallback so the
  final root splitter and scroll extent can account for it.
- Working solution: live flat-layout recomputes must preserve rendered widths
  for panels that are not being actively resized. `refreshFlatPanelLayoutFromLiveState`
  and `applyLiveLayoutGroupRatio` pass `preferLivePanelWidths` into
  `computePanelLayoutGeometry` so stale `panels/sync` payload widths do not snap
  neighboring panels back to old widths or shift the strip while a splitter is
  moving. Subdivision ratio changes also preserve the current main rect width
  while recomputing the group geometry.
- Manual verification surface: checklist item 17, root panel width resize.

Panel header hiding:

- Source of truth: `PanelStore.#headerHiddenByTabId` persists side-panel and
  sub-panel header visibility keyed by tab id. `StoredEntryV5.headerHidden`
  stores only `true`; missing, false, or malformed values load as absent. No
  storage version bump is required.
- Chrome bridge: `panel/setHeaderHidden` writes the store and does not trigger a
  sync echo. `panels/sync.panels[]` carries `headerHidden` so chrome can restore
  the flag after restart or workspace switch.
- Renderer path: the flat-layout reconciler's per-resolved-panel header
  injection loop toggles `data-bento-header-hidden` from each payload. Do not
  put this in legacy `applySubdivisions`; flat layout keeps subdivision leaves
  as direct `tabpanels` children and resets `currentSubdivisions`.
- Restore path: `restorePanelsForWorkspace` reapplies `headerHidden` after
  matching persisted entries to live tab ids, alongside persisted panel widths.
- Header hide must use `max-height` collapse without `!important`.
  `forcePanelHeaderInteractiveState` stamps inline-important opacity and
  visibility on injected headers, and top-closed subdivision CSS must keep
  precedence when both states apply.
- Departing-panel cleanup must remove `data-bento-header-hidden`; otherwise a
  recycled tab panel can leak a stale hidden-header state into another layout.

Add-panel trailer visibility:

- Renderer path: the trailer participates in the same flat geometry as root
  panels and contributes to the horizontal scroll extent.
- Working solution: keep the explicit `#bento-add-panel-trailer` width and
  `getTrailerLayoutWidth` fallback. If either is removed, the final root
  splitter and scroll extent can miss the trailer and hide the Add panels button
  cluster.
- Working solution: keep the existing trailer node mounted once it has been
  appended to `tabpanels`. Flat-layout geometry and the CSS `order: 999` rule
  keep it visually trailing without moving it in the DOM. Re-appending an
  already-mounted trailer reparents its remote `bento-panel-trailer-frame`
  iframe, which can make the Add panels cluster blink when subdivision fill
  actions create new panel nodes.
- Manual verification surface: checklist item 4, create root panels.

Subdivision splitter resizing:

- Source of truth: group ratios live in the `PanelLayout` tree and are persisted
  by `PanelStore.setGroupRatio` through `panelLayout/setGroupRatio`.
- Chrome bridge: layout splitter drag commits only the final ratio through
  `panelLayout/setGroupRatio`; tools persists it and later syncs the canonical
  tree.
- Renderer path: vertical and horizontal subdivision splitters are flat overlay
  splitters in `#bento-side-panel-host`, not children of nested browser hosts.
  During drag, `applyLiveLayoutGroupRatio` mutates the current in-memory layout
  mirror, recomputes flat geometry, reapplies panel rects, updates existing
  overlay splitter positions, and resyncs root splitters.
- Working solution: do not only move the overlay handle while dragging. Update
  the flat geometry live, otherwise the visible panels do not resize until a
  later sync, and the drag appears broken. Keep `pointer-events: auto` on
  `.bento-layout-vsplitter` and `.bento-layout-hsplitter` because these overlay
  splitters sit outside `tabpanels`.
- Working solution: live subdivision ratio recomputes must also preserve current
  rendered root panel widths. Otherwise adjusting a vertical or horizontal
  subdivision splitter can reset neighboring root widths from stale payload data.
- Regression pitfall: when `computePanelLayoutGeometry` is called with
  `preferLivePanelWidths`, root panel width overrides still win, but existing
  vertical groups must prefer `currentPanelLayoutGeometry.rootRects` over
  payload `widthPx`. A horizontal split-child drag changes child panel rects;
  treating a child payload/live width as the vertical group's root width can
  collapse or reset the whole group.
- Manual verification surface: checklist items 15 and 16, vertical and
  horizontal subdivision splitter drag.

Chooser fill sizing:

- Source of truth: chooser children get their width from the flat layout rect
  computed for the vertical group or horizontal split, not from
  `defaultPanelWidthPx`.
- Tools path: `panelLayout/fillChooser` creates the requested tab or tabs and
  assigns them to the workspace, but must not call `PanelStore.setWidth` with
  the default root-panel width. A chooser child is not a new root panel.
  It also must not emit `scrollToPanelTabId`; subdivision fill should preserve
  the user's current strip scroll position.
- Chooser UI: `createSubdivisionChooser` renders the primary `Full panel` and
  `Split panels` actions side by side, mirrors saved-panel bookmark options
  from `panels/sync.savedPanelItems`, and fills the chooser with the clicked
  saved URL through `panelLayout/fillChooser` in `single` mode. The chooser's
  close button dispatches `panelLayout/removeVerticalGroup`, which promotes the
  top child back to root without creating a temporary bottom panel.
- Empty chooser removal pitfall: `removeVerticalGroup` can validly remove a
  group with zero bottom victims. `PanelStore.removeVerticalGroup` must persist
  and sync based on layout mutation, not `victims.length`, otherwise closing an
  empty subdivision only changes in-memory state and can reappear after restart.
- Renderer path: subdivision child enter animations are collected during
  reconcile, but run only after `applyPanelLayoutRects` has applied the final
  flat-layout rects. They fade in without width or transform animation so the
  first painted size is the assigned subdivision size.
- Regression pitfall: do not run the generic root-panel enter animation for
  `subdivision-bottom` or `split-child` panels before flat geometry is applied.
  Its requestAnimationFrame callback can overwrite the correct rect with a
  stale default-width measurement.
- Regression pitfall: generic new-panel auto-scroll in `reconcilePanels` must
  ignore new tabs whose layout status is `subdivision-bottom` or `split-child`.
  Only new root panels should trigger implicit panel-strip auto-scroll.
- Regression pitfall: default new-panel loading for chooser-created split
  children must be idempotent. Metadata-only `panels/sync` broadcasts can arrive
  while a new split child is still settling; `loadDefaultNewTabInBrowser` must
  not reissue the same Bento new-panel load when that URL is already in flight or
  already loaded, or the panel can flicker between the loading overlay and the
  blank/new-panel surface.
- Manual verification surface: checklist items 6 and 7, fill chooser as single
  panel and dual split.

Top-row splits and 2x2 groups:

- Source of truth: `PanelLayout` vertical groups now accept a top child of
  either a panel or a horizontal group. The bottom child remains a panel,
  chooser, or horizontal group.
- Tools path: `panelLayout/splitTopPanel` creates one new tab, assigns it to
  the workspace, and calls `PanelStore.splitTopPanel` to replace the single top
  panel with a horizontal group. Do not model this as a second vertical group;
  that creates two independent 1x2 columns instead of one shared 2x2 grid.
  It must not emit `scrollToPanelTabId`; splitting inside an existing vertical
  group should preserve strip scroll.
- Bottom survivor re-split path: when one child of a bottom horizontal split is
  closed, `removePanelFromRoot` normalizes the bottom child back to a single
  `subdivision-bottom` panel. That panel exposes `Split this panel`, dispatches
  `panelLayout/splitBottomPanel`, and `PanelStore.splitBottomPanel` replaces the
  bottom panel with a new horizontal group in the same vertical group. Do not
  route this through `panelLayout/subdivide`; that would violate the depth cap
  by creating a nested vertical subdivision. This path also preserves strip
  scroll rather than focusing or revealing the new split child.
- Renderer path: `computePanelLayoutGeometry` uses the same horizontal-group
  rect logic for vertical group top and bottom children, and emits a separate
  overlay splitter for each horizontal group id. Root width should be anchored
  to the top-left panel's stored width when present, falling back to the
  previous root rect when a just-created top split has no stored width yet.
- Top-level strip resize pitfall: once the top row is split, the first visible
  panel element is only the left child. `startPanelDrag` and `endPanelDrag`
  must read the root rect width for that element's `data-bento-root-node-id`,
  then persist that width through the anchor tab id. Reading the child element's
  own rect collapses the vertical group to half width on the next reconcile.
- Header menu: an unsplit top panel with status `chooser-owner` or
  `subdivision-top`, and a single bottom panel with status
  `subdivision-bottom`, exposes `Split this panel`. Once it is split, children
  are `split-child` entries and the split action is no longer shown.
- Manual verification surface: checklist item 7, top split plus bottom split
  creates a single 2x2 vertical group; checklist item 13, close one bottom
  split child and re-split the survivor.
- Panel navigator grouped favicons must derive from `currentPanelLayout`, not
  the legacy `currentSubdivisions` mirror. Flat layout keeps subdivision leaves
  as direct `tabpanels` children and resets `currentSubdivisions`, so the
  navigator must build each root icon from the active layout node: one row for a
  panel child, two cells for a horizontal child, and a placeholder cell for a
  chooser. Active marker mapping must also use root node ids; mapping cycle
  targets by raw panel index points split-child focus at the wrong favicon when
  one root node contains multiple visible leaves.
- Panel navigator favicons must update on panel tab metadata changes, not just
  on layout changes. Chrome listens for `TabAttrModified`, patches
  `__lastPanelsPayload` for the changed panel tab, and re-runs
  `refreshPanelNav` for an immediate local update after panel-header URL
  navigation. Bento-tools also emits `panels/sync` when a panel tab `title` or
  `favIconUrl` delta arrives so the canonical payload catches up and reused
  grouped/nav buttons receive the latest favicon. Do not include `title` or
  `favIconUrl` in the navigator structural signature; those are metadata updates
  that must patch the existing button/image in place. Otherwise navigation
  rebuilds the button, triggering the nav icon enter/leave width transition and
  producing a resize flicker. While a tab is still loading, an empty favicon is
  treated as transient and the existing favicon is retained until a new favicon
  arrives or loading settles. The main-slot favicon is subject to the same rule:
  panel-tab `TabAttrModified` events must not refresh the main icon, and
  `panels/sync` must reuse the main button untouched. The main key has no
  side-panel payload, so never route it through side-panel metadata update logic;
  doing so makes `updatePanelNavButton` reject the null metadata and rebuild the
  first nav button on every panel metadata sync.
- Sleeping panel visuals ride the same metadata path. `panels/sync` includes
  each panel tab's `discarded` state, `background.ts` re-emits panel sync when a
  panel tab's discarded flag changes, and `bento-shell-mount.js` toggles
  `.bento-panel--discarded` plus `.bento-panel-nav__icon--discarded` without
  changing navigator structure. Grouped navigator cells also receive a per-cell
  dimming class so subdivided groups can show which contained panel is asleep.
  `SleepPolicy` receives active-workspace visible panel ids from `background.ts`
  as protected tab ids, so the 60-second sweep cannot discard a panel currently
  rendered in a visible workspace and trigger an immediate wake/reload loop.
  Inactive-workspace panels can still be discarded and later wake through
  Firefox's normal tab restore path.
- Panel navigator structural changes must keep each button at a stable layout
  size. Split, subdivide, promote-survivor, and remove operations can convert a
  single-panel icon to a grouped icon or back while the panel strip is also
  recomputing geometry. Entry states in `bento-shell-mount.js` should fade
  opacity only and must not animate width, padding, or margin; stale replaced
  buttons should be removed synchronously before reordering the desired buttons,
  otherwise the old root icon can flash before the main-slot icon for one paint.
  The nav button box itself should use border-box sizing so grouped-icon padding
  differences do not change the outer slot. Dimensional nav animation makes the
  navigator row jump during those layout operations even when favicon metadata is
  patched in place.
- Panel navigator button size should stay compact enough for the native top
  toolbar:
  `--bento-panel-nav-button-size` uses `--bento-control-size-sm`, matching Tale
  UI `IconButton size="sm"`, and `#bento-panel-nav` is mounted before the first
  extension toolbar child so it stays after Reload/Stop while the first
  extension child becomes the right-aligned toolbar anchor. Bento collapses
  native toolbar springs in sidebar-addressbar mode so that the navigator starts
  at the sidebar divider instead of drifting right behind an empty URL-bar gap.
  Keep grouped favicon cells
  small enough to fit inside that fixed 24px slot; increasing grouped favicon
  dimensions without changing the slot causes the navigator to overflow or
  drift out of alignment with the sidebar footer.
- Panel navigator drag reorder must dispatch only layout root node ids to
  `panelLayout/reorderRoot`. Do not derive this payload from
  `getOrderedPanels()`: that list includes the main content slot, so it can add
  a bogus `panel:undefined` entry and make `PanelStore.reorderRootNodes` reject
  the reorder. Use the navigator root-node payload (`getPanelNavRootNodeIds`) so
  the ids match `currentPanelLayout.root` exactly.
- The first panel navigator button represents the fixed main content slot, not a
  draggable panel. Keep `bento-panel-nav__icon--main` applied when the button is
  created and when it is reused during navigator diffing. It should have the
  `Main content slot` label, should use a divider between itself and the
  side-panel buttons instead of an outline/border treatment, and must not
  receive `data-bento-nav-draggable`; side-panel buttons are the only navigator
  entries that participate in drag reorder.

### Flat layout pitfalls

- Keep live panel browser containers as direct `tabpanels` children unless the
  browser reparenting risks have been revalidated.
- Splitter drags should update local flat geometry live, then dispatch
  `panelLayout/setGroupRatio` on commit. Tools persists the ratio and the next
  `panels/sync` re-applies it.
- Sanitise layout payloads against the current panel list. A layout node for a
  missing tab must not be rendered.
- Use stable root node ids for reorder. Grouped roots are not equivalent to the
  top panel's tab id.
- Header drag reorder should compute target slots from the pointer position
  against stable snapped drop targets, not from the dragged panel's centre. Using
  the dragged panel's centre makes target zones scale with the width of the panel
  being dragged, which makes the drop affordance drift away from the cursor for
  wide panels. Header drag now moves a single visible panel leaf, not always its
  containing root. Chrome clones `currentPanelLayout`, removes the dragged leaf,
  and computes root drop targets from that post-removal layout so subpanels and
  split children can be dragged out into the top-level strip without moving the
  whole vertical group. Horizontal row insertion targets should use live row
  geometry so the hit zone matches the row the user is hovering, but must be
  validated against the post-removal layout so rows in a group that would be
  collapsed away are not offered. Rows already represented by a horizontal group
  are full unless the dragged source is one of that row's two children; in that
  case the survivor's live rect is a valid target for reordering the pair.
  Empty subdivision chooser targets are collected from live chooser geometry and
  filtered against the post-removal layout, so a panel can be dragged into an
  unconfigured subdivision area while a chooser that disappears after removing
  the dragged source is not offered. Dropping on a chooser dispatches
  `panelLayout/movePanel` with a chooser target and tools replaces that chooser
  with the existing panel as a full bottom panel.
  Dropping on an eligible row dispatches `panelLayout/movePanel` with a
  horizontal target and tools creates a two-panel horizontal group. Cache those
  targets for the active drag session. Repeated reorder FLIP animations can
  leave transient transforms on panel elements; starting a new header drag
  should therefore settle any in-flight transform-only reorder animation before
  painting the new drag transform.
- When promoting a child out of a closing subdivision, preserve the child's
  browser content and width. Otherwise the promoted panel can flash blank or
  resize unexpectedly.
- Panel close animation is opacity-only. `.bento-panel--removing` must not
  mutate width, min-width, max-width, flex, transform, or margins; otherwise the
  outgoing panel fades while the surrounding layout resizes. Let the delayed
  `tab/close` dispatch and the following reconcile remove the slot after the
  fade.
- Plain top-level panel close uses a separate transform-only close-gap FLIP.
  `stageTopLevelPanelCloseGapFlip` snapshots the surviving root slots and the
  add-panel trailer immediately before the delayed `tab/close` dispatch, and
  `runPendingTopLevelPanelCloseGapFlip` consumes that snapshot after the next
  reconcile. Keep this separate from the reorder FLIP and do not run it for
  subdivision promotion paths; those use their own close/promotion animation
  rules.

## Panel traversal and focus

Panel traversal is split between chrome focus tracking and a JSWindowActor pair:

- `src/browser/actors/BentoKeyChild.sys.mjs` listens in content documents.
- `src/browser/actors/BentoKeyParent.sys.mjs` dispatches a chrome
  `BentoKey:Cycle` or `BentoKey:PanelHistory` event.
- `bento-shell-mount.js` registers the actor with `ChromeUtils.registerWindowActor`
  and handles the custom events by calling the private `navigatePanels` closure
  or the focused panel browser's `goBack()` / `goForward()` methods.

The actor forwards `Cmd/Ctrl+Shift+ArrowLeft` and
`Cmd/Ctrl+Shift+ArrowRight` for panel cycling and `Cmd/Ctrl+ArrowLeft` /
`Cmd/Ctrl+ArrowRight` for panel-local history navigation. It skips editable
targets and already-handled events. Plain Left/Right arrows stay in content for
video scrubbing and page-local keyboard behavior. Other page keys pass
through so keyboard extensions like Vimium still receive normal content key
events.

Panel header Back and Forward buttons left-click the target panel browser's
`goBack()` / `goForward()` methods. Their right-click menu is built in
`bento-shell-mount.js` from that same browser's
`browsingContext.sessionHistory`, falling back to
`SessionStore.getSessionHistory(tab, callback)` when parent-process session
history is not populated. Menu commands call `browser.gotoIndex(index)` for the
panel browser. Do not call Firefox's stock `FillHistoryMenu` or
`BrowserCommands.gotoHistoryIndex` for this surface: both are hard-wired to
`gBrowser.selectedBrowser` / `gBrowser.selectedTab` and would show or navigate
the main tab instead of the panel.

`setActiveByIndex` focuses the panel's `<browser>` for panel targets, not the
chrome notificationbox. The add-panel trailer is the exception: cycle focus
stays on the outer XUL `vbox` so Enter/Space creates a blank panel.

`bento-shell-mount.js` uses `.bento-panel--focused` and
`.bento-panel--cycle-focused` as the source of truth for visible panel focus.
Those classes paint the existing panel ring while keeping the panel header
surface neutral-5 with the standard neutral icon treatment.
DevTools/content partner panels receive the same classes through
`getDevtoolsFocusPartnerElement`, so focusing either side of a pair highlights
both rings.
Cycle navigation applies both classes immediately: `.bento-panel--cycle-focused`
is the short-lived traversal flash, while `.bento-panel--focused` persists on the
actual content slot until focus moves elsewhere. The chrome focus tracker also
re-applies `.bento-panel--focused` when the focus event belongs to the already
active cycle index, because privileged `about:*` pages can move focus into the
main browser while `currentActiveIdx` is already `0`.

Clicking into panel content runs through `updatePanelActivationFromChromeTarget`.
Chrome `focusin` remains the normal signal, but each reconciled split-view
`.browserContainer` and `<browser>` also has a Bento-owned capture-phase `click`
fallback attached after Firefox's native split-view click listener is removed.
This fixes privileged internal pages such as `about:preferences` and
`about:addons`, where the click can focus content without producing the chrome
`focusin` path Bento previously depended on. The fallback updates
`currentActiveIdx`, the favicon navigator marker, the persistent focus ring, and
the minimal strip reveal without calling `setActiveByIndex`, so it does not
promote the panel to `gBrowser.selectedTab` or steal focus from the clicked
control.

Cmd/Ctrl+Shift+arrow and Shift-wheel traversal must use minimal reveal
scrolling. If the next cycle target is already fully visible, the strip should
not scroll. When the target reaches an edge, call `scrollPanelIntoViewFromRight`
so the strip only nudges enough to reveal the target instead of snapping the
target to the leftmost slot. Navigator favicon clicks are the explicit
left-align affordance and still use `scrollPanelToLeftmost`.

The `Wrap panel shortcut cycling at the ends` setting applies to shortcut
traversal only. Shift-wheel panel cycling must always clamp at the first and
last cycle targets; do not let scroll gestures loop back to the start or end.
When the Add-panel trailer receives focus, the `focusin` auto-scroll listener
must call `scrollPanelIntoViewFromRight` for `#bento-add-panel-trailer`, then
return before panel-index bookkeeping. The capture-phase focus tracker must
still ignore trailer focus. The trailer sits under an ancestor with
`data-bento-main-panel`, so an unguarded `closest()` lookup can misidentify
trailer focus as main-panel focus and reset `currentActiveIdx` to 0. That makes
the next scroll gesture appear to loop back to the main content slot even when
wheel traversal is clamped.

The Add-panel trailer's visible cycle indicator belongs on the outer
`#bento-add-panel-trailer` XUL host, not only inside the iframe. The host is the
actual arrow-cycle focus target; the iframe owns pointer/Tab focus for the
individual buttons.

The outer Add-panel trailer `keydown` handler is only for cycle-Enter or
cycle-Space while the outer XUL host itself is focused. When focus has moved
inside the trailer iframe, the iframe buttons own Enter/Space. Do not let saved
panel button keyboard activation bubble back to the outer host, or a saved-panel
Enter press will create a blank `about:blank?bento_add_as_panel=1...` marker
panel instead of opening the saved URL.

The chrome `Cmd/Ctrl+W` intercept closes the focused side panel before falling
back to main-slot close. Resolve the panel first from `document.activeElement`,
then from `Services.focus.focusedContentBrowsingContext.top.embedderElement`,
then from `currentFocusedPanelTabId` plus the visible `.bento-panel--focused`
state. Privileged `about:*` pages, especially `about:preferences` and
`about:settings`, can leave chrome `activeElement` outside the panel even while
the panel owns content focus; without the focused-browser/focused-panel fallback
the shortcut falls through to `tab/closeMain` and removes the main content tab.

Boot-time strip scroll restore uses `stripScrollLeft` from `panels/sync` and
applies it after the flat layout commits. When restoring to a nonzero scroll
position on first launch, keep `__suppressNextMainAutoScrollForWorkspace` armed
until the user explicitly navigates to the main slot. Both the reconcile-time
main auto-scroll and the `focusin` auto-scroll path must respect that guard;
otherwise the first click in chrome, the address bar, or browser content can
reinterpret Firefox's settled main-browser focus as intent to reveal the main
slot and yank the strip back to the left.

Pinned-panel rail activation dispatches `pinnedPanel/open`. Tools first checks
whether the pinned panel still exists; if so, it activates the owning workspace
and emits `scrollToPanelTabId` so chrome scrolls and focuses that exact panel.
If the panel/tab was closed, the pin remains URL-backed, tools recreates the
panel in the owning workspace, rebinds the pin to the replacement tab id, and
then emits `scrollToPanelTabId`. Recreated pinned panels use the pin's
remembered `widthPx` when present, falling back to the normal default new-panel
width only for older pins without width metadata.

Panel creation flows (`panel/add`, `panel/openAt`, and the chrome add-panel
marker path) emit `scrollToPanelReveal: 'right-edge'` with `scrollToPanelTabId`.
Chrome still focuses the new panel, but reveals it with the same minimal-scroll
path as panel cycling: if the new panel fits in the visible strip, its right
edge lands against the strip's right edge instead of snapping the panel's left
edge next to the sidebar. Wider-than-visible panels fall back to left-edge
alignment so the header and start of the content remain usable. The scheduled
reveal must retry until the target panel is fully visible; a one-shot
right-edge scroll can be clamped against stale `scrollWidth` while a saved-panel
or blank add-panel insertion is still settling.

### Traversal pitfalls

- Do not focus chrome panel containers as the normal traversal target. Content
  key extensions need DOM focus inside the page.
- Do not use `scrollPanelToLeftmost` for shortcut or Shift-wheel traversal.
  That makes focus appear locked to the left edge and hides visible context.
- Do not let Shift-wheel traversal inherit shortcut wraparound. Pass
  `allowWrap: false` when scroll gestures call `navigatePanels`.
- Do not let trailer focus update `currentActiveIdx` through ancestor
  `data-bento-main-panel` lookup.
- Do not let the persistent focus ring depend on a later chrome focus event
  after wheel/shortcut cycle. `setActiveByIndex` and `focusPanelCycleTarget`
  must update `.bento-panel--focused` directly, otherwise cycling back to main
  can leave the first side panel painted as focused while main content owns
  focus.
- Do not skip the persistent focus-ring refresh just because a chrome focus
  event resolves to the current `currentActiveIdx`. That same-index case is how
  tabbing into an already-active main `about:*` browser restores the main-slot
  focus indicator.
- Do not rely only on chrome `focusin` to detect click-into-panel activation.
  Privileged `about:*` pages can skip that path, so reconciled panel
  `.browserContainer` / `<browser>` nodes keep a Bento click fallback that
  updates the focused-panel ring, navigator marker, and strip reveal without
  forcing focus away from the clicked content control.
- Do not route `Cmd/Ctrl+W` straight to main-slot close when no active chrome
  ancestor resolves to `[data-bento-panel-tab-id]`. Check Firefox's focused
  content embedder and the persisted focused panel indicator first so focused
  `about:*` panel content closes its panel.
- Do not forward plain arrow keys, or panel shortcuts from editable targets, in
  the actor.
- Do not activate a pinned panel by setting `gBrowser.selectedTab` to the panel
  tab. That relocates the panel into the main slot.
- The actor files must live under `src/browser/actors/` and be registered into
  Firefox with `patches/chrome-layout/04-bento-key-actors.patch`. The build sync
  script also copies them into built app actor targets.

## Panel widgets, saved panels, and pinned panels

Pinned panels are global shortcuts rendered as a favicon-only secondary rail to
the left of the normal sidebar column. They are backed by
`extensions/bento-tools/src/pinnedPanels/PinnedPanelsStore.ts`. Runtime identity
is `(workspaceId, tabId)` while the backing tab exists; after closure, entries
remain URL-backed and may temporarily use synthetic negative tab ids until the
user opens them again. Persistence stores URLs and optional panel keys because
tab ids do not survive restart. Boot restore remaps persisted entries to live
tab ids when possible and otherwise keeps them as URL-backed rail entries.
Because inactive workspaces restore panels lazily, `PinnedPanelsStore.init`
materializes every persisted pin as a synthetic URL-backed entry immediately;
the global pinned rail must not wait for each workspace's first activation.
When a workspace later runs `recoverTabIdsAfterPanelRestore`, the matching
synthetic entry is replaced with the restored live tab id.
`pinnedPanel/open` is single-flight per current `(workspaceId, tabId)` identity;
repeated clicks before an async URL-backed open finishes must not create
duplicate panel tabs or duplicate rail entries. For synthetic URL-backed pins
in lazily-restored workspaces, the handler activates the workspace, waits
briefly for panel restore to rebind the pin, then focuses the restored panel
instead of creating a second panel for the same URL.
Pinned entries also persist last-known title, favicon, and panel-width metadata;
tab metadata updates refresh pinned entries before closure so the rail favicon
remains stable when the panel is closed and later reopened. `panel/setWidth`
updates the pinned entry for any matching live pin so a resized pinned panel
reopens at the latest user-chosen width.
Each side-panel header exposes a pin icon that dispatches `pinnedPanel/add` or
`pinnedPanel/remove` and mirrors the active workspace's
`pinnedTabIdsInWorkspace` set with a filled icon state.
`background.ts` also listens to `PinnedPanelsStore` deltas and calls
`browser.tabs.update(tabId, { pinned: true })` for added live pinned panels and
`{ pinned: false }` when a live pinned-panel binding is explicitly removed.
This keeps backing Firefox tabs protected by the tab sleep policy. Synthetic
URL-backed pinned-panel entries use negative tab ids and are ignored until they
rebind to a live panel tab.
Chrome dispatches `panel/focusedChanged` when the focused side-panel tab id
changes. The shell mirrors that event into `usePanelFocusStore`, and the pinned
rail applies the `color-60` tonal treatment to the matching pinned-panel button.

Saved panels are bookmarks in a managed "Saved panels" folder under Firefox's
"Other Bookmarks" root. The store is
`extensions/bento-tools/src/saved-panels/SavedPanelsStore.ts`. It creates or
adopts the folder, dedupes by URL, mirrors bookmark changes, and broadcasts
snapshots to the panel trailer.
The side-panel header bookmark icon is separate from Saved panels: it toggles
normal Firefox bookmark records for the current panel URL, fills when that URL
has a non-Saved-panels bookmark, and leaves the managed "Saved panels" folder
untouched when removing normal bookmarks.

The visible panel trailer is rendered by `extensions/bento-shell/src/panel-trailer/main.tsx`
and `components/PanelTrailer`. It runs inside the chrome-mounted
`bento-panel-trailer-frame`.

### Widget pitfalls

- Do not call Places APIs from shell or chrome UI for saved panels. The
  `SavedPanelsStore` owns bookmarks interaction.
- Do not persist pinned panels by tab id only. Use URL and panel key remapping.
- Pinned-panel rail clicks dispatch `pinnedPanel/open`, which focuses the
  specific pinned panel if it still exists and recreates/rebinds it from the
  stored URL only when it does not. Do not activate the pinned tab directly;
  direct tab activation breaks the main/panel distinction.
- Relaunch + double-click regression: after `pnpm run dev` relaunch, inactive
  workspace pins are initially synthetic URL-backed entries while panel restore
  is still lazy. `pinnedPanel/open` must be single-flight by stable pin identity
  (`workspaceId`, `order`, URL/tab id fallback), activate the workspace, wait
  for lazy restore to rebind the pin, and focus the restored panel when present.
  Creating from URL immediately after activation duplicates both the panel strip
  entry and the pinned rail entry.
- `pinnedPanel/close` marks the backing tab as closing before removing the panel
  binding, then closes that tab. It must not use the normal `panel/remove`
  demotion path, because that exposes the closed pinned panel as a sidebar tab.
- Ordinary panel and tab closure must not remove pins; pinned rail entries are
  removed only by `pinnedPanel/remove` from the rail context menu.
- Keep backing Firefox tab pinning coupled to `PinnedPanelsStore` deltas, not
  only the direct add/remove handlers, so restore, import, and URL-backed
  reopen paths receive the same sleep protection.
- The saved-panel favicon row cannot rely on `page-icon:` URLs from the
  trailer iframe. `SavedPanelsStore` filters privileged favicon URLs and uses
  placeholders when needed.

## Theming and color mode

Workspace theme metadata is stored as `Workspace.themeId`.

Shell theme flow:

- `extensions/bento-shell/src/theme/useWorkspaceTheme.ts` mirrors the active
  workspace theme to `<html data-bento-theme="...">`.
- `useToolsPort.ts` includes the active workspace theme id in the active
  `BENTO_PANELS` payload.
- `bento-shell-mount.js` mirrors that payload's theme id to the chrome window
  root.

UI color mode flow:

- `BentoSettings.uiColorMode` is the source for shell and chrome UI mode. It
  accepts `light`, `dark`, and `system`; `system` is the user-facing Auto mode.
- `useFirefoxTheme.ts` resolves `system` against
  `(prefers-color-scheme: dark)`, updates shell `<html data-color-mode>` with
  the resolved `light`/`dark` value, and mirrors the stored preference to
  localStorage for pre-React boot.
- `public/boot.js` reads that localStorage value before CSS loads. Explicit
  `light`/`dark` values paint directly; `system` paints from the current OS
  preference; missing values paint the fresh-profile Light default.
- Chrome receives `uiColorMode` through `BENTO_PANELS`, resolves `system`
  against the same media query, and applies explicit `data-color-mode` to the
  chrome root. If the settings mirror has not hydrated when the first targeted
  panel sync arrives, the shell forwards the pre-React boot value from
  `data-bento-color-mode-pref` / `data-color-mode`.
- `bento-shell-mount.js` seeds chrome `<window data-color-mode="light">` before
  injecting chrome token/theme stylesheets. This matches Bento's fresh-profile
  default and prevents OS-dark chrome from flashing behind the light sidebar
  before the first `BENTO_PANELS` payload arrives.
- During that same startup interval, chrome sets `bento-startup-loading="true"`
  on the root, hides the native navigator toolbox, and shows a chrome-owned
  startup skeleton over the browser area. The skeleton is dismissed after the
  first `BENTO_PANELS` payload applies theme/color/sidebar state, with a timeout
  fallback so a failed sync cannot leave the window covered.
- Auto UI mode must resolve from chrome/sidebar state, not from regular
  extension tabs. Bento's content color-scheme override can make
  `matchMedia('(prefers-color-scheme: dark)')` return the content preference
  inside pages like `settings.html`, while chrome resolves Auto against the
  actual browser/OS theme. `useFirefoxTheme` writes `resolved-color-mode` from
  authoritative shell contexts; Settings calls it with
  `preferStoredSystemResolution` so it follows that cached resolved value.

Content color mode is separate: `BentoSettings.contentColorMode` is applied by
`bento-tools` through Firefox's content color-scheme browser setting.

Theme authoring and import workflow is documented in [themes.md](themes.md).

### Theme pitfalls

- Do not add standalone theme title writes on shell mount. Theme and
  `uiColorMode` must ride together inside `BENTO_PANELS`; otherwise a
  theme-only title can overwrite the first panel sync before chrome polls it.
- Keep Auto mode resolved to explicit `light`/`dark` on DOM roots. Tale UI's
  runtime styling expects `data-color-mode` to carry the rendered mode; the
  stored user preference is mirrored separately as `data-bento-color-mode-pref`.
- Workspace themes are static scoped CSS. Do not generate runtime style elements
  for theme switching.
- Chrome token updates require regenerating/importing the chrome stylesheet; the
  shell CSS bundle alone is not enough.
- Firefox notification bars (`notification-message`, including the popup-blocked
  banner) are `moz-message-bar`/infobar custom elements with shadow-root CSS.
  `bento-chrome-theme.css` can theme their host and inherited custom properties,
  but it cannot directly remove the default left gradient stripe inside
  `infobar.css`. Keep `patches/core-ui/10-bento-infobar-accent-token.patch` in
  place: it makes the stripe read `--info-bar-accent-background`, and Bento sets
  that token to `none` while using an inverted neutral scheme
  (`--neutral-90` background, `--neutral-5` text/icon, light neutral action
  buttons) so notification bars pop against both light and dark chrome.

## Manual regression areas

When changing core functionality, manually verify at least the affected subset:

- workspace switch with different panel sets;
- workspace switch with saved strip scroll positions;
- first panel add in a workspace;
- panel add from main context menu and from panel context menu;
- panel trailer blank add and saved-panel add;
- panel resize, including `about:preferences` or `about:settings` in a panel,
  main resize, and workspace switch after resize;
- panel reorder with grouped and ungrouped roots;
- subdivision create, fill, resize, break out, and remove;
- closing main tabs while panels exist;
- closing a sidebar multi-selection with Cmd/Ctrl+W and with the multi-select
  context-menu item;
- closing side panels with descendant sub-panels;
- Cmd+Shift+T restore of a closed panel;
- Cmd/Ctrl+Shift+arrow panel traversal while content has focus, and plain
  Left/Right arrow behavior inside page content;
- Vimium or another content-key extension inside a panel;
- AMO install permission prompt from a panel;
- Dark Reader or another content-script extension inside a panel;
- video fullscreen from the main content slot and from a side panel while side
  panels are present, with the side-panel video visible and no Bento loading
  overlay, spinner, or neutral chrome background replacing it;
- theme switch and sidebar footer UI light/dark/Auto switch;
- profile restart with panels, pinned panels, saved panels, widths, and scroll
  positions restored.

If a regression touches these areas, record the cause and fix in this document
or in the relevant feature section before closing the task.
