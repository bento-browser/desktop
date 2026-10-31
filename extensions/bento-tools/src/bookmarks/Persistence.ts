import { isRecord } from '@shared/export-schema';
import {
  BOOKMARK_COLORS,
  type BookmarkColor,
  type BookmarkGroup,
  type BookmarkItem,
  type BookmarkSpace,
  type BookmarksSnapshot,
} from '@shared/protocol';
import { normalizeName, normalizeText, normalizeTitle } from './fields';
import { cleanFavIconUrl, isLinkUrl } from './links';

/** What is stored: the snapshot without its load `status`. */
export type BookmarksData = Omit<BookmarksSnapshot, 'status'>;

/** The version is part of the key, so a future schema reads and migrates from this one. */
export const STORAGE_KEY = 'bento.bookmarks.v1';
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

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
        title: normalizeTitle(typeof value.title === 'string' ? value.title : '', value.url),
        ...(favIconUrl ? { favIconUrl } : {}),
      };
    }
    case 'note':
      return typeof value.text === 'string'
        ? { ...base, kind: 'note', text: normalizeText(value.text) }
        : null;
    case 'todo':
      return typeof value.text === 'string'
        ? { ...base, kind: 'todo', text: normalizeText(value.text), done: value.done === true }
        : null;
    default:
      return null;
  }
}

/**
 * Reads a stored snapshot defensively: drops malformed records and anything whose parent
 * is gone, then restores the invariants (unique ids, field caps, dense order, a valid
 * `lastSpaceId`). Null when nothing usable is stored.
 */
export function parseStored(raw: unknown): BookmarksData | null {
  if (!isRecord(raw)) return null;
  const spaces: BookmarkSpace[] = [];
  for (const value of asArray(raw.spaces)) {
    if (!isRecord(value) || !isString(value.id) || spaces.some((s) => s.id === value.id)) continue;
    spaces.push({
      id: value.id,
      name: typeof value.name === 'string' ? normalizeName(value.name, '') : '',
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
      name: typeof value.name === 'string' ? normalizeName(value.name, '') : '',
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
export async function load(): Promise<BookmarksData | null> {
  const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
  return parseStored(raw[STORAGE_KEY]);
}

/**
 * Writes the latest state to storage as soon as it changes, one write in flight at a time. State
 * scheduled during a write waits as a single dirty slot (newer replaces older) and is written
 * right after, so a burst of changes costs two writes. A failed write keeps its state dirty
 * unless newer state arrived, and retries with exponential backoff; changes that arrive during
 * the backoff are written by that retry.
 */
export class Persistence {
  #dirty: BookmarksData | null = null;
  /** Set when a write starts and cleared when the loop ends, so no change is left unwritten. */
  #busy = false;
  /** The current write loop; never rejects. */
  #settled: Promise<void> = Promise.resolve();
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #failures = 0;

  schedule(state: BookmarksData): void {
    this.#dirty = state;
    this.#start();
  }

  /** Writes any unwritten state now, skipping a backoff wait, and resolves when the write ends. A
   * write that fails again stays dirty and re-arms the backoff; this does not reject. */
  flush(): Promise<void> {
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#start();
    return this.#settled;
  }

  #start(): void {
    if (this.#busy || this.#retryTimer || !this.#dirty) return;
    this.#busy = true;
    this.#settled = this.#writeLoop();
  }

  async #writeLoop(): Promise<void> {
    try {
      while (this.#dirty) {
        const state = this.#dirty;
        this.#dirty = null;
        try {
          await browser.storage.local.set({ [STORAGE_KEY]: state });
          this.#failures = 0;
        } catch (err) {
          this.#dirty ??= state;
          this.#failures += 1;
          const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.#failures - 1));
          console.error(`[bento-tools] bookmarks: save failed, retrying in ${delay} ms`, err);
          this.#retryTimer = setTimeout(() => {
            this.#retryTimer = null;
            this.#start();
          }, delay);
          return;
        }
      }
    } finally {
      this.#busy = false;
    }
  }
}
