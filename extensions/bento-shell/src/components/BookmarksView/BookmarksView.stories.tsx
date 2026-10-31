// Bookmarks view stories: the states of the chosen layout (default, editing, empty space, narrow
// window with the drawer over the boards), plus search, long text, many columns, a failed load and
// the keyboard menus (a row's Move, an open tab's Save to group, a column's Move left and right,
// each opened as it appears). Each story edits a local copy of its fixture through
// `useFakeBookmarks`, so reordering, deleting (with the undo toast), adding and dropping a tab
// from the drawer all work. Switch Ladle's theme toggle for dark and light. Nothing here reaches
// the tools port.

import { useState } from 'react';
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

/** a. The default: a space with four groups, rows with hover actions, the drawer closed. */
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

// ---- The keyboard menus, open -----------------------------------------------------------

const GROUPS = groupChoices(buildBoard(SAMPLE_SNAPSHOT).groups);

function MenuFrame({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', width: 320, padding: 16 }}>
      {children}
    </div>
  );
}

/** A row's Move menu: Move to group (a submenu of the other groups), Move up, Move down. */
export const RowMoveMenu = () => (
  <MenuFrame>
    <ItemMenu
      defaultOpen
      groups={GROUPS}
      groupId={GROUPS[1]!.id}
      moveUpBefore="item-before"
      moveDownBefore={null}
      onMove={() => {}}
    />
  </MenuFrame>
);

/** The first row of a group cannot move up. */
export const RowMoveMenuFirstRow = () => (
  <MenuFrame>
    <ItemMenu
      defaultOpen
      groups={GROUPS}
      groupId={GROUPS[0]!.id}
      moveUpBefore={undefined}
      moveDownBefore="item-after"
      onMove={() => {}}
    />
  </MenuFrame>
);

/** An open tab's menu: Save to group lists the space's groups and a New group. */
export const TabSaveMenu = () => (
  <MenuFrame>
    <TabMenu defaultOpen label="Moon Board" groups={GROUPS} onSave={() => {}} />
  </MenuFrame>
);

/** A column's menu with Move left and Move right. */
export const ColumnMenu = () => {
  const [open, setOpen] = useState(true);
  return (
    <MenuFrame>
      <EntityMenu
        label="Actions for Gyms"
        deleteLabel="Delete group"
        color="green"
        open={open}
        onOpenChange={setOpen}
        openAll={{ count: 5, onOpenAll: () => {} }}
        move={{ left: () => {}, right: undefined }}
        onRename={() => {}}
        onColor={() => {}}
        onDelete={() => {}}
      />
    </MenuFrame>
  );
};
