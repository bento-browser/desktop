// Bookmarks view stories: the states of the chosen layout (default, editing, empty space, narrow
// window with the drawer over the boards), plus search, long text, many columns, a failed load, rows
// whose "More actions" trigger has the focus (a link, a long title, a short note and to-do: the
// text beside the trigger stays readable), the keyboard menus (a row's More actions, an open
// tab's Save to group, a column's Move left and right, each opened as it appears; a row shows the
// same trigger on hover) and the right-click menus (a link, a note, a to-do, a group header, a
// space, an open tab and the board, each opened by a `contextmenu` event on the element, so the
// view's routing runs). Each story edits a local copy of its fixture through
// `useFakeBookmarks`, so reordering, deleting (with the undo toast), adding and dropping a tab
// from the drawer all work. Switch Ladle's theme toggle for dark and light. Nothing here reaches
// the tools port.

import { useEffect, useRef } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import {
  EMPTY_SPACE_SNAPSHOT,
  LOAD_FAILED_SNAPSHOT,
  MANY_SNAPSHOT,
  SAMPLE_SNAPSHOT,
  SAMPLE_TABS,
  useFakeBookmarks,
} from '../../state/__fixtures__/bookmarks';
import type { BookmarksSnapshot } from '@shared/protocol';
import BookmarksView from './BookmarksView';
import { EntityMenu } from './EntityMenu';
import { ItemMenu } from './ItemMenu';
import { groupSelector, itemMenuSelector, itemSelector } from './focus';
import {
  groupEntries,
  itemEntries,
  tabEntries,
  type GroupHandlers,
  type ItemHandlers,
} from './menuEntries';
import { buildBoard, groupChoices } from './model';
import { TabMenu } from './TabsDrawer';

/** A story has no host to hide it; a close request is counted on <body>. */
const onClose = () => {
  document.body.dataset.closeRequests = String(
    Number(document.body.dataset.closeRequests ?? 0) + 1,
  );
};

function Frame({ width, children }: { width: number; children: ReactNode }) {
  return <div style={{ width, height: 760, position: 'relative' }}>{children}</div>;
}

function Story({
  snapshot = SAMPLE_SNAPSHOT,
  width = 1440,
  ...rest
}: {
  snapshot?: BookmarksSnapshot;
  width?: number;
} & Partial<ComponentProps<typeof BookmarksView>>) {
  const fake = useFakeBookmarks(snapshot);
  return (
    <Frame width={width}>
      <BookmarksView
        snapshot={fake.snapshot}
        openTabs={SAMPLE_TABS}
        send={fake.send}
        onClose={onClose}
        {...rest}
      />
    </Frame>
  );
}

/** a. The default: a space with four groups, rows with a hover "More actions" trigger, the
 * drawer closed. */
export const Default = () => <Story />;

/** The drawer open beside the boards. Drag a tab into a column. */
export const DrawerOpen = () => <Story initialDrawerOpen />;

/** b. Inline editing: a note being edited and the entry of the first column. */
export const Editing = () => {
  const note = SAMPLE_SNAPSHOT.items.find((item) => item.kind === 'note');
  return (
    <Story
      initialDrawerOpen
      initialEditing={note ? { kind: 'item', id: note.id } : { kind: 'add-group' }}
    />
  );
};

export const AddingAnItem = () => (
  <Story initialEditing={{ kind: 'add-item', groupId: 'group-gyms' }} />
);

/** The first group of a space: the name field replaces the "Group" button. */
export const EmptySpaceAddingGroup = () => (
  <Story snapshot={EMPTY_SPACE_SNAPSHOT} initialEditing={{ kind: 'add-group' }} />
);

/** c. A space with no groups: the drop zone, first steps and the Firefox import offer. */
export const EmptySpace = () => <Story snapshot={EMPTY_SPACE_SNAPSHOT} initialDrawerOpen />;

/** d. A narrow window: the spaces fold to dots and the drawer covers the boards. */
export const Narrow = () => <Story width={1000} initialDrawerOpen />;

export const NarrowClosedDrawer = () => <Story width={1000} />;

/** A search across every space, results grouped by space and group. */
export const Searching = () => <Story initialQuery="gear" />;

export const NoResults = () => <Story initialQuery="zzzz" />;

/** Nine columns of growing length: the boards scroll sideways and each column scrolls. */
export const ManyColumns = () => <Story snapshot={MANY_SNAPSHOT} initialDrawerOpen />;

