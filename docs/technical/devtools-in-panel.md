# DevTools In Panel Implementation

Part of the [technical notes index](../core-functionality-technical.md).

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
drops only its link and does not affect the caller. The header and
`closeDevtoolsPanelTab` both dispatch `tab/close`: this route captures the
PanelStore classification (or existing DevTools session marker) before removing
links, then uses destructive membership marking at both close marks. A toolbox
reaching main-tab close uses the same policy; it never retains workspace/folder
session keys or rolls back as a regular user tab. Session markers use
`bento.isDevtoolsPanel` separately from `bento.isPanel`; marker sync clears the
normal panel marker from DevTools tabs, and boot sweeps restored
`about:devtools-toolbox` tabs or tabs carrying the DevTools marker.
Pinned-panel bindings remain persistent for normal panels, but not for DevTools
panels. Chrome hides and guards the panel-header pin button for DevTools panels,
`pinnedPanel/add` refuses DevTools panel ids, DevTools close/sweep paths call
`PinnedPanelsStore.removeForTab`, and pinned-panel persistence filters
`about:devtools-toolbox` URLs on load and save so old bad pins do not survive a
restart.

## DevTools In Panel Pitfalls

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
