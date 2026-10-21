# Sidebar Native Firefox Surfaces

Part of the [technical notes index](../core-functionality-technical.md).

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

The click path knows the button's rect because the click carries it; an automatic
open does not, so the shell reports where the Downloads button is.
`observeFooterButtonEdges()` (`extensions/bento-shell/src/sidebar/footerAnchor.ts`)
watches the footer with a `ResizeObserver`, measuring the button mounted at that
moment, and `App.tsx` sends
`BENTO_DOWNLOADS_ANCHOR:<timestamp>:<base64-json>` with the button's distances from
the shell viewport's right and bottom edges plus its size, once when first measured
and again only when those change: the rail restacking the footer
(`column-reverse`, so Downloads sits at the top of the stack). The footer has a fixed
set of buttons, so a running merge, whose card floats over the list, never changes
them. Edges, not a position, because the footer is pinned to the
bottom and its buttons keep their distance from the right as the sidebar or window
resizes; a position would be a message on every frame of a sidebar drag. Chrome
(`handleDownloadsAnchorTitle`) keeps the latest edges per window and
`ensureSidebarDownloadsFallbackAnchor` builds the anchor from them and the
`#bento-shell-frame` rect at open time, through the same `ensureSidebarFooterAnchor`
the click path uses. Until the first report it uses the expanded footer's position
(`DOWNLOADS_BUTTON_EDGES_DEFAULT`).

## Footer buttons

The footer holds exactly five buttons: the collapse toggle, the command palette, the
color mode cycle, the Firefox menu, and Downloads. It never gains a sixth. A running
merge shows as a floating card over the bottom of the tab list, above the footer, not
in it (see "Sidebar progress card" in
[session-merge-backups.md](session-merge-backups.md)). There is no idle merge button
and no Settings button: "Merge browser session" lives in the command palette and
Bento Settings, and Bento Settings in the app menu and the command palette.

## Bento Settings item in the app menu

The sidebar footer has no Settings button. Bento Settings is reached from the
native app menu: `installBentoSettingsAppMenuItem()` in the mount script adds a
`toolbarbutton.subviewbutton` (id `bento-appmenu-settings-button`, fixed label
"Bento Settings", like the other Bento-added menu items; no shortcut) directly
above `#appMenu-settings-button`. Its `command` calls `openBentoSettings()`, which
opens `about:settings#bento` or focuses an existing Settings tab in that window
and switches it to `#bento`. Bento does not hide the panel: Firefox's panel close
listeners (`CustomizableUI.maybeAutoHidePanel`) close it after a click or Enter,
as they do for Firefox's own Settings item. The command palette's Settings
command is separate and still sends `BENTO_OPEN_SETTINGS_`.

Firefox creates the main view lazily: it stays in the `appMenu-viewCache`
template until the first open, then `PanelMultiView` moves it into
`#appMenu-popup`. Every open path goes through that view, and its bubbling
`ViewShowing` event arrives at the panel after the view is in the live DOM and
before it is measured. One `ViewShowing` listener on `#appMenu-popup` (matching
the target by `appMenu-mainView`) inserts the item on whichever open comes first
and finds it already present afterwards, so repeated opens and every window get
exactly one item. In Bento's sidebar-addressbar mode the stock toolbar button is
hidden, so the footer button is the visible open path; `PanelUI.show()`
dispatches the same `ViewShowing`.

Manual check: open the app menu from the footer in light and dark mode. "Bento
Settings" sits directly above "Settings" with the same height, hover and focus
ring; ArrowDown from Zoom reaches it, Enter or a click opens `about:settings#bento`
and closes the menu; reopening several times and in a second window shows one
item.

Bento does not reimplement Firefox's app menu in React. The native menu keeps
owning sign-in state, update/menu-message banners, subviews, extension entries,
shortcuts, and Firefox command handlers. Bento also keeps the native downloads
panel as the source of truth for download item actions, blocked-download flows,
private-download prompts, and download history. Bento hides the stock
`#PanelUI-button`, `#downloads-button`, `#wrapper-downloads-button`, and
`#fxa-toolbar-menu-button` while Bento's sidebar-addressbar chrome mode is
active so the footer buttons are the visible app/download entry points and the
native Account menu does not occupy the top toolbar.

## Pitfalls

- The downloads fallback anchor used fixed offsets from the shell frame's bottom
  right (`width - 43`, `height - 44`), tuned for the expanded footer with a Settings
  button after Downloads. It missed the button once the cog went (2026-10-21), in the
  rail (Downloads is at the top of the stacked buttons) and while a merge progress
  ring, since removed from the footer, was showing. The shell now reports the button's edges (see above). To check
  one, call `DownloadsButton.getAnchor()` in the Browser Toolbox Console in the
  expanded footer and the rail, and compare its rect with the Downloads button's.
- The footer observer must not hold the Downloads button element it first saw.
  `FooterTooltip` renders the bare child while the rail is collapsed and a tooltip
  around it otherwise, so React mounts a new button on every switch and a held one is
  detached (a rect of 0,0). The first version did that and reported only at startup;
  the observer now reads the live ref on each observation. A check is to switch the
  rail and watch `BENTO_DOWNLOADS_ANCHOR` titles on `#bento-shell-frame`: one per
  rail change, none while the window resizes or a merge card comes and goes.
