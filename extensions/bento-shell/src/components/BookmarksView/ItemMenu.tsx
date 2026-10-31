// The "More actions" menu of a row, its only hover action: Open in new tab (links), Edit, Move and
// Delete. Move is a submenu with the keyboard route to what dragging does: "Move to group" lists
// the other groups of the space (the row goes to the end of the one picked), "Move up" and "Move
// down" reorder within the group. Opening the link in a panel is the row's own button. The trigger
// shows with the row's hover surface, so it is reached by Tab.

import { Menu } from '@muxui/react';
import Ellipsis from 'lucide-react/dist/esm/icons/ellipsis';

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
  /** Links only: opens the link in a new tab. Undefined hides the item. */
  onOpenInTab?: () => void;
  onEdit: () => void;
  onDelete: () => void;
  defaultOpen?: boolean;
}

export function ItemMenu({
  groups,
  groupId,
  moveUpBefore,
  moveDownBefore,
  onMove,
  onOpenInTab,
  onEdit,
  onDelete,
  defaultOpen,
}: ItemMenuProps) {
  return (
    <Menu.Root defaultOpen={defaultOpen}>
      <Menu.Trigger
        className="bento-bookmarks__more"
        aria-label="More actions"
        title="More actions"
        data-bm-item-menu
        data-bm-no-drag
      >
        <BentoIcon icon={Ellipsis} size="sm" />
      </Menu.Trigger>
      <Menu.Popup placement="bottom-end" offset={4}>
        <Menu.List aria-label="More actions">
          {onOpenInTab ? (
            <Menu.Item id="open-tab" onAction={onOpenInTab}>
              Open in new tab
            </Menu.Item>
          ) : null}
          <Menu.Item id="edit" onAction={onEdit}>
            Edit
          </Menu.Item>
          <Menu.Submenu>
            <Menu.Item id="move" textValue="Move">
              Move
            </Menu.Item>
            <Menu.Popup placement="end-top">
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
          </Menu.Submenu>
          <Menu.Separator />
          <Menu.Item id="delete" onAction={onDelete}>
            Delete
          </Menu.Item>
        </Menu.List>
      </Menu.Popup>
    </Menu.Root>
  );
}
