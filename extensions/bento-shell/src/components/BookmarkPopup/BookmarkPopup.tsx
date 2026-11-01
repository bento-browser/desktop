// The bookmark popup: the one component the popup overlay document renders for whatever chrome
// opened it (bridge/bookmarkPopup.ts): the save popover for the star and Cmd+D, or one of the
// toolbar's menus. It owns closing: `close` is idempotent, so Esc, an outside press and an item
// choice that all end the same popup send one close.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { BookmarksSnapshot } from '@shared/protocol';

import type { BookmarkPopupRequest } from '../../bridge/bookmarkPopup';
import type { BookmarksAction } from '../BookmarksView/types';
import { GroupMenu, OverflowMenu, SpacesMenu, type MenuActions } from './BookmarkMenus';
import { EditPopover } from './EditPopover';
import './BookmarkPopup.css';

/** How long a popup waits for the first snapshot before it closes. */
const SNAPSHOT_WAIT_MS = 3000;

export interface BookmarkPopupProps {
  request: BookmarkPopupRequest;
  snapshot: BookmarksSnapshot | null;
  send: (action: BookmarksAction) => void;
  /** The popup is done, for whatever reason; the owner hides it. Called at most once. */
  onClose: () => void;
  /** Shows the Bookmarks view. */
  onOpenBookmarks: () => void;
}

export function BookmarkPopup({
  request,
  snapshot,
  send,
  onClose,
  onOpenBookmarks,
}: BookmarkPopupProps) {
  const latestOnClose = useRef(onClose);
  useEffect(() => {
    latestOnClose.current = onClose;
  });
  const closed = useRef(false);
  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    latestOnClose.current();
  }, []);

  // No snapshot (tools not answering) leaves nothing to show; do not hold the overlay open.
  const hasSnapshot = snapshot !== null;
  useEffect(() => {
    if (hasSnapshot) return;
    const timer = window.setTimeout(close, SNAPSHOT_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [hasSnapshot, close]);

  const actions = useMemo<MenuActions>(
    () => ({ send, openBookmarks: onOpenBookmarks, close }),
    [send, onOpenBookmarks, close],
  );

  if (request.kind === 'edit') {
    return <EditPopover request={request} snapshot={snapshot} send={send} close={close} />;
  }
  if (!snapshot) return null;
  switch (request.kind) {
    case 'group':
      return (
        <GroupMenu
          anchor={request.anchor}
          snapshot={snapshot}
          actions={actions}
          groupId={request.groupId}
        />
      );
    case 'spaces':
      return <SpacesMenu anchor={request.anchor} snapshot={snapshot} actions={actions} />;
    case 'overflow':
      return (
        <OverflowMenu
          anchor={request.anchor}
          snapshot={snapshot}
          actions={actions}
          groupIds={request.groupIds}
        />
      );
  }
}
