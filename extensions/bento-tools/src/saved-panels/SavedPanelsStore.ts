// Source-of-truth store for the "Saved panels" bookmark folder. The folder
// lives under Firefox's "Other Bookmarks" root (PlacesUtils.bookmarks.unfiledGuid,
// well-known WebExtension id "unfiled_____"). The store ensures the folder
// exists, mirrors its child list, dedupes saves by URL, and broadcasts
// updates whenever the underlying bookmarks change — both Bento-driven
// (via `save()`) and user-driven (manual add/remove in Firefox's Library
// Manager, drag-and-drop, etc.) edits flow through the same listener path.
//
// The trailer iframe's React app reads from this store via the existing
// shell-tools port — no PlacesUtils call sites in chrome / shell, per
// CLAUDE.md's state-pattern guardrail.
import type { SavedPanelEntry } from '@shared/protocol';

type Listener = (items: SavedPanelEntry[]) => void;

/** Well-known Firefox WebExtension id for the "Other Bookmarks" root.
 * Stable across Firefox versions (matches PlacesUtils.bookmarks.unfiledGuid).
 * If the bookmarks API ever returns something different we fall back to a
 * tree walk in {@link findUnfiledRootId}. */
const UNFILED_ROOT_ID = 'unfiled_____';

/** Folder title we manage. Matched case-sensitively; if a user happens to
 * already have a "Saved panels" folder under Other Bookmarks we adopt it
 * rather than creating a parallel one. */
const FOLDER_TITLE = 'Saved panels';

function normalizeFaviconUrl(favIconUrl: string | undefined): string | undefined {
  if (!favIconUrl || favIconUrl.length === 0) return undefined;
  // `page-icon:` is chrome-privileged in Firefox. It works in some chrome
  // surfaces but not reliably from the moz-extension trailer iframe, so do
  // not forward it as an <img> src.
  if (favIconUrl.startsWith('page-icon:')) return undefined;
  return favIconUrl;
}

async function getOpenTabFaviconsByUrl(): Promise<Map<string, string>> {
  const favicons = new Map<string, string>();
  try {
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      const favIconUrl = normalizeFaviconUrl(tab.favIconUrl);
      if (tab.url && favIconUrl && !favicons.has(tab.url)) {
        favicons.set(tab.url, favIconUrl);
      }
    }
  } catch {
    // Treat favicon lookup as best-effort; bookmarks still render with
    // placeholders when no icon is available.
  }
  return favicons;
}

/** Resolve the WebExtension bookmark id for the unfiled bookmarks root.
 * Tries the well-known id first; on failure walks the tree looking for the
 * top-level child whose id ends with "unfiled" or matches the historical
 * pattern. Returns null when nothing matches — callers should bail gracefully
 * (e.g. log and skip), since we cannot create a parent folder. */
async function findUnfiledRootId(): Promise<string | null> {
  try {
    const [node] = await browser.bookmarks.get(UNFILED_ROOT_ID);
    if (node) return node.id;
  } catch {
    // fall through to tree walk
  }
  try {
    const tree = await browser.bookmarks.getTree();
    const root = tree[0];
    if (!root || !root.children) return null;
    for (const child of root.children) {
      // WebExtension id pattern for Firefox roots is name + padding
      // underscores; "unfiled_____" is the historical form.
      if (child.id.startsWith('unfiled')) return child.id;
    }
  } catch (err) {
    console.warn('[bento-tools] findUnfiledRootId: getTree failed:', err);
  }
  return null;
}

export class SavedPanelsStore {
  #folderId: string | null = null;
  #items: SavedPanelEntry[] = [];
  #favIconByUrl = new Map<string, string>();
  #listeners = new Set<Listener>();
  #initialized = false;

