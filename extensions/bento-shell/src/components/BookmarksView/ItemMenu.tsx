// The "More actions" menu of a row, its only hover action. The items are `itemEntries`
// (menuEntries.ts), the same list the right-click menu shows: for a link Open in panel, Open in new
// tab and Copy link, then Edit, for a to-do Mark done, Move (a submenu with the keyboard route to
// what dragging does) and Delete. The trigger shows with the row's hover surface, so it is reached
// by Tab.

import { Menu } from '@muxui/react';
import Ellipsis from 'lucide-react/dist/esm/icons/ellipsis';

import { BentoIcon } from '../primitives';
import { EntryList } from './EntryList';
import type { MenuEntry } from './menuEntries';

export interface ItemMenuProps {
  entries: readonly MenuEntry[];
  defaultOpen?: boolean;
}

export function ItemMenu({ entries, defaultOpen }: ItemMenuProps) {
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
          <EntryList entries={entries} />
        </Menu.List>
      </Menu.Popup>
    </Menu.Root>
  );
}
