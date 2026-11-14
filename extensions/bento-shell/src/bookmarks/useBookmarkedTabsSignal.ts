// The sidebar's report to chrome of which tabs show a saved page. Its own module because it reads
// the tabs mirror: the bookmark toolbar and popup import useBookmarkManager and mirror no tabs.

import { useEffect, useMemo, useRef } from 'react';

import { sendBookmarkedTabs } from '../bridge/bookmarkPopup';
import { useCurrentWindowId } from '../bridge/useToolsPort';
import { useTabsStore } from '../state/tabs';
import { bookmarkedTabIds } from './links';
import { useBookmarkManagerOn, useBookmarksSnapshot, useLinkKeys } from './useBookmarkManager';

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
