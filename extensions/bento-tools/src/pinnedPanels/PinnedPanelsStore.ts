// Source-of-truth store for pinned panel bindings. Pinned panels are
// GLOBAL across workspaces (every workspace's sidebar sees the same list);
// each entry starts keyed by `(workspaceId, tabId)` and refers to a panel
// binding owned by PanelStore. If the panel/tab is later closed, the pin
// remains URL-backed and can be rebound to a replacement tab when opened.
//
// Persistence: tab IDs aren't stable across browser restarts, so the
// in-memory store keeps tabIds (efficient runtime) but the persistence
// layer stores URLs. The boot-time restorer (background.ts) holds the
// persisted entries in a hold-pen and matches URLs back to live tabIds
// per-workspace as each workspace's panels are restored.

import type { PinnedPanelDelta, PinnedPanelEntry } from '@shared/protocol';
import { Persistence, type PersistedPinnedEntry, load } from './Persistence';

type Listener = (deltas: PinnedPanelDelta[]) => void;

interface PendingPersistedEntry {
  workspaceId: string;
  panelKey?: string;
  url: string;
  order: number;
  title?: string;
  favIconUrl?: string;
  widthPx?: number;
}

interface PinnedPanelsStoreOptions {
  getPanelKey?: (workspaceId: string, tabId: number) => string | undefined;
}

export class PinnedPanelsStore {
  /** Live entries keyed by "wsId\\0tabId" for O(1) duplicate check. */
  #byKey = new Map<string, PinnedPanelEntry>();
  /** Monotonic counter used for new entries' `order`. Initialized at boot
   * from the max persisted order so restored entries keep their original
   * positions and new pins append after them. */
  #nextOrder = 0;
  /** Persisted entries from last shutdown, grouped by workspaceId. The
   * boot restorer (background.ts) consumes from here as each workspace's
   * panels finish restoring — see `recoverTabIdsAfterPanelRestore`. */
  #pendingByWorkspace = new Map<string, PendingPersistedEntry[]>();
  #nextSyntheticTabId = -1;
  #pending: PinnedPanelDelta[] = [];
  #flushScheduled = false;
  #listeners = new Set<Listener>();
  #persistence = new Persistence();
  #getPanelKey: ((workspaceId: string, tabId: number) => string | undefined) | undefined;

  constructor(options: PinnedPanelsStoreOptions = {}) {
    this.#getPanelKey = options.getPanelKey;
  }

  async init(): Promise<void> {
    const persisted = await load();
    if (!persisted) return;
    let maxOrder = -1;
    for (const e of persisted.entries) {
      if (e.order > maxOrder) maxOrder = e.order;
      const list = this.#pendingByWorkspace.get(e.workspaceId) ?? [];
      list.push({
        workspaceId: e.workspaceId,
        panelKey: e.panelKey,
        url: e.url,
        order: e.order,
        title: e.title,
        favIconUrl: e.favIconUrl,
        widthPx: e.widthPx,
      });
      this.#pendingByWorkspace.set(e.workspaceId, list);
    }
    this.#nextOrder = maxOrder + 1;
  }

