// Source of truth for the Bookmarks manager: spaces hold groups, groups hold links, notes
// and to-dos. State lives in storage.local (`bento.bookmarks.v1`) and is independent of
// Firefox's own bookmarks; the shell mirrors it through `bookmarks/snapshot`. Every
// mutation validates its ids, renumbers the affected siblings densely (0..n-1) and, when
// something changed, notifies listeners with the full snapshot and writes it to storage.
//
// Load: the store starts `loading`. `init()` reads storage and settles as `ready` (loaded, or
// seeded on first run) or `loadFailed` (storage unreadable: no data, every mutation refused,
// nothing written, `init()` retries). `afterInit` holds shell actions until the load settles so
// none can run against, and then overwrite, data that has not been read yet.
import type {
  BookmarkColor,
  BookmarkGroup,
  BookmarkItem,
  BookmarkItemInput,
  BookmarkSpace,
  BookmarksSnapshot,
} from '@shared/protocol';
import { normalizeName, normalizeText, normalizeTitle } from './fields';
import { firefoxFolders } from './firefoxImport';
import { cleanFavIconUrl, isLinkUrl, isSavableTabUrl } from './links';
import { Persistence, load, type BookmarksData } from './Persistence';

type Listener = (snapshot: BookmarksSnapshot) => void;

const DEFAULT_SPACE_NAME = 'Personal';
const SAVED_TABS_GROUP_NAME = 'Saved tabs';
const FIREFOX_SPACE_NAME = 'Firefox bookmarks';
const MAX_IMPORTED_LINKS = 2000;

type Status = 'loading' | 'ready' | 'loadFailed';

