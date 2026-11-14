// Hooks that tell a shell document whether Bento's bookmark manager is in charge of the star and
// the toolbar, and give it the manager's data. A private window and the Settings opt-out keep
// Firefox's own bookmarks (Places), so every Bento surface checks `useBookmarkManagerOn` first.

import { useEffect, useMemo } from 'react';
import type { BookmarksSnapshot } from '@shared/protocol';

import { dispatch, useToolsReady } from '../bridge/useToolsPort';
import { useBookmarksStore } from '../state/bookmarks';
import { useSettingsStore } from '../state/settings';
import { usePrivateWindow } from '../state/privateWindow';
import { linkKeys } from './links';

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
