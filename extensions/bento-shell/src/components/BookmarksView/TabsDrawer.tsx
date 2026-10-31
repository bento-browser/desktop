// The right drawer: the open tabs of the window's active workspace. Each row is a drag source for
// a column; "Save all to new group" saves every tab into a group of its own. Presentational: the
// view owns whether it is open (it plays its own enter and exit), the tabs and the drag.

import { forwardRef, memo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Button, IconButton, Text } from '@muxui/react';
import X from 'lucide-react/dist/esm/icons/x';

import { BentoIcon } from '../primitives';
import { Favicon } from './ItemRow';
import { hostnameOf } from './model';
import type { OpenTab } from './types';
import type { DragSource } from './useBoardDrag';

export interface TabsDrawerProps {
  tabs: readonly OpenTab[];
  exiting: boolean;
  /** The tab being dragged, if any, so its row can dim. */
  draggingTabId: number | null;
  onClose: () => void;
  onSaveAll: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, source: DragSource) => void;
}

const TabRow = memo(function TabRow({
  tab,
  dragging,
  onPointerDown,
}: {
  tab: OpenTab;
  dragging: boolean;
  onPointerDown: TabsDrawerProps['onPointerDown'];
}) {
  return (
    <li
      className="bento-bookmarks__row bento-bookmarks__tab"
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
    </li>
  );
});

export const TabsDrawer = forwardRef<HTMLElement, TabsDrawerProps>(function TabsDrawer(
  { tabs, exiting, draggingTabId, onClose, onSaveAll, onPointerDown },
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
