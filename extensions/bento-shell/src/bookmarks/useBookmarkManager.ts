// Hooks that tell a shell document whether Bento's bookmark manager is in charge of the star and
// the toolbar, and give it the manager's data. A private window and the Settings opt-out keep
// Firefox's own bookmarks (Places), so every Bento surface checks `useBookmarkManagerOn` first.

import { useEffect, useMemo, useRef } from 'react';
import type { BookmarksSnapshot } from '@shared/protocol';

import { sendBookmarkedTabs } from '../bridge/bookmarkPopup';
import { dispatch, useCurrentWindowId, useToolsReady } from '../bridge/useToolsPort';
import { useBookmarksStore } from '../state/bookmarks';
import { useSettingsStore } from '../state/settings';
import { usePrivateWindow } from '../state/privateWindow';
import { useTabsStore } from '../state/tabs';
import { bookmarkedTabIds, linkKeys } from './links';

/** Whether the star, Cmd+D and the toolbar use the Bento store in this window: a regular window
 * with the Settings switch on (it defaults to on while the settings have not arrived). */
export function useBookmarkManagerOn(): boolean {
  const isPrivate = usePrivateWindow();
  const enabled = useSettingsStore((state) => state.current?.bookmarksEnabled ?? true);
  return !isPrivate && enabled;
}

/**
 * The Bento bookmarks mirror. Tools sends it to a document that connects while it is booting, and
 * one that joins a running tools asks once the bus has answered (as the Bookmarks view does). Null
 * until the first snapshot, and always in a private window, which tools never sends it to.
 */
export function useBookmarksSnapshot(): BookmarksSnapshot | null {
  const ready = useToolsReady();
  const isPrivate = usePrivateWindow();
  useEffect(() => {
    if (ready && !isPrivate) dispatch({ type: 'bookmarks/requestSnapshot' });
  }, [ready, isPrivate]);
  return useBookmarksStore((state) => state.snapshot);
}

/** The URL keys of the saved links, recomputed only when the snapshot changes. */
export function useLinkKeys(snapshot: BookmarksSnapshot | null): ReadonlySet<string> {
  return useMemo(() => linkKeys(snapshot), [snapshot]);
}

/**
 * Sidebar only: tells chrome which of this window's tabs show a saved page, so the panel header
 * star fills. Sent when the set changes, and once when the manager (re)starts to report, because
 * chrome may hold a set from before. A window that is private, or has the manager off, sends
 * nothing and forgets what it sent; neither does one whose snapshot has not arrived or failed.
 */
export function useBookmarkedTabsSignal(): void {
  const on = useBookmarkManagerOn();
  const windowId = useCurrentWindowId();
  const snapshot = useBookmarksSnapshot();
  const keys = useLinkKeys(snapshot);
  const tabsById = useTabsStore((state) => state.byId);
  const lastSent = useRef<string | null>(null);
  const reports = on && snapshot?.status === 'ready';
  const ids = useMemo(
    () => (reports ? bookmarkedTabIds(Object.values(tabsById), keys, windowId) : null),
    [reports, tabsById, keys, windowId],
  );

  useEffect(() => {
    if (ids === null) {
      lastSent.current = null;
      return;
    }
    const signature = ids.join(',');
    if (signature === lastSent.current) return;
    lastSent.current = signature;
    sendBookmarkedTabs(ids);
  }, [ids]);
}
