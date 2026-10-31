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

Pinned-panel persistence ordering: every `PinnedPanelsStore` mutation (add,
remove, reorder, rebind, metadata, width, workspace or tab removal, boot
recovery) snapshots `#byKey` synchronously and calls `#resolveAndPersist`. The
call takes the next `#persistGeneration` number, then reads each pin's tab with
`browser.tabs.get` right away (at change time; only the storage write is
debounced) and records the URL, title, and favicon it saw in `#observed`. A pin
found in a private tab is added to `#privateTabIds` instead. The call writes
only if it still holds the highest generation once every lookup started so far
has finished, so a stale pin list or a pin removed in the meantime cannot reach
storage. Membership and order come only from the newest snapshot; URL, title,
and favicon come from `#observed`, with the snapshot entry as the fallback.

`#observed` holds the freshest value of each field per pin, stamped with the
persist generation that saw it. Per field, the higher generation wins, whichever
lookup or write finishes last; the merge reads `observed.field` when the field was
observed and the snapshot entry only when it never was. A superseded call's lookup
that resolves late therefore replaces nothing newer, and a tab that closed keeps
what was read from it. Entries of pins that left the membership are dropped when
the newest call merges. Who stamps what:

- Tab reads (`browser.tabs.get`) stamp at their own call's generation, through
  `readTab`. Firefox's `TabBase.convert()` (`ext-tabs-base.js`) copies `url`,
  `title` and `favIconUrl` only when truthy, so a page with no icon (or an empty
  title) yields an object without the key, not an empty string; `status` is
  always present, `loading` while the tab is `busy` and `complete` otherwise. On a
  `complete` tab a missing title or favicon therefore means the page has none: it
  is stored as an empty observation that clears the value and wins by generation,
  and the stored entry then omits the field. While `status` is `loading` (or
  missing) a missing field says nothing and keeps the older value, so a tab in
  the middle of navigation does not blank a good title or icon. An explicit empty
  string is a clear whatever the status. A read whose URL
  `isPersistablePinnedPanelUrl` rejects (empty, `about:blank` before SessionStore
  has set the address, `about:devtools-toolbox`) is not the pinned page, so
  `readTab` discards it whole: it replaces no URL and neither clears nor sets the
  title or favicon, whatever its status and whether it omits them or carries its
  own.
- `add`, `rebindTabId` and `updateMetadataForTab` pass the metadata they wrote to
  the entry as `edits` to `#schedulePersist`; the edits are recorded at the
  generation of the persist call they start, before that call's own lookups, so
  the lookup of the same call wins a tie. `add` and `rebindTabId` stamp the fields
  they carry. `updateMetadataForTab` stamps every non-empty field it supplies,
  whether or not it differs from the entry, because the value that would be stored
  can be an older tab read the entry never held (a title captured before the tab
  closed). Fields the update does not supply keep their older stamp. Tab events
  report empty titles and favicons while a page loads, so an empty event value is
  not supplied; only a tab read clears a field.
- Boot recovery passes no edits: persisted values are older than any live read.

`persistCurrentState` is a durability barrier (`ImportExecutor` awaits it before
old-workspace cleanup). It registers its generation in `#awaiting` and settles
only after a write of its state or a newer one has finished, however many later
calls supersede it. While any awaited persist is outstanding, every write is
flushed instead of debounced, so a newer state is never left on the 500 ms timer
behind an awaiting caller. A storage failure does not hold it up: `Persistence`
logs a failed backup or primary write and still releases its waiters, and an
error in the lookup or write chain is logged and releases the awaiting callers
up to that generation. The promise therefore never rejects and never hangs on
storage, and means the write was attempted to completion, not that storage
accepted it. Do not add a mutation that skips `#schedulePersist`; it would not
bump the generation and an in-flight older lookup could resurrect its state.

