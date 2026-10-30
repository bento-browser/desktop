# Address Entry Implementation

Part of the [technical notes index](../core-functionality-technical.md).

`src/browser/base/content/bento-shell-mount.js` owns address-entry routing.
`Cmd/Ctrl+T`, the sidebar `New tab` action, and native top-urlbar fallback
focus open the centered floating overlay hosted at `address-bar.html`.
`Cmd/Ctrl+L` and `Cmd/Ctrl+E` (the chrome keybinding and the BentoKey
`BentoKey:AddrbarOpen` event from web content) and direct activation of the
expanded-sidebar URL row open the same overlay with a sidebar anchor, so its
header is the row grown and it extends over the panel strip and main content.
Those two shortcuts fall back to the centered overlay whenever the expanded
row is not on screen (see "Open request" below).

The workspace switcher trigger is mounted above the persistent sidebar address
row, and both are mounted above `TabList`.
In expanded mode, `.bento-tab-list-pane__scroller` owns a `--space-3xs` top
padding matching the address row's top padding below the workspace switcher.
Keeping the lower gap inside the native scroller makes it visible at scroll
position zero and lets it scroll away so tab content becomes flush with the
address row edge. Collapsed mode resets that top padding to zero because the
address row is hidden.
`extensions/bento-shell/src/state/sidebarAddress.ts` stores the last
chrome-owned snapshot, edit mode, draft value, pending bookmark-toggle key, and
`paletteOverRow` (see "Row border fade").
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
`address-bar.html` over the existing `BentoAddrbarOpen` frame script.
`computeAddrbarAnchoredPlacement` puts the popup's top-left corner exactly on
the row's top-left corner; it moves only when the row itself is outside the
window, and the 12px margin applies to the right and bottom edges only. The
placement also carries the row's size (`anchorWidth`, `anchorHeight`) so the
document can start its grow from the row's box. The overlay owns the
focused input, result list, and search-engine picker, so the popup can extend
over the panel strip or main content without asking the sidebar iframe to
overpaint its chrome bounds. Sidebar-anchored placements use a smaller
512px-by-378px cap so the row-local picker reads as attached to the sidebar,
while new-tab and top-urlbar fallback opens omit the anchor and
therefore keep the original centered overlay size and position.

### Anchored popup is the row grown

