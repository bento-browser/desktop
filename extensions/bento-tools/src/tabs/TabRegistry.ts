// Source-of-truth tab tracker for Bento. Listens to browser.tabs.* events,
// keeps an internal Map<id, TabSnapshot>, and emits batched delta arrays via
// requestAnimationFrame (§6.5) so opening 50 tabs at once becomes one
// broadcast instead of fifty round-trips.
//
// Per-tab workspace assignment is persisted via browser.sessions.setTabValue
// (rides Firefox session restore, see §4.3) and hydrated on init.

import type { TabDelta, TabSnapshot } from '@shared/protocol';

type Listener = (deltas: TabDelta[]) => void;

export interface WindowClosingTabSnapshot extends TabSnapshot {
  url?: string;
}

type WindowClosingListener = (info: { windowId: number; tabs: WindowClosingTabSnapshot[] }) => void;

const WORKSPACE_SESSION_KEY = 'bento.workspaceId';
const FOLDER_SESSION_KEY = 'bento.folderId';
const CUSTOM_TITLE_SESSION_KEY = 'bento.customTitle';
const CLOSING_TAB_SESSION_KEY = 'bento.closingTab';

function toSnapshot(t: browser.tabs.Tab): TabSnapshot {
  return {
    id: t.id ?? -1,
    windowId: t.windowId ?? -1,
    index: t.index,
    title: t.title ?? '',
    url: tabUrl(t),
    favIconUrl: t.favIconUrl,
    active: t.active,
    pinned: t.pinned,
    audible: t.audible ?? false,
    muted: t.mutedInfo?.muted ?? false,
    loading: t.status === 'loading',
    discarded: t.discarded ?? false,
  };
}

function tabUrl(t: browser.tabs.Tab): string | undefined {
  const pendingUrl =
    typeof (t as browser.tabs.Tab & { pendingUrl?: unknown }).pendingUrl === 'string'
      ? ((t as browser.tabs.Tab & { pendingUrl?: string }).pendingUrl ?? '')
      : '';
  const url = t.url && t.url !== 'about:blank' ? t.url : pendingUrl;
  return url || undefined;
}

function customTitleMatchesPageIdentity(tab: TabSnapshot): boolean {
  const customTitle = tab.customTitle?.trim();
  if (!customTitle) return false;
  return customTitle === tab.title.trim() || customTitle === tab.url?.trim();
}

