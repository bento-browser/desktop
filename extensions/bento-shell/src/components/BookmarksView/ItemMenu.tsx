// The "Move" menu of a row: the keyboard route to what dragging does. "Move to group" lists the
// other groups of the space (the row goes to the end of the one picked), "Move up" and "Move down"
// reorder within the group. It sits with the row's hover actions, so it is reached by Tab.

import { Menu } from '@muxui/react';
import ArrowUpDown from 'lucide-react/dist/esm/icons/arrow-up-down';

import { BentoIcon } from '../primitives';
import { GroupSubmenu } from './GroupSubmenu';
import type { GroupChoice } from './types';

export interface ItemMenuProps {
  /** The groups of the current space; the row's own is left out. */
  groups: readonly GroupChoice[];
  groupId: string;
  /** The `beforeId` of "Move up": the item above. Undefined: the row is first. */
  moveUpBefore: string | undefined;
  /** The `beforeId` of "Move down": the item after the next one, null for the end. Undefined: the row is last. */
  moveDownBefore: string | null | undefined;
  /** Moves the row into `groupId` before `beforeId`. */
  onMove: (groupId: string, beforeId: string | null) => void;
  defaultOpen?: boolean;
}

export function ItemMenu({
  groups,
  groupId,
  moveUpBefore,
  moveDownBefore,
  onMove,
  defaultOpen,
}: ItemMenuProps) {
  return (
    <Menu.Root defaultOpen={defaultOpen}>
      <Menu.Trigger
        className="bento-bookmarks__more"
        aria-label="Move"
        title="Move"
        data-bm-move-trigger
        data-bm-no-drag
      >
        <BentoIcon icon={ArrowUpDown} size="sm" />
      </Menu.Trigger>
      <Menu.Popup placement="bottom-end" offset={4}>
        <Menu.List aria-label="Move">
          <GroupSubmenu
            id="move-group"
            label="Move to group"
            groups={groups.filter((group) => group.id !== groupId)}
            onPick={(target) => onMove(target, null)}
          />
          <Menu.Item
            id="move-up"
            disabled={moveUpBefore === undefined}
            onAction={() => {
              if (moveUpBefore !== undefined) onMove(groupId, moveUpBefore);
            }}
          >
            Move up
          </Menu.Item>
          <Menu.Item
            id="move-down"
            disabled={moveDownBefore === undefined}
            onAction={() => {
              if (moveDownBefore !== undefined) onMove(groupId, moveDownBefore);
            }}
          >
            Move down
          </Menu.Item>
        </Menu.List>
      </Menu.Popup>
    </Menu.Root>
  );
}
