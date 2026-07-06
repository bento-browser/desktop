// Tale UI Menu wrapper used inside the chrome-menu overlay page. Takes
// a serializable items payload from chrome and renders a Tale UI menu
// anchored to an invisible trigger positioned at the chrome-window
// coords of the original click target.
//
// Item types are intentionally minimal — chrome only knows how to
// serialize { id, label, items?, isDisabled?, kind? }. Anything richer
// (icons, badges, keyboard shortcuts) is added here by interpreting
// well-known itemId conventions or by extending this schema later.

import { useRef } from 'react';
import { Menu } from '@tale-ui/react/menu';
import { SubmenuTrigger } from 'react-aria-components';

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
  placement?: 'bottom start' | 'bottom end';
}

interface ChromeMenuProps {
  payload: ChromeMenuOpenPayload;
  onSelect: (itemId: string) => void;
  onClose: () => void;
}

const SMALL_MENU_CLASS = 'tale-menu__popup--sm';

function renderItems(items: ChromeMenuItem[], onSelect: (id: string) => void) {
  return items.map((item, index) => {
    if (item.kind === 'separator') {
      return <Menu.Separator key={item.id || `sep-${index}`} />;
    }
    if (item.items && item.items.length > 0) {
      // Submenu: wrap a styled Menu.Item trigger and the nested Menu.Popover
      // in react-aria-components' SubmenuTrigger. Tale UI's
      // Menu.SubmenuTrigger styles the trigger ITEM (chevron, etc.); the
      // OUTER wrapper that wires up open-on-hover/click belongs to
      // react-aria-components.
      //
      // `id` MUST be present on Menu.SubmenuTrigger (it's a styled
      // AriaMenuItem and react-aria's collection layer dereferences a
      // null id during keyboard-navigation map lookups — symptom is
      // "t is null" in the minified bundle the first time the menu
      // renders). The React `key` is unrelated; it satisfies the
      // children-array diff, not the collection identity.
      return (
        <SubmenuTrigger key={item.id}>
          <Menu.SubmenuTrigger id={item.id}>{item.label ?? ''}</Menu.SubmenuTrigger>
          <Menu.Popover>
            <Menu.MenuList className={SMALL_MENU_CLASS} onAction={(key) => onSelect(String(key))}>
              {renderItems(item.items, onSelect)}
            </Menu.MenuList>
          </Menu.Popover>
        </SubmenuTrigger>
      );
    }
    return (
      <Menu.Item key={item.id} id={item.id} isDisabled={item.isDisabled}>
        {item.label ?? ''}
      </Menu.Item>
    );
  });
}

export function ChromeMenu({ payload, onSelect, onClose }: ChromeMenuProps) {
  // Invisible anchor positioned at the chrome trigger's rect. react-aria
  // uses the trigger element's getBoundingClientRect() to position the
  // popover; an opacity:0, pointer-events:none button still has a rect
  // for that math. Same trick as workspace-switcher/main.tsx, but no
  // sidebar-frame offset translation needed because the chrome trigger's
  // rect is already in chrome-window coords (this overlay frame covers
  // the whole window, so its DOM coords == chrome-window coords).
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { anchor, items, placement = 'bottom end' } = payload;

  return (
    <Menu.Root
      isOpen={true}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Menu.Trigger
        ref={triggerRef}
        aria-hidden
        excludeFromTabOrder
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
      <Menu.Popover placement={placement} offset={4}>
        <Menu.MenuList className={SMALL_MENU_CLASS} onAction={(key) => onSelect(String(key))}>
          {renderItems(items, onSelect)}
        </Menu.MenuList>
      </Menu.Popover>
    </Menu.Root>
  );
}
