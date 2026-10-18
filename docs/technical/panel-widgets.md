# Panel widgets, saved panels, and pinned panels

Part of the [technical notes index](../core-functionality-technical.md).

Pinned panels are global shortcuts rendered as a favicon-only secondary rail to
the left of the normal sidebar column. They are backed by
`extensions/bento-tools/src/pinnedPanels/PinnedPanelsStore.ts`. Runtime identity
is `(workspaceId, tabId)` while the backing tab exists; after closure, entries
remain URL-backed and may temporarily use synthetic negative tab ids until the
user opens them again. Persistence stores URLs and optional panel keys because
tab ids do not survive restart. Boot restore remaps persisted entries to live
tab ids when possible and otherwise keeps them as URL-backed rail entries.
The main sidebar does not render a top concave-corner pseudo-element beside the
rail, so the workspace switcher keeps a clean rectangular boundary.
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
rail applies the destination workspace's scoped `color-60` tonal treatment to
each pinned-panel button. Each button carries that workspace's
`data-bento-theme`, so its solid `color-20` background and workspace-toned
border resolve correctly even when the destination is not the active workspace.
Hover uses `color-30`; the focused panel uses `color-60`.
Pinned rail reordering is committed only on pointer release: `PinnedPanels.tsx`
uses a 4px threshold, then takes pointer capture only after that threshold so
the normal React Aria `IconButton` press sequence remains intact for clicks. It
paints a non-reflowing horizontal insertion indicator and dispatches
`pinnedPanels/reorder` with every `(workspaceId, tabId)` identity.
`PinnedPanelsStore.reorder()` rejects incomplete or stale lists, normalizes
`order`, persists the result, and emits its existing complete `reordered` delta
to every shell mirror. Before dispatch, the rail captures each button rect;
after the delta reorders React children, a vertical FLIP transform settles the
buttons with the same opacity, scale and accent-indicator treatment as the top panel
navigator (both settle on Mux motion roles; see the Motion section of
`docs/mux-ui-component-customisations.md`). A completed drag suppresses the button's
normal open press.

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

The trailer's size is one set of `--bento-panel-trailer-*` tokens in
`extensions/bento-shell/src/theme/bento-tokens.css`: button size, grid gap, inline
padding, grid width (a 3x3 grid), the select's wide width, and the base width (the
larger of the wide width and the padded grid). `PanelTrailer.css` lays the buttons
and the "More saved panels" select out from them inside the iframe, and the chrome
host `#bento-add-panel-trailer` (`bento-shell-mount.css`) derives its `width`,
`flex-basis` and `min-width` from the same tokens. `applyTrailerWidth()` sets
`--bento-saved-panel-overflow` to 1 once more than eight panels are saved, which
widens the host from the base width to the wide width plus the padding so the select
fits. Chrome's root font size is not the shell's, so the chrome token sheet pins the
button, gap, padding and wide-width tokens in px at the shell's root size (see
[Shell-sized geometry](../chrome-tokens.md#shell-sized-geometry)): the host is 256 px
wide (284 px with the select) in the shell's 16 px reading, where chrome's own rem
gave 176 px (195 px). The flat layout measures the host's rendered width
(`getTrailerLayoutWidth`), so the wider trailer takes 80 px (89 px with the select)
more of the strip's scroll extent and leaves the main panel that much less room when
side panels are open.

## Widget pitfalls

- Do not call Places APIs from shell or chrome UI for saved panels. The
  `SavedPanelsStore` owns bookmarks interaction.
- Do not persist pinned panels by tab id only. Use URL and panel key remapping.
- Pinned-panel rail clicks dispatch `pinnedPanel/open`, which focuses the
  specific pinned panel if it still exists and recreates/rebinds it from the
  stored URL only when it does not. Do not activate the pinned tab directly;
  direct tab activation breaks the main/panel distinction.
- Pinned-panel rail reorder actions must carry the complete global identity
  list, not an index or a workspace-local subset. The rail includes pins from
  every workspace and synthetic negative tab ids can be rebound after restore.
  Reordering must therefore retain each live `(workspaceId, tabId)` entry and
  wait for a real drag before suppressing the normal open press.
- Pinned-panel favicon images must be `draggable={false}` and pointer-transparent.
  Otherwise Firefox starts native image drag-and-drop, shows its ghost image,
  and prevents the IconButton's pointer-capture reorder path from receiving the
  drag sequence.
- Pointer capture can remain active if the user releases the pointer outside the
  Firefox window. While a pinned-rail drag is active, cancel it on window blur,
  document hiding, or a `mouseout` whose `relatedTarget` is null; otherwise the
  source stays dimmed and the insertion marker remains visible indefinitely.
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
- Do not size the trailer host in chrome with its own rem formulas or copy the
  trailer's px into the mount script. `#bento-add-panel-trailer` holds a shell
  document, and chrome's root font size (the system UI font, 11 px on macOS) is
  smaller than the shell's 16 px, so the host's `16rem` base and wide widths were
  176 px against the 256 px the shell lays the select out at: with more than eight
  saved panels the select (and the grid's 31.15 px buttons against the shell's
  39.6 px, a 103 px grid against 133 px) did not fit the host. The host reads the
  shared tokens, the generator pins the rem leaves in `SHELL_SIZED_TOKENS`, and
  `getTrailerLayoutWidth` has no px fallback to keep in step. When the trailer's
  geometry changes, change the token and read the host's computed `width` in the
  Browser Toolbox against the iframe's `.bento-panel-trailer__more` width.
- The saved-panel favicon row cannot rely on `page-icon:` URLs from the
  trailer iframe. `SavedPanelsStore` filters privileged favicon URLs and uses
  placeholders when needed.
