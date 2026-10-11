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
import {
  Persistence,
  isPersistablePinnedPanelUrl,
  type PersistedPinnedEntry,
  load,
} from './Persistence';

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

const METADATA_FIELDS = ['url', 'title', 'favIconUrl'] as const;
type MetadataField = (typeof METADATA_FIELDS)[number];
type PinMetadata = Partial<Record<MetadataField, string>>;

/** The freshest known value of each metadata field of a pin, with the persist
 * generation that saw it. */
type ObservedMetadata = Partial<Record<MetadataField, { value: string; generation: number }>>;

/** Metadata a mutation just wrote to the entry of one pin ("wsId\\0tabId"). */
type MetadataEdit = [key: string, metadata: PinMetadata];

/** What a `tabs.get` result says about a pin. A tab whose URL could not be stored
 * (`about:blank` before SessionStore sets the address, a DevTools toolbox) is not
 * the pinned page, so it says nothing, title and favicon included. Otherwise
 * Firefox's tab converter copies a title or favIconUrl only when it is truthy, so
 * on a completed tab a missing one means the page has none: it reads as an empty
 * value, which clears. A loading tab (or one of unknown status) may only lack it
 * for now, so a missing field says nothing and keeps the last value. */
function readTab({
  url,
  title,
  favIconUrl,
  status,
}: PinMetadata & { status?: string }): PinMetadata {
  if (!isPersistablePinnedPanelUrl(url)) return {};
  const missing = status === 'complete' ? '' : undefined;
  return { url, title: title ?? missing, favIconUrl: favIconUrl ?? missing };
}

interface PinnedPanelsStoreOptions {
  getPanelKey?: (workspaceId: string, tabId: number) => string | undefined;
}

