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
  `import/firefox|dismiss`, `requestSnapshot`). A change shows on screen when the next snapshot
  arrives; there is no optimistic state, so a rejected action leaves the screen as it was. Every
  create carries a client id ([Follow-ups](#follow-ups-for-created-items)).
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
`bento-bookmarks-hide` (`src/bookmarks/visibility.ts`, below) and closes the view by sending
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
| `actions.ts` | Builders for the actions that create: client ids (`crypto.randomUUID()`), `tabsSave` (ids and a placed run in one action), `itemRestore` (undo). Pure. |
| `followups.ts` | What to do once a snapshot holds an id the view sent (`exists`, `itemPlacedAt`, `groupPlacedAt`, `settleFollowups`). Pure. |
| `focus.ts` | Selectors for the elements the focus returns to, and `neighbourMoves` (the slots of Move up/down/left/right). Pure. |
| `clickSuppressor.ts` | Keeps a drag from activating its source, through the release (below). |
| `dismissTimer.ts` | The undo toast's countdown with separate pointer and focus holds. |
| `flip.ts` | Records element positions before a snapshot and plays the settle after it. |
| `useBoardDrag.ts` | Pointer drag for items, open tabs and groups. |
| `InlineEditor.tsx` | The one inline text field: Enter commits, Shift+Enter breaks a line in a multiline field, Esc cancels, blur commits; `maxLength` caps it at the stored field's limit. |
| `ItemMenu`, `GroupSubmenu`, `EntityMenu`, `TabMenu` (in `TabsDrawer.tsx`) | The keyboard menus (below). |
| `AddGroup.tsx` | The "+ Group" button that becomes a name field; used by the board's trailing column and by the empty space. |
| `LoadFailed.tsx` | The notice for a failed load (below). |
| `SpacesList`, `BoardColumn`, `ItemRow`, `TabsDrawer`, `SearchResults`, `EmptySpace`, `UndoToasts` | The parts of the screen. |

### Transient state

Local to the view: the search text, one `editing` target (a space or group name, an item, an
add row, "+ Space", "+ Group"), the drawer, one pending confirmation, the undo toasts and the
waiting follow-ups. A show resets all of it (and puts the focus in the search field only when
chrome allows, below); a hide also drops an unfinished edit and the toasts. The selected space
is not local: `bookmarks/space/select` records `lastSpaceId` in tools, and the view shows
`lastSpaceId`, else the first space.

### Show and hide events

Chrome dispatches `bento-bookmarks-show` with `detail: { focus: boolean }`: `focus: false`
when something above the view (a prompt, another overlay) holds the focus. `showMayFocus`
reads it (an event with no usable detail, as a story or a test sends, may focus; chrome's frame
script also sends the event without a detail, and logs why, if it cannot build one), `useVisibilityTokens`
returns it as `focusOnOpen` together with the show and hide counters, and `BookmarksView` takes
it as `focusSearchOnOpen`: the show still resets the view, but the search field takes the focus
only when it is true.

### Load failure

`snapshot.status === 'loadFailed'` renders `LoadFailed` instead of the frame: "Bookmarks couldn't
load", a Retry button and Back to browser. Tools refuses every change and writes nothing in that
state, so an editable board would look like it saves and not. Retry sends `bookmarks/requestSnapshot`,
which makes tools read the storage again; the button reads "Retrying" until the next snapshot,
which either replaces the notice or is a new failed one. Esc still closes the view.

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
a hover action behave as before. A drag that crosses the threshold arms the click suppressor, which
`isSuppressed` reads; see "Cancelled drags" below.

While a drag is active, a `requestAnimationFrame` loop draws everything imperatively: a clone
of the row follows the pointer, a one-pixel insertion line is placed from the measured column
boxes (`drop.ts`), and the board autoscrolls near its edges. React renders nothing per move,
and the line is positioned over the board, so rows never reflow while the pointer moves. The
move commits on release. Esc, window blur, and a hide cancel without a commit.

Targets: an item or tab goes into any column at a slot, or onto the empty-space zone; a group
goes between columns of the same space. A drop that would leave the order unchanged sends
nothing (`isItemMoveNoop`, `isGroupMoveNoop`). A tab dropped at a slot is one `tabs/save` with
`beforeId` and a client id, not a save followed by a move.

### Cancelled drags

A Mux `Button` does not activate on the pointer release. React Aria's `usePress` waits for the
click that follows and calls `onPress` from it; when that click never reaches its capture
listener, it clicks the button itself 80 ms later. So the click is never swallowed (the earlier
`stopPropagation` on it made that late click, which opened the link after a drop onto the
source's own place), and the controls ask the suppressor instead: `ItemRow` checks
`isSuppressed()` in `onActivate`. `clickSuppressor.ts` is armed when the drag starts, with the
button still down, and stays armed whatever ends the drag. Esc, a lost window focus and a drop
all leave it on through the release of that pointer (`pointerup` or `pointercancel` with its id)
and a `RELEASE_GRACE_MS` (120 ms) after it, which covers the click and the fallback click. A
new `pointerdown`, the window `blur`, `cancel()` (a show or hide) and unmount end it at once. Each
gesture has a generation, and the release callback is bound to it: the timer of a drop that is
still running when the next drag starts (inside the 120 ms) does nothing, so it cannot disarm the
drag that is going on.

Reorder settle: `recordFlip` stores the rects of `[data-bm-flip]` elements (the dragged row's
start comes from the ghost) before the action goes out, and `playFlip` runs in a layout effect
when the next snapshot arrives. It sets `data-bm-flipping`, whose transition is the `reveal`
role on `transform`, and clears it with `afterMotion({ properties: ['transform'] })`. It does
nothing under reduced motion and ends an unfinished settle before starting another.

### Follow-ups for created items

The view never works out what it created from a snapshot diff. Every create carries a client id
(`actions.ts`: `spaceCreate`, `groupCreate`, `itemCreate`, `tabsSave`, all `crypto.randomUUID()`;
tools refuses an id that exists), and a follow-up is a `{ ready(snapshot), run() }` pair in a
ref list that waits for that id (`followups.ts`, `settleFollowups` in an effect on the snapshot):

- creating a space selects it once its id is in a snapshot (`bookmarks/space/select`);
- a new group, a new row and the first saved tab (`tabs/save` takes `ids`, one per `tabIds`
  entry) are scrolled into view; creating the first group of an empty space by keyboard
  also focuses the new column's "Link, note or to-do" button, because the empty space's
  "Group" button is gone by then;
- a tab drop is one `tabs/save` with `beforeId` and `ids`; there is no follow-up move, so the
  row never shows at the end first;
- undo of a delete is one `item/create` with the item's own id and `done` for a to-do;
- a keyboard move (below) waits for `itemPlacedAt` / `groupPlacedAt` and then focuses the
  moved row's or column's menu trigger.

A change another window or an import makes never matches an id the view generated, and
a follow-up whose action was refused simply never fires. Show and hide clear the list.

### Keyboard alternatives to dragging

Each pointer drag has a menu built from public Mux `Menu` parts, reached by Tab (the row
actions and the column menu show on `:focus-within`, and stay while their menu is open through
`:has([aria-expanded='true'], [data-muxui-state-open])`):

| Surface | Menu | Action sent |
| --- | --- | --- |
| Open tab in the drawer (`TabMenu`, "Save <title>") | Save to group: a submenu of the current space's groups, then "New group" | `tabs/save` at the end of the group (or `groupId: null`) |
| Item row (`ItemMenu`, a "Move" trigger among the hover actions) | Move to group (the other groups), Move up, Move down | `item/move` with `beforeId` from `neighbourMoves` |
| Column header (`EntityMenu`, `move`) | Move left, Move right | `group/move` with `beforeId` from `neighbourMoves` |

A direction that is not possible (the first row up, the last column right) is a disabled item,
and Mux skips disabled items when arrowing. `GroupSubmenu` shows a disabled item instead of an empty
submenu when there is no other group. The groups handed to the menus are `groupChoices`, kept
reference-stable by `stableChoices` so memoized rows and columns do not re-render on every
snapshot. After a move the view records a FLIP like a drag does, and the follow-up refocuses the
moved element, which is a new DOM node when it changed column.

### Inline editors

Every editor caps its field with `maxLength` from `BOOKMARK_LIMITS` (names 1,024, link title
4,096, note and to-do text 32,768) and the link address with `MAX_URL_LENGTH`, so a value the
editor accepts is one tools stores and undo can send back.

`EditHandler` is `onEdit(target | null, returnFocus?)`. An editor that ends by Enter or Esc closes
with `returnFocus: true`: the view remembers which editor closed and, in a layout effect once it is
gone, focuses `editReturnSelector(target)`: the row's first control, a column's "..." trigger, the
space's button, the "Link, note or to-do", "+ Group" or "+ Space" button. An editor that ends because
it lost focus (the user clicked or tabbed elsewhere) passes nothing and the focus stays
where the user put it. The Enter that adds an item keeps the entry open, so the focus stays there.

## Undo toasts

Deleting an item removes it at once and offers Undo for 6 s (`UNDO_TOAST_MS`). Undo is one
`bookmarks/item/create` from `itemRestore`: the item's fields in its old slot (before the
sibling that followed it), a to-do with its `done`, and the item's own id (it no longer exists), so
a second Undo is refused and cannot make a copy. It gets a new creation time. A keyboard Undo
refocuses the restored row, because the button that had the focus is gone. The toasts are the
Bento composite `UndoToasts` on Mux `Button`, `IconButton` and `Text`, not Mux `Toast`: Mux Toast
added about 7 KB gzip to the cold start of every overlay document. The countdown is
`createDismissTimer`: the pointer over the toast and the focus inside it are separate holds, and the
countdown restarts in full only when neither holds. A toast leaves through `afterMotion` on the
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
8. Keyboard only: Tab to a row (its actions show), open its Move menu with Enter, pick Move down
   and Move to group; the focus stays on the moved row's Move button. Open an open tab's menu in
   the drawer and Save to group; open a column's "..." menu and Move left and Move right.
9. Drag a row, press Esc while holding the button, then release over the same row: the link must
   not open. Do the same by dropping a row onto its own place.
10. Rename a group with Enter, and with Esc: the focus returns to its "..." button. Start an
    edit and click the search field: the field keeps the focus.
11. Delete a to-do that is ticked and Undo: it returns ticked in its place. Tab to Undo and
    wait 10 s: the toast stays until the focus leaves it.
12. In a space with no groups, click "Group", type a name and press Enter.
13. With a prompt or another overlay holding the focus, open the view: the search field does not
    take it.

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
- Never `stopPropagation` the click that follows a drag. React Aria fires `onPress` from that
  click, and when it does not see one it clicks the target itself 80 ms later, after the
  suppression has ended (see "Cancelled drags").
- Find what a create made by its client id, never by diffing the snapshot (the earlier pending
  create took any new item in the group, so a concurrent create or an import was mistaken for the
  follow-up's own item, and an undo could tick or move an unrelated row).
- The hover-action text mask belongs to rows that say they have actions (`data-bm-actions`); a
  search result row has none, so its title is not faded under buttons that do not exist.
- A row's actions are hidden until hover or focus inside the row. An open menu moves the focus
  into its popup, so the actions (and the mask) also stay while `:has([aria-expanded='true'])`
  matches, or the trigger would vanish under its own menu.
- Reordering rows in the DOM drops the focus from the moved element; a keyboard move refocuses it
  once the snapshot shows it placed.
