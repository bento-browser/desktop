// Source of truth for the Bookmarks manager: spaces hold groups, groups hold links, notes
// and to-dos. State lives in storage.local (`bento.bookmarks.v1`) and is independent of
// Firefox's own bookmarks; the shell mirrors it through `bookmarks/snapshot`. Every
// mutation validates its ids, renumbers the affected siblings densely (0..n-1) and, when
// something changed, notifies listeners with the full snapshot and schedules a write.
import type {
  BookmarkColor,
  BookmarkGroup,
  BookmarkItem,
  BookmarkItemInput,
  BookmarkSpace,
  BookmarksSnapshot,
} from '@shared/protocol';
import { firefoxFolders } from './firefoxImport';
import { cleanFavIconUrl, isLinkUrl, isSavableTabUrl } from './links';
import { Persistence, load } from './Persistence';

type Listener = (snapshot: BookmarksSnapshot) => void;

const DEFAULT_SPACE_NAME = 'Personal';
const SAVED_TABS_GROUP_NAME = 'Saved tabs';
const FIREFOX_SPACE_NAME = 'Firefox bookmarks';
const MAX_IMPORTED_LINKS = 2000;

export interface ItemChanges {
  title?: string;
  url?: string;
  text?: string;
  done?: boolean;
}

/** Puts `moved` before the entry `beforeId` (or last) among `siblings` and renumbers them.
 * `siblings` may already contain `moved`. Returns whether any order value changed. */
function place<T extends { id: string; order: number }>(
  siblings: T[],
  moved: T,
  beforeId: string | null,
): boolean {
  const rest = siblings.filter((entry) => entry.id !== moved.id);
  const at = beforeId === null ? -1 : rest.findIndex((entry) => entry.id === beforeId);
  rest.splice(at === -1 ? rest.length : at, 0, moved);
  return renumber(rest);
}

/** Renumbers an ordered sibling list 0..n-1. Returns whether any order value changed. */
function renumber<T extends { order: number }>(ordered: T[]): boolean {
  let changed = false;
  ordered.forEach((entry, index) => {
    if (entry.order !== index) changed = true;
    entry.order = index;
  });
  return changed;
}

const byOrder = (a: { order: number }, b: { order: number }) => a.order - b.order;

export class BookmarksStore {
  #spaces: BookmarkSpace[] = [];
  #groups: BookmarkGroup[] = [];
  #items: BookmarkItem[] = [];
  #lastSpaceId: string | null = null;
  #firefoxImportOffered = false;
  #listeners = new Set<Listener>();
  #persistence = new Persistence();
  /** False when storage could not be read, so a seeded state never overwrites unread data. */
  #canPersist = true;
  #initialized = false;
  #importing = false;

  /** Loads the stored state, or seeds one empty space on first run, and tells listeners. Idempotent. */
  async init(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    let stored: BookmarksSnapshot | null = null;
    try {
      stored = await load();
    } catch (err) {
      this.#canPersist = false;
      console.error('[bento-tools] bookmarks: load failed, changes will not be saved:', err);
    }
    if (stored) {
      this.#spaces = stored.spaces;
      this.#groups = stored.groups;
      this.#items = stored.items;
      this.#lastSpaceId = stored.lastSpaceId;
      this.#firefoxImportOffered = stored.firefoxImportOffered;
      this.#emit(this.snapshot());
      return;
    }
    this.#seedSpace();
    this.#commit();
  }

  /** A copy of the state with every array sorted by `order`. */
  snapshot(): BookmarksSnapshot {
    return {
      spaces: this.#spaces.map((space) => ({ ...space })).sort(byOrder),
      groups: this.#groups.map((group) => ({ ...group })).sort(byOrder),
      items: this.#items.map((item) => ({ ...item })).sort(byOrder),
      lastSpaceId: this.#lastSpaceId,
      firefoxImportOffered: this.#firefoxImportOffered,
    };
  }

  /** Subscribe to state changes; the callback receives the full new snapshot. */
  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Writes any pending change now (tests, shutdown). */
  flush(): Promise<void> {
    return this.#persistence.flush();
  }

  /** The URL of a link item, or null when the id is not a link. */
  linkUrl(id: string): string | null {
    const item = this.#items.find((entry) => entry.id === id);
    return item?.kind === 'link' && isLinkUrl(item.url) ? item.url : null;
  }

  // ---- Spaces -------------------------------------------------------------

  createSpace(name: string): string {
    const space = this.#addSpace(name.trim() || 'Untitled space');
    this.#commit();
    return space.id;
  }

  updateSpace(id: string, changes: { name?: string; color?: BookmarkColor }): boolean {
    const space = this.#spaces.find((entry) => entry.id === id);
    if (!space) return false;
    const changed = this.#applyLabel(space, changes);
    if (changed) this.#commit();
    return changed;
  }

