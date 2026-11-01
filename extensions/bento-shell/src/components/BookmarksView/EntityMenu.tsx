// The "..." menu of a space or a group. The items are `groupEntries` or `spaceEntries`
// (menuEntries.ts), the same list the right-click menu shows.

import { Menu } from '@muxui/react';
import Ellipsis from 'lucide-react/dist/esm/icons/ellipsis';

import { BentoIcon } from '../primitives';
import { EntryList } from './EntryList';
import type { MenuEntry } from './menuEntries';

export interface EntityMenuProps {
  /** Names the trigger: "Actions for Gyms". */
  label: string;
  entries: readonly MenuEntry[];
  defaultOpen?: boolean;
}

export function EntityMenu({ label, entries, defaultOpen }: EntityMenuProps) {
  return (
    <Menu.Root defaultOpen={defaultOpen}>
      <Menu.Trigger
        className="bento-bookmarks__more"
        aria-label={label}
        data-bm-menu-trigger
        data-bm-no-drag
      >
        <BentoIcon icon={Ellipsis} size="sm" />
      </Menu.Trigger>
      <Menu.Popup placement="bottom-end" offset={4}>
        <Menu.List aria-label={label}>
          <EntryList entries={entries} />
        </Menu.List>
      </Menu.Popup>
    </Menu.Root>
  );
}