  /** Resolve the folder (creating it if missing), prime the list, and wire
   * the four browser.bookmarks listeners. Idempotent. */
  async init(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;

    const parentId = await findUnfiledRootId();
    if (!parentId) {
      console.warn(
        '[bento-tools] SavedPanelsStore.init: could not resolve unfiled bookmarks root — feature disabled this session',
      );
      return;
    }
    this.#folderId = await this.#findOrCreateFolder(parentId);
    if (!this.#folderId) return;
    await this.#refresh();

    // Listener subscribes to ALL bookmark events; the per-call filter checks
    // whether the affected bookmark is a child of our folder. Cheaper than
    // re-reading the tree on every event, and covers user edits made
    // outside Bento (Library Manager, sync from another device, etc.).
    const refreshIfInFolder = (info: { parentId?: string; oldParentId?: string }) => {
      // onChanged/onCreated carry { parentId }; onRemoved carries
      // { parentId } on the removeInfo; onMoved carries both
      // { parentId } (new) and { oldParentId } (old). Any match — old OR
      // new — could affect our list, so re-read on any hit.
      if (
        info.parentId === this.#folderId ||
        ('oldParentId' in info && info.oldParentId === this.#folderId)
      ) {
        void this.#refresh();
      }
    };
    browser.bookmarks.onCreated.addListener((_id, bookmark) => {
      refreshIfInFolder({ parentId: bookmark.parentId });
    });
    browser.bookmarks.onRemoved.addListener((_id, removeInfo) => {
      refreshIfInFolder({ parentId: removeInfo.parentId });
    });
    browser.bookmarks.onChanged.addListener(() => {
      // onChanged doesn't include parentId in changeInfo — re-resolve.
      // This is rarely fired (title/url edits) so the cost is negligible.
      void this.#refresh();
    });
    browser.bookmarks.onMoved.addListener((_id, moveInfo) => {
      refreshIfInFolder({
        parentId: moveInfo.parentId,
        oldParentId: moveInfo.oldParentId,
      });
    });
  }

  /** Subscribe to list-changed notifications. The callback receives the
   * full new list; subscribers replace their mirror state. */
  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Current items, in folder order. */
  list(): SavedPanelEntry[] {
    return this.#items.slice();
  }

  /** Save a URL into the folder. De-dupes silently — if a child with the
   * same URL already exists, this is a no-op (no event, no error).
   * Lazily recreates the folder when the user has deleted it via the
   * Library Manager between `init()` and this call. */
  async save(url: string, title: string, favIconUrl?: string): Promise<void> {
    const normalizedFaviconUrl = normalizeFaviconUrl(favIconUrl);
    if (normalizedFaviconUrl) this.#favIconByUrl.set(url, normalizedFaviconUrl);
    if (!this.#folderId) {
      // Folder was deleted by the user (or init never resolved one).
      // Re-locate the unfiled root and recreate so the next favicon row
      // refresh has somewhere to land. Without this the feature would
      // silently no-op for the rest of the session.
      const parentId = await findUnfiledRootId();
      if (!parentId) return;
      this.#folderId = await this.#findOrCreateFolder(parentId);
      if (!this.#folderId) return;
    }
    try {
      const children = await browser.bookmarks.getChildren(this.#folderId);
      if (children.some((c) => c.url === url)) {
        await this.#refresh();
        return;
      }
      // Title fallback: an empty title would render as the URL in the
      // bookmark UI, but we want SOMETHING readable in the tooltip. The
      // chrome dispatcher passes contentTitle || url, so this is mostly
      // defensive.
      const displayTitle = title.trim().length > 0 ? title : url;
      await browser.bookmarks.create({
        parentId: this.#folderId,
        title: displayTitle,
        url,
      });
      // No explicit emit — the onCreated listener above re-reads and
      // broadcasts, which keeps Bento-driven and user-driven saves
      // on a single code path.
    } catch (err) {
      console.warn('[bento-tools] SavedPanelsStore.save failed:', err);
    }
  }

  async #findOrCreateFolder(parentId: string): Promise<string | null> {
    try {
      const children = await browser.bookmarks.getChildren(parentId);
      const existing = children.find((c) => c.type === 'folder' && c.title === FOLDER_TITLE);
      if (existing) return existing.id;
      const created = await browser.bookmarks.create({
        parentId,
        title: FOLDER_TITLE,
        type: 'folder',
      });
      return created.id;
    } catch (err) {
      console.warn('[bento-tools] SavedPanelsStore.findOrCreateFolder failed:', err);
      return null;
    }
  }

  async #refresh(): Promise<void> {
    if (!this.#folderId) return;
    try {
      const children = await browser.bookmarks.getChildren(this.#folderId);
      const openTabFavicons = await getOpenTabFaviconsByUrl();
      const next: SavedPanelEntry[] = [];
      for (const c of children) {
        // Skip subfolders or separators a user may have added — the
        // trailer iframe only knows how to open URL items as panels.
        if (!c.url) continue;
        const favIconUrl = openTabFavicons.get(c.url) ?? this.#favIconByUrl.get(c.url);
        if (favIconUrl) this.#favIconByUrl.set(c.url, favIconUrl);
        next.push({
          id: c.id,
          title: c.title ?? c.url,
          url: c.url,
          ...(favIconUrl ? { favIconUrl } : {}),
        });
      }
      // Suppress emit when the content didn't actually change — bookmark
      // listeners fire for unrelated trees too (we filter inside the
      // listener, but onChanged has to re-read defensively because its
      // changeInfo lacks parentId).
      if (this.#sameItems(next)) return;
      this.#items = next;
      for (const l of this.#listeners) l(next.slice());
    } catch (err) {
      // Folder may have been deleted by the user (Library Manager).
      // Drop the cache + listener path so the next save() lazily
      // recreates it. We avoid recreating eagerly here because the
      // user might be mid-cleanup; the next explicit save signals
      // they want the folder back.
      console.warn('[bento-tools] SavedPanelsStore.refresh failed (folder gone?):', err);
      this.#folderId = null;
      this.#items = [];
      for (const l of this.#listeners) l([]);
    }
  }

  #sameItems(next: SavedPanelEntry[]): boolean {
    if (next.length !== this.#items.length) return false;
    for (let i = 0; i < next.length; i++) {
      const a = next[i]!;
      const b = this.#items[i]!;
      if (
        a.id !== b.id ||
        a.title !== b.title ||
        a.url !== b.url ||
        a.favIconUrl !== b.favIconUrl
      ) {
        return false;
      }
    }
    return true;
  }
}
