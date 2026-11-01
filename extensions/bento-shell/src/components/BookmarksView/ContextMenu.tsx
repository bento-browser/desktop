// The right-click menu: a public Mux `Menu` opened at a point of this document. The view covers the
// whole window, so an in-document popup is enough and no chrome overlay is needed. Mux documents
// the recipe for context coordinates: a consumer-owned element placed at the point is the
// popup's `anchorRef`, and the root is controlled with `open`. There is no trigger, so the
// popup returns the focus to the element that had it when the menu opened (a row opened with the
// keyboard gets its focus back).

import { useRef } from 'react';
import { Menu } from '@muxui/react';

import { EntryList } from './EntryList';
import type { MenuEntry } from './menuEntries';

export interface ContextMenuRequest {
  /** Where the menu opens, from the top left of the view. */
  x: number;
  y: number;
  /** Names the list for assistive technology. */
  label: string;
  entries: readonly MenuEntry[];
}

export interface ContextMenuProps {
  /** Null while no menu is open. */
  request: ContextMenuRequest | null;
  onClose: () => void;
}

export function ContextMenu({ request, onClose }: ContextMenuProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  // The popup plays its exit after `request` is gone, so it keeps drawing the last one.
  const lastRef = useRef(request);
  if (request) lastRef.current = request;
  const shown = lastRef.current;
  return (
    <>
      <span
        ref={anchorRef}
        className="bento-bookmarks__context-anchor"
        style={shown ? { left: shown.x, top: shown.y } : undefined}
        aria-hidden="true"
      />
      {shown ? (
        <Menu.Root
          open={request !== null}
          onOpenChange={(open) => {
            if (!open) onClose();
          }}
        >
          <Menu.Popup anchorRef={anchorRef} placement="bottom-start" offset={0}>
            <Menu.List aria-label={shown.label}>
              <EntryList entries={shown.entries} />
            </Menu.List>
          </Menu.Popup>
        </Menu.Root>
      ) : null}
    </>
  );
}