  /** Deletes the space with its groups and their items. Deleting the last space leaves a fresh
   * empty "Personal", so there is always one. */
  deleteSpace(id: string): boolean {
    if (!this.#spaces.some((space) => space.id === id)) return false;
    const groupIds = new Set(
      this.#groups.filter((group) => group.spaceId === id).map((group) => group.id),
    );
    this.#items = this.#items.filter((item) => !groupIds.has(item.groupId));
    this.#groups = this.#groups.filter((group) => group.spaceId !== id);
    this.#spaces = this.#spaces.filter((space) => space.id !== id);
    renumber(this.#spaces.sort(byOrder));
    if (this.#spaces.length === 0) this.#seedSpace();
    else if (this.#lastSpaceId === id) this.#lastSpaceId = this.#spaces[0]!.id;
    this.#commit();
    return true;
  }

  selectSpace(id: string): boolean {
    if (!this.#spaces.some((space) => space.id === id) || this.#lastSpaceId === id) return false;
    this.#lastSpaceId = id;
    this.#commit();
    return true;
  }

  // ---- Groups -------------------------------------------------------------

  createGroup(spaceId: string, name: string): string | null {
    if (!this.#spaces.some((space) => space.id === spaceId)) return null;
    const group = this.#addGroup(spaceId, name.trim() || 'Untitled group');
    this.#commit();
    return group.id;
  }

  updateGroup(id: string, changes: { name?: string; color?: BookmarkColor }): boolean {
    const group = this.#groups.find((entry) => entry.id === id);
    if (!group) return false;
    const changed = this.#applyLabel(group, changes);
    if (changed) this.#commit();
    return changed;
  }

  /** Deletes the group and its items. */
  deleteGroup(id: string): boolean {
    const group = this.#groups.find((entry) => entry.id === id);
    if (!group) return false;
    this.#items = this.#items.filter((item) => item.groupId !== id);
    this.#groups = this.#groups.filter((entry) => entry.id !== id);
    renumber(this.#groupsOf(group.spaceId));
    this.#commit();
    return true;
  }

  /** Moves a group into `spaceId` before the group `beforeId`, or to the end. */
  moveGroup(id: string, spaceId: string, beforeId: string | null): boolean {
    const group = this.#groups.find((entry) => entry.id === id);
    if (!group || !this.#spaces.some((space) => space.id === spaceId)) return false;
    const from = group.spaceId;
    group.spaceId = spaceId;
    let changed = place(this.#groupsOf(spaceId), group, beforeId);
    if (from !== spaceId) {
      renumber(this.#groupsOf(from));
      changed = true;
    }
    if (changed) this.#commit();
    return changed;
  }

  // ---- Items --------------------------------------------------------------

  createItem(groupId: string, beforeId: string | null, input: BookmarkItemInput): string | null {
    if (!this.#groups.some((group) => group.id === groupId)) return null;
    const item = this.#addItem(groupId, input);
    if (!item) return null;
    place(this.#itemsOf(groupId), item, beforeId);
    this.#commit();
    return item.id;
  }

  /** `title` and `url` apply to links, `text` to notes and to-dos, `done` to to-dos. */
  updateItem(id: string, changes: ItemChanges): boolean {
    const item = this.#items.find((entry) => entry.id === id);
    if (!item) return false;
    let changed = false;
    if (item.kind === 'link') {
      if (changes.url !== undefined && isLinkUrl(changes.url) && changes.url !== item.url) {
        item.url = changes.url;
        delete item.favIconUrl;
        changed = true;
      }
      if (changes.title !== undefined) {
        const title = changes.title.trim() || item.url;
        if (title !== item.title) {
          item.title = title;
          changed = true;
        }
      }
    } else {
      if (changes.text !== undefined && changes.text !== item.text) {
        item.text = changes.text;
        changed = true;
      }
      if (item.kind === 'todo' && changes.done !== undefined && changes.done !== item.done) {
        item.done = changes.done;
        changed = true;
      }
    }
    if (changed) this.#commit();
    return changed;
  }

  deleteItem(id: string): boolean {
    const item = this.#items.find((entry) => entry.id === id);
    if (!item) return false;
    this.#items = this.#items.filter((entry) => entry.id !== id);
    renumber(this.#itemsOf(item.groupId));
    this.#commit();
    return true;
  }

  /** Moves an item into `groupId` before the item `beforeId`, or to the end. */
  moveItem(id: string, groupId: string, beforeId: string | null): boolean {
    const item = this.#items.find((entry) => entry.id === id);
    if (!item || !this.#groups.some((group) => group.id === groupId)) return false;
    const from = item.groupId;
    item.groupId = groupId;
    let changed = place(this.#itemsOf(groupId), item, beforeId);
    if (from !== groupId) {
      renumber(this.#itemsOf(from));
      changed = true;
    }
    if (changed) this.#commit();
    return changed;
  }

  // ---- Bulk ---------------------------------------------------------------

  /**
   * Saves open tabs as links at the end of `groupId`, or of a new group "Saved tabs" in
   * `spaceId` when it is null. Closed tabs, private tabs and tabs without a savable web URL
   * are skipped, and no group is created when nothing is left to save.
   */
  async saveTabs(spaceId: string, groupId: string | null, tabIds: number[]): Promise<void> {
    if (!this.#spaces.some((space) => space.id === spaceId)) return;
    const tabs = await Promise.all(
      [...new Set(tabIds)].map((tabId) => browser.tabs.get(tabId).catch(() => null)),
    );
    const links: Array<Extract<BookmarkItemInput, { kind: 'link' }>> = [];
    for (const tab of tabs) {
      if (!tab || tab.incognito || !isSavableTabUrl(tab.url)) continue;
      const favIconUrl = cleanFavIconUrl(tab.favIconUrl);
      links.push({
        kind: 'link',
        url: tab.url,
        title: tab.title ?? '',
        ...(favIconUrl ? { favIconUrl } : {}),
      });
    }
    // The space or group may have been deleted while the tabs were read.
    if (links.length === 0 || !this.#spaces.some((space) => space.id === spaceId)) return;
    let target: BookmarkGroup | undefined;
    if (groupId === null) {
      target = this.#addGroup(spaceId, SAVED_TABS_GROUP_NAME);
    } else {
      target = this.#groups.find((group) => group.id === groupId && group.spaceId === spaceId);
      if (!target) return;
    }
    for (const link of links) this.#addItem(target.id, link);
    this.#commit();
  }

  /** Imports the Firefox bookmark folders into a new, selected space and marks the offer as taken. */
  async importFirefox(): Promise<void> {
    if (this.#importing) return;
    this.#importing = true;
    try {
      const tree = await browser.bookmarks.getTree();
      const space = this.#addSpace(FIREFOX_SPACE_NAME);
      for (const folder of firefoxFolders(tree, MAX_IMPORTED_LINKS)) {
        const group = this.#addGroup(space.id, folder.name);
        for (const link of folder.links) this.#addItem(group.id, { kind: 'link', ...link });
      }
      this.#lastSpaceId = space.id;
      this.#firefoxImportOffered = true;
      this.#commit();
    } catch (err) {
      // The offer stays open so the user can try again.
      console.warn('[bento-tools] bookmarks: Firefox import failed:', err);
    } finally {
      this.#importing = false;
    }
  }

  /** Declines the Firefox import offer. */
  dismissImport(): boolean {
    if (this.#firefoxImportOffered) return false;
    this.#firefoxImportOffered = true;
    this.#commit();
    return true;
  }

  // ---- Internals ----------------------------------------------------------

  #groupsOf(spaceId: string): BookmarkGroup[] {
    return this.#groups.filter((group) => group.spaceId === spaceId).sort(byOrder);
  }

  #itemsOf(groupId: string): BookmarkItem[] {
    return this.#items.filter((item) => item.groupId === groupId).sort(byOrder);
  }

  /** Applies a trimmed non-empty name and a colour; true when either changed. */
  #applyLabel(
    entry: BookmarkSpace | BookmarkGroup,
    changes: { name?: string; color?: BookmarkColor },
  ): boolean {
    let changed = false;
    const name = changes.name?.trim();
    if (name && name !== entry.name) {
      entry.name = name;
      changed = true;
    }
    if (changes.color !== undefined && changes.color !== entry.color) {
      entry.color = changes.color;
      changed = true;
    }
    return changed;
  }

  /** Appends a space and returns it. Callers commit. */
  #addSpace(name: string): BookmarkSpace {
    const space: BookmarkSpace = {
      id: crypto.randomUUID(),
      name,
      color: 'gray',
      order: this.#spaces.length,
    };
    this.#spaces.push(space);
    return space;
  }

  #seedSpace(): void {
    this.#lastSpaceId = this.#addSpace(DEFAULT_SPACE_NAME).id;
  }

  /** Appends a group to a space and returns it. Callers commit. */
  #addGroup(spaceId: string, name: string): BookmarkGroup {
    const group: BookmarkGroup = {
      id: crypto.randomUUID(),
      spaceId,
      name,
      color: 'gray',
      order: this.#groupsOf(spaceId).length,
    };
    this.#groups.push(group);
    return group;
  }

  /** Appends an item to a group and returns it, or null when a link's URL is not allowed. */
  #addItem(groupId: string, input: BookmarkItemInput): BookmarkItem | null {
    const base = {
      id: crypto.randomUUID(),
      groupId,
      order: this.#itemsOf(groupId).length,
      createdAt: Date.now(),
    };
    let item: BookmarkItem;
    switch (input.kind) {
      case 'link': {
        if (!isLinkUrl(input.url)) return null;
        const favIconUrl = cleanFavIconUrl(input.favIconUrl);
        item = {
          ...base,
          kind: 'link',
          url: input.url,
          title: input.title.trim() || input.url,
          ...(favIconUrl ? { favIconUrl } : {}),
        };
        break;
      }
      case 'note':
        item = { ...base, kind: 'note', text: input.text };
        break;
      case 'todo':
        item = { ...base, kind: 'todo', text: input.text, done: false };
        break;
    }
    this.#items.push(item);
    return item;
  }

  #commit(): void {
    const snapshot = this.snapshot();
    if (this.#canPersist) this.#persistence.schedule(snapshot);
    this.#emit(snapshot);
  }

  #emit(snapshot: BookmarksSnapshot): void {
    for (const listener of this.#listeners) listener(snapshot);
  }
}