export class PinnedPanelsStore {
  /** Live entries keyed by "wsId\\0tabId" for O(1) duplicate check. */
  #byKey = new Map<string, PinnedPanelEntry>();
  /** Next order assigned to an appended pin. Initialized at boot from the
   * persisted maximum and normalized after a user reorder. */
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
  /** Pinned tabs seen in a private window. Their metadata never reaches storage,
   * including the in-memory fallback used after the tab closes. */
  #privateTabIds = new Set<number>();
  /** Sequence of persist calls. Each call takes the next number before its
   * async tab lookups; only the call holding the highest number writes. */
  #persistGeneration = 0;
  /** Settles once every tab lookup started so far has finished. A write waits
   * for it, so what an older (superseded) call read is in `#observed` before the
   * newest call merges. It must settle to nothing: each call chains onto the
   * previous barrier, and a value would retain every earlier call's. */
  #lookupsSettled: Promise<void> = Promise.resolve();
  /** Freshest URL, title and favicon per pin ("wsId\\0tabId"), kept after the tab
   * closes and across superseded calls. Fed by tab reads and by mutations that set
   * metadata; per field, the higher persist generation wins, so neither a stale
   * read nor an old store value can replace a newer one. A field holds an empty
   * value after a tab read that cleared it. Membership and order always come from
   * the newest snapshot; this only supplies URL, title and favicon, with the
   * snapshot entry as the fallback for a field never observed. */
  #observed = new Map<string, ObservedMetadata>();
  /** Awaited persists (`persistCurrentState`), by generation, still waiting for a
   * write of their state or a newer one. While any exist, writes are flushed
   * instead of debounced. */
  #awaiting = new Map<number, () => void>();
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
      const tabId = this.#nextSyntheticTabId--;
      this.#byKey.set(this.#key(e.workspaceId, tabId), {
        workspaceId: e.workspaceId,
        tabId,
        order: e.order,
        url: e.url,
        title: e.title,
        favIconUrl: e.favIconUrl,
        widthPx: e.widthPx,
      });
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

  findByStableIdentity(
    workspaceId: string,
    identity: Pick<PinnedPanelEntry, 'tabId' | 'order' | 'url'>,
  ): PinnedPanelEntry | undefined {
    const byKey = this.get(workspaceId, identity.tabId);
    if (byKey) return byKey;
    for (const entry of this.#byKey.values()) {
      if (entry.workspaceId !== workspaceId) continue;
      if (entry.order !== identity.order) continue;
      if (entry.url !== identity.url) continue;
      return entry;
    }
    return undefined;
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
    this.#schedulePersist([[key, metadata]]);
    return true;
  }

  /** Replace the global rail order. The caller must supply every live entry
   * exactly once; rejecting partial or stale payloads prevents accidental pin
   * loss when two windows have the rail open. */
  reorder(orderedKeys: Array<Pick<PinnedPanelEntry, 'workspaceId' | 'tabId'>>): boolean {
    const current = this.entries();
    if (orderedKeys.length !== current.length) return false;

    const remaining = new Map<string, PinnedPanelEntry>();
    for (const entry of current) {
      remaining.set(this.#key(entry.workspaceId, entry.tabId), entry);
    }

    const reordered: PinnedPanelEntry[] = [];
    for (const identity of orderedKeys) {
      const key = this.#key(identity.workspaceId, identity.tabId);
      const entry = remaining.get(key);
      if (!entry) return false;
      remaining.delete(key);
      reordered.push(entry);
    }
    if (remaining.size !== 0) return false;
    if (reordered.every((entry, index) => entry === current[index])) return false;

    const normalized = reordered.map((entry, order) => ({ ...entry, order }));
    for (const entry of normalized) {
      this.#byKey.set(this.#key(entry.workspaceId, entry.tabId), entry);
    }
    this.#nextOrder = normalized.length;
    this.#enqueue({ kind: 'reordered', entries: normalized });
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
    this.#schedulePersist([[newKey, metadata]]);
    return true;
  }

  /** Apply the title and favicon a tab event reports. Empty values are not
   * supplied (events report them while a page loads); only a tab read can clear a
   * field. Every supplied field is stamped fresh, even when it equals the entry's
   * value, because the value that would be stored may be an older tab read.
   * Returns true when a pin received them. */
  updateMetadataForTab(
    tabId: number,
    metadata: Pick<PinnedPanelEntry, 'title' | 'favIconUrl'>,
  ): boolean {
    const supplied: PinMetadata = {
      title: metadata.title || undefined,
      favIconUrl: metadata.favIconUrl || undefined,
    };
    if (!supplied.title && !supplied.favIconUrl) return false;
    const edits: MetadataEdit[] = [];
    for (const [key, entry] of Array.from(this.#byKey.entries())) {
      if (entry.tabId !== tabId) continue;
      edits.push([key, supplied]);
      const next: PinnedPanelEntry = {
        ...entry,
        title: supplied.title ?? entry.title,
        favIconUrl: supplied.favIconUrl ?? entry.favIconUrl,
      };
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
    }
    if (edits.length > 0) this.#schedulePersist(edits);
    return edits.length > 0;
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
      const matchedTabId = typeof tabId === 'number' && !consumed.has(tabId) ? tabId : undefined;
      const placeholder = this.#findSyntheticEntry(workspaceId, entry);
      const materializedTabId = matchedTabId ?? placeholder?.tabId ?? this.#nextSyntheticTabId--;
      if (matchedTabId !== undefined) consumed.add(matchedTabId);
      if (placeholder && materializedTabId === placeholder.tabId) continue;
      const key = this.#key(workspaceId, materializedTabId);
      const live: PinnedPanelEntry = {
        workspaceId,
        tabId: materializedTabId,
        order: entry.order,
        url: entry.url,
        title: entry.title,
        favIconUrl: entry.favIconUrl,
        widthPx: entry.widthPx,
      };
      if (placeholder) {
        const oldKey = this.#key(workspaceId, placeholder.tabId);
        this.#byKey.delete(oldKey);
        this.#enqueue({ kind: 'removed', workspaceId, tabId: placeholder.tabId });
      } else if (this.#byKey.has(key)) {
        continue;
      }
      this.#byKey.set(key, live);
      this.#enqueue({ kind: 'added', entry: live });
      dirty = true;
    }
    if (dirty) this.#schedulePersist();
  }

  #key(workspaceId: string, tabId: number): string {
    return workspaceId + '\u0000' + tabId;
  }

  #findSyntheticEntry(
    workspaceId: string,
    pending: Pick<PendingPersistedEntry, 'order' | 'url'>,
  ): PinnedPanelEntry | undefined {
    for (const entry of this.#byKey.values()) {
      if (entry.workspaceId !== workspaceId) continue;
      if (entry.tabId >= 0) continue;
      if (entry.order !== pending.order) continue;
      if (entry.url !== pending.url) continue;
      return entry;
    }
    return undefined;
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

  /** `edits` are the metadata values the calling mutation just wrote to entries. */
  #schedulePersist(edits: MetadataEdit[] = []): void {
    // Persistence needs URLs, but we hold tabIds. The flush runs in the
    // debounce callback's async chain — resolve URLs there via browser.tabs.get
    // (same pattern as PanelStore's Persistence). Snapshot the entries
    // synchronously so the resolver sees state-at-schedule-time.
    const snapshot = Array.from(this.#byKey.values());
    void this.#resolveAndPersist(snapshot, false, edits);
  }

  persistCurrentState(): Promise<void> {
    return this.#resolveAndPersist(Array.from(this.#byKey.values()), true);
  }

  /** Persist a snapshot. Every mutation, including removals, starts a call that
   * reads each pin's tab right away (change time) and writes only if no newer
   * call has started by the time it may write, so an older pin list, or a pin
   * removed in the meantime, never reaches storage. Superseded calls still leave
   * what they read in `#observed`, and a write waits for all earlier lookups, so a
   * tab that closed before the newest call looked still contributes the URL, title
   * and favicon read from it earlier (and a pin found private is dropped). The
   * `edits` of a mutation and this call's own lookups share its generation, the
   * lookups taking precedence as they are read after the edit.
   *
   * With `awaited`, the returned promise settles only once a write of this state
   * or a newer one has landed, however many calls supersede it. */
  #resolveAndPersist(
    snapshot: PinnedPanelEntry[],
    awaited = false,
    edits: MetadataEdit[] = [],
  ): Promise<void> {
    const generation = ++this.#persistGeneration;
    for (const [key, metadata] of edits) this.#observe(key, metadata, generation);
    const durable = awaited
      ? new Promise<void>((resolve) => this.#awaiting.set(generation, resolve))
      : Promise.resolve();
    const settled = Promise.all([
      this.#lookupsSettled,
      this.#captureTabs(generation, snapshot),
    ]).then(() => undefined);
    this.#lookupsSettled = settled;
    void settled
      .then(() => this.#write(generation, snapshot))
      .catch((err) => {
        console.error('[bento-tools] pinnedPanels: persist failed', err);
        this.#settleAwaiting(generation);
      });
    return durable;
  }

  async #write(generation: number, snapshot: PinnedPanelEntry[]): Promise<void> {
    if (generation !== this.#persistGeneration) return;
    const state = { entries: this.#mergeObserved(snapshot) };
    if (this.#awaiting.size === 0) {
      this.#persistence.schedule(state);
      return;
    }
    await this.#persistence.flushNow(state);
    this.#settleAwaiting(generation);
  }

  /** Resolve awaited persists whose state is covered by a landed write of `generation`. */
  #settleAwaiting(generation: number): void {
    for (const [awaitedGeneration, resolve] of this.#awaiting) {
      if (awaitedGeneration > generation) continue;
      this.#awaiting.delete(awaitedGeneration);
      resolve();
    }
  }

  async #captureTabs(generation: number, snapshot: PinnedPanelEntry[]): Promise<void> {
    for (const entry of snapshot) {
      if (this.#privateTabIds.has(entry.tabId)) continue;
      try {
        const tab = await browser.tabs.get(entry.tabId);
        if (tab.incognito === true) {
          this.#privateTabIds.add(entry.tabId);
          continue;
        }
        this.#observe(this.#key(entry.workspaceId, entry.tabId), readTab(tab), generation);
      } catch {
        // Tab gone: `#mergeObserved` falls back to what was seen before, then the entry.
      }
    }
  }

  /** Record metadata seen at `generation`. Lookups finish out of order, so a value
   * never replaces one from a newer generation. An undefined field says nothing.
   * An empty title or favicon is a real observation (the tab has none): it clears
   * the value like any other (`readTab` turns a completed tab's missing field into
   * one). A URL is observed only if it could be stored, so a blank tab (a pinned
   * tab before session restore sets its address) never replaces the usable URL. */
  #observe(key: string, metadata: PinMetadata, generation: number): void {
    const observed = this.#observed.get(key) ?? {};
    for (const field of METADATA_FIELDS) {
      const value = metadata[field];
      if (value === undefined) continue;
      if (field === 'url' && !isPersistablePinnedPanelUrl(value)) continue;
      if ((observed[field]?.generation ?? 0) > generation) continue;
      observed[field] = { value, generation };
    }
    this.#observed.set(key, observed);
  }

  /** Stored form of the newest snapshot: each pin merged with the freshest
   * metadata seen for it. Also forgets pins that left the membership. */
  #mergeObserved(snapshot: PinnedPanelEntry[]): PersistedPinnedEntry[] {
    const members = new Set<string>();
    const merged: PersistedPinnedEntry[] = [];
    for (const entry of snapshot) {
      const key = this.#key(entry.workspaceId, entry.tabId);
      members.add(key);
      if (this.#privateTabIds.has(entry.tabId)) continue;
      const observed = this.#observed.get(key);
      // A field that was observed wins, even as an empty clear; the entry only
      // fills in for one that never was.
      const latest = (field: MetadataField) => {
        const seen = observed?.[field];
        return seen ? seen.value : entry[field];
      };
      const url = latest('url');
      if (!isPersistablePinnedPanelUrl(url)) continue;
      merged.push({
        workspaceId: entry.workspaceId,
        panelKey: this.#getPanelKey?.(entry.workspaceId, entry.tabId),
        url,
        order: entry.order,
        title: latest('title') || undefined,
        favIconUrl: latest('favIconUrl') || undefined,
        widthPx: entry.widthPx,
      });
    }
    for (const key of this.#observed.keys()) {
      if (!members.has(key)) this.#observed.delete(key);
    }
    return merged;
  }
}
