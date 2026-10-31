// A menu item that opens a submenu of groups: "Move to group" on a row, "Save to group" on an
// open tab. The groups are those of the current space, each with its colour dot; an optional last
// item makes a new group. With nothing to pick the item is shown disabled instead of opening an
// empty list. Used inside a Mux Menu.List.

import { Menu } from '@muxui/react';

import type { GroupChoice } from './types';

export interface GroupSubmenuProps {
  /** The item's id and its text: "Move to group". */
  id: string;
  label: string;
  groups: readonly GroupChoice[];
  onPick: (groupId: string) => void;
  /** Adds a last "New group" item. */
  onNewGroup?: () => void;
}

export function GroupSubmenu({ id, label, groups, onPick, onNewGroup }: GroupSubmenuProps) {
  if (groups.length === 0 && !onNewGroup) {
    return (
      <Menu.Item id={id} disabled>
        {label}
      </Menu.Item>
    );
  }
  return (
    <Menu.Submenu>
      <Menu.Item id={id} textValue={label}>
        {label}
      </Menu.Item>
      <Menu.Popup placement="end-top">
        <Menu.List aria-label={label}>
          {groups.map((group) => (
            <Menu.Item
              key={group.id}
              id={`group:${group.id}`}
              textValue={group.name}
              onAction={() => onPick(group.id)}
            >
              <span className="bento-bookmarks__menu-colour">
                <span className="bento-bookmarks__dot" data-bm-color={group.color} />
                {group.name}
              </span>
            </Menu.Item>
          ))}
          {onNewGroup && groups.length > 0 ? <Menu.Separator /> : null}
          {onNewGroup ? (
            <Menu.Item id="group:new" onAction={onNewGroup}>
              New group
            </Menu.Item>
          ) : null}
        </Menu.List>
      </Menu.Popup>
    </Menu.Submenu>
  );
}