/** Before tools has sent the first snapshot. */
export const Loading = () => (
  <Frame width={1440}>
    <BookmarksView snapshot={null} openTabs={[]} send={() => {}} onClose={onClose} />
  </Frame>
);

/** Tools could not read the stored bookmarks: a notice instead of an editable board. Retry asks
 * again; the fake finds nothing stored and seeds the first space. */
export const LoadFailed = () => <Story snapshot={LOAD_FAILED_SNAPSHOT} />;

// ---- Rows whose "More actions" trigger has the focus --------------------------------------

/** Short texts in the Gyms column: the row text must stay visible beside the focused trigger. */
const SHORT_TEXT_SNAPSHOT: BookmarksSnapshot = {
  ...SAMPLE_SNAPSHOT,
  items: [
    ...SAMPLE_SNAPSHOT.items,
    {
      id: 'item-short-note',
      groupId: 'group-gyms',
      order: 100,
      createdAt: 1_700_000_100_000,
      kind: 'note',
      text: 'hello edited',
    },
    {
      id: 'item-short-todo',
      groupId: 'group-gyms',
      order: 101,
      createdAt: 1_700_000_100_001,
      kind: 'todo',
      text: 'Call gym',
      done: false,
    },
  ],
};

const itemIdOf = (match: (item: BookmarksSnapshot['items'][number]) => boolean) =>
  SHORT_TEXT_SNAPSHOT.items.find(match)!.id;

/** Puts the focus on a row's trigger as Tab does, which shows the row's action and its mask. */
function FocusedRow({ itemId }: { itemId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(itemMenuSelector(itemId))?.focus();
  }, [itemId]);
  return (
    <div ref={ref}>
      <Story snapshot={SHORT_TEXT_SNAPSHOT} />
    </div>
  );
}

/** A link row with its trigger focused: the title is faded only at the trigger. */
export const RowFocused = () => (
  <FocusedRow
    itemId={itemIdOf((item) => item.kind === 'link' && item.title === 'Northside Boulders')}
  />
);

/** A long title keeps its leading text and fades out at the trigger. */
export const LongTitleFocused = () => (
  <FocusedRow
    itemId={itemIdOf((item) => item.kind === 'link' && item.title.startsWith('The complete'))}
  />
);

/** A short note with its trigger focused is still readable. */
export const ShortNoteFocused = () => (
  <FocusedRow itemId={itemIdOf((item) => item.kind === 'note' && item.text === 'hello edited')} />
);

export const ShortTodoFocused = () => (
  <FocusedRow itemId={itemIdOf((item) => item.kind === 'todo' && item.text === 'Call gym')} />
);

// ---- The keyboard menus, open -----------------------------------------------------------

const BOARD = buildBoard(SAMPLE_SNAPSHOT);
const GROUPS = groupChoices(BOARD.groups);
const GYMS = BOARD.groups.find((entry) => entry.group.id === 'group-gyms')!;

const NOTHING = () => {};
const ITEM_HANDLERS: ItemHandlers = {
  send: NOTHING,
  onEdit: NOTHING,
  onOpen: NOTHING,
  onCopy: NOTHING,
  onDelete: NOTHING,
  onMove: NOTHING,
};
const GROUP_HANDLERS: GroupHandlers = {
  send: NOTHING,
  onEdit: NOTHING,
  onMoveGroup: NOTHING,
  onOpenAll: NOTHING,
  onDeleteGroup: NOTHING,
};

function MenuFrame({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', width: 320, padding: 16 }}>
      {children}
    </div>
  );
}

const itemOf = (match: (item: BookmarksSnapshot['items'][number]) => boolean) =>
  SAMPLE_SNAPSHOT.items.find(match)!;
const LINK = itemOf((item) => item.kind === 'link' && item.title === 'Northside Boulders');
const NOTE = itemOf((item) => item.kind === 'note');
const TODO = itemOf((item) => item.kind === 'todo' && !item.done);

/** A link row's More actions menu: Open in panel, Open in new tab, Copy link, Edit, Move (a
 * submenu with Move to group, Move up and Move down) and Delete. The right-click menu is the same
 * list. */
export const RowMenu = () => (
  <MenuFrame>
    <ItemMenu
      defaultOpen
      entries={itemEntries(
        LINK,
        { groups: GROUPS, moveUpBefore: 'item-before', moveDownBefore: null },
        ITEM_HANDLERS,
      )}
    />
  </MenuFrame>
);

/** A note has no link items; the first row of a group cannot move up. */
export const RowMenuNoteFirstRow = () => (
  <MenuFrame>
    <ItemMenu
      defaultOpen
      entries={itemEntries(
        NOTE,
        { groups: GROUPS, moveUpBefore: undefined, moveDownBefore: 'item-after' },
        ITEM_HANDLERS,
      )}
    />
  </MenuFrame>
);