export interface SaveTabsOptions {
  /** Insert before this item of the target group; the end when absent, null or not in the group. */
  beforeId?: string | null;
  /** Client ids matched to `tabIds` by index (see `saveTabs`). */
  ids?: string[];
}

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
  #status: Status = 'loading';
  #loading: Promise<void> | null = null;
  /** Actions that arrived while loading, run in arrival order when the load settles. */
  #queue: Array<() => void> = [];
  #importing = false;

  /**
   * Loads the stored state, or seeds one empty space on first run, and tells listeners. Resolves
   * when the load has settled and never rejects. When storage cannot be read the store becomes
   * `loadFailed` and a later call retries. A no-op once loaded.
   */
  init(): Promise<void> {
    if (this.#status === 'ready') return Promise.resolve();
    this.#loading ??= this.#load();
    return this.#loading;
  }

  /** Runs `run` now when the load has settled (ready or failed), else once it settles, after the
   * actions queued before it. */
  afterInit(run: () => void): void {
    if (this.#status === 'loading') this.#queue.push(run);
    else run();
  }

  /** A copy of the state with every array sorted by `order`. While the data is not loaded the
   * arrays are empty and `status` is `loadFailed`; nothing observes that before the load settles. */
  snapshot(): BookmarksSnapshot {
    return { status: this.#status === 'ready' ? 'ready' : 'loadFailed', ...this.#data() };
  }

  /** Subscribe to state changes; the callback receives the full new snapshot. */
  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Writes any unwritten change now (tests). Writes already happen on every change. */
  flush(): Promise<void> {
    return this.#persistence.flush();
  }

  /** The URL of a link item, or null when the id is not a link. */
  linkUrl(id: string): string | null {
    const item = this.#items.find((entry) => entry.id === id);
    return item?.kind === 'link' && isLinkUrl(item.url) ? item.url : null;
  }

  // ---- Spaces -------------------------------------------------------------
  //
  // Every mutation returns false or null without changing anything while the store is not
  // `ready`. The create methods take an optional client `id`: refused (null) when it exists.

  createSpace(name: string, id?: string): string | null {
    if (!this.#canCreate(id)) return null;
    const space = this.#addSpace(normalizeName(name, 'Untitled space'), id);
    this.#commit();
    return space.id;
  }

  updateSpace(id: string, changes: { name?: string; color?: BookmarkColor }): boolean {
    const space = this.#spaces.find((entry) => entry.id === id);
    if (!space || this.#status !== 'ready') return false;
    const changed = this.#applyLabel(space, changes);
    if (changed) this.#commit();
    return changed;
  }

  /** Deletes the space with its groups and their items. Deleting the last space leaves a fresh
   * empty "Personal", so there is always one. */
  deleteSpace(id: string): boolean {
    if (this.#status !== 'ready' || !this.#spaces.some((space) => space.id === id)) return false;
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
    if (this.#status !== 'ready') return false;
    if (!this.#spaces.some((space) => space.id === id) || this.#lastSpaceId === id) return false;
    this.#lastSpaceId = id;
    this.#commit();
    return true;
  }

  // ---- Groups -------------------------------------------------------------

  createGroup(spaceId: string, name: string, id?: string): string | null {
    if (!this.#canCreate(id) || !this.#spaces.some((space) => space.id === spaceId)) return null;
    const group = this.#addGroup(spaceId, normalizeName(name, 'Untitled group'), id);
    this.#commit();
    return group.id;
  }

  updateGroup(id: string, changes: { name?: string; color?: BookmarkColor }): boolean {
    const group = this.#groups.find((entry) => entry.id === id);
    if (!group || this.#status !== 'ready') return false;
    const changed = this.#applyLabel(group, changes);
    if (changed) this.#commit();
    return changed;
  }

  /** Deletes the group and its items. */
  deleteGroup(id: string): boolean {
    const group = this.#groups.find((entry) => entry.id === id);
    if (!group || this.#status !== 'ready') return false;
    this.#items = this.#items.filter((item) => item.groupId !== id);
    this.#groups = this.#groups.filter((entry) => entry.id !== id);
    renumber(this.#groupsOf(group.spaceId));
    this.#commit();
    return true;
  }

  /** Moves a group into `spaceId` before the group `beforeId`, or to the end. */
  moveGroup(id: string, spaceId: string, beforeId: string | null): boolean {
    const group = this.#groups.find((entry) => entry.id === id);
    if (!group || this.#status !== 'ready') return false;
    if (!this.#spaces.some((space) => space.id === spaceId)) return false;
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

  createItem(
    groupId: string,
    beforeId: string | null,
    input: BookmarkItemInput,
    id?: string,
  ): string | null {
    if (!this.#canCreate(id) || !this.#groups.some((group) => group.id === groupId)) return null;
    const item = this.#makeItem(groupId, input, id);
    if (!item) return null;
    this.#insertItems(groupId, [item], beforeId);
    this.#commit();
    return item.id;
  }

  /** `title` and `url` apply to links, `text` to notes and to-dos, `done` to to-dos. Text is
   * capped as on create. */
  updateItem(id: string, changes: ItemChanges): boolean {
    const item = this.#items.find((entry) => entry.id === id);
    if (!item || this.#status !== 'ready') return false;
    let changed = false;
    if (item.kind === 'link') {
      if (changes.url !== undefined && isLinkUrl(changes.url) && changes.url !== item.url) {
        item.url = changes.url;
        delete item.favIconUrl;
        changed = true;
      }
      if (changes.title !== undefined) {
        const title = normalizeTitle(changes.title, item.url);
        if (title !== item.title) {
          item.title = title;
          changed = true;
        }
      }
    } else {
      if (changes.text !== undefined) {
        const text = normalizeText(changes.text);
        if (text !== item.text) {
          item.text = text;
          changed = true;
        }
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
    if (!item || this.#status !== 'ready') return false;
    this.#items = this.#items.filter((entry) => entry.id !== id);
    renumber(this.#itemsOf(item.groupId));
    this.#commit();
    return true;
  }

  /** Moves an item into `groupId` before the item `beforeId`, or to the end. */
  moveItem(id: string, groupId: string, beforeId: string | null): boolean {
    const item = this.#items.find((entry) => entry.id === id);
    if (!item || this.#status !== 'ready') return false;
    if (!this.#groups.some((group) => group.id === groupId)) return false;
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
   * Saves open tabs as links into `groupId`, or into a new group "Saved tabs" in `spaceId` when it
   * is null, as one change. Closed tabs, private tabs, tabs without a savable web URL and repeats
   * of an earlier tab id are skipped, and no group is created when nothing is left to save.
   * Returns the ids of the saved links, in order.
   *
   * - `beforeId`: the links go in, in `tabIds` order, before that item of the target group; at the
   *   end when it is absent, null or not in the group. A new group has nothing to be before.
   * - `ids`: client ids matched to `tabIds` by index. The link saved from `tabIds[i]` gets
   *   `ids[i]`. A skipped tab leaves its slot unused and does not shift the others. A tab whose
   *   slot is missing (`ids` shorter than `tabIds`) gets a generated id. When any entry of `ids`
   *   already exists or repeats, nothing is saved.
   */
  async saveTabs(
    spaceId: string,
    groupId: string | null,
    tabIds: number[],
    { beforeId = null, ids = [] }: SaveTabsOptions = {},
  ): Promise<string[]> {
    if (this.#status !== 'ready' || !this.#spaces.some((space) => space.id === spaceId)) return [];
    const firsts = new Map<number, number>();
    tabIds.forEach((tabId, index) => {
      if (!firsts.has(tabId)) firsts.set(tabId, index);
    });
    const tabs = await Promise.all(
      [...firsts.keys()].map((tabId) => browser.tabs.get(tabId).catch(() => null)),
    );
    const slots = [...firsts.values()];
    const links: Array<{ id: string | undefined; input: BookmarkItemInput }> = [];
    tabs.forEach((tab, at) => {
      if (!tab || tab.incognito || !isSavableTabUrl(tab.url)) return;
      const favIconUrl = cleanFavIconUrl(tab.favIconUrl);
      links.push({
        id: ids[slots[at]!],
        input: {
          kind: 'link',
          url: tab.url,
          title: tab.title ?? '',
          ...(favIconUrl ? { favIconUrl } : {}),
        },
      });
    });
    // The store may have changed while the tabs were read: the space or group may be gone, and
    // another action may have taken a client id.
    if (links.length === 0 || this.#status !== 'ready') return [];
    if (!this.#spaces.some((space) => space.id === spaceId)) return [];
    const taken = this.#allIds();
    if (new Set(ids).size !== ids.length || ids.some((id) => taken.has(id))) return [];
    let target: BookmarkGroup | undefined;
    if (groupId === null) {
      target = this.#addGroup(spaceId, SAVED_TABS_GROUP_NAME);
    } else {
      target = this.#groups.find((group) => group.id === groupId && group.spaceId === spaceId);
      if (!target) return [];
    }
    const items = this.#makeItems(
      target.id,
      links.map((link) => link.input),
      links.map((link) => link.id),
    );
    this.#insertItems(target.id, items, groupId === null ? null : beforeId);
    this.#commit();
    return items.map((item) => item.id);
  }

  /** Imports the Firefox bookmark folders into a new, selected space and marks the offer as taken. */
  async importFirefox(): Promise<void> {
    if (this.#importing || this.#status !== 'ready') return;
    this.#importing = true;
    try {
      const tree = await browser.bookmarks.getTree();
      const space = this.#addSpace(FIREFOX_SPACE_NAME);
      for (const folder of firefoxFolders(tree, MAX_IMPORTED_LINKS)) {
        const group = this.#addGroup(space.id, normalizeName(folder.name, 'Untitled folder'));
        const inputs = folder.links.map((link) => ({ kind: 'link' as const, ...link }));
        this.#insertItems(group.id, this.#makeItems(group.id, inputs), null);
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
    if (this.#status !== 'ready' || this.#firefoxImportOffered) return false;
    this.#firefoxImportOffered = true;
    this.#commit();
    return true;
  }

  // ---- Internals ----------------------------------------------------------

  async #load(): Promise<void> {
    this.#status = 'loading';
    let stored: BookmarksData | null = null;
    let failed = false;
    try {
      stored = await load();
    } catch (err) {
      failed = true;
      console.error(
        '[bento-tools] bookmarks: load failed, changes are refused until it loads:',
        err,
      );
    }
    this.#loading = null;
    if (failed) {
      this.#status = 'loadFailed';
      this.#emit(this.snapshot());
    } else if (stored) {
      this.#status = 'ready';
      this.#spaces = stored.spaces;
      this.#groups = stored.groups;
      this.#items = stored.items;
      this.#lastSpaceId = stored.lastSpaceId;
      this.#firefoxImportOffered = stored.firefoxImportOffered;
      this.#emit(this.snapshot());
    } else {
      this.#status = 'ready';
      this.#seedSpace();
      this.#commit();
    }
    for (const run of this.#queue.splice(0)) {
      try {
        run();
      } catch (err) {
        console.error('[bento-tools] bookmarks: queued action failed:', err);
      }
    }
  }

  #data(): BookmarksData {
    return {
      spaces: this.#spaces.map((space) => ({ ...space })).sort(byOrder),
      groups: this.#groups.map((group) => ({ ...group })).sort(byOrder),
      items: this.#items.map((item) => ({ ...item })).sort(byOrder),
      lastSpaceId: this.#lastSpaceId,
      firefoxImportOffered: this.#firefoxImportOffered,
    };
  }

  /** True when a create may go ahead: the store is ready and the client id, if any, is free. */
  #canCreate(id: string | undefined): boolean {
    return this.#status === 'ready' && (id === undefined || !this.#idTaken(id));
  }

  /** Space, group and item ids share one namespace, so a client id cannot alias another entity. */
  #idTaken(id: string): boolean {
    return this.#allIds().has(id);
  }

  #allIds(): Set<string> {
    return new Set([...this.#spaces, ...this.#groups, ...this.#items].map((entry) => entry.id));
  }

  #groupsOf(spaceId: string): BookmarkGroup[] {
    return this.#groups.filter((group) => group.spaceId === spaceId).sort(byOrder);
  }

  #itemsOf(groupId: string): BookmarkItem[] {
    return this.#items.filter((item) => item.groupId === groupId).sort(byOrder);
  }

  /** Applies a name (trimmed, capped, never blank) and a colour; true when either changed. */
  #applyLabel(
    entry: BookmarkSpace | BookmarkGroup,
    changes: { name?: string; color?: BookmarkColor },
  ): boolean {
    let changed = false;
    const name = changes.name === undefined ? '' : normalizeName(changes.name, '');
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
  #addSpace(name: string, id: string = crypto.randomUUID()): BookmarkSpace {
    const space: BookmarkSpace = { id, name, color: 'gray', order: this.#spaces.length };
    this.#spaces.push(space);
    return space;
  }

  #seedSpace(): void {
    this.#lastSpaceId = this.#addSpace(DEFAULT_SPACE_NAME).id;
  }

  /** Appends a group to a space and returns it. Callers commit. */
  #addGroup(spaceId: string, name: string, id: string = crypto.randomUUID()): BookmarkGroup {
    const group: BookmarkGroup = {
      id,
      spaceId,
      name,
      color: 'gray',
      order: this.#groupsOf(spaceId).length,
    };
    this.#groups.push(group);
    return group;
  }

  /** Builds an item for a group, with every field capped, or null when a link's URL is not
   * allowed. It is not stored: `#insertItems` places it. */
  #makeItem(
    groupId: string,
    input: BookmarkItemInput,
    id: string = crypto.randomUUID(),
  ): BookmarkItem | null {
    const base = { id, groupId, order: 0, createdAt: Date.now() };
    switch (input.kind) {
      case 'link': {
        if (!isLinkUrl(input.url)) return null;
        const favIconUrl = cleanFavIconUrl(input.favIconUrl);
        return {
          ...base,
          kind: 'link',
          url: input.url,
          title: normalizeTitle(input.title, input.url),
          ...(favIconUrl ? { favIconUrl } : {}),
        };
      }
      case 'note':
        return { ...base, kind: 'note', text: normalizeText(input.text) };
      case 'todo':
        return {
          ...base,
          kind: 'todo',
          text: normalizeText(input.text),
          done: input.done === true,
        };
    }
  }

  /** `#makeItem` for each input, skipping any that are refused. `ids[i]` is the client id of
   * `inputs[i]`, when given. */
  #makeItems(
    groupId: string,
    inputs: BookmarkItemInput[],
    ids: Array<string | undefined> = [],
  ): BookmarkItem[] {
    return inputs.flatMap((input, index) => this.#makeItem(groupId, input, ids[index]) ?? []);
  }

  /** Stores `items` as one run in `groupId`, before the item `beforeId` or at the end, and
   * renumbers the group. */
  #insertItems(groupId: string, items: BookmarkItem[], beforeId: string | null): void {
    const siblings = this.#itemsOf(groupId);
    const at = beforeId === null ? -1 : siblings.findIndex((entry) => entry.id === beforeId);
    siblings.splice(at === -1 ? siblings.length : at, 0, ...items);
    for (const item of items) this.#items.push(item);
    renumber(siblings);
  }

  #commit(): void {
    const data = this.#data();
    this.#persistence.schedule(data);
    this.#emit({ status: 'ready', ...data });
  }

  #emit(snapshot: BookmarksSnapshot): void {
    for (const listener of this.#listeners) listener(snapshot);
  }
}
