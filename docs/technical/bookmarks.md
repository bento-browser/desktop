# Bookmarks view

Part of the [technical notes index](../core-functionality-technical.md).

The Bookmarks manager is a full-window view of Bento's own link store (spaces, groups and
links, notes and to-dos), separate from Firefox's Places bookmarks. This note covers the
shell document that draws it. The chrome host, the open and close paths, the Esc stack and
the hidden chrome are in [Bookmarks view](overlay-documents.md#bookmarks-view); the data
layer is `extensions/bento-tools/src/bookmarks/`.

## Source of truth and data flow

- **Source of truth.** The `bento-tools` bookmarks store (`BookmarksStore.ts`), persisted in
  the extension's storage. The shell never writes it. `useBookmarksStore`
  (`extensions/bento-shell/src/state/bookmarks.ts`) is a downstream mirror with one setter,
  `apply(snapshot)`; the whole snapshot (spaces, groups and items, each sorted by `order`,
  plus `lastSpaceId`, `firefoxImportOffered` and the load `status`) replaces the previous one.
- **Snapshot.** Tools broadcasts `bookmarks/snapshot` to the documents of regular windows on
  shell connect and after every change. The Bookmarks document is created lazily, so it
  sends `bookmarks/requestSnapshot` once when its port is ready and again on every
  `bento-bookmarks-show` (it may have missed changes while hidden); it does not rely on the
  boot replay. `bridge/useToolsPort.ts` applies the event with the `bookmarks/snapshot` case.
- **Actions.** The UI dispatches `bookmarks/*` actions only (`space/create|update|delete|select`,
  `group/create|update|delete|move`, `item/create|update|delete|move|open`, `tabs/save`,
  `import/firefox|dismiss`). A change shows on screen when the next snapshot arrives; there is
  no optimistic state, so a rejected action leaves the screen as it was.
- **Open tabs.** The drawer's tabs come from the shell's tabs store, not from tools:
  `useOpenTabs` (`src/bookmarks/useOpenTabs.ts`) lists the active workspace's tabs of the
  document's own window (panels included, in tab-strip order, `customTitle || title`),
  skipping schemes the store would refuse (`about:` and the privileged ones; the scheme list
  is `ALLOWED_URL_SCHEMES` of `@shared/export-schema`, minus `about:`). `tabs/save` carries tab
  ids; tools resolves the URLs.
- **Private windows.** Chrome refuses to open the view and tools refuses `bookmarks/*` actions
  there. The command palette entry is not rendered in a private window, `Cmd/Ctrl+Shift+O`
  keeps opening Firefox's Library there, and the document shows a "not available" notice if it is ever shown in one.

## Data layer

`BookmarksStore.ts` holds the state and applies every mutation; `Persistence.ts` loads and
writes `storage.local` key `bento.bookmarks.v1`; `bookmarksActions.ts` routes the `bookmarks/*`
actions after the protocol handler's private-window check; `fields.ts` applies the field caps.
The wire validator (`_shared/wire-action.ts`) rejects malformed actions before any of them run.

### Load, status and action order

- The store starts `loading`. `init()` reads storage and settles as `ready` (loaded, or seeded
  with one empty "Personal" space on first run) or `loadFailed`. It never rejects.
- Every `bookmarks/*` action goes through `afterInit`: one that arrives while the load is
  pending is queued and runs, in arrival order, right after the loaded state has been announced.
  Without that, an action received during startup would build on an empty state and its write
  would replace the stored data. A direct store call while loading is refused, not queued.
- `loadFailed` (storage could not be read) means: the snapshot has `status: 'loadFailed'` and
  empty arrays, every mutation is refused, nothing is written, and no "Personal" space is
  seeded. `bookmarks/requestSnapshot` calls `init()` again, which retries the read, and replies
  once it settles; a successful retry announces the loaded state to every window.
  The UI shows a notice with Retry (a `requestSnapshot`) while `status` is `loadFailed`.
- Stored data that is present but unusable (no valid space) is treated as first run and replaced
  by the seeded space.

### Writes

Writes are immediate and serialized: every change calls `Persistence.schedule(data)`, which
starts a `storage.local.set` unless one is in flight. Changes made during a write replace one
dirty slot (newest wins) and a single follow-up write carries them, so a burst costs two writes
and quitting loses nothing beyond the write in flight. A failed write keeps its state dirty
(unless newer state arrived), logs, and retries after 1 s, doubling to a 30 s ceiling; changes
made during the backoff wait for that retry, and success resets it. `flush()` skips the wait
(tests). The stored object is the snapshot without `status`.

### Field caps

One cap per stored field (`BOOKMARK_LIMITS` in `_shared/protocol.ts`, UTF-16 code units):
names 1,024, link title 4,096, note and to-do text 32,768, favicon URL 262,144, link URL
`MAX_URL_LENGTH`. Create, update, Firefox import, `tabs/save` and storage load all go through
`fields.ts`, which trims names and titles, truncates to the cap and trims the end again, so
normalizing a stored value returns it unchanged: delete + undo (a `item/create` of the old
fields) reproduces the item. The wire validator rejects longer input on create and update with
the same constants. Imported and tab-derived text is truncated rather than refused; a favicon
URL over the cap or with a scheme the wire does not accept (`page-icon:`, `blob:`) is dropped; a
blank link title falls back to the (capped) URL.

### Client ids

`space/create`, `group/create` and `item/create` take an optional `id`: a lowercase UUID
(`crypto.randomUUID()`, validated by the wire guard). The create is refused, with no change and
no event, when the id already exists among spaces, groups or items (one namespace). Tools
generates an id when it is absent. A to-do's `done` can be set on create, so undo restores a done
to-do in one action.

### tabs/save placement and ids

`bookmarks/tabs/save` saves every savable tab in one change (one renumber, one snapshot).

- `beforeId`: the run goes before that item of the target group, in `tabIds` order; at the end
  when it is absent, null or not in the group; ignored when `groupId` is null (a new group).
- `ids`: client ids matched to `tabIds` by index. The link saved from `tabIds[i]` gets
  `ids[i]`. A tab that is skipped (closed, private, unsavable URL, or a repeat of an earlier
  `tabIds` entry) leaves its slot unused and does not shift later ones. A tab with no slot
  (`ids` shorter than `tabIds`) gets a generated id. If any entry of `ids` already exists or
  repeats, nothing is saved and no "Saved tabs" group is created.

## Document

`bookmarks.html` is the `bookmarks` entry in `vite.config.ts` and `OVERLAY_ENTRIES`
(`entries.test.ts`); `main.tsx` calls `useOverlayReadySignal('bookmarks')` after its
visibility subscription is in place. It listens for `bento-bookmarks-show` and
`bento-bookmarks-hide` (`src/bookmarks/visibility.ts`) and closes the view by sending
`BENTO_CLOSE_BOOKMARKS_<ts>` through `sendChromeTitle` (`src/bookmarks/titles.ts`; a test keeps
the open and close prefixes equal to the mount script's). The document background is opaque,
`var(--bento-toolbar-main-bg)`, set by a rule keyed on `html[data-bento-document='bookmarks']`
so it wins over the shared document rule: the view is one surface with the toolbar strip that
stays visible above it.

The component is `components/BookmarksView/`. `BookmarksView.tsx` is presentational: it takes
the snapshot, the open tabs, `send` and `onClose`, so stories bind `send` to the fake reducer
in `state/__fixtures__/bookmarks.ts` (`applyFakeAction`, `useFakeBookmarks`).

| File | Role |
| --- | --- |
| `model.ts` | Snapshot to board: space summaries, the selected space's groups, search across all spaces, and `parseAddInput` (URL or bare domain becomes a link, `[] text` a to-do, anything else a note). |
| `drop.ts` | Drop slot from measured boxes (`itemDrop`, `groupDrop`) and the no-op checks. Pure. |
| `pending.ts` | The pending-create follow-ups (below). Pure. |
| `flip.ts` | Records element positions before a snapshot and plays the settle after it. |
| `useBoardDrag.ts` | Pointer drag for items, open tabs and groups. |
| `InlineEditor.tsx` | The one inline text field: Enter commits, Shift+Enter breaks a line in a multiline field, Esc cancels, blur commits. |
| `SpacesList`, `BoardColumn`, `ItemRow`, `TabsDrawer`, `SearchResults`, `EmptySpace`, `EntityMenu`, `UndoToasts` | The parts of the screen. |

### Transient state

Local to the view: the search text, one `editing` target (a space or group name, an item, an
add row, "+ Space", "+ Group"), the drawer, one pending confirmation and the undo toasts. A
show resets all of it; a hide also drops an unfinished edit and the toasts. The selected space
is not local: `bookmarks/space/select` records `lastSpaceId` in tools, and the view shows
`lastSpaceId`, else the first space.

### Esc order

The document handles Esc itself (the chrome listener returns for this frame). One press does
one thing: an open inline editor cancels, else a Mux menu closes (it consumes its own Esc),
else a search with text clears (the field's own handler), else a drawer that overlays the board
(below the narrow-width breakpoint) closes, else the view closes. A drawer docked beside the
board is left alone.

## Drag and drop

`useBoardDrag.begin` runs from `onPointerDownCapture` on item rows, open-tab rows and group
headers. React Aria's `usePress` stops `pointerdown` from bubbling, so a bubble-phase handler
never sees a press that starts on a Mux Button. Nothing happens until the pointer has moved
4 px; only then does the hook take pointer capture, so a click, a double-click and a press on
a hover action behave as before. A drag that crosses the threshold swallows the click that
follows and sets a suppress flag that `consumeSuppress` reads.

While a drag is active, a `requestAnimationFrame` loop draws everything imperatively: a clone
of the row follows the pointer, a one-pixel insertion line is placed from the measured column
boxes (`drop.ts`), and the board autoscrolls near its edges. React renders nothing per move,
and the line is positioned over the board, so rows never reflow while the pointer moves. The
move commits on release. Esc, window blur, and a hide cancel without a commit.

Targets: an item or tab goes into any column at a slot, or onto the empty-space zone; a group
goes between columns of the same space. A drop that would leave the order unchanged sends
nothing (`isItemMoveNoop`, `isGroupMoveNoop`).

Reorder settle: `recordFlip` stores the rects of `[data-bm-flip]` elements (the dragged row's
start comes from the ghost) before the action goes out, and `playFlip` runs in a layout effect
when the next snapshot arrives. It sets `data-bm-flipping`, whose transition is the `reveal`
role on `transform`, and clears it with `afterMotion({ properties: ['transform'] })`. It does
nothing under reduced motion and ends an unfinished settle before starting another.

### Follow-ups for created items

Create actions return no ids. `pending.ts` holds a short list of intents (`PendingCreate`,
live for `PENDING_CREATE_TTL_MS`, 5 s) and the view resolves them against the next snapshots by
finding items in that group that were not there before the action:

- a tab dropped at a slot is saved at the end of the group (`tabs/save`), then moved to the
  slot with `item/move`, so a tab drop shows briefly at the end before the settle;
- deleting a to-do that was done and undoing it creates it open (`item/create`) and then ticks
  it (`item/update`), because the create input has no `done` field;
- creating a space selects it; creating a group scrolls it into view.

## Undo toasts

Deleting an item removes it at once and offers Undo for 6 s (`UNDO_TOAST_MS`). Undo re-creates
the item with `bookmarks/item/create` in its old slot (`restorePlan`), so it comes back with a
new id and creation time. The toasts are the Bento composite `UndoToasts` on Mux `Button`,
`IconButton` and `Text`, not Mux `Toast`: Mux Toast added about 7 KB gzip to the cold start of
every overlay document. A toast pauses on hover and focus, leaves through `afterMotion` on the
`dismiss` role, and at most three show; a fourth removes the oldest. Deleting a group or space
asks first, in a Mux `Dialog`, and is not undoable.

## Entry points

- The command palette's "Open Bookmarks" Navigation command (`CommandPalette.tsx`, id
  `nav:bookmarks`) calls `openBookmarksView()` and is hidden in a private window. There is no
  sidebar footer button: the footer keeps exactly five buttons
  ([sidebar-native-surfaces.md](sidebar-native-surfaces.md#footer-buttons)). `Cmd/Ctrl+Shift+O` is handled by
  chrome ([overlay-documents.md](overlay-documents.md#bookmarks-view)).
- The size ceiling for the document is the overlay target (200 KB gzip cold start):
  `bookmarks` is in that list in `scripts/check-size-budgets.mjs`.

## Manual verification

1. Bento window, regular: press `Cmd+Shift+O` (or run "Open Bookmarks" from the command palette). The sidebar and panels give way
   to the view; the toolbar strip stays and joins the view's surface.
2. Add a space, a group, a link (paste `example.com`), a note and a `[] to-do`. Edit each inline;
   Esc cancels, Enter commits. Delete the link and press Undo in the toast.
3. Drag a link to another column, a column to another position, and a row from the Open tabs
   drawer into a column. The insertion line must not move any row; the dropped row glides into
   place.
4. Narrow the window below about 1200 px: the spaces fold to dots and the drawer overlays the
   board. Esc closes the drawer first, then the view.
5. Search with text: results span all spaces; Esc clears the field.
6. Open a private window: no palette command, and `Cmd+Shift+O` opens Firefox's Library.
7. Light and dark colour mode and a non-default workspace theme.

## Pitfalls

- A `pointerdown` handler on a row never fires when the press starts on a Mux Button.
  Use the capture phase (`onPointerDownCapture`), and take pointer capture only after the
  threshold, or the click that follows never reaches the button.
- Hover actions sit over the end of a row without a background. A solid or gradient fill
  that differs from the row's hover tint shows as a lighter patch; the row text under the
  actions is masked out instead. The mask uses `mask-size` and `mask-position` lengths with no
  `var()` inside the gradient stops, which `scripts/mount-motion.test.mjs` rejects.
- Mux `Checkbox` has a hover/press gradient tint over an unregistered custom property, so it
  does not cross-fade with the theme; it is recorded in `MUX_GRADIENT_RESIDUAL` in
  `scripts/mount-fade-css.test.mjs` (a to-do checkbox under the pointer only).
- The four hover action buttons use the small control size (24 px): at 32 px they covered most
  of a narrow row and left little to grab.
- A pending create finds its items by group and by the ids the group held when the action was
  sent, not by URL or text. A create that another window or an import puts into the same group
  inside the 5 s window is taken as the follow-up's own item.