/** A to-do adds Mark done (Mark not done once it is ticked). */
export const RowMenuTodo = () => (
  <MenuFrame>
    <ItemMenu
      defaultOpen
      entries={itemEntries(
        TODO,
        { groups: GROUPS, moveUpBefore: 'item-before', moveDownBefore: 'item-after' },
        ITEM_HANDLERS,
      )}
    />
  </MenuFrame>
);

/** An open tab's menu: Save to group lists the space's groups and a New group. */
export const TabSaveMenu = () => (
  <MenuFrame>
    <TabMenu
      defaultOpen
      label="Moon Board"
      entries={tabEntries(SAMPLE_TABS[0]!, GROUPS, NOTHING)}
    />
  </MenuFrame>
);

/** A column's menu with Open all, Rename, Colour, Move left and Move right. */
export const ColumnMenu = () => (
  <MenuFrame>
    <EntityMenu
      defaultOpen
      label="Actions for Gyms"
      entries={groupEntries(
        GYMS.group,
        GYMS.items,
        { moveLeftBefore: 'group-before', moveRightBefore: undefined },
        GROUP_HANDLERS,
      )}
    />
  </MenuFrame>
);

// ---- The right-click menus, open ----------------------------------------------------------

/** Right-clicks the first element matching `selector` once the view has rendered, as a pointer
 * would: the view's own routing decides what opens. `at` is the point inside the element. */
function RightClick({
  selector,
  at,
  children,
}: {
  selector: string;
  at?: { x: number; y: number };
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const target = ref.current?.querySelector(selector);
    if (!target) return;
    const box = target.getBoundingClientRect();
    target.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: box.left + (at?.x ?? box.width / 2),
        clientY: box.top + (at?.y ?? box.height / 2),
      }),
    );
  }, [selector, at?.x, at?.y]);
  return <div ref={ref}>{children}</div>;
}

/** A link: Open in panel, Open in new tab, Copy link, Edit, Move and Delete. */
export const ContextMenuLink = () => (
  <RightClick selector={itemSelector(LINK.id)} at={{ x: 60, y: 14 }}>
    <Story />
  </RightClick>
);

/** A note: Edit, Move and Delete. */
export const ContextMenuNote = () => (
  <RightClick selector={itemSelector(NOTE.id)} at={{ x: 60, y: 14 }}>
    <Story />
  </RightClick>
);

/** A to-do: Edit, Mark done, Move and Delete. */
export const ContextMenuTodo = () => (
  <RightClick selector={itemSelector(TODO.id)} at={{ x: 120, y: 14 }}>
    <Story />
  </RightClick>
);

/** A column header: Open all in panels, Rename, Colour, Move left and right, Delete group. */
export const ContextMenuGroup = () => (
  <RightClick
    selector={`${groupSelector('group-gyms')} [data-bm-group-header]`}
    at={{ x: 90, y: 14 }}
  >
    <Story />
  </RightClick>
);

/** A space in the list: Rename, Colour and Delete space. */
export const ContextMenuSpace = () => (
  <RightClick selector="[data-bm-space-id='space-trip']" at={{ x: 60, y: 14 }}>
    <Story />
  </RightClick>
);

/** An open tab in the drawer: Save to group, with the groups and a New group. */
export const ContextMenuTab = () => (
  <RightClick selector="[data-bm-tab-id]" at={{ x: 60, y: 14 }}>
    <Story initialDrawerOpen />
  </RightClick>
);

/** The board background: New group, and Save all open tabs to new group while tabs are open. */
export const ContextMenuBoard = () => (
  <RightClick selector="[data-bm-board]" at={{ x: 1000, y: 300 }}>
    <Story />
  </RightClick>
);

/** An empty space is a board too. */
export const ContextMenuEmptySpace = () => (
  <RightClick selector="[data-bm-board]" at={{ x: 500, y: 180 }}>
    <Story snapshot={EMPTY_SPACE_SNAPSHOT} />
  </RightClick>
);

// ---- The Back button ----------------------------------------------------------------------

/** "Back to browser" beside its arrow, in a window wide enough for the full spaces column. */
export const BackToBrowser = () => <Story />;

/** Below 1200 px the spaces fold and the Back button keeps only its arrow; its accessible name
 * and tooltip stay "Back to browser". */
export const BackToBrowserCompact = () => <Story width={1000} />;