`pinnedPanels/Persistence` is single-flight like `panels/Persistence`: one write
(backup copy plus primary set) in flight, one queued state, a newer queued state
replaces an older one, and the backup and primary writes of one state never
interleave with another state's. `schedule` is the 500 ms debounce path;
`flushNow` resolves once a write at least as new as its state has landed.
Verify with `PinnedPanelsStore.test.ts` ("persist ordering", "superseded
lookups", "metadata freshness", "metadata clears") and `Persistence.test.ts`.

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
[Shell-sized lengths](../chrome-tokens.md#shell-sized-lengths)): the host is 256 px
wide (284 px with the select) in the shell's 16 px reading, where chrome's own rem
gave 176 px (195 px). The flat layout measures the host's rendered width
(`getTrailerLayoutWidth`), so the wider trailer takes 80 px (89 px with the select)
more of the strip's scroll extent and leaves the main panel that much less room when
side panels are open.

## Widget pitfalls

- Do not call Places APIs from shell or chrome UI for saved panels. The
  `SavedPanelsStore` owns bookmarks interaction.
- Do not persist pinned panels by tab id only. Use URL and panel key remapping.
- Keep the trailer's `split-view-panel-active` paint class, but omit its host
  from `modePageFrames()`'s live page holes. Its saved-panel grid and interior
  fill must remain under the [shared mode fade](theming.md#mode-flip-fade);
  otherwise they jump to final colours before the surrounding chrome finishes.
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
- Keep pinned-panel metadata and privacy capture inside the persist call each
  mutation starts. `PinnedPanelsStore` reads URL, title, favicon, and
  `tab.incognito` from `browser.tabs.get` in `#resolveAndPersist`, right when the
  mutation runs; the ordering fix only serializes those persists (generation
  guard, `#observed`, single-flight `Persistence`). Do not hand privacy or tab
  metadata to the mutation methods as sticky provenance (new `incognito`
  parameters), and do not defer the reads behind the 500 ms timer. Two attempts
  that did one of these leaked or lost data: a pin restored into a private
  window (via `recoverTabIdsAfterPanelRestore`) was inserted without privacy and
  leaked after it navigated; rebinding a private pin dropped its pending
  provenance and made inherited private metadata persistable; a URL change
  followed by a tab close before the registry delta flush lost the new URL;
  recovery by panel key kept stale persisted metadata instead of writing the
  current URL; and a regular pin reopened privately and then regularly lost
  persistence permanently. The `capture semantics` tests in
  `PinnedPanelsStore.test.ts` pin this behavior.
- Do not discard a superseded persist's lookups, and do not let the newest call
  write before earlier lookups finish. Dropping an older call whole loses what it
  read: if its tab closes before the newest lookup, the newest call has no URL
  (the pin vanishes from storage when it had none) or only an outdated one, and a
  pin the older lookup found private is written from the fallback entry. Writing
  the newest snapshot with `#observed` merged in fixes this. The cost is that a
  write waits for the slowest earlier `tabs.get`; a lookup that never settled
  would block every later write.
- Do not let one metadata source win unconditionally. A merge that always
  preferred the last tab read discarded a newer title or favicon from
  `updateMetadataForTab` when that call's own lookup failed because the tab was
  closing; one that preferred the entry lost the URL of a closed tab. Both go
  through `#observe` with the persist generation, per field, higher wins. A new
  mutation that writes entry metadata must pass it as `edits` to
  `#schedulePersist`, or an older read will override it. Boot recovery
  deliberately passes none: persisted values are older than any live read.
- Stamp what an update supplies, not what changed against the entry. Comparing
  only with the entry left a newer update losing to a cached read: the entry had
  title `Original`, a lookup captured `Transient` and the tab closed, then an
  update supplied `Original` plus a new favicon. Only the favicon got a fresh
  stamp, so storage kept `Transient`.
- Keep "observed" and "not observed" distinct in the merge. Treating a successful
  read's empty title or favicon as missing (a truthiness test on the observed
  value) kept the old value, and an import creates pins without metadata, so a
  title captured once could never be cleared. Only an undefined field is "no
  information". The cost: a tab that still reports an empty title or favicon
  while it loads clears the stored value until a later read supplies it again.
  The `metadata freshness` and `metadata clears` tests pin both cases.
- Firefox does not send empty strings: `TabBase.convert()` omits a falsy title or
  favicon, so waiting for an explicit `''` never clears anything in the real
  browser. A pin imported without metadata kept the first favicon it saw after
  the page moved to one without an icon, because the read looked like "no
  information". `readTab` maps a missing title or favicon on a `complete` tab to
  `''`; a `loading` or status-less read stays undefined. Build tab fixtures with
  `firefoxTab` (omits falsy fields), not with empty strings, or a test passes
  where the browser would not. A `complete` tab with a non-persistable URL
  (`about:blank` before SessionStore sets the address) has no title or icon yet
  and would have blanked the stored ones, so `readTab` ignores the whole read
  unless its URL passes `isPersistablePinnedPanelUrl`; the "completed tab at
  about:blank" test pins it. The cost: a `complete` tab at a real URL that has not
  loaded its icon yet clears the stored icon until a later read supplies it.
- `#lookupsSettled` must settle to `undefined`. `Promise.all([previous, lookups])`
  resolves to an array holding the previous barrier's value, and each persist
  chains onto the last barrier, so a value kept every earlier result alive (1,000
  persists retained 1,000 nested arrays). The "settles the lookup barrier" test
  in `PinnedPanelsStore.test.ts` reads the settled values off the `Promise.all`
  inputs, so it assumes the barrier is built with `Promise.all`.
- An awaited `persistCurrentState` must not adopt another call's promise. A
  superseded awaited call that returned the newest call's promise resolved while
  an intermediate write was still in flight and the newest state sat on the
  debounce timer, so `ImportExecutor` proceeded with nothing durable. The
  barrier is the `#awaiting` registry, settled by landed writes. The
  `persist ordering` tests cover several supersessions behind a blocked write.
- The saved-panel favicon row cannot rely on `page-icon:` URLs from the
  trailer iframe. `SavedPanelsStore` filters privileged favicon URLs and uses
  placeholders when needed.
