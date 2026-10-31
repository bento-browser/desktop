import { isRecord } from '@shared/export-schema';
import {
  BOOKMARK_COLORS,
  type BookmarkColor,
  type BookmarkGroup,
  type BookmarkItem,
  type BookmarkSpace,
  type BookmarksSnapshot,
} from '@shared/protocol';
import { cleanFavIconUrl, isLinkUrl } from './links';

/** The version is part of the key, so a future schema reads and migrates from this one. */
export const STORAGE_KEY = 'bento.bookmarks.v1';
const DEBOUNCE_MS = 500;

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const asColor = (v: unknown): BookmarkColor => BOOKMARK_COLORS.find((c) => c === v) ?? 'gray';
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Sorts each parent's children by `order` and renumbers them 0..n-1. Returns the list sorted by order. */
export function densifyOrder<T extends { order: number }>(
  list: T[],
  parentOf: (entry: T) => string,
): T[] {
  const sorted = [...list].sort((a, b) => a.order - b.order);
  const next = new Map<string, number>();
  for (const entry of sorted) {
    const parent = parentOf(entry);
    entry.order = next.get(parent) ?? 0;
    next.set(parent, entry.order + 1);
  }
  return sorted;
}

function parseItem(value: unknown): BookmarkItem | null {
  if (!isRecord(value) || !isString(value.id) || !isString(value.groupId)) return null;
  const base = {
    id: value.id,
    groupId: value.groupId,
    order: isNumber(value.order) ? value.order : 0,
    createdAt: isNumber(value.createdAt) ? value.createdAt : 0,
  };
  switch (value.kind) {
    case 'link': {
      if (!isLinkUrl(value.url)) return null;
      const favIconUrl = cleanFavIconUrl(value.favIconUrl);
      return {
        ...base,
        kind: 'link',
        url: value.url,
        title: typeof value.title === 'string' ? value.title : value.url,
        ...(favIconUrl ? { favIconUrl } : {}),
      };
    }
    case 'note':
      return typeof value.text === 'string' ? { ...base, kind: 'note', text: value.text } : null;
    case 'todo':
      return typeof value.text === 'string'
        ? { ...base, kind: 'todo', text: value.text, done: value.done === true }
        : null;
    default:
      return null;
  }
}

/**
 * Reads a stored snapshot defensively: drops malformed records and anything whose parent
 * is gone, then restores the invariants (unique ids, dense order, a valid `lastSpaceId`).
 * Null when nothing usable is stored.
 */
export function parseStored(raw: unknown): BookmarksSnapshot | null {
  if (!isRecord(raw)) return null;
  const spaces: BookmarkSpace[] = [];
  for (const value of asArray(raw.spaces)) {
    if (!isRecord(value) || !isString(value.id) || spaces.some((s) => s.id === value.id)) continue;
    spaces.push({
      id: value.id,
      name: typeof value.name === 'string' ? value.name : '',
      color: asColor(value.color),
      order: isNumber(value.order) ? value.order : 0,
    });
  }
  if (spaces.length === 0) return null;

  const spaceIds = new Set(spaces.map((s) => s.id));
  const groups: BookmarkGroup[] = [];
  for (const value of asArray(raw.groups)) {
    if (!isRecord(value) || !isString(value.id) || !isString(value.spaceId)) continue;
    if (!spaceIds.has(value.spaceId) || groups.some((g) => g.id === value.id)) continue;
    groups.push({
      id: value.id,
      spaceId: value.spaceId,
      name: typeof value.name === 'string' ? value.name : '',
      color: asColor(value.color),
      order: isNumber(value.order) ? value.order : 0,
    });
  }

  const groupIds = new Set(groups.map((g) => g.id));
  const items: BookmarkItem[] = [];
  const itemIds = new Set<string>();
  for (const value of asArray(raw.items)) {
    const item = parseItem(value);
    if (!item || !groupIds.has(item.groupId) || itemIds.has(item.id)) continue;
    itemIds.add(item.id);
    items.push(item);
  }

  const sortedSpaces = densifyOrder(spaces, () => '');
  const last = raw.lastSpaceId;
  return {
    spaces: sortedSpaces,
    groups: densifyOrder(groups, (g) => g.spaceId),
    items: densifyOrder(items, (i) => i.groupId),
    lastSpaceId: isString(last) && spaceIds.has(last) ? last : (sortedSpaces[0]?.id ?? null),
    firefoxImportOffered: raw.firefoxImportOffered === true,
  };
}

/** Throws when storage cannot be read, so the caller does not overwrite what it could not see. */
export async function load(): Promise<BookmarksSnapshot | null> {
  const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
  return parseStored(raw[STORAGE_KEY]);
}

/** Debounced writer: the latest scheduled state wins. */
export class Persistence {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: BookmarksSnapshot | null = null;

  schedule(state: BookmarksSnapshot): void {
    this.#pending = state;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, DEBOUNCE_MS);
  }

  /** Writes the pending state now. */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const state = this.#pending;
    this.#pending = null;
    if (!state) return;
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: state });
    } catch (err) {
      console.error('[bento-tools] bookmarks: save failed', err);
    }
  }
}
