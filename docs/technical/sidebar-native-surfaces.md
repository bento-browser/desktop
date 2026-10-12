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

Bento does not reimplement Firefox's app menu in React. The native menu keeps
owning sign-in state, update/menu-message banners, subviews, extension entries,
shortcuts, and Firefox command handlers. Bento also keeps the native downloads
panel as the source of truth for download item actions, blocked-download flows,
private-download prompts, and download history. Bento hides the stock
`#PanelUI-button`, `#downloads-button`, `#wrapper-downloads-button`, and
`#fxa-toolbar-menu-button` while Bento's sidebar-addressbar chrome mode is
active so the footer buttons are the visible app/download entry points and the
native Account menu does not occupy the top toolbar.