In an anchored open (`bento-address-bar__toolbar--anchored`,
`AddressBar.css`) the popup's header is the sidebar row, field for field: the
popup's top border is the row's top border and the header's bottom border is the
row's bottom border, so the header is `--bento-sidebar-address-row-height` minus
one hairline; the inline padding and gap are the row's, a search icon takes the
lock button's `--bento-sidebar-address-button-size` slot, and the input has no
field outline, takes the row input's font, and so starts its text at the x where
the row's URL text starts. Both inputs have `padding-inline-start: 0` (the end
padding stays Mux's field padding), so the text starts one gap after the icon
slot and the space right of the icon (icon to text) equals the space left of it
(inner border edge to icon): each is the icon's half-slack in its slot plus
`--space-4xs`, at every fluid token value. The popup takes the row's border
colour; its radius is not the row's `--bento-sidebar-address-field-radius` but Mux's
`--muxui-semantic-shape-container-radius` (radius-l, 12px), the command palette's,
because the anchored rule sets no `border-radius` and the elevation sibling uses the same
token. The row's radius survives only as the grow's start-frame clip radius (see "Grow
motion"). The Clear button and the engine
picker are `--bento-sidebar-address-button-size` high so they fit the row, and
the picker shows no outline until hovered, focused or open. The Ladle stories
"Anchored over the sidebar row" and "Anchored, start of the grow" render the real
`SidebarAddressBar` under the popup, which is how the alignment is checked
(row rect against popup rect, lock slot against search icon, row text start
against input text start, and the space left and right of the icon, to 0.5px). The
popup, its elevation sibling, the centered address popup and the command palette popup
all compute the same `border-radius`.

The popup and the elevation sibling share one CSS size, defined once on the backdrop
(`--bento-address-bar-fit-width` and `-height` in `AddressBar.css`): the placement's size
(`--bento-address-bar-popup-width` and `-height`) capped by the room left in the window,
`min(<placement>, 100vw - <left> - var(--bento-address-bar-anchor-margin))` and the same for
height with `100vh` and `top`. The anchored popup rule also sets `max-height: none`, so Mux's
`min(84vh, 45rem)` cap on `.muxui-command-palette__popup` does not apply. The placement does
not always fit the window. Chrome places the popup once, at open (`computeAddrbarAnchoredPlacement`
clamps it to the `#browser` edges but gives it a 180px minimum height), and does not place a
palette that is already open again, so a window shrunk under an open palette, or a row so low
that 180px does not fit below it, leaves a placement larger than the window. The cap never
binds while the placement fits: `--bento-address-bar-anchor-margin` (`bento-tokens.css`, 12px)
is the margin chrome leaves at the right and bottom (`ADDRBAR_ANCHOR_MARGIN_PX`), and
`scripts/overlay-surfaces.test.mjs` keeps the two equal. With the cap, the popup, its shadow
and the list's scroll area shrink and grow together as the window changes, and the last
result stays reachable.

### Grow motion

`useAddressBarGrow` replays the grow on every open. The address bar document is
prewarmed and the Mux popup stays mounted (`open={true}`, `openVersion` keys the
content), so `data-entering` and mount animations run once; the hook keys on
`openVersion` instead. In a layout effect it measures the popup's rendered border box
(`getBoundingClientRect`, not the placement's size, which the cap above can undercut) and sets the
popup's inline `clip-path` to the row's box, `inset(0 <popupWidth - rowWidth>px
<popupHeight - rowHeight>px 0 round <rowRadius>px)`, and `data-bento-grow='start'`; two
animation frames later it measures again (a document shown after its window was resized still
has the old viewport for its first frames, about 100 ms, so the first measure can be the stale
box; the host is still faded out then), rewrites the start values if the box changed and commits them with a layout read, and
sets `data-bento-grow='running'` and the clip to `inset(0 0 0 0 round <popupRadius>px)`,
which `AddressBar.css` transitions on the `reveal` spring pair
(`--muxui-semantic-motion-reveal-transition-spring-duration` with `-easing`, the pair
the sidebar push and the Search peek use). `afterMotion` then removes the clip,
the attribute and `will-change`. The clip values are literal pixels computed in
script, never `var()`, because MotionScore grades a variable inside a compositor
value as C-tier. The popup does not fade in the document: chrome's host fade
(`ADDRBAR_HOST_TRANSITION`, `modal`) is the open and the close, there is no
reverse grow, and the anchored popup forces `opacity: 1 !important` so Mux's
one-time entry fade cannot hide the start frame of the first open. Reduced
motion (`prefers-reduced-motion`, `[data-muxui-motion='reduced']`) skips the hook
and opens at full size. The results list fades in on the `state` pair after the
spring's visual duration. The row's background (`--bento-brand-bg`, the same
`--neutral-5` as the popup surface) needs no fade, so there is none; its border does
(see "Row border fade").

The elevation is not the popup's own `box-shadow`: the clip would cut it, and a
clip that ends outside the box lets the box reach its edges within the first
quarter of the spring. `AddressBar.tsx` draws it on a sibling,
`bento-address-bar__shadow`, at the popup's final box (the same fit size as the popup,
`transform-origin: 0 0`), and it grows with the clip. The hook finds it in the
popup's backdrop and, with the popup's own attributes, sets `data-bento-grow='start'`,
an inline `transform: scale(<rowWidth / popupWidth>, <rowHeight / popupHeight>)`
(`growShadowTransforms`, from the same measured box as the clip, clamped to 1 like the clip's
insets, literal numbers) and
`will-change: transform, opacity`; `AddressBar.css` holds it at `opacity: 0`. In the
frame the clip goes to full size the hook sets `'running'` and `scale(1, 1)`, and the
sibling transitions `transform` and `opacity` on the same `reveal` spring pair as the
clip, with no delay. Clip insets and a scale interpolate linearly on the same easing and
duration, so the shadow's box is the popup's visible box every frame. `afterMotion`
clears the sibling's attribute, transform and `will-change` with the popup's. The results
list is the one part that waits: it fades in on the `state` pair after the spring's
visual duration.

### Row border fade

The palette is a separate overlay document over the shell, and the row it grows from
lives in the shell document under it. The palette's top-left corner is rounder (12px,
Mux's container radius) than the row's (6px, `--bento-sidebar-address-field-radius`), so
the row's 1px border (`--neutral-18`) would show in the crescent between the two
curves as a faint second arc outside the palette. While the anchored palette is open
over the row, the row's border fades out, and it fades back in as the palette closes.
Both keep their own radius.

Chrome tells the row over the sidebar address channel (`dispatchSidebarAddressMessage`,
`bento-sidebar-address-bus`, scoped by window id and bridge token like the other kinds):
`{ kind: 'palette-over-row', windowId, bridgeToken, messageId, open }`. `setAddrbarOverSidebarRow`
records the wanted state at once (`addrbarOverSidebarRow`) and `syncAddrbarOverSidebarRow`
delivers it, only when it differs from what the row was last told
(`addrbarOverSidebarRowSent`, recorded only for a delivered message). A delivery that
fails (the shell frame's message manager is not there yet) is retried by `sync` itself,
100 ms apart up to `SIDEBAR_ADDRESS_RETRY_LIMIT` times, and every attempt re-reads the
wanted state, so only the latest value is ever delivered; `dispatchSidebarAddressMessage`
is called with `attempt` at that limit, which sends once and queues no retry of its own
(its retry resends the message it was given, which is how a stale `open: true` could land
after the hide). The other message kinds keep the helper's retry. The sends are:

- `open: true` from `revealPendingAddrbar`, in the same step that sets the host's opacity
  to 1 (the start of the host fade-in), when the open has a placement (an anchored open).
  A pending open that is hidden before it is revealed never sends it.
- `open: false` from `hideAddrbar`, in the same step that sets the host's opacity to 0
  (the start of the close fade). Esc, an outside click, the palette's own close and a
  submitted URL all reach `hideAddrbar`. And from `showAddrbar` when the new open has no
  placement (Cmd+T, a collapsed or hidden sidebar, the native-urlbar fallback), which
  replaces an anchored palette at once.

`applySidebarAddressBusMessage` (called by the bridge's listener after
`shouldAcceptSidebarAddressMessage`) sets `useSidebarAddressStore`'s `paletteOverRow`;
`reset()` clears it. `SidebarAddressBar` puts `data-palette-over="true"` on
`.bento-sidebar-address-bar__row` while it is set, and `SidebarAddressBar.css` makes the
row's `border-color` `transparent` under that attribute. The row transitions
`border-color` on `var(--muxui-semantic-motion-modal-transition)`, the pair of chrome's
host fade (`ADDRBAR_HOST_TRANSITION`), so the palette's border fading in and the row's
border fading out run on the same duration and easing and cross-fade. A sidebar that
collapses or hides while the palette is open does not close the palette, so the flag stays
set until `hideAddrbar` clears it; the hidden row has no border to see meanwhile.

A new sidebar document (Alt+Shift+R in a dev build, or a re-created shell frame) starts with
`paletteOverRow` false while `addrbarOverSidebarRowSent` still holds the old document's last
delivery, so the next sync would skip a delivery the new document never got. The bridge hook
(`useSidebarAddressBridge`) therefore writes `BENTO_SIDEBAR_ADDRESS_READY:<ts>` after its
channel listener exists, and again when the window id resolves (a message for another window id
is dropped, so the first announcement can precede the first accepted message). Chrome's
`handleSidebarAddressReadyTitle` (routed from the shell frame's title handler) sets
`addrbarOverSidebarRowSent = false` and syncs: a palette open over the row sends the new
document `open: true`, a closed one sends nothing. The overlay `BENTO_OVERLAY_READY` titles
cover only the overlay frames in `createOverlayManager`'s table, and the page's static
`<title>` fires when the document loads, before React has subscribed, so the shell announces
this itself.

### Open request (Cmd+L and Cmd+E)

Chrome cannot read the row's rect synchronously, because the shell is a
separate frame, so `requestAddrbarOpen` asks the row. For `Cmd/Ctrl+L` and
`Cmd/Ctrl+E` (current-tab mode) with the sidebar expanded, settled and not hidden
(`canAnchorAddrbarToSidebarRow`, from `isSidebarCollapsedTarget`,
`isSidebarHiddenTarget` and `isBentoSidebarPushing`), it sends
`{ kind: 'open-request', windowId, bridgeToken, requestId, mode }` over the
sidebar address channel (`dispatchSidebarAddressMessage`, the frame script and
`bento-sidebar-address-bus` that carry snapshots, scoped by window id and
`bentoSidebarAddressBridgeToken`). `SidebarAddressBar` answers with the same
`BENTO_OPEN_ADDRBAR` a click sends (the current URL as `initialQuery`, which
the palette selects), plus `requestId`: anchored when its row is laid out, and
with no anchor and an empty query when it is not (collapsed rail), which chrome
opens as the centered overlay. Chrome keeps one pending request
(`pendingAddrbarOpenRequest`). `handleAddrbarOpenAnswer` accepts an answer only
when `takeAddrbarOpenRequest(requestId)` finds it pending, and acts on its anchor
only while `canAnchorAddrbarToSidebarRow()` still holds: a sidebar that began to
collapse or hide since the request keeps the row's frame-local rect positive while it
slides, so an answer that finds it ineligible opens centered with an empty query, the
same open the unanswered timer makes. If no answer arrives
within `ADDRBAR_OPEN_RETRY_MS` the timer opens the centered overlay, and the
answer that comes later finds no pending request and is dropped, so an open is
neither doubled nor lost. A pending request counts as an open for every dismissal:
`isAddrbarVisible` is true while it waits, so Esc and an outside click (both ask
`isOverlayOpen`) reach `hideAddrbar` and cancel the request and its timer. Any
`showAddrbar`, `hideAddrbar`, newer request, or another overlay's `openOverlay` also
cancels it (the newest open wins), so neither a late answer nor the timer opens the
palette afterwards. `Cmd/Ctrl+T`, a collapsed or hidden sidebar, a push in
progress, a failed dispatch, `New tab` and the native-urlbar fallback never ask
and open centered at once. The previous `focus` message kind on this channel
(and `focusRequest` in the store) had no consumer and became `open-request`.
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
`#bento-shell-host` has no width transition (sidebar collapse/expand is a
transform slide, see
[Sidebar collapse and expand](workspaces.md#sidebar-collapse-and-expand)), so the
manual splitter drag writes live `width` values straight to the pointer.
`attachSidebarSplitterFeedback()` still adds `bento-shell-sidebar-resizing` during
the drag: it also turns off the hidden host's transform transition and the
frame's pointer events. The same splitter setup must
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
sidebar collapse/expand is the push slide (see
[Sidebar collapse and expand](workspaces.md#sidebar-collapse-and-expand)). Also drag the
expanded sidebar to its minimum width and verify the divider stops at the same
point as Back/Forward/Reload instead of sliding underneath them. The host has no
width transition, so a collapsed-width change cannot make live sidebar or window
resize inherit a collapse animation; its hidden-mode transform transition is still
switched off under both `:root[bento-sidebar-resizing='true']` and
`:root[bento-window-resizing='true']`. The sidebar drag hooks
(`prepare*`/`sync*ForSidebarWidth`) are also how the push commits the toolbar
band's final geometry. Panel-view and no-side-panels main-frame shadows stay at the normal
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
`extensions/bento-tools/src/search/AddressSearch.ts` independently requests two
recently closed tabs, two recent history pages (`startTime: 0`, native visit
order), and two new-tab top sites (`newtab: true`, native order). An unavailable
source omits only its own group. `search/ClosedSessions.ts` scans at most 25
sessions, skips window sessions, and requires the original tab window and private
status to match the trusted action context. Unknown context returns no closed
tabs. Closed sessions remain distinct even when their URLs match.

`AddressBar` dispatches `addrbar/query` after a 120ms debounce keyed by query,
`openVersion`, and error refresh. It registers a fresh opaque `requestId` before
dispatch and invalidates it immediately on input/open changes. The
`useAddressBarStore` mirror accepts results only for its latest id and normalized
query, so equal-query replies from earlier opens or other documents cannot replace
current rows. This path writes no persistent state and does not use title IPC.

Closed rows carry `sessionId` and optional epoch-ms `closedAt`; recent-history
rows carry optional epoch-ms `lastVisitTime`. Activating a closed row sends
`addrbar/restoreClosed` with a separate request id. Tools re-queries eligible
sessions before calling `browser.sessions.restore(sessionId)` for that exact id.
There is no latest-session or URL fallback. A pending activation blocks another
row activation and makes the input read-only. A correlated success closes the
palette; unavailable/failed outcomes keep it open with a status and refresh all
sources. A newer open ignores the earlier restore outcome.

Native restore resolves before Bento classification completes. The tools handler
awaits `prepareRestoredTab`: `background.ts` shares the in-flight
`maybeRestorePanelFromMarker` task with its existing onCreated path. That task asks
`TabRegistry.hydrateRestoredTab` to validate retained membership before consuming
the closing mark and re-reading native workspace/folder/custom-title values.
Only then does it resolve the saved workspace's owning window. If that window
is different from Firefox's native restore window, it moves only the restored
tab with `moveWorkspaceTabsToWindow`, preserving its identity, history and panel
classification. It awaits workspace activation, normal-tab selection or targeted
panel sync, and window focus before reporting the actual destination window in
the original correlated reply. A failed move, reveal or changed ownership reports
failure. Private restores stay in the requesting private window. It must never
activate a tab early and clear a still-restoring panel marker.

Ordinary single, bulk, main-tab and non-DevTools pinned-panel closes opt into
`markClosing(id, { preserveSessionMembership: true })`. Live membership and pending
assignments are cleared immediately; existing regular-tab `bento.workspaceId`
and `bento.folderId` values remain for Firefox's native closed session. Private
membership is never retained. Cleanup, workspace deletion, startup sweeps,
DevTools and panel-layout cascades keep destructive marking.

On restore, the saved workspace must still exist and the saved folder must still
belong to it. A deleted workspace, including one automatically deleted after its
last tab closes, falls back to the current window's workspace. Deleted or moved
folders are dropped. Bento closing marks never authorize import adoption or
workspace resurrection, including through panel markers. Unmarked genuine
imports retain their adoption path. Startup marked live tabs are swept rather
than treated as undo-close requests. Existing beforeunload cancellation rollback
and the panel marker remain in use; no replacement tab or URL fallback is used.

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
For empty floating opens, Recently Closed, Recent History and Top Sites come
first, with two rows each. Empty new-tab opens append a validated clipboard URL
row and saved-panel rows after those groups. Saved-panel rows are built from the
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

The engine `Select` is a React sibling of `CommandPalette.Content`, inside the
palette popup/dialog. `createPortal` places it in the toolbar's boxless
`bento-address-bar__engine-slot`; search input and results remain in Content.
Content supplies Autocomplete collection and virtual-focus context, which must
not reach the independent Select list. The portal preserves the popup's React
event ancestry, including its pointer-capture dismissal guard.

Shared row shaping for tools results, synthetic open/search rows, saved-panel
defaults, URL-like detection, row text, and one-shot engine payload selection
lives in `components/AddressBar/addressRows.ts`. Both the sidebar row and
floating fallback use those helpers so autocomplete behavior does not drift.

## Address Entry Pitfalls

- Isolated shell packages must include `dist/assets/background.js`, as declared
  by the shell manifest. Putting the relay at `dist/background.js` leaves the
  sidebar connecting and the engine picker unhydrated. Check manifest resources
  and compare the complete tested and staged file trees; extra files in a test
  app can otherwise hide a missing entry point.
- Empty Enter must fall through to Mux's focused option. Only typed input uses
  the synthetic search/open submission override. Keep modifiers and IME unchanged.
- Keep `requestId` in both query and result payloads: query text alone cannot
  distinguish repeated empty opens or equal queries from other documents.
- Keep `openVersion` in the debounced query effect. The address component survives
  closing, and each empty open clears its result mirror. Depending only on query
  changes leaves an empty-to-empty reopen blank. Verify repeated empty opens,
  typing then reopening empty, and reopening before the 120ms debounce fires in
  an isolated native test profile.
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
- Keep the centered address `CommandPalette` animation opacity-only. Mux UI's
  default command-palette transform transition causes visible movement when
  switching between anchored sidebar opens and centered new-tab opens. The anchored
  popup has no document fade at all and grows instead (see "Grow motion").
- A `position: fixed` element always forms a stacking context, so the Mux popup's
  `z-index: 101` ranks only inside its (fixed) backdrop. In a Ladle story that renders
  `SidebarAddressBar` under the popup, the row's own `z-index: 2` outranks the popup
  unless the story wraps the sidebar at `z-index: 0`. In the real window the two live in
  separate documents, so only the story needs it.
- Do not put the anchored popup's elevation back on the popup itself (see "Grow
  motion"), and do not read a `clip-path` end value from a CSS variable.
- The anchored popup must not be capped by Mux's `max-height: min(84vh, 45rem)`. The
  shadow and the grow's start insets use the popup's box, so a popup capped below it
  (84vh of a 445px window is 373.8px against a 378px placement) stands short of the shadow
  and starts its grow at the wrong row height: the gap and the bright strip come back. Any
  new Mux sizing rule on the popup (`max-*`, `min-*`) needs the same override on the anchored
  rule.
- Do not size the anchored popup from the placement alone. Chrome does not place an open
  palette again, so a popup left at 378px after the window shrank to a 320px viewport kept an
  oversized list scroll area, and the last result sat below the window's edge, out of reach.
  The popup and the shadow both read `--bento-address-bar-fit-width` and `-height` (the
  placement capped by the room left); keep them on that one size, and keep
  `--bento-address-bar-anchor-margin` equal to chrome's `ADDRBAR_ANCHOR_MARGIN_PX`.
- Measure the popup for the grow, never take `placement.width` and `height` for it: where the
  180px minimum exceeds the room below the row (a short window, a low row) the rendered popup
  is smaller than the placement, and a clip or a shadow scale built from the placement starts
  larger than the row's box.
- Measure the popup again just before the grow runs. The address bar document is hidden
  between opens, and a hidden frame keeps the window size it had when it was hidden: for its
  first ~100 ms after being shown the viewport (so `100vh` and the cap) is the old one. The
  first measure then reads a popup of the wrong height, and clip insets built from it start
  the grow at the wrong box (a 32px row grew from a 368px box after the window had been
  enlarged while the palette was closed). The host is still faded out at that point, so the
  start values can be rewritten before the transition begins.
- A cached "last delivered" value belongs to the document it was delivered to. A reloaded or
  re-created shell document comes back with `paletteOverRow` false, so a palette open over the
  row showed the new row's border under the palette until a close and open cycle, because the
  next reveal saw the cache already `true` and sent nothing. Reset
  the cache on the document's `BENTO_SIDEBAR_ADDRESS_READY` announcement and sync again.
- Only the latest over-row value may be delivered. Record the wanted state before sending
  and let every retry re-read it; never queue a retry of a message built from an earlier
  value. A cache set only when a send succeeds, with the helper's own retry, let a failed
  open's retry land `open: true` after Esc (Esc skipped the `false` because the cache still
  matched), and the row stayed borderless after the palette closed.
- The elevation sibling must ride the same spring pair as the clip, not a fade after
  it. A shadow at full size (or fading in on a delay) while the clip still has the
  spring's tail left (9 to 11px on the right and bottom of a 512 by 378 popup at
  the 200 ms visual duration) leaves a gap between the popup's edge and the shadow's
  box, and the page shows through it as a bright strip that reads as an inner border.
  Keep its scale on the clip's start box and its `transform`, `opacity` and the clip on
  one `reveal` spring pair.
- A missing Cmd+L answer must still open: never wait for the row without the
  `ADDRBAR_OPEN_RETRY_MS` fallback, and never act on an answer `takeAddrbarOpenRequest`
  does not know, or one shortcut press can open the palette twice.
- Focusing `#bento-shell-frame` restores focus to the row's read-only input, whose
  `onFocus` opens the palette. A runtime probe that needs the chrome window focused
  (a Cmd+L test) must clear the focus (`Services.focus.clearFocus(window)`) instead of
  focusing the shell frame, or the palette opens before the key is sent.
- The address bar document stays hidden between opens, so a colour-mode flip reaches it
  on its next show: the first anchored open after a flip can paint the start frame
  mid-fade (the popup background between the old and new mode). Later opens, and every
  open after a workspace theme change, start on the row's exact colour.
- The grow's two clip radii are read, not written: `to` from the popup's computed
  `border-top-left-radius` (the container radius), `from` from
  `--bento-address-bar-grow-from-radius`, a registered `<length>` the anchored popup rule
  sets to `--bento-sidebar-address-field-radius` (registered so `getComputedStyle` returns
  px, where an unregistered custom property returns the `0.375rem` text). The clip rounds
  the row's box with the row's radius and the corners ease out to the popup's as it grows.
  The popup's own `border-radius` (12px) still cuts the top-left corner on every frame,
  because that corner is the row's and the clip's 6px curve lies inside it; the clip radius
  only shapes the other three corners of the start frame. The row sits in another document
  under the transparent overlay, so its 6px corner and border would show through the crescent
  between the two curves, at rest and on the start frame alike: a faint second arc outside
  the popup's top-left corner (measured in Default: at most 11/255 lighter or darker than
  the surface on the diagonal, 22/255 along the arc, in light and dark mode). The row's
  border fades out while the anchored palette is over it ("Row border fade"); the row's
  background is the sidebar's, so the border is all that shows. Do not give the palette the
  row's radius to hide the arc (the two radii differ on purpose), and do not drop the
  `palette-over-row` message or the row's `border-color` transition without restoring the
  arc. The row's border is transparent only while chrome says the palette is over it, so a
  centered open or a missed `open: false` would leave the row borderless.
- The address bar host fades on the Mux `modal` role
  (`ADDRBAR_HOST_TRANSITION = 'opacity var(--muxui-semantic-motion-modal-transition)'`).
  `hideAddrbar` sets opacity 0 and `hideOverlayHostAfterFade` commits `display: none`
  from the host's computed transition; do not put a duration back in script, and a
  reopen during the fade must keep the host (`prepareAddrbarHostForOpen` cancels the
  pending hide).
- Keep the address popup and search-engine picker popover on `var(--neutral-5)`
  surfaces so the palette reads as a traditional neutral command palette in
  light and dark modes.
- Scope engine-picker geometry to `bento-address-bar__engine-*` classes, not
  Mux Select part names. The local Mux rename from `muxui-select-trigger` to
  `muxui-select__trigger` left the old overrides unmatched and restored the
  default 10rem trigger minimum (160px at the 16px root). Keep the compact
  `width: auto`/`min-width: 0` override, hidden selected name, anchored height,
  and independent menu sizing. Resting transparency must exclude hover,
  native `:focus-visible`, `[data-focus-visible]`,
  `[data-muxui-state-focus-visible]` and `[aria-expanded='true']`; the last also
  drives the Bento chevron's rotation. Check anchored/centered and light/dark
  states against both npm and existing local generated Mux output.
- Keep the engine Select outside `CommandPalette.Content` in React ancestry,
  even though its toolbar host is inside Content in the DOM. Nesting the Select
  under Content makes it inherit Autocomplete's collection ref, listbox ID and
  virtual focus: ArrowDown closes the engine menu without changing selection,
  and its option becomes the search input's active descendant. A DOM portal
  from inside Content or an ID-only patch does not isolate that context. Verify
  native Tab, Enter, ArrowDown and Enter with empty and typed queries, separate
  listbox references, Escape/Tab focus return and parent result navigation.
- Keep the nested search-engine `Select.Popup` non-modal. React Aria's
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
- Privileged search-icon conversion accepts only `data:image/` URLs (by string
  length), bounded `https:`, `moz-extension:`, `chrome:`, `resource:`, and
  `moz-icon:` sources, and Firefox's own `blob:system/<uuid>` icon URLs. Network
  reads omit credentials and referrers, time out after five seconds, stop at
  512 KiB and abandon the request when they fail or exceed the cap; engine
  conversion is limited to four concurrent tasks. Do not add `http:`, `file:`,
  other blob origins, or unbounded response reads to this bridge. Per-form
  limits: [privacy-search.md](privacy-search.md).
- Keep expanded-sidebar address editing in the shared address overlay. A
  sidebar-frame popover cannot reliably paint over the panel strip/main content
  because the sidebar is a chrome-hosted iframe with its own paint bounds.
- Keep the sidebar-anchored address overlay smaller than the centered overlay. The
  anchored cap is 80% of the standard width and 90% of the standard height; new-tab,
  top-urlbar and collapsed or hidden sidebar opens (including `Cmd/Ctrl+L` and
  `Cmd/Ctrl+E` while the expanded row is not on screen) keep the standard centered
  dimensions.
- Only the sidebar URL row passes an anchor: a click on it, or its answer to a
  `Cmd/Ctrl+L` or `Cmd/Ctrl+E` open request. `Cmd/Ctrl+T`, `New tab` and top-urlbar
  fallback opens must keep the centered address/search overlay and never ask the row.
- Keep address-palette search-engine state separate from privacy settings. The
  picker is a one-shot override for submitted non-URL searches only.
- Keep the picker dirty flag tied to `openVersion`. Late search-engine snapshots
  must not reset a user-selected engine before submit, and each new open must
  reset to Firefox's current default.