async function readWorkspaceId(tabId: number): Promise<string | undefined> {
  try {
    const value = await browser.sessions.getTabValue(tabId, WORKSPACE_SESSION_KEY);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readFolderId(tabId: number): Promise<string | undefined> {
  try {
    const value = await browser.sessions.getTabValue(tabId, FOLDER_SESSION_KEY);
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readCustomTitle(tabId: number): Promise<string | undefined> {
  try {
    const value = await browser.sessions.getTabValue(tabId, CUSTOM_TITLE_SESSION_KEY);
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

async function readClosingTab(tabId: number): Promise<boolean> {
  try {
    return (await browser.sessions.getTabValue(tabId, CLOSING_TAB_SESSION_KEY)) === '1';
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readSessionMetadata(tabId: number): Promise<{
  workspaceId?: string;
  folderId?: string;
  closing: boolean;
}> {
  const [workspaceId, folderId, closing] = await Promise.all([
    readWorkspaceId(tabId),
    readFolderId(tabId),
    readClosingTab(tabId),
  ]);
  return { workspaceId, folderId, closing };
}

async function readSessionMetadataWithRetries(
  tabId: number,
  attempts: number,
  delayMs: number,
): Promise<{
  workspaceId?: string;
  folderId?: string;
  closing: boolean;
}> {
  let latest = await readSessionMetadata(tabId);
  for (let i = 1; i < attempts && !latest.workspaceId && !latest.folderId && !latest.closing; i++) {
    await delay(delayMs);
    latest = await readSessionMetadata(tabId);
  }
  return latest;
}

export class TabRegistry {
  #tabs = new Map<number, TabSnapshot>();
  #pending: TabDelta[] = [];
  #flushScheduled = false;
  #listeners = new Set<Listener>();
  #windowClosingListeners = new Set<WindowClosingListener>();
  #notifiedClosingWindows = new Set<number>();
  #urlByTabId = new Map<number, string>();
  #closingTabIds = new Set<number>();
  #unmarkedClosingTabIds = new Set<number>();
  // Eager pre-assignments stashed by `assignWorkspaceEagerly` when the
  // tab hasn't yet been seen by #onCreated. Firefox is free to resolve
  // tabs.create's promise BEFORE dispatching the onCreated event, so a
  // handler that calls assignWorkspaceEagerly straight after `await
  // browser.tabs.create(...)` can race ahead of #tabs being populated.
  // The pending entry is consumed by #onCreated on arrival so the
  // emitted 'created' delta already carries workspaceId — avoids any
  // shell-side "tab briefly orphaned" frame.
  #pendingWorkspaceAssignments = new Map<number, string>();
  #pendingFolderAssignments = new Map<number, string>();
  #privateTabIds = new Set<number>();

  async init(): Promise<void> {
    // Register listeners FIRST so we don't miss tabs created during the
    // initial query's await. Firefox can emit onCreated for startup tabs
    // in that window — without listeners up first those events are lost.
    browser.tabs.onCreated.addListener(this.#onCreated);
    browser.tabs.onUpdated.addListener(this.#onUpdated);
    browser.tabs.onRemoved.addListener(this.#onRemoved);
    browser.tabs.onActivated.addListener(this.#onActivated);
    browser.tabs.onMoved.addListener(this.#onMoved);
    // onMoved fires only for WITHIN-window moves. Cross-window moves
    // (browser.tabs.move with a different windowId) fire onDetached
    // followed by onAttached. Tracking onAttached keeps the registry's
    // tab.windowId in sync after a workspace-claim moves panel tabs
    // from one window to another — without this the orchestrator's
    // post-move snapshot would still show the old windowId and would
    // re-move the tabs forever.
    browser.tabs.onAttached.addListener(this.#onAttached);

    const all = await browser.tabs.query({});
    // Hydrate session-stored workspace assignments in parallel.
    const hydrated = await Promise.all(
      all.map(async (t) => {
        const snap = toSnapshot(t);
        if (snap.id === -1) return snap;
        const [workspaceId, folderId, customTitle, closing] = await Promise.all([
          readWorkspaceId(snap.id),
          readFolderId(snap.id),
          readCustomTitle(snap.id),
          readClosingTab(snap.id),
        ]);
        if (closing && !this.#unmarkedClosingTabIds.has(snap.id)) {
          this.#closingTabIds.add(snap.id);
        } else {
          snap.workspaceId = workspaceId;
          snap.folderId = folderId;
        }
        snap.customTitle = customTitle;
        return snap;
      }),
    );
    for (const snap of hydrated) {
      if (snap.id === -1) continue;
      // Set only if a concurrent onCreated didn't already insert it.
      if (!this.#tabs.has(snap.id)) this.#tabs.set(snap.id, snap);
    }
    for (const tab of all) {
      if (typeof tab.id !== 'number') continue;
      if (tab.incognito === true) this.#privateTabIds.add(tab.id);
      const url = tabUrl(tab);
      if (url) this.#urlByTabId.set(tab.id, url);
    }
  }

  /** Read `bento.workspaceId` session value for every tab and apply it to
   * the in-memory snapshot. Required after settle-wait at boot: Firefox
   * SessionStore restores tabs via onCreated (after our init() resolves)
   * and the WebExtension Tab object passed to onCreated does not include
   * session values. Without this re-hydration, restored tabs sit in the
   * registry with workspaceId=undefined, the boot-time backfill clobbers
   * them by assigning to the active workspace, and tabs leak across
   * workspace boundaries. */
  async hydrateWorkspaceIds(options: { attempts?: number; delayMs?: number } = {}): Promise<void> {
    const attempts = Math.max(1, options.attempts ?? 8);
    const delayMs = Math.max(0, options.delayMs ?? 100);
    const ids = Array.from(this.#tabs.keys());
    const results = await Promise.all(
      ids.map(async (id) => {
        const metadata = await readSessionMetadataWithRetries(id, attempts, delayMs);
        return {
          id,
          ws: metadata.workspaceId,
          folderId: metadata.folderId,
          closing: metadata.closing,
        };
      }),
    );
    for (const { id, ws, folderId, closing } of results) {
      const tab = this.#tabs.get(id);
      if (!tab) continue;
      const changes: Partial<TabSnapshot> = {};
      if (closing && !this.#unmarkedClosingTabIds.has(id)) {
        this.#closingTabIds.add(id);
        if (tab.workspaceId !== undefined) {
          delete tab.workspaceId;
          changes.workspaceId = undefined;
        }
        if (tab.folderId !== undefined) {
          delete tab.folderId;
          changes.folderId = undefined;
        }
        if (Object.keys(changes).length > 0) this.#enqueue({ kind: 'updated', id, changes });
        continue;
      }
      if (ws && tab.workspaceId !== ws) {
        tab.workspaceId = ws;
        changes.workspaceId = ws;
      }
      if (folderId !== tab.folderId) {
        if (folderId) tab.folderId = folderId;
        else delete tab.folderId;
        changes.folderId = folderId;
      }
      if (Object.keys(changes).length > 0) this.#enqueue({ kind: 'updated', id, changes });
    }
  }

  /** Assign (or reassign) a tab to a workspace. Persists via sessions API and
   * emits an `updated` delta so the shell mirror picks it up. */
  async assignWorkspace(
    id: number,
    workspaceId: string,
    options: { preserveFolderId?: string } = {},
  ): Promise<void> {
    if (this.#closingTabIds.has(id)) return;
    const tab = this.#tabs.get(id);
    if (!tab) return;
    if (tab.workspaceId === workspaceId && tab.folderId === options.preserveFolderId) return;
    try {
      await browser.sessions.setTabValue(id, WORKSPACE_SESSION_KEY, workspaceId);
      if (options.preserveFolderId) {
        await browser.sessions.setTabValue(id, FOLDER_SESSION_KEY, options.preserveFolderId);
      }
    } catch (err) {
      console.warn('[bento-tools] sessions.setTabValue failed:', id, err);
      return;
    }
    tab.workspaceId = workspaceId;
    const changes: Partial<TabSnapshot> = { workspaceId };
    if (options.preserveFolderId) {
      if (tab.folderId !== options.preserveFolderId) {
        tab.folderId = options.preserveFolderId;
        changes.folderId = options.preserveFolderId;
      }
    } else if (tab.folderId !== undefined) {
      try {
        await browser.sessions.removeTabValue(id, FOLDER_SESSION_KEY);
      } catch {
        // Missing folderId is already the desired persisted state.
      }
      delete tab.folderId;
      changes.folderId = undefined;
    }
    this.#enqueue({ kind: 'updated', id, changes });
  }

  async setFolder(id: number, folderId: string | null): Promise<void> {
    const tab = this.#tabs.get(id);
    if (!tab || this.#closingTabIds.has(id)) return;
    const next = folderId ?? undefined;
    if (tab.folderId === next) return;
    try {
      if (folderId === null) {
        await browser.sessions.removeTabValue(id, FOLDER_SESSION_KEY);
      } else {
        await browser.sessions.setTabValue(id, FOLDER_SESSION_KEY, folderId);
      }
    } catch (err) {
      if (folderId !== null) {
        console.warn('[bento-tools] sessions.setTabValue folder failed:', id, err);
        return;
      }
    }
    if (next === undefined) delete tab.folderId;
    else tab.folderId = next;
    this.#enqueue({ kind: 'updated', id, changes: { folderId: next } });
  }

  /** Eager folder assignment for handler-created tabs. Mirrors
   * assignWorkspaceEagerly's tabs.create race handling so callers can persist
   * folder membership even when Firefox resolves tabs.create before
   * tabs.onCreated has populated #tabs. */
  async assignFolderEagerly(id: number, folderId: string): Promise<boolean> {
    if (this.#closingTabIds.has(id)) return false;
    const tab = this.#tabs.get(id);
    if (tab) {
      if (tab.folderId !== folderId) {
        tab.folderId = folderId;
        this.#enqueue({ kind: 'updated', id, changes: { folderId } });
      }
    } else {
      this.#pendingFolderAssignments.set(id, folderId);
    }
    try {
      await browser.sessions.setTabValue(id, FOLDER_SESSION_KEY, folderId);
      return true;
    } catch (err) {
      console.warn('[bento-tools] sessions.setTabValue folder (eager) failed:', id, err);
      return false;
    }
  }

  /** Set or clear Bento's sidebar display name for a tab. This does not
   * call browser.tabs.update({ title }) because Firefox tab titles are
   * page-owned; Bento stores a per-tab override in SessionStore instead. */
  async rename(id: number, title: string): Promise<void> {
    const tab = this.#tabs.get(id);
    if (!tab) return;
    const customTitle = title.trim();
    try {
      await browser.sessions.setTabValue(id, CUSTOM_TITLE_SESSION_KEY, customTitle);
    } catch (err) {
      console.warn('[bento-tools] sessions.setTabValue custom title failed:', id, err);
      return;
    }
    const next = customTitle.length > 0 ? customTitle : undefined;
    if (tab.customTitle === next) return;
    tab.customTitle = next;
    this.#enqueue({ kind: 'updated', id, changes: { customTitle: next } });
  }

  /** In-memory-only workspace assignment for boot-time backfill. Does NOT
   * call browser.sessions.setTabValue — so if `hydrateWorkspaceIds`
   * transiently returned `undefined` for a tab (sessions API hadn't
   * finished attaching extData yet) and we backfilled to the active
   * workspace, the ORIGINAL session value is preserved. The next launch
   * gets another chance to hydrate it correctly. Without this guard,
   * each backfill destructively overwrites the session value and the
   * tab leaks into whatever workspace is active at boot.
   *
   * The delta is still emitted so the shell mirror sees the same view
   * the in-memory snapshot does. Persistent state stays clean.
   */
  setWorkspaceInMemory(id: number, workspaceId: string): void {
    if (this.#closingTabIds.has(id)) return;
    const tab = this.#tabs.get(id);
    if (!tab) return;
    if (tab.workspaceId === workspaceId) return;
    tab.workspaceId = workspaceId;
    this.#enqueue({ kind: 'updated', id, changes: { workspaceId } });
  }

  /** Eager assignment for handler-initiated tab creation (tab/openUrl,
   * tab/create). Emits the 'updated' delta SYNCHRONOUSLY so it batches
   * with the preceding 'created' delta in the same rAF flush — the
   * shell mirror sees workspaceId on the new tab in the first broadcast
   * instead of "tab briefly orphaned until a follow-up batch lands".
   * Persists via browser.sessions.setTabValue after the synchronous state
   * update. Callers that need restart durability before reporting success can
   * await the returned boolean; callers that only need first-paint freshness
   * can ignore it.
   *
   * If the tab isn't yet in #tabs (Firefox can resolve tabs.create
   * BEFORE dispatching onCreated), stash the assignment so the next
   * #onCreated picks it up — either path lands workspaceId on the
   * downstream 'created' delta.
   *
   * Distinct from assignWorkspace: that one awaits setTabValue before
   * emitting (strict fail-closed semantics for explicit user re-
   * assignment). This one updates memory before awaiting persistence, which is
   * what tab-creation handlers actually need. */
  async assignWorkspaceEagerly(id: number, workspaceId: string): Promise<boolean> {
    if (this.#closingTabIds.has(id)) return false;
    const tab = this.#tabs.get(id);
    if (tab) {
      if (tab.workspaceId !== workspaceId) {
        tab.workspaceId = workspaceId;
        this.#enqueue({ kind: 'updated', id, changes: { workspaceId } });
      }
    } else {
      this.#pendingWorkspaceAssignments.set(id, workspaceId);
    }
    try {
      await browser.sessions.setTabValue(id, WORKSPACE_SESSION_KEY, workspaceId);
      return true;
    } catch (err) {
      console.warn('[bento-tools] sessions.setTabValue (eager) failed:', id, err);
      return false;
    }
  }

  isClosing(id: number): boolean {
    return this.#closingTabIds.has(id);
  }

  async isClosingOrMarked(id: number): Promise<boolean> {
    if (this.#unmarkedClosingTabIds.has(id)) return false;
    if (this.#closingTabIds.has(id)) return true;
    if (!(await readClosingTab(id))) return false;
    this.#closingTabIds.add(id);
    return true;
  }

  async unmarkClosing(id: number): Promise<void> {
    this.#unmarkedClosingTabIds.add(id);
    this.#closingTabIds.delete(id);
    try {
      await browser.sessions.removeTabValue(id, CLOSING_TAB_SESSION_KEY);
    } catch {
      // removeTabValue throws if the key is already absent. The desired
      // state is "not marked as closing", so missing is fine.
    }
  }

  async markClosing(id: number): Promise<void> {
    this.#unmarkedClosingTabIds.delete(id);
    this.#closingTabIds.add(id);
    this.#pendingWorkspaceAssignments.delete(id);
    this.#pendingFolderAssignments.delete(id);

    const tab = this.#tabs.get(id);
    if (tab?.workspaceId !== undefined) {
      delete tab.workspaceId;
      const changes: Partial<TabSnapshot> = { workspaceId: undefined };
      if (tab.folderId !== undefined) {
        delete tab.folderId;
        changes.folderId = undefined;
      }
      this.#enqueue({ kind: 'updated', id, changes });
    }

    const ignoreInvalidTab = (err: unknown) => {
      if (!String(err).includes('Invalid tab ID')) {
        console.warn('[bento-tools] markClosing session write failed:', id, err);
      }
    };
    await Promise.all([
      browser.sessions.setTabValue(id, CLOSING_TAB_SESSION_KEY, '1').catch(ignoreInvalidTab),
      browser.sessions.removeTabValue(id, WORKSPACE_SESSION_KEY).catch(ignoreInvalidTab),
      browser.sessions.removeTabValue(id, FOLDER_SESSION_KEY).catch(ignoreInvalidTab),
    ]);
  }

  async closeMarkedTabs(): Promise<void> {
    const ids = Array.from(this.#closingTabIds).filter((id) => this.#tabs.has(id));
    for (const id of ids) {
      await this.markClosing(id);
      void browser.tabs.remove(id).catch((err) => {
        if (!String(err).includes('Invalid tab ID')) {
          console.warn('[bento-tools] closing-tab retry failed:', id, err);
        }
      });
    }
  }

  snapshot(): TabSnapshot[] {
    return Array.from(this.#tabs.values()).sort((a, b) => a.index - b.index);
  }

  isPrivate(id: number): boolean {
    return this.#privateTabIds.has(id);
  }

  onDeltas(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onWindowClosing(listener: WindowClosingListener): () => void {
    this.#windowClosingListeners.add(listener);
    return () => this.#windowClosingListeners.delete(listener);
  }

  #onCreated = (tab: browser.tabs.Tab) => {
    const snap = toSnapshot(tab);
    if (snap.id === -1) return;
    if (tab.incognito === true) this.#privateTabIds.add(snap.id);
    // Eager pre-assignment from assignWorkspaceEagerly: covers the case
    // where Firefox resolved tabs.create's promise (and the handler ran
    // its eager-assign call) BEFORE this onCreated dispatch. Apply
    // before the hydration carry-over so a deliberate pre-assignment
    // wins over a stale prior value.
    const pending = this.#pendingWorkspaceAssignments.get(snap.id);
    if (pending) {
      snap.workspaceId = pending;
      this.#pendingWorkspaceAssignments.delete(snap.id);
    }
    const pendingFolderId = this.#pendingFolderAssignments.get(snap.id);
    if (pendingFolderId) {
      snap.folderId = pendingFolderId;
      this.#pendingFolderAssignments.delete(snap.id);
    }
    // Preserve any workspaceId we've already hydrated for this tab.
    // SessionStore-restored tabs can fire onCreated AFTER init's query
    // already saw and hydrated them — without this guard, the second
    // toSnapshot (which can't read session values) would clobber the
    // workspaceId field with undefined and the downstream onDeltas
    // listener would auto-assign to the active workspace, destroying
    // the original session value.
    const existing = this.#tabs.get(snap.id);
    if (!this.#closingTabIds.has(snap.id) && existing?.workspaceId && !snap.workspaceId) {
      snap.workspaceId = existing.workspaceId;
    }
    if (existing?.customTitle && !snap.customTitle) {
      snap.customTitle = existing.customTitle;
    }
    if (existing?.folderId && !snap.folderId) {
      snap.folderId = existing.folderId;
    }
    if (existing?.url && !snap.url) {
      snap.url = existing.url;
    }
    const url = snap.url;
    if (url) this.#urlByTabId.set(snap.id, url);
    this.#tabs.set(snap.id, snap);
    this.#enqueue({ kind: 'created', tab: snap });
    // For tabs that have NEVER been hydrated (no existing entry, or
    // the existing entry also lacked workspaceId), kick off an async
    // session-value read. If a value comes back, set it in-memory.
    // Doesn't write to sessions, so it can't corrupt — it only
    // recovers a value that was already there.
    if (!snap.workspaceId) {
      void this.#hydrateOne(snap.id);
    }
  };

  async #hydrateOne(id: number): Promise<void> {
    const [ws, folderId, customTitle, closing] = await Promise.all([
      readWorkspaceId(id),
      readFolderId(id),
      readCustomTitle(id),
      readClosingTab(id),
    ]);
    const tab = this.#tabs.get(id);
    if (!tab) return;
    const changes: Partial<TabSnapshot> = {};
    if (closing && !this.#unmarkedClosingTabIds.has(id)) {
      this.#closingTabIds.add(id);
      if (tab.workspaceId !== undefined) {
        delete tab.workspaceId;
        changes.workspaceId = undefined;
      }
      if (tab.folderId !== undefined) {
        delete tab.folderId;
        changes.folderId = undefined;
      }
    } else if (ws && tab.workspaceId !== ws) {
      tab.workspaceId = ws;
      changes.workspaceId = ws;
    }
    if (!closing && folderId !== tab.folderId) {
      if (folderId) tab.folderId = folderId;
      else delete tab.folderId;
      changes.folderId = folderId;
    }
    if (customTitle && tab.customTitle !== customTitle) {
      tab.customTitle = customTitle;
      changes.customTitle = customTitle;
    }
    if (Object.keys(changes).length > 0) this.#enqueue({ kind: 'updated', id, changes });
  }

  #onUpdated = (
    id: number,
    _changeInfo: browser.tabs._OnUpdatedChangeInfo,
    tab: browser.tabs.Tab,
  ) => {
    const existing = this.#tabs.get(id);
    if (!existing) {
      // Defensive: treat as create if we missed it
      const snap = { ...toSnapshot(tab), id };
      const url = snap.url;
      if (url) this.#urlByTabId.set(id, url);
      this.#tabs.set(id, snap);
      this.#enqueue({ kind: 'created', tab: snap });
      return;
    }
    // Reconcile against the live `tab` snapshot rather than `changeInfo` —
    // Firefox's session-restore path fires onUpdated with only `status` /
    // `url` set even when title and favIconUrl have transitioned (e.g.
    // "Restore Session" placeholder → real page title). Reading the full
    // tab object catches every property that may have shifted alongside
    // the change Firefox chose to surface in changeInfo.
    const changes: Partial<TabSnapshot> = {};
    const liveTitle = tab.title ?? '';
    if (liveTitle !== existing.title) changes.title = liveTitle;
    if (tab.favIconUrl !== existing.favIconUrl) changes.favIconUrl = tab.favIconUrl;
    if ((tab.audible ?? false) !== existing.audible) changes.audible = tab.audible ?? false;
    if ((tab.mutedInfo?.muted ?? false) !== existing.muted) {
      changes.muted = tab.mutedInfo?.muted ?? false;
    }
    if (tab.pinned !== existing.pinned) changes.pinned = tab.pinned;
    const nextLoading = tab.status === 'loading';
    if (nextLoading !== (existing.loading ?? false)) changes.loading = nextLoading;
    const nextDiscarded = tab.discarded ?? false;
    if (nextDiscarded !== (existing.discarded ?? false)) changes.discarded = nextDiscarded;
    const nextUrl = tabUrl(tab);
    if (nextUrl) this.#urlByTabId.set(id, nextUrl);
    const urlChanged = nextUrl !== existing.url;
    if (nextUrl !== existing.url) {
      if (nextUrl) {
        changes.url = nextUrl;
      } else if (existing.url !== undefined) {
        changes.url = undefined;
        this.#urlByTabId.delete(id);
      }
    }
    if (urlChanged && customTitleMatchesPageIdentity(existing)) {
      changes.customTitle = undefined;
      void browser.sessions.setTabValue(id, CUSTOM_TITLE_SESSION_KEY, '').catch((err) => {
        console.warn('[bento-tools] custom title clear on navigation failed:', id, err);
      });
    }
    if (Object.keys(changes).length === 0) return;
    Object.assign(existing, changes);
    if ('url' in changes && changes.url === undefined) {
      delete existing.url;
    }
    if ('customTitle' in changes && changes.customTitle === undefined) {
      delete existing.customTitle;
    }
    this.#enqueue({ kind: 'updated', id, changes });
  };

  #onRemoved = (id: number, removeInfo?: browser.tabs._OnRemovedRemoveInfo) => {
    const windowId =
      removeInfo && typeof removeInfo.windowId === 'number' && removeInfo.windowId >= 0
        ? removeInfo.windowId
        : null;
    if (
      removeInfo?.isWindowClosing &&
      windowId !== null &&
      !this.#notifiedClosingWindows.has(windowId)
    ) {
      this.#notifiedClosingWindows.add(windowId);
      const closingTabs = Array.from(this.#tabs.values())
        .filter((tab) => tab.windowId === windowId)
        .map((tab) => ({
          ...tab,
          url: this.#urlByTabId.get(tab.id),
        }));
      for (const listener of this.#windowClosingListeners) {
        try {
          listener({ windowId, tabs: closingTabs });
        } catch (err) {
          console.warn('[bento-tools] TabRegistry onWindowClosing listener threw:', err);
        }
      }
    }
    this.#pendingWorkspaceAssignments.delete(id);
    this.#pendingFolderAssignments.delete(id);
    this.#closingTabIds.delete(id);
    this.#unmarkedClosingTabIds.delete(id);
    this.#urlByTabId.delete(id);
    this.#privateTabIds.delete(id);
    if (!this.#tabs.delete(id)) return;
    this.#enqueue({ kind: 'removed', id });
  };

  #onActivated = (info: browser.tabs._OnActivatedActiveInfo) => {
    for (const t of this.#tabs.values()) {
      if (t.windowId !== info.windowId) continue;
      const wasActive = t.active;
      t.active = t.id === info.tabId;
      if (t.active !== wasActive) {
        this.#enqueue({ kind: 'updated', id: t.id, changes: { active: t.active } });
      }
    }
    this.#enqueue({ kind: 'activated', id: info.tabId, windowId: info.windowId });
  };

  #onMoved = (id: number, info: browser.tabs._OnMovedMoveInfo) => {
    const t = this.#tabs.get(id);
    if (!t) return;
    // tabs.onMoved only fires for the explicitly-moved tab. Every other
    // tab in the same window whose position changed to make room for
    // (or fill the gap left by) the moved tab needs its mirror index
    // updated too — otherwise the registry's snapshot has two tabs at
    // the same index and recomputeOrder produces a stale ordering. The
    // shift rule matches Firefox's internal tab-strip splice:
    //   forward move (toIndex > fromIndex): tabs in (fromIndex, toIndex]
    //     shift down by 1.
    //   backward move (toIndex < fromIndex): tabs in [toIndex, fromIndex)
    //     shift up by 1.
    const { fromIndex, toIndex, windowId } = info;
    if (toIndex > fromIndex) {
      for (const other of this.#tabs.values()) {
        if (other.id === id) continue;
        if (other.windowId !== windowId) continue;
        if (other.index > fromIndex && other.index <= toIndex) {
          other.index -= 1;
          this.#enqueue({ kind: 'updated', id: other.id, changes: { index: other.index } });
        }
      }
    } else if (toIndex < fromIndex) {
      for (const other of this.#tabs.values()) {
        if (other.id === id) continue;
        if (other.windowId !== windowId) continue;
        if (other.index >= toIndex && other.index < fromIndex) {
          other.index += 1;
          this.#enqueue({ kind: 'updated', id: other.id, changes: { index: other.index } });
        }
      }
    }
    t.index = toIndex;
    this.#enqueue({ kind: 'updated', id, changes: { index: toIndex } });
  };

  #onAttached = (id: number, info: browser.tabs._OnAttachedAttachInfo) => {
    const t = this.#tabs.get(id);
    if (!t) return;
    if (t.windowId === info.newWindowId && t.index === info.newPosition) return;
    t.windowId = info.newWindowId;
    t.index = info.newPosition;
    this.#enqueue({
      kind: 'updated',
      id,
      changes: { windowId: info.newWindowId, index: info.newPosition },
    });
  };

  #enqueue(delta: TabDelta): void {
    this.#pending.push(delta);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    // requestAnimationFrame may not exist in some background contexts; fall
    // back to a 16ms timer that approximates a single frame.
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
}
