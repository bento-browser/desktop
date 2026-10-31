// The "..." menu of a space or a group: Rename, Colour (a submenu), Delete, and for a group Open
// all in panels. The caller owns the open state, so a right-click on a space row can open it too.

import { Menu } from '@muxui/react';
import Check from 'lucide-react/dist/esm/icons/check';
import Ellipsis from 'lucide-react/dist/esm/icons/ellipsis';
import { BOOKMARK_COLORS, type BookmarkColor } from '@shared/protocol';

import { BentoIcon } from '../primitives';

export const COLOR_LABELS: Record<BookmarkColor, string> = {
  gray: 'Gray',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
};

export interface EntityMenuProps {
  /** Names the trigger: "Actions for Gyms". */
  label: string;
  /** What Delete removes, in the menu: "Delete group". */
  deleteLabel: string;
  color: BookmarkColor;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Groups only: open every link of the group in panels. */
  openAll?: { count: number; onOpenAll: () => void };
  onRename: () => void;
  onColor: (color: BookmarkColor) => void;
  onDelete: () => void;
}

export function EntityMenu({
  label,
  deleteLabel,
  color,
  open,
  onOpenChange,
  openAll,
  onRename,
  onColor,
  onDelete,
}: EntityMenuProps) {
  return (
    <Menu.Root open={open} onOpenChange={onOpenChange}>
      <Menu.Trigger className="bento-bookmarks__more" aria-label={label} data-bm-no-drag>
        <BentoIcon icon={Ellipsis} size="sm" />
      </Menu.Trigger>
      <Menu.Popup placement="bottom-end" offset={4}>
        <Menu.List aria-label={label}>
          {openAll ? (
            <Menu.Item
              id="open-all"
              disabled={openAll.count === 0}
              onAction={openAll.onOpenAll}
            >{`Open all ${openAll.count} in panels`}</Menu.Item>
          ) : null}
          <Menu.Item id="rename" onAction={onRename}>
            Rename
          </Menu.Item>
          <Menu.Submenu>
            <Menu.Item id="colour" textValue="Colour">
              Colour
            </Menu.Item>
            <Menu.Popup placement="end-top">
              <Menu.List aria-label="Colour">
                {BOOKMARK_COLORS.map((entry) => (
                  <Menu.Item
                    key={entry}
                    id={`colour:${entry}`}
                    textValue={COLOR_LABELS[entry]}
                    onAction={() => onColor(entry)}
                  >
                    <span className="bento-bookmarks__menu-colour">
                      <span className="bento-bookmarks__dot" data-bm-color={entry} />
                      {COLOR_LABELS[entry]}
                      {entry === color ? <BentoIcon icon={Check} size="sm" /> : null}
                    </span>
                  </Menu.Item>
                ))}
              </Menu.List>
            </Menu.Popup>
          </Menu.Submenu>
          <Menu.Separator />
          <Menu.Item id="delete" onAction={onDelete}>
            {deleteLabel}
          </Menu.Item>
        </Menu.List>
      </Menu.Popup>
    </Menu.Root>
  );
}
