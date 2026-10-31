// Pure view model of the Bookmarks manager: what the screen shows for one snapshot. Nothing here
// touches the DOM or the bridge, so it is tested on plain data.

import type {
  BookmarkGroup,
  BookmarkItem,
  BookmarkItemInput,
  BookmarkSpace,
  BookmarksSnapshot,
} from '@shared/protocol';
import { ALLOWED_URL_SCHEMES } from '@shared/export-schema';

export interface SpaceSummary {
  space: BookmarkSpace;
  groupCount: number;
  linkCount: number;
}

export interface BoardGroup {
  group: BookmarkGroup;
  items: BookmarkItem[];
}

export interface BoardModel {
  spaces: SpaceSummary[];
  /** The space shown: `lastSpaceId`, else the first space. Null only before any space exists. */
  current: BookmarkSpace | null;
  groups: BoardGroup[];
  linkCount: number;
}

const isLink = (item: BookmarkItem) => item.kind === 'link';

/** Groups the snapshot by parent. The snapshot's arrays are sorted by `order`, and filtering
 * keeps that sibling order. */
export function buildBoard(snapshot: BookmarksSnapshot): BoardModel {
  const itemsByGroup = new Map<string, BookmarkItem[]>();
  for (const item of snapshot.items) {
    const list = itemsByGroup.get(item.groupId);
    if (list) list.push(item);
    else itemsByGroup.set(item.groupId, [item]);
  }
  const groupsBySpace = new Map<string, BookmarkGroup[]>();
  for (const group of snapshot.groups) {
    const list = groupsBySpace.get(group.spaceId);
    if (list) list.push(group);
    else groupsBySpace.set(group.spaceId, [group]);
  }
  const spaces = snapshot.spaces.map((space) => {
    const groups = groupsBySpace.get(space.id) ?? [];
    const linkCount = groups.reduce(
      (sum, group) => sum + (itemsByGroup.get(group.id) ?? []).filter(isLink).length,
      0,
    );
    return { space, groupCount: groups.length, linkCount };
  });
  const current =
    snapshot.spaces.find((space) => space.id === snapshot.lastSpaceId) ??
    snapshot.spaces[0] ??
    null;
  const groups = current
    ? (groupsBySpace.get(current.id) ?? []).map((group) => ({
        group,
        items: itemsByGroup.get(group.id) ?? [],
      }))
    : [];
  const linkCount = spaces.find((entry) => entry.space.id === current?.id)?.linkCount ?? 0;
  return { spaces, current, groups, linkCount };
}

/** The host of a link without a leading `www.`, or the text itself when it is not a URL. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || url;
  } catch {
    return url;
  }
}

/** What a row shows as its title: a link's title, else its host; a note's or to-do's text. */
export function itemLabel(item: BookmarkItem): string {
  if (item.kind === 'link') return item.title || hostnameOf(item.url);
  return item.text;
}

// ---- Adding ---------------------------------------------------------------------------------

const BARE_DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#]\S*)?$/i;
const TODO_PREFIX = /^\[\](?:\s+|$)/;

/** A URL the text names, or null: it has an allowed scheme, or it is a bare domain (`example.com`,
 * `example.com/path`), which gets https. Text with a space in it is never a URL. */
function urlFromText(text: string): string | null {
  if (/\s/.test(text)) return null;
  try {
    const url = new URL(text);
    if (ALLOWED_URL_SCHEMES.has(url.protocol)) return url.href;
  } catch {
    // Not absolute: it may still be a bare domain.
  }
  return BARE_DOMAIN.test(text) ? `https://${text}` : null;
}

/** What the "+ Link, note or to-do" field makes of its text: a URL becomes a link, text that starts
 * with `[] ` a to-do, anything else a note. Null when there is nothing to add. */
export function parseAddInput(raw: string): BookmarkItemInput | null {
  const text = raw.trim();
  if (!text) return null;
  if (TODO_PREFIX.test(text)) {
    const todo = text.replace(TODO_PREFIX, '').trim();
    return todo ? { kind: 'todo', text: todo } : null;
  }
  const url = urlFromText(text);
  if (url) return { kind: 'link', url, title: hostnameOf(url) };
  return { kind: 'note', text };
}

/** Whether a typed address is one the field would store as a link (used to validate the link
 * editor's URL field). */
export function normalizeUrl(raw: string): string | null {
  return urlFromText(raw.trim());
}

// ---- Search ---------------------------------------------------------------------------------

export interface SearchHit {
  space: BookmarkSpace;
  group: BookmarkGroup;
  items: BookmarkItem[];
}

function searchText(item: BookmarkItem): string {
  return item.kind === 'link' ? `${item.title} ${item.url}` : item.text;
}

/** Items of every space whose text holds every word of the query, grouped by space and group in
 * the snapshot's order. Empty for a blank query. */
export function searchBookmarks(snapshot: BookmarksSnapshot, query: string): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const matching = new Map<string, BookmarkItem[]>();
  for (const item of snapshot.items) {
    const text = searchText(item).toLowerCase();
    if (!terms.every((term) => text.includes(term))) continue;
    const list = matching.get(item.groupId);
    if (list) list.push(item);
    else matching.set(item.groupId, [item]);
  }
  const spaceById = new Map(snapshot.spaces.map((space) => [space.id, space]));
  const hits: SearchHit[] = [];
  for (const group of snapshot.groups) {
    const items = matching.get(group.id);
    const space = spaceById.get(group.spaceId);
    if (items && space) hits.push({ space, group, items });
  }
  // Spaces in their own order, groups within a space in theirs.
  const spaceOrder = new Map(snapshot.spaces.map((space, index) => [space.id, index]));
  return hits.sort(
    (a, b) =>
      (spaceOrder.get(a.space.id) ?? 0) - (spaceOrder.get(b.space.id) ?? 0) ||
      a.group.order - b.group.order,
  );
}
