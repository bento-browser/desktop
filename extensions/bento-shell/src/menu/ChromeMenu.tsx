// Mux Menu wrapper used inside the chrome-menu overlay page. Takes
// a serializable items payload from chrome and renders a Mux menu
// anchored to an invisible trigger positioned at the chrome-window
// coords of the original click target.
//
// Item types are intentionally minimal — chrome only knows how to
// serialize { id, label, items?, isDisabled?, kind? }. Anything richer
// (icons, badges, keyboard shortcuts) is added here by interpreting
// well-known itemId conventions or by extending this schema later.

import { useRef } from 'react';
import { Menu } from '@muxui/react';
import './menu.css';

export interface ChromeMenuItem {
  /** Stable id echoed back to chrome on selection. */
  id: string;
  /** Visible text. Ignored when kind === 'separator'. */
  label?: string;
  /** Nested items — presence makes this a submenu trigger. */
  items?: ChromeMenuItem[];
  /** Render as a non-selectable separator instead of an item. */
  kind?: 'separator';
  /** Greyed-out, non-interactive item. */
  isDisabled?: boolean;
}

export interface ChromeMenuAnchor {
  /** chrome-window coords (the overlay frame covers the whole window). */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ChromeMenuOpenPayload {
  contextId: string;
  anchor: ChromeMenuAnchor;
  items: ChromeMenuItem[];
  placement?: 'bottom-start' | 'bottom-end';
}

interface ChromeMenuProps {
  payload: ChromeMenuOpenPayload;
  onSelect: (itemId: string) => void;
  onClose: () => void;
}

const SMALL_MENU_CLASS = 'bento-chrome-menu--sm';
const SUBMENU_ITEM_CLASS = 'bento-chrome-menu__submenu-item';

function itemId(item: { id?: string; key?: string; value?: string } | undefined): string {
  return String(item?.id ?? item?.key ?? item?.value ?? '');
}

function renderItems(items: ChromeMenuItem[], onSelect: (id: string) => void) {
  return items.map((item, index) => {
    if (item.kind === 'separator') {
      return <Menu.Separator key={item.id || `sep-${index}`} />;
    }
    if (item.items && item.items.length > 0) {
      return (
        <Menu.Submenu key={item.id}>
          <Menu.Item
            id={item.id}
            textValue={item.label ?? ''}
            disabled={item.isDisabled}
            className={SUBMENU_ITEM_CLASS}
          >
            {item.label ?? ''}
          </Menu.Item>
          <Menu.Popup>
            <Menu.List
              className={SMALL_MENU_CLASS}
              onAction={(selected) => onSelect(itemId(selected))}
            >
              {renderItems(item.items, onSelect)}
            </Menu.List>
          </Menu.Popup>
        </Menu.Submenu>
      );
    }
    return (
      <Menu.Item key={item.id} id={item.id} textValue={item.label ?? ''} disabled={item.isDisabled}>
        {item.label ?? ''}
      </Menu.Item>
    );
  });
}

export function ChromeMenu({ payload, onSelect, onClose }: ChromeMenuProps) {
  // Invisible anchor positioned at the chrome trigger's rect. Mux
  // uses the trigger element's getBoundingClientRect() to position the
  // popover; an opacity:0, pointer-events:none button still has a rect
  // for that math. Same trick as workspace-switcher/main.tsx, but no
  // sidebar-frame offset translation needed because the chrome trigger's
  // rect is already in chrome-window coords (this overlay frame covers
  // the whole window, so its DOM coords == chrome-window coords).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { anchor, items, placement = 'bottom-end' } = payload;

  return (
    <Menu.Root
      open={true}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Menu.Trigger
        ref={triggerRef}
        aria-hidden
        tabIndex={-1}
        style={{
          position: 'fixed',
          top: anchor.top,
          left: anchor.left,
          width: anchor.width,
          height: anchor.height,
          opacity: 0,
          pointerEvents: 'none',
          border: 0,
          background: 'transparent',
          padding: 0,
          margin: 0,
        }}
      />
      <Menu.Popup placement={placement} offset={4}>
        <Menu.List className={SMALL_MENU_CLASS} onAction={(selected) => onSelect(itemId(selected))}>
          {renderItems(items, onSelect)}
        </Menu.List>
      </Menu.Popup>
    </Menu.Root>
  );
}