  onDeltas(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Snapshot of live entries, ordered ascending by `order`. */
  entries(): PinnedPanelEntry[] {
    return Array.from(this.#byKey.values()).sort((a, b) => a.order - b.order);
  }

  /** Live tab IDs pinned in a specific workspace, in `order` ascending.
   * Used by chrome's kebab menu (Pin vs Unpin label) via the
   * `panels/sync.pinnedTabIdsInWorkspace` payload. */
  entriesForWorkspace(workspaceId: string): number[] {
    const out: PinnedPanelEntry[] = [];
    for (const entry of this.#byKey.values()) {
      if (entry.workspaceId === workspaceId) out.push(entry);
    }
    out.sort((a, b) => a.order - b.order);
    return out.map((e) => e.tabId).filter((tabId) => tabId >= 0);
  }

  entriesForWorkspaceDetailed(workspaceId: string): PinnedPanelEntry[] {
    return Array.from(this.#byKey.values())
      .filter((entry) => entry.workspaceId === workspaceId)
      .sort((a, b) => a.order - b.order);
  }

  has(workspaceId: string, tabId: number): boolean {
    return this.#byKey.has(this.#key(workspaceId, tabId));
  }

  get(workspaceId: string, tabId: number): PinnedPanelEntry | undefined {
    return this.#byKey.get(this.#key(workspaceId, tabId));
  }

  /** Append a pin. No-op (returns false) if `(workspaceId, tabId)` is
   * already pinned. Validation that the tab is actually a panel in that
   * workspace lives in the protocol handler — keeping it out here makes
   * the boot restorer's "I already know this URL matched a real panel"
   * path cheap. */
  add(
    workspaceId: string,
    tabId: number,
    metadata: Pick<PinnedPanelEntry, 'url' | 'title' | 'favIconUrl' | 'widthPx'> = {},
  ): boolean {
    const key = this.#key(workspaceId, tabId);
    if (this.#byKey.has(key)) return false;
    const entry: PinnedPanelEntry = {
      workspaceId,
      tabId,
      order: this.#nextOrder++,
      ...metadata,
    };
    this.#byKey.set(key, entry);
    this.#enqueue({ kind: 'added', entry });
    this.#schedulePersist();
    return true;
  }

  rebindTabId(
    workspaceId: string,
    oldTabId: number,
    newTabId: number,
    metadata: Pick<PinnedPanelEntry, 'url' | 'title' | 'favIconUrl' | 'widthPx'> = {},
  ): boolean {
    const oldKey = this.#key(workspaceId, oldTabId);
    const existing = this.#byKey.get(oldKey);
    if (!existing) return false;
    const newKey = this.#key(workspaceId, newTabId);
    const next: PinnedPanelEntry = {
      ...existing,
      ...metadata,
      workspaceId,
      tabId: newTabId,
    };
    this.#byKey.delete(oldKey);
    this.#byKey.set(newKey, next);
    this.#enqueue({ kind: 'removed', workspaceId, tabId: oldTabId });
    this.#enqueue({ kind: 'added', entry: next });
    this.#schedulePersist();
    return true;
  }

  updateMetadataForTab(
    tabId: number,
    metadata: Pick<PinnedPanelEntry, 'title' | 'favIconUrl'>,
  ): boolean {
    let changed = false;
    for (const [key, entry] of Array.from(this.#byKey.entries())) {
      if (entry.tabId !== tabId) continue;
      const next: PinnedPanelEntry = { ...entry };
      if (metadata.title && metadata.title !== entry.title) next.title = metadata.title;
      if (metadata.favIconUrl && metadata.favIconUrl !== entry.favIconUrl) {
        next.favIconUrl = metadata.favIconUrl;
      }
      if (next.title === entry.title && next.favIconUrl === entry.favIconUrl) continue;
      this.#byKey.set(key, next);
      this.#enqueue({
        kind: 'updated',
        workspaceId: entry.workspaceId,
        tabId,
        changes: {
          title: next.title,
          favIconUrl: next.favIconUrl,
        },
      });
      changed = true;
    }
    if (changed) this.#schedulePersist();
    return changed;
  }

  updateWidthForTab(tabId: number, widthPx: number): boolean {
    if (!Number.isFinite(widthPx) || widthPx <= 0) return false;
    const rounded = Math.round(widthPx);
    let changed = false;
    for (const [key, entry] of Array.from(this.#byKey.entries())) {
      if (entry.tabId !== tabId || entry.widthPx === rounded) continue;
      const next: PinnedPanelEntry = { ...entry, widthPx: rounded };
      this.#byKey.set(key, next);
      this.#enqueue({
        kind: 'updated',
        workspaceId: entry.workspaceId,
        tabId,
        changes: { widthPx: rounded },
      });
      changed = true;
    }
    if (changed) this.#schedulePersist();
    return changed;
  }

  /** Remove a single pin. Returns true when something was removed. */
  remove(workspaceId: string, tabId: number): boolean {
    const key = this.#key(workspaceId, tabId);
    if (!this.#byKey.delete(key)) return false;
    this.#enqueue({ kind: 'removed', workspaceId, tabId });
    this.#schedulePersist();
    return true;
  }

  /** Drop every pin belonging to a workspace. Called when the workspace
   * is deleted (with or without its tabs). */
  removeForWorkspace(workspaceId: string): boolean {
    let removed = false;
    // Also drop any unconsumed persisted entries for this workspace so a
    // later activation of a same-id workspace (deleted-then-restored) does
    // not resurrect the old pins.
    if (this.#pendingByWorkspace.delete(workspaceId)) {
      removed = true;
    }
    for (const [key, entry] of Array.from(this.#byKey.entries())) {
      if (entry.workspaceId !== workspaceId) continue;
      this.#byKey.delete(key);
      this.#enqueue({ kind: 'removed', workspaceId, tabId: entry.tabId });
      removed = true;
    }
    if (removed) this.#schedulePersist();
    return removed;
  }

  /** Explicitly drop every pin pointing at this tabId. Normal tab/panel
   * closure intentionally does NOT call this: pinned rail entries survive
   * closure and can be removed only from the pinned rail context menu. */
  removeForTab(tabId: number): boolean {
    let removed = false;
    for (const [key, entry] of Array.from(this.#byKey.entries())) {
      if (entry.tabId !== tabId) continue;
      this.#byKey.delete(key);
      this.#enqueue({ kind: 'removed', workspaceId: entry.workspaceId, tabId });
      removed = true;
    }
    if (removed) this.#schedulePersist();
    return removed;
  }

  /** After PanelStore has restored a workspace's panels and the caller has
   * built a URL → tabId map, materialize persisted pins for that workspace.
   * Entries that no longer match a live panel remain as URL-backed pins
   * with synthetic negative tab ids until the user opens them. */
  recoverTabIdsAfterPanelRestore(
    workspaceId: string,
    restored:
      | Map<string, number>
      | { panelKeyToTabId: Map<string, number>; urlToTabId: Map<string, number> },
  ): void {
    const pending = this.#pendingByWorkspace.get(workspaceId);
    if (!pending) return;
    this.#pendingByWorkspace.delete(workspaceId);
    const panelKeyToTabId =
      restored instanceof Map ? new Map<string, number>() : restored.panelKeyToTabId;
    const urlToTabId = restored instanceof Map ? restored : restored.urlToTabId;
    // Track which tabIds we've already consumed so two persisted pins with
    // the same URL don't both bind to the same tab (defensive — duplicates
    // shouldn't exist in storage, but the live store enforces uniqueness
    // by key anyway).
    const consumed = new Set<number>();
    let dirty = false;
    for (const entry of pending) {
      const tabId =
        (entry.panelKey ? panelKeyToTabId.get(entry.panelKey) : undefined) ??
        urlToTabId.get(entry.url);
      const materializedTabId =
        typeof tabId === 'number' && !consumed.has(tabId) ? tabId : this.#nextSyntheticTabId--;
      if (typeof tabId === 'number') consumed.add(tabId);
      const key = this.#key(workspaceId, materializedTabId);
      if (this.#byKey.has(key)) continue;
      const live: PinnedPanelEntry = {
        workspaceId,
        tabId: materializedTabId,
        order: entry.order,
        url: entry.url,
        title: entry.title,
        favIconUrl: entry.favIconUrl,
        widthPx: entry.widthPx,
      };
      this.#byKey.set(key, live);
      this.#enqueue({ kind: 'added', entry: live });
      dirty = true;
    }
    if (dirty) this.#schedulePersist();
  }

  #key(workspaceId: string, tabId: number): string {
    return workspaceId + '\u0000' + tabId;
  }

  #enqueue(delta: PinnedPanelDelta): void {
    this.#pending.push(delta);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    const flush = () => {
      this.#flushScheduled = false;
      const batch = this.#pending;
      this.#pending = [];
      if (batch.length === 0) return;
      for (const l of this.#listeners) l(batch);
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 16);
    }
  }

  #schedulePersist(): void {
    // Persistence needs URLs, but we hold tabIds. The flush runs in the
    // debounce callback's async chain — resolve URLs there via browser.tabs.get
    // (same pattern as PanelStore's Persistence). Snapshot the entries
    // synchronously so the resolver sees state-at-schedule-time.
    const snapshot = Array.from(this.#byKey.values());
    void this.#resolveAndPersist(snapshot);
  }

  async #resolveAndPersist(snapshot: PinnedPanelEntry[]): Promise<void> {
    const resolved: PersistedPinnedEntry[] = [];
    for (const entry of snapshot) {
      try {
        const tab = await browser.tabs.get(entry.tabId);
        const url = tab.url || entry.url;
        if (!url || url === 'about:blank') continue;
        resolved.push({
          workspaceId: entry.workspaceId,
          panelKey: this.#getPanelKey?.(entry.workspaceId, entry.tabId),
          url,
          order: entry.order,
          title: tab.title || entry.title,
          favIconUrl: tab.favIconUrl || entry.favIconUrl,
          widthPx: entry.widthPx,
        });
      } catch {
        if (!entry.url || entry.url === 'about:blank') continue;
        resolved.push({
          workspaceId: entry.workspaceId,
          panelKey: this.#getPanelKey?.(entry.workspaceId, entry.tabId),
          url: entry.url,
          order: entry.order,
          title: entry.title,
          favIconUrl: entry.favIconUrl,
          widthPx: entry.widthPx,
        });
      }
    }
    this.#persistence.schedule({ entries: resolved });
  }
}
