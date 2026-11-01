// The right drawer: the open tabs of the window's active workspace. Each row is a drag source for
// a column and has a menu (reached by Tab) with "Save to group" for the keyboard; "Save all to new
// group" saves every tab into a group of its own. Presentational: the view owns whether it is
// open (it plays its own enter and exit), the tabs and the drag.

import { forwardRef, memo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Button, IconButton, Menu, Text } from '@muxui/react';
import Ellipsis from 'lucide-react/dist/esm/icons/ellipsis';
import X from 'lucide-react/dist/esm/icons/x';

import { BentoIcon } from '../primitives';
import { Favicon } from './ItemRow';
import { EntryList } from './EntryList';
import { tabEntries, type MenuEntry, type SaveTab } from './menuEntries';
import { hostnameOf } from './model';
import type { GroupChoice, OpenTab } from './types';
import type { DragSource } from './useBoardDrag';

export interface TabsDrawerProps {
  tabs: readonly OpenTab[];
  exiting: boolean;
  /** The tab being dragged, if any, so its row can dim. */
  draggingTabId: number | null;
  /** The groups of the current space, for "Save to group". */
  groups: readonly GroupChoice[];
  onClose: () => void;
  onSaveAll: () => void;
  /** Saves one tab at the end of `groupId`, or into a new group when null. */
  onSaveTab: SaveTab;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, source: DragSource) => void;
}

/** The "..." menu of an open tab: the keyboard route to dropping it into a column. Its items are
 * `tabEntries`, the same list the right-click menu shows. */
export function TabMenu({
  label,
  entries,
  defaultOpen,
}: {
  /** The tab's title, to name the trigger: "Save Moon Board". */
  label: string;
  entries: readonly MenuEntry[];
  defaultOpen?: boolean;
}) {
  return (
    <Menu.Root defaultOpen={defaultOpen}>
      <Menu.Trigger
        className="bento-bookmarks__more"
        aria-label={`Save ${label}`}
        title="Save to group"
        data-bm-no-drag
      >
        <BentoIcon icon={Ellipsis} size="sm" />
      </Menu.Trigger>
      <Menu.Popup placement="bottom-end" offset={4}>
        <Menu.List aria-label={`Save ${label}`}>
          <EntryList entries={entries} />
        </Menu.List>
      </Menu.Popup>
    </Menu.Root>
  );
}

const TabRow = memo(function TabRow({
  tab,
  dragging,
  groups,
  onSaveTab,
  onPointerDown,
}: {
  tab: OpenTab;
  dragging: boolean;
  groups: readonly GroupChoice[];
  onSaveTab: TabsDrawerProps['onSaveTab'];
  onPointerDown: TabsDrawerProps['onPointerDown'];
}) {
  return (
    <li
      className="bento-bookmarks__row bento-bookmarks__tab"
      data-bm-actions="1"
      data-bm-tab-id={tab.id}
      data-dragging={dragging ? 'true' : undefined}
      title={tab.url}
      onPointerDownCapture={(event) => onPointerDown(event, { kind: 'tab', id: tab.id })}
    >
      <Favicon src={tab.favIconUrl} />
      <span className="bento-bookmarks__row-text">
        <Text variant="body" size="sm" truncate>
          {tab.title || hostnameOf(tab.url)}
        </Text>
        <Text variant="body" size="xs" color="muted" truncate>
          {hostnameOf(tab.url)}
        </Text>
      </span>
      <div className="bento-bookmarks__row-actions" data-bm-no-drag>
        <TabMenu
          label={tab.title || hostnameOf(tab.url)}
          entries={tabEntries(tab, groups, onSaveTab)}
        />
      </div>
    </li>
  );
});

export const TabsDrawer = forwardRef<HTMLElement, TabsDrawerProps>(function TabsDrawer(
  { tabs, exiting, draggingTabId, groups, onClose, onSaveAll, onSaveTab, onPointerDown },
  ref,
) {
  return (
    <aside
      ref={ref}
      className="bento-bookmarks__drawer"
      aria-label="Open tabs"
      data-exiting={exiting ? 'true' : undefined}
      inert={exiting}
    >
      <header className="bento-bookmarks__drawer-head">
        <Text variant="label" size="sm">
          Open tabs
        </Text>
        <Text variant="body" size="sm" color="muted" className="bento-bookmarks__count">
          {tabs.length}
        </Text>
        <IconButton
          variant="ghost"
          size="sm"
          className="bento-bookmarks__drawer-close"
          aria-label="Close open tabs"
          onActivate={onClose}
        >
          <BentoIcon icon={X} size="sm" />
        </IconButton>
      </header>
      {tabs.length > 0 ? (
        <ul className="bento-bookmarks__drawer-list">
          {tabs.map((tab) => (
            <TabRow
              key={tab.id}
              tab={tab}
              dragging={draggingTabId === tab.id}
              groups={groups}
              onSaveTab={onSaveTab}
              onPointerDown={onPointerDown}
            />
          ))}
        </ul>
      ) : (
        <Text variant="body" size="sm" color="muted" className="bento-bookmarks__drawer-empty">
          No tabs to save in this workspace.
        </Text>
      )}
      <footer className="bento-bookmarks__drawer-foot">
        <Button
          variant="ghost"
          size="sm"
          className="bento-bookmarks__add"
          disabled={tabs.length === 0}
          onActivate={onSaveAll}
        >
          Save all to new group
        </Button>
      </footer>
    </aside>
  );
});
