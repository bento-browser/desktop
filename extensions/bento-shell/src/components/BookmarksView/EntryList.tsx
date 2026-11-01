// Draws a `MenuEntry` list (menuEntries.ts) with the public Mux `Menu` parts, inside a
// `Menu.List`: an action is a `Menu.Item`, a separator a `Menu.Separator`, and a submenu a
// `Menu.Submenu` (an item and a popup holding its own list). Every menu of the Bookmarks view goes
// through here, so they look and behave alike.

import { Menu } from '@muxui/react';
import Check from 'lucide-react/dist/esm/icons/check';

import { BentoIcon } from '../primitives';
import type { MenuEntry } from './menuEntries';

function Entry({ entry }: { entry: MenuEntry }) {
  switch (entry.type) {
    case 'separator':
      return <Menu.Separator />;
    case 'submenu':
      return (
        <Menu.Submenu>
          <Menu.Item id={entry.id} textValue={entry.label}>
            {entry.label}
          </Menu.Item>
          <Menu.Popup placement="end-top">
            <Menu.List aria-label={entry.label}>
              <EntryList entries={entry.entries} />
            </Menu.List>
          </Menu.Popup>
        </Menu.Submenu>
      );
    case 'action':
      return (
        <Menu.Item
          id={entry.id}
          textValue={entry.label}
          disabled={entry.disabled}
          onAction={entry.onAction}
        >
          {entry.swatch ? (
            <span className="bento-bookmarks__menu-colour">
              <span className="bento-bookmarks__dot" data-bm-color={entry.swatch} />
              {entry.label}
              {entry.checked ? <BentoIcon icon={Check} size="sm" /> : null}
            </span>
          ) : (
            entry.label
          )}
        </Menu.Item>
      );
  }
}

export function EntryList({ entries }: { entries: readonly MenuEntry[] }) {
  return (
    <>
      {entries.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </>
  );
}
