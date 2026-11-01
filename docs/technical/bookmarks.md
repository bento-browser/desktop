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
- **The opt-out.** The Bookmarks manager can be turned off in Settings
  ([Turning the manager off](#turning-the-manager-off)). The store, its snapshots and the
  `bookmarks/*` actions are not affected by it.

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
`var(--bento-brand-bg)` (neutral-5), set by a rule keyed on `html[data-bento-document='bookmarks']`
so it wins over the shared document rule: the view is one surface with the toolbar strip that
stays visible above it. That page colour and the floating layers (menus, the save popover, the
confirmation dialog, undo toasts, the drag ghost, and the open tabs drawer while it overlays the
boards in the narrow layout) are the only opaque neutral fills. Every neutral fill that sits on the
page, in the view, the save popover's form and the toolbar, is a translucent `color-mix` tint, so
nothing paints a solid patch on it (the rule and the tokens are under "Bookmarks view" in
[../mux-ui-component-customisations.md](../mux-ui-component-customisations.md#bookmarks-view)).

The top-left button reads "Back to browser" beside a left chevron and leaves the view. Below the
narrow-width breakpoint the stylesheet hides the label and the button keeps only the chevron; its
`aria-label` and `title` stay "Back to browser" at every width.

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
| `focusWhenReady.ts` | `useFocusWhenReady`: the editors' replacement for `autoFocus`, which waits out the inert page a closing menu leaves (below). |
| `clickSuppressor.ts` | Keeps a drag from activating its source, through the release (below). |
| `dismissTimer.ts` | The undo toast's countdown with separate pointer and focus holds. |
| `flip.ts` | Records element positions before a snapshot and plays the settle after it. |
| `useBoardDrag.ts` | Pointer drag for items, open tabs and groups. |
| `InlineEditor.tsx` | The one inline text field: Enter commits, Shift+Enter breaks a line in a multiline field, Esc cancels, blur commits; `maxLength` caps it at the stored field's limit. |
| `menuEntries.ts` | What every menu offers, as data: `itemEntries`, `groupEntries`, `spaceEntries`, `tabEntries`, `boardEntries` (below). Pure. |
| `EntryList.tsx` | Draws a `MenuEntry` list with the public Mux `Menu` parts. |
| `ItemMenu`, `EntityMenu`, `TabMenu` (in `TabsDrawer.tsx`) | The trigger and popup of the row, column or space, and open-tab menus; their items are `menuEntries.ts` lists. |
| `contextMenuModel.ts`, `ContextMenu.tsx` | The right-click menu: which element a click or key press is about, whether the native menu stays, and the Mux menu opened at a point (below). `contextMenuModel.ts` is pure. |
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
one thing: an open inline editor cancels, else a Mux menu (a "More actions" menu or the right-click
menu) closes (it consumes its own Esc),
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
trigger and the column menu show on `:focus-within`, and stay while their menu is open through
`:has([aria-expanded='true'], [data-muxui-state-open])`):

| Surface | Menu | Action sent |
| --- | --- | --- |
| Open tab in the drawer (`TabMenu`, "Save <title>") | Save to group: a submenu of the current space's groups, then "New group" | `tabs/save` at the end of the group (or `groupId: null`) |
| Item row (`ItemMenu`, the "More actions" trigger) | Move, a submenu of Move to group (the other groups), Move up and Move down | `item/move` with `beforeId` from `neighbourMoves` |
| Column header (`EntityMenu`) | Move left, Move right | `group/move` with `beforeId` from `neighbourMoves` |

### Row actions

A row has one hover action, the "More actions" trigger (`ItemMenu`, an ellipsis, `data-bm-item-menu`). Its
menu is `itemEntries`: for a link Open in panel, Open in new tab and Copy link, then Edit, for a to-do
Mark done (Mark not done once ticked), Move (the submenu above) and Delete (after a separator). The
right-click menu on a row shows the same list. There is no separate Open in panel button: the row's own
button opens a link in a panel (Mux `Button`, so Enter and Space open it too), and a note's button starts
its edit. Five direct buttons covered most of a 236 px column, so titles and short notes disappeared
under them; one trigger keeps the text readable.

The trigger sits over the row's right end and paints no background. The text under it is masked
out: the row text, the note text and the to-do text carry a `mask-image` while the row is hovered,
holds the focus or has a menu open, and `data-bm-actions` marks rows that have an action (an item
row or an open tab row; a search result has none, so no mask). The mask is a percentage of the
masked element's own box, so each of those elements fills the row (`flex: 1 1 auto`); the
trigger ends `--bento-bookmarks-actions-inset` (twice the focus ring width) short of the row's
edge so its focus ring is not clipped by the column.

A direction that is not possible (the first row up, the last column right) is a disabled item,
and Mux skips disabled items when arrowing. `GroupSubmenu` shows a disabled item instead of an empty
submenu when there is no other group. The groups handed to the menus are `groupChoices`, kept
reference-stable by `stableChoices` so memoized rows and columns do not re-render on every
snapshot. After a move the view records a FLIP like a drag does, and the follow-up refocuses the
moved element, which is a new DOM node when it changed column.

### Context menus

Firefox's page menu (Bookmark Page, Save Page As, Select All, View Page Source) means nothing in
this view, so every `contextmenu` event in the document is handled by the root (`BookmarksView`;
the failed-load root too). `routeContextMenu` (`contextMenuModel.ts`) walks up from the event target
and decides:

| Target | What happens |
| --- | --- |
| A text field (`textarea`, or an `input` that takes text: the search field, every inline editor) | Nothing is intercepted: the native menu stays for cut, copy, paste and spelling. A checkbox or button input is not a text field. |
| An element with actions: a row (`data-bm-item-id`), an open-tab row (`data-bm-tab-id`), a column (`data-bm-group-id`, header or empty column area), a space (`data-bm-space-id`), the board (`data-bm-board`: the boards strip, or an empty space's box) | `preventDefault`, then the Bento menu opens at the pointer. The nearest mark wins, so a row inside a column is a row. |
| Anything else (the title, the toolbar, search results, the drawer header, the toasts, the open menu itself) | `preventDefault` and nothing opens. |

The menus are the `menuEntries.ts` lists the buttons use, so an action is defined once:

| Element | Items |
| --- | --- |
| Link | Open in panel, Open in new tab, Copy link, Edit, Move (Move to group, Move up, Move down), separator, Delete |
| Note | Edit, Move, separator, Delete |
| To-do | Edit, Mark done or Mark not done, Move, separator, Delete |
| Column (header or empty area) | Open all N in panels (only when it has links), Rename, Colour, Move left, Move right, separator, Delete group |
| Space | Rename, Colour, separator, Delete space |
| Open tab | Save to group (the groups, then New group) |
| Board background | New group, and Save all open tabs to new group while tabs are open |

Delete group and Delete space still ask in the Mux `Dialog`; Delete on a row still offers the undo
toast; Edit, Rename and New group open the same inline editors as their buttons (New group is
`onEdit({ kind: 'add-group' })`, the "+ Group" field), and a keyboard move refocuses the moved
element. "Open all" is left out of a column with no links, in the column's "..." menu too.

The menu is `ContextMenu.tsx`: a public Mux `Menu` with a controlled `open`, no trigger, and a
`Menu.Popup` whose `anchorRef` is an empty absolutely positioned `span` the view places at the
pointer (the recipe in the Mux README: a consumer-owned element at the point). The view fills the
window, so the popup is an in-document popover and the chrome `menu` overlay is not used. It is
modal like the other menus; Esc, a click outside and a choice close it, and the popup returns the
focus to the element that had it when the menu opened. The open menu holds only the target's id:
the items are rebuilt from the current snapshot, so a change shows at once and a target another
window deleted closes the menu. A show or hide closes it.

Keyboard: the Menu key and Shift+F10 on a focused element route like a right-click on it
(`routeContextKey`, a capture-phase `keydown` on the root) and open the menu below that element, so
a row's button, a to-do's checkbox, a column's "..." button or a space's button works; the key's
default is prevented so the native menu does not also open. Copy link calls
`navigator.clipboard.writeText` from the menu item's own click or key press (its user activation).
The shell manifest holds only `storage`; Firefox allows `writeText` during user activation without
`clipboardWrite`, but that is unverified in a built Bento (manual step 14 checks it).

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

An editor a menu opened (Edit on a row, Rename on a column or space) mounts while the closing menu's
popup still makes the rest of the page inert, and `focus()` on an inert field does nothing, which
is all `autoFocus` tries. The editors call `useFocusWhenReady` instead: it focuses at once on an
ordinary page, and otherwise waits for the page to stop being inert plus one frame, so the
menu's own focus return to its trigger does not take the focus back. `Menu.Popup modal={false}`
is not a way out: that menu no longer closes on a click outside it.

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
  `nav:bookmarks`) calls `openBookmarksView()` and is hidden in a private window and while the
  Bookmarks manager is off. There is no
  sidebar footer button: the footer keeps exactly five buttons
  ([sidebar-native-surfaces.md](sidebar-native-surfaces.md#footer-buttons)). `Cmd/Ctrl+Shift+O` is handled by
  chrome ([overlay-documents.md](overlay-documents.md#bookmarks-view)).

## Turning the manager off

`BentoSettings.bookmarksEnabled` (default `true`) is the opt-out. It is an ordinary
persisted Bento setting, so `bento-tools` owns it and every mirror is downstream:

1. **Tools.** `SettingsStore` keeps it in the sparse `bento.settings` overrides (stored only
   while `false`). `_shared/settings-rules.ts` lets the Settings palette write it
   (`settings/update`, boolean only, from a regular or a private window: the setting is
   profile-wide), and `_shared/export-schema.ts` accepts it in a stored patch and a backup
   file. A backup exports it with the other overrides when it is off, an import applies it
   with the rest of the settings, and Reset Bento turns it back on. When it changes,
   `background.ts` re-sends `panels/sync` for every shown workspace, like the other
   chrome-bound settings.
2. **Shell.** `useSettingsStore` mirrors it. `forwardPanelsToChrome` (`bridge/useToolsPort.ts`)
   adds `bookmarksEnabled` to the `BENTO_PANELS` payload. The command palette document reads the
   store and leaves `nav:bookmarks` out while it is `false` (a missing snapshot counts as on).
   The Settings palette row is the "Bookmarks manager" switch in the Workspaces category
   (`settingsCatalog.ts`, `categories.ts`, `rows.ts`, description in `settingsCopy.ts`'s
   `TOGGLE_DESCRIPTIONS`), shown in regular windows only, with a matching entry in the command
   palette's `settingsIndex.ts`.
3. **Chrome.** `handlePanelsTitle` hands the value to `applyChromeBookmarksEnabled`
   ([overlay-documents.md](overlay-documents.md#bookmarks-view)): while it is off
   `showBookmarksView` refuses every path (title routes, the key, the toggle), an open view
   closes, and `Cmd/Ctrl+Shift+O` opens Firefox's Library again.

The Bookmarks document does not react: chrome never shows it while the manager is off, and it
keeps receiving snapshots, so turning the manager on again shows the same spaces, groups and
links. Nothing is deleted or migrated in either direction, and `bookmarks/*` actions are still
served (a window that has the view open for the instant before chrome hears about the change
can still save). A window that has not heard from tools yet assumes the default (on).
- The size ceiling for the document is the overlay target (200 KB gzip cold start):
  `bookmarks` is in that list in `scripts/check-size-budgets.mjs`.

## Saving pages and the bookmarks toolbar

With the manager on, in a regular window, the bookmark star, `Cmd/Ctrl+D` and the bookmarks toolbar
work on the Bento store. Private windows and the opt-out keep Firefox's Places paths unchanged
(the sidebar toggle title, the panel header star's Places toggle, the native toolbar).

- **Source of truth.** The Bento store in `bento-tools`. No new action or stored field: a save is
  `bookmarks/group/create` (only when the target space has no group, "Unsorted", client id) and
  `bookmarks/tabs/save` with a client id; edits are `item/update`, `item/move`, `item/delete`; the
  toolbar's space menu is `bookmarks/space/select`, so it moves the shared `lastSpaceId` (the view and
  every window's toolbar follow).
- **Default target** (`defaultSaveTarget`, `src/bookmarks/links.ts`): in the current space, the group
  of its newest link, else its first group, else a new "Unsorted". A URL matches a link by
  `urlKey` (`new URL(u).href`, fragment kept); the popover edits the newest match.
- **Documents.** Two new shell entries, both reading the store mirror themselves (`initToolsPort()`),
  so chrome passes only ids and anchors, never favicons:
  - `bookmarks-popup` (prewarmed overlay, full-window transparent host): the edit popover (Mux
    `Popover`, Name `TextField`, Space and Group `SelectNative`, Remove, Done) and the group, Spaces
    and overflow menus (Mux `Menu`). Components in `components/BookmarkPopup/`.
  - `bookmarks-toolbar` (persistent frame in `#PersonalToolbar`, the panel trailer pattern): group
    buttons for `lastSpaceId`, the space button, the overflow button and the empty hint. Components
    in `components/BookmarksToolbar/`.
- **Bridges** (contract in `bridge/bookmarkPopup.ts`; chrome side in
  [overlay-documents.md](overlay-documents.md#bookmark-popup-and-toolbar)):
  - Shell to chrome titles: `BENTO_BOOKMARK_POPUP_OPEN:` (sidebar or toolbar frame, frame-local
    anchor), `BENTO_BOOKMARK_POPUP_CLOSE:` (popup frame), `BENTO_OPEN_BOOKMARKS_<ts>` (popup frame,
    Open in Bookmarks), `BENTO_BOOKMARKED_TABS:` (sidebar: the tab ids whose URL is saved, for the
    panel header star).
  - Chrome to documents: `ui/bookmarkPopup/open` on `bento-shell-bus` (document-local, window
    stamped, anchor in host coordinates), and the sidebar-address bus message
    `bookmark-popup-request` for `Cmd/Ctrl+D` and the other `PlacesCommandHook.bookmarkPage` entries.
    The row answers with an `edit` open when its star is laid out; otherwise chrome anchors the
    popover at the active panel after the timeout.
  - Popup to toolbar and sidebar: `opened` and `closed` notices on `bento-bookmark-popup-bus` drive
    the pressed state.
- **Toolbar visibility.** The root attribute `bento-bookmarks-toolbar` swaps Firefox's toolbar
  contents for the Bento frame; `Cmd/Ctrl+Shift+B` and the visibility pref (Bento default
  `never`) are Firefox's own and unchanged. The frame is created the first time the toolbar shows.
- **Toolbar look and motion.** The toolbar is a rounded strip over the panel column, not a row
  under the top bar: its top lines up with the sidebar's workspace switcher, its left and right
  edges with the panels (the panel strip's gutters, in every sidebar mode), its corners use the
  panels' radius and it is one panel gap above them. Showing it grows the strip and shrinks the
  panels' height in one motion (the reveal spring pair) while the sidebar stays still; its buttons
  slide and fade in, and out faster on the dismiss pair on a hide. Reduced motion shows and
  hides at once. The geometry, alignment source, motion and pitfalls are in
  [address-entry.md](address-entry.md#bookmarks-toolbar-strip).
- **Not built.** Dropping links or tabs on the toolbar; address-bar results from the Bento store
  (`AddressSearch.ts` still searches Places).

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
8. Keyboard only: Tab to a row, then Tab again to its "More actions" button and open it with Enter. Edit
   puts the focus in the field (Esc returns it to the row); Open in new tab opens the link; Move
   opens a submenu: pick Move down and Move to group, and the focus stays on the moved row's
   "More actions" button. Open an open tab's menu in the drawer and Save to group; open a column's
   "..." menu and Move left and Move right. Hover a row, a short note and a long title: the text
   stays readable beside the button, and a focused button on a short note hides none of it.
9. Drag a row, press Esc while holding the button, then release over the same row: the link must
   not open. Do the same by dropping a row onto its own place.
10. Rename a group with Enter, and with Esc: the focus returns to its "..." button. Start an
    edit and click the search field: the field keeps the focus.
11. Delete a to-do that is ticked and Undo: it returns ticked in its place. Tab to Undo and
    wait 10 s: the toast stays until the focus leaves it.
12. In a space with no groups, click "Group", type a name and press Enter.
13. With a prompt or another overlay holding the focus, open the view: the search field does not
    take it.
14. Settings, Workspaces, Bookmarks manager Off: "Open Bookmarks" is gone from the command palette,
    `Cmd+Shift+O` opens Firefox's Library, and the sidebar and panels are as before. With the view
    open and Settings opened over it (command palette, Open Settings), turning it Off closes the
    view under Settings with its usual fade and leaves Settings open. Turn it On: the command and
    `Cmd+Shift+O` open the view again, with every space, group and link still there. Repeat in a
    second window: its view closes and its key changes without a restart. Quit and relaunch with
    it Off: the setting and the Library key hold.
15. Right-click a link, a note, a to-do, a column header (and the empty part of a column), a space, an
    open tab in the drawer, and the board background (between and beside the columns, and in an empty
    space). Each opens the menu listed under "Context menus" at the pointer, with no Firefox page menu.
    Copy link puts the address on the clipboard (paste it into the search field); Mark done ticks the
    to-do; New group opens the "+ Group" field; Delete group asks first.
16. Right-click the search field and an open inline editor: the native menu (cut, copy, paste,
    spelling) shows. Right-click the title, the toolbar and the drawer header: nothing shows, and
    no Firefox page menu either.
17. Tab to a row's button, a column's "..." button and a space, press Shift+F10 (or the Menu key):
    the menu opens under it; Esc returns the focus to that element.
18. Resize below about 1200 px: the Back button shows only its chevron, and a screen reader or the
    tooltip still calls it "Back to browser"; wide, it reads "Back to browser".
19. Bento window, regular, manager on: press the sidebar star on a web page. The star fills and the
    popover opens under it with the page title, the current space and its newest link's group.
    Rename and press Enter, change Group, press Done: the view shows the link there.
20. Press `Cmd+D` on a saved page with the page focused, then with the sidebar collapsed: the popover
    opens at the sidebar star, then at the top right of the active panel. Esc after typing a new
    name closes it and keeps the old name. Remove deletes the link and the star empties.
21. In a split layout, the panel header star of each panel fills for saved pages and opens the
    popover at that star.
22. Press `Cmd+Shift+B`: the Bento toolbar shows the current space's groups. Open a group menu, open a
    link, use Open all in panels, switch space from the right menu (the view follows), narrow the
    window until the overflow button appears, and open an empty space for the hint. Watch the
    toggle itself (`Cmd+Shift+B` on and off, with the toolbar set to show in Firefox's bookmarks
    toolbar menu): the strip grows under the top bar while the panels shrink in one motion, the
    buttons slide and fade in, and the sidebar does not move at any frame (watch the workspace
    switcher and the splitter); off is the reverse. At rest the strip's top is level with the
    workspace switcher's, its left and right with the main panel's (with two side panels, with
    none, with the sidebar collapsed to the rail, and hidden), the gap below equals the gap
    between two panels, and its corners follow the panel corner radius setting. With Reduce
    motion on in the system settings, both toggles are instant.
23. Repeat 19 and 22 in a private window and with the manager off: Firefox's star, `Cmd+D` and native
    toolbar work as before.
24. Check that the macOS window buttons stay visible and the window still drags from the top strip
    while the popover and the toolbar menus are open and after they close.

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
- Mux paints several neutral fills as solids that no Bento rule asked for: the unchecked
  `Checkbox` box (raised neutral-10, neutral-98 in dark), a selected `ToggleButton` (neutral-80, and
  neutral-90 under the pointer), and every field (`--muxui-field-bg`, neutral-5; the `SearchField`
  also has a dark-scheme rest fill of its own that ignores that variable). The view overrides each
  (`--muxui-field-bg` on `.bento-bookmarks` and on the save popover, `--muxui-component-checkbox-indicator-background`
  on `.bento-bookmarks__todo-box`, scoped rules for the toggle and the search input) with the
  `--bento-bookmarks-*-fill` tokens. A new Mux control in these components needs the same check:
  read its `background-color` at rest, hovered and pressed, in light and dark, and tint any solid
  neutral. The note bar (`--bento-bookmarks-note-bar-fill`) has a dark weight in `bento-tokens.css`
  because Mux's `border-strong` is neutral-26 in light and a much lighter step in dark.
- A row's actions are one 24 px trigger (small control size) because five buttons covered most of
  a narrow row; do not add direct buttons back. A masked element's `mask-size` percentage is of
  its own box: a note text that shrink-wrapped to 70 px was masked from `100% - 88px`, fully
  invisible with its Edit button focused. Every masked text element fills the row.
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
- A Mux `Menu` is modal: while its popup is open or exiting, the rest of the page is `inert`. An
  editor opened by a menu item (Edit, Rename) could not take the focus then (`autoFocus` tries
  once and fails silently, leaving an unfocused field), and the menu's focus return to its trigger
  would take it a frame later; see `useFocusWhenReady` above.
- The column list clips at its edge (`overflow-x: hidden`), so a trigger flush with the row's end
  has its focus ring cut; the actions are inset by the ring's width and offset.
- Never `preventDefault` a `contextmenu` event whose target is a text field: the native menu is the
  only route to paste and spelling there. `routeContextMenu` checks the target itself, not its
  ancestors, because a row's editor is a text field inside an element that has actions.
- The context menu's anchor is positioned relative to the view root (`position: absolute`, from the
  event's client coordinates minus the root's rect), never `fixed`: the root is a size container, which
  makes it the containing block of fixed descendants, and in a story the view is not at the window's
  origin.
- Two module files whose names differ only in case (`ContextMenu.tsx` and `contextMenu.ts`,
  `MenuEntries.tsx` and `menuEntries.ts`) collide for TypeScript on a case-insensitive disk; the
  pure modules are `menuEntries.ts` and `contextMenuModel.ts`, the components `EntryList.tsx` and
  `ContextMenu.tsx`.
- The shell-action frame script runs in the sidebar frame and calls `content.focus()` for `ui/*`
  actions; it skips `ui/bookmarkPopup/`, or opening the popup would pull the focus back to the
  sidebar. Chrome focuses the popup frame itself, like the menu overlay.
- Every popup close sends `BENTO_BOOKMARK_POPUP_CLOSE`, including after Open in Bookmarks, where
  chrome has already hidden it: chrome drops a close whose `popupId` is not the active one, so it
  never moves the focus twice.
- The save target follows the current space, not the newest link anywhere: after a space switch in
  the toolbar, a save landing in the previous space's group read as lost.
- A chrome hide can land before the popup document accepts the open or mounts (chrome presents the
  host first, and the open message and React's subscription come later), so the popup document
  follows `bento-host-presentation` from startup (`observeHostPresentation`) and `useHostHidden`
  closes at once when the host was hidden after the latest open's show; subscribing only after the
  mount left the star pressed with the popup invisible.
- The edit popover's invisible anchor is a Mux `Button`, which keeps the md control's minimum
  height (36px) even when sized to the 24px star rect, so the popover opened 12px low; the anchor
  overrides `min-block-size`.
