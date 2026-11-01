// Pure rules the sidebar star, the save popover and the toolbar share about which page is a
// Bento bookmark and where a new one goes. No DOM and no bridge, so it is tested on plain data.

import type { BookmarkItem, BookmarksSnapshot } from '@shared/protocol';

export type BookmarkLink = Extract<BookmarkItem, { kind: 'link' }>;

/** The name of the group a first save creates when the current space has none. */
export const UNSORTED_GROUP_NAME = 'Unsorted';

/** A page URL in its canonical form, the key "this page is already saved" compares on. Null for
 * text that is not a URL. */
export function urlKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

// bento-tools' `isSavableTabUrl` (bookmarks/links.ts): web and file pages, not Firefox's own
// about: pages or any privileged scheme (moz-extension, chrome, resource, view-source, data,
// blob). Kept in step by hand: shell code does not import tools code.
const SAVABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'ftp:']);

/** Whether the store would save a tab showing this URL. */
export function isSavableUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    return SAVABLE_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

const isLink = (item: BookmarkItem): item is BookmarkLink => item.kind === 'link';

/** The newer of two links; a later position in the (order-sorted) list wins a tie. */
const newer = (best: BookmarkLink | null, link: BookmarkLink) =>
  best === null || link.createdAt >= best.createdAt ? link : best;

/** The newest link saved under this URL key, or null. A URL saved in several groups edits the
 * most recent one. */
export function newestLinkFor(snapshot: BookmarksSnapshot, key: string): BookmarkLink | null {
  let best: BookmarkLink | null = null;
  for (const item of snapshot.items) {
    if (isLink(item) && urlKey(item.url) === key) best = newer(best, item);
  }
  return best;
}

/** The URL keys of every saved link: what the star and the toolbar compare a page against. */
export function linkKeys(snapshot: BookmarksSnapshot | null): ReadonlySet<string> {
  const keys = new Set<string>();
  if (snapshot?.status !== 'ready') return keys;
  for (const item of snapshot.items) {
    const key = isLink(item) ? urlKey(item.url) : null;
    if (key !== null) keys.add(key);
  }
  return keys;
}

/** Where a first save goes. `groupId` is null when the space has no group yet and "Unsorted"
 * has to be created in it first. */
export interface SaveTarget {
  spaceId: string;
  groupId: string | null;
}

/**
 * In the current space (the one the toolbar and the view show): the group of its newest link;
 * else its first group; else "needs Unsorted" there. Null while there is nothing to save into
 * (no snapshot, a failed load, no space). Stores no extra state: the newest link is the last
 * place a save went.
 */
export function defaultSaveTarget(snapshot: BookmarksSnapshot | null): SaveTarget | null {
  if (snapshot?.status !== 'ready') return null;
  const space =
    snapshot.spaces.find((entry) => entry.id === snapshot.lastSpaceId) ?? snapshot.spaces[0];
  if (!space) return null;
  const groupIds = new Set(
    snapshot.groups.filter((group) => group.spaceId === space.id).map((group) => group.id),
  );
  let newest: BookmarkLink | null = null;
  for (const item of snapshot.items) {
    if (isLink(item) && groupIds.has(item.groupId)) newest = newer(newest, item);
  }
  const first = snapshot.groups.find((group) => group.spaceId === space.id);
  return { spaceId: space.id, groupId: newest?.groupId ?? first?.id ?? null };
}

/** The tab shape the bookmarked-tabs signal reads. */
interface TabForKeys {
  id: number;
  windowId: number;
  url?: string;
}

/** The WebExtension ids of this window's tabs whose URL is a saved link, ascending. */
export function bookmarkedTabIds(
  tabs: Iterable<TabForKeys>,
  keys: ReadonlySet<string>,
  windowId: number | null,
): number[] {
  const ids: number[] = [];
  for (const tab of tabs) {
    if (windowId !== null && tab.windowId !== windowId) continue;
    const key = urlKey(tab.url);
    if (key !== null && keys.has(key)) ids.push(tab.id);
  }
  return ids.sort((a, b) => a - b);
}
