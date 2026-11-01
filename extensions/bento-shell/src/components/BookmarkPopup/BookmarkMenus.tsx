// The toolbar's menus: one group's links, the Spaces switcher, and the groups that did not fit.
// Each is a Mux Menu anchored to the rect of the toolbar button that opened it, in the popup
// overlay (see bridge/bookmarkPopup.ts). Links open the way a click does in the Bookmarks view:
// as a new panel in the current workspace.

import { useEffect, type ReactNode } from 'react';
import { Menu } from '@muxui/react';
import type { BookmarkGroup, BookmarkItem, BookmarksSnapshot } from '@shared/protocol';
import Check from 'lucide-react/dist/esm/icons/check';

import type { PopupRect } from '../../bridge/bookmarkPopup';
import type { BookmarksAction } from '../BookmarksView/types';
import { itemLabel } from '../BookmarksView/model';
import { BentoIcon } from '../primitives';
import { ColorDot, LinkIcon, MenuAnchor, useEscape } from './parts';

type Link = Extract<BookmarkItem, { kind: 'link' }>;

/** What the menus do besides sending actions. */
export interface MenuActions {
  send: (action: BookmarksAction) => void;
  /** Shows the Bookmarks view (the popup hides itself as chrome opens it). */
  openBookmarks: () => void;
  /** Closes the popup; safe to call more than once. */
  close: () => void;
}

const linksOf = (snapshot: BookmarksSnapshot, group: BookmarkGroup): Link[] =>
  snapshot.items.filter((item): item is Link => item.groupId === group.id && item.kind === 'link');

function PopupMenu({
  anchor,
  label,
  close,
  children,
}: {
  anchor: PopupRect;
  label: string;
  close: () => void;
  children: ReactNode;
}) {
  useEscape(close);
  return (
    <Menu.Root
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <MenuAnchor anchor={anchor} />
      <Menu.Popup placement="bottom-start" offset={4}>
        <Menu.List className="bento-bookmark-popup__menu" aria-label={label}>
          {children}
        </Menu.List>
      </Menu.Popup>
    </Menu.Root>
  );
}

function ItemLabel({ children }: { children: ReactNode }) {
  return <span className="bento-bookmark-popup__item">{children}</span>;
}

/** A group's links, then "Open all in panels" and "Open in Bookmarks". */
function GroupEntries({
  snapshot,
  group,
  actions,
}: {
  snapshot: BookmarksSnapshot;
  group: BookmarkGroup;
  actions: MenuActions;
}) {
  const links = linksOf(snapshot, group);
  const openInBookmarks = () => {
    if (snapshot.lastSpaceId !== group.spaceId) {
      actions.send({ type: 'bookmarks/space/select', id: group.spaceId });
    }
    actions.openBookmarks();
  };
  return (
    <>
      {links.length === 0 ? (
        <Menu.Item id={`${group.id}:empty`} textValue="No links" disabled>
          No links
        </Menu.Item>
      ) : (
        links.map((link) => (
          <Menu.Item
            key={link.id}
            id={link.id}
            textValue={itemLabel(link)}
            onAction={() =>
              actions.send({ type: 'bookmarks/item/open', id: link.id, where: 'panel' })
            }
          >
            <ItemLabel>
              <LinkIcon src={link.favIconUrl} />
              <span className="bento-bookmark-popup__item-text">{itemLabel(link)}</span>
            </ItemLabel>
          </Menu.Item>
        ))
      )}
      <Menu.Separator />
      <Menu.Item
        id={`${group.id}:open-all`}
        textValue="Open all in panels"
        disabled={links.length === 0}
        onAction={() => {
          for (const link of links) {
            actions.send({ type: 'bookmarks/item/open', id: link.id, where: 'panel' });
          }
        }}
      >
        Open all in panels
      </Menu.Item>
      <Menu.Item
        id={`${group.id}:open-in-bookmarks`}
        textValue="Open in Bookmarks"
        onAction={openInBookmarks}
      >
        Open in Bookmarks
      </Menu.Item>
    </>
  );
}

interface MenuProps {
  anchor: PopupRect;
  snapshot: BookmarksSnapshot;
  actions: MenuActions;
}

/** The links of one toolbar group. */
export function GroupMenu({ anchor, snapshot, actions, groupId }: MenuProps & { groupId: string }) {
  const group = snapshot.groups.find((entry) => entry.id === groupId);
  useEffect(() => {
    if (!group) actions.close();
  }, [group, actions]);
  if (!group) return null;
  return (
    <PopupMenu anchor={anchor} label={group.name} close={actions.close}>
      <GroupEntries snapshot={snapshot} group={group} actions={actions} />
    </PopupMenu>
  );
}

/** Every space with a check on the current one, then "Open Bookmarks". */
export function SpacesMenu({ anchor, snapshot, actions }: MenuProps) {
  return (
    <PopupMenu anchor={anchor} label="Spaces" close={actions.close}>
      {snapshot.spaces.map((space) => (
        <Menu.Item
          key={space.id}
          id={space.id}
          textValue={space.name}
          onAction={() => actions.send({ type: 'bookmarks/space/select', id: space.id })}
        >
          <ItemLabel>
            <ColorDot color={space.color} />
            <span className="bento-bookmark-popup__item-text">{space.name}</span>
            {space.id === snapshot.lastSpaceId ? (
              <span className="bento-bookmark-popup__check">
                <BentoIcon icon={Check} size="sm" label="Current space" />
              </span>
            ) : null}
          </ItemLabel>
        </Menu.Item>
      ))}
      <Menu.Separator />
      <Menu.Item id="open-bookmarks" textValue="Open Bookmarks" onAction={actions.openBookmarks}>
        Open Bookmarks
      </Menu.Item>
    </PopupMenu>
  );
}

/** The groups that did not fit in the toolbar, each a submenu of its links. */
export function OverflowMenu({
  anchor,
  snapshot,
  actions,
  groupIds,
}: MenuProps & { groupIds: readonly string[] }) {
  const groups = groupIds.flatMap((id) => snapshot.groups.filter((entry) => entry.id === id));
  useEffect(() => {
    if (groups.length === 0) actions.close();
  }, [groups.length, actions]);
  if (groups.length === 0) return null;
  return (
    <PopupMenu anchor={anchor} label="More groups" close={actions.close}>
      {groups.map((group) => (
        <Menu.Submenu key={group.id}>
          <Menu.Item
            id={group.id}
            textValue={group.name}
            className="bento-bookmark-popup__submenu-item"
          >
            <ItemLabel>
              <ColorDot color={group.color} />
              <span className="bento-bookmark-popup__item-text">{group.name}</span>
            </ItemLabel>
          </Menu.Item>
          <Menu.Popup placement="end-top">
            <Menu.List className="bento-bookmark-popup__menu" aria-label={group.name}>
              <GroupEntries snapshot={snapshot} group={group} actions={actions} />
            </Menu.List>
          </Menu.Popup>
        </Menu.Submenu>
      ))}
    </PopupMenu>
  );
}
