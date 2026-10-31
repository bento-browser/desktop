// Source-of-truth tab tracker for Bento. Listens to browser.tabs.* events,
// keeps an internal Map<id, TabSnapshot>, and emits batched delta arrays via
// requestAnimationFrame (§6.5) so opening 50 tabs at once becomes one
// broadcast instead of fifty round-trips.
//
// Per-tab workspace assignment is persisted via browser.sessions.setTabValue
// (rides Firefox session restore, see §4.3) and hydrated on init.

import type { TabDelta, TabSnapshot } from '@shared/protocol';
import { isEphemeralWorkspaceId } from '../workspaces/ephemeral';

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
  // Page errors the experiment reported for a tab that onCreated has not delivered yet.
  #pendingPageErrors = new Map<number, NonNullable<TabSnapshot['pageError']>>();
  #privateTabIds = new Set<number>();
  #privateWindowByDelta = new WeakMap<TabDelta, number>();
  // Tabs `clearWorkspace` detached on purpose. SessionStore can copy the old
  // window's workspace value back onto them afterwards, so that value is stale,
  // not a restored assignment.
  #releasedTabIds = new Set<number>();
  // Per tab, the newest attach or activation that set its `active` flag; see #syncActive.
  #activeReads = new Map<number, number>();

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
    this.#watchPageErrors();

    const all = await browser.tabs.query({});
    // Privacy first: an event for one of these tabs can arrive while the session values
    // below are read, and its delta is classified (and its audience fixed) when queued.
    for (const tab of all) {
      if (tab.incognito === true && typeof tab.id === 'number') this.#privateTabIds.add(tab.id);
    }
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
      const url = tabUrl(tab);
      if (url) this.#urlByTabId.set(tab.id, url);
    }
    await this.#readPageErrors();
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
    this.#releasedTabIds.delete(id);
    try {
      // A private window's Private workspace is never written to SessionStore.
      if (!isEphemeralWorkspaceId(workspaceId)) {
        await browser.sessions.setTabValue(id, WORKSPACE_SESSION_KEY, workspaceId);
        if (options.preserveFolderId) {
          await browser.sessions.setTabValue(id, FOLDER_SESSION_KEY, options.preserveFolderId);
        }
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

  /** Forget a live tab's workspace and folder, in memory and in SessionStore.
   * For a tab that arrived from another window and still names that window's
   * workspace. Unlike `markClosing` it leaves the tab open and unmarked. */
  async clearWorkspace(id: number): Promise<void> {
    this.#releasedTabIds.add(id);
    this.#pendingWorkspaceAssignments.delete(id);
    this.#pendingFolderAssignments.delete(id);
    const tab = this.#tabs.get(id);
    if (tab && (tab.workspaceId !== undefined || tab.folderId !== undefined)) {
      delete tab.workspaceId;
      delete tab.folderId;
      this.#enqueue({
        kind: 'updated',
        id,
        changes: { workspaceId: undefined, folderId: undefined },
      });
    }
    await Promise.all(
      [WORKSPACE_SESSION_KEY, FOLDER_SESSION_KEY].map((key) =>
        browser.sessions.removeTabValue(id, key).catch(() => {
          // A missing value is already the desired state.
        }),
      ),
    );
  }

  /** The tabs among `ids` whose session metadata was read just now and holds no
   * workspace, folder, or closing mark. Those are safe to give a workspace: a
   * tab with a value is a restored assignment the registry has not hydrated yet
   * (it is applied in memory here), and a tab whose read fails is unknown.
   * A tab `clearWorkspace` detached counts as unassigned without a read. */
  async confirmUnassigned(ids: readonly number[]): Promise<number[]> {
    const confirmed = new Set<number>();
    await Promise.all(
      ids.map(async (id) => {
        if (this.#releasedTabIds.has(id)) {
          confirmed.add(id);
          return;
        }
        try {
          const values = await Promise.all(
            [WORKSPACE_SESSION_KEY, FOLDER_SESSION_KEY, CLOSING_TAB_SESSION_KEY].map((key) =>
              browser.sessions.getTabValue(id, key),
            ),
          );
          if (values.every((value) => value === undefined)) confirmed.add(id);
          else void this.#hydrateOne(id);
        } catch {
          // Unreadable metadata is not evidence that the tab is unassigned.
        }
      }),
    );
    return ids.filter((id) => confirmed.has(id));
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
    // A private tab's name stays in memory: nothing of it may reach the session store.
    if (!this.#privateTabIds.has(id)) {
      try {
        await browser.sessions.setTabValue(id, CUSTOM_TITLE_SESSION_KEY, customTitle);
      } catch (err) {
        console.warn('[bento-tools] sessions.setTabValue custom title failed:', id, err);
        return;
      }
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
    this.#releasedTabIds.delete(id);
    const tab = this.#tabs.get(id);
    if (tab) {
      if (tab.workspaceId !== workspaceId) {
        tab.workspaceId = workspaceId;
        this.#enqueue({ kind: 'updated', id, changes: { workspaceId } });
      }
    } else {
      this.#pendingWorkspaceAssignments.set(id, workspaceId);
    }
    if (isEphemeralWorkspaceId(workspaceId)) return true;
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

  /** Validate Bento-closed membership before consuming its mark. Unmarked imports keep
   * their existing adoption path. Returns whether this was a Bento-closed tab. */
  async hydrateRestoredTab(
    id: number,
    membership: {
      hasWorkspace: (workspaceId: string) => boolean;
      folderWorkspaceId: (folderId: string) => string | undefined;
    },
  ): Promise<boolean> {
    const { workspaceId, folderId, closing } = await readSessionMetadataWithRetries(id, 8, 50);
    const marked = this.#closingTabIds.has(id) || closing;
    if (marked) {
      const validWorkspace =
        !this.#privateTabIds.has(id) &&
        !!workspaceId &&
        !isEphemeralWorkspaceId(workspaceId) &&
        membership.hasWorkspace(workspaceId);
      // Remove invalid values while the closing mark still blocks concurrent hydration.
      if (workspaceId && !validWorkspace) {
        await browser.sessions.removeTabValue(id, WORKSPACE_SESSION_KEY);
      }
      if (folderId && (!validWorkspace || membership.folderWorkspaceId(folderId) !== workspaceId)) {
        await browser.sessions.removeTabValue(id, FOLDER_SESSION_KEY);
      }
    }
    await this.unmarkClosing(id);
    await this.#hydrateOne(id);
    return marked;
  }

  async markClosing(
    id: number,
    options: { preserveSessionMembership?: boolean } = {},
  ): Promise<void> {
    this.#unmarkedClosingTabIds.delete(id);
    this.#closingTabIds.add(id);
    this.#pendingWorkspaceAssignments.delete(id);
    this.#pendingFolderAssignments.delete(id);

    const tab = this.#tabs.get(id);
    if (tab && (tab.workspaceId !== undefined || tab.folderId !== undefined)) {
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
    const preserve = options.preserveSessionMembership === true && !this.#privateTabIds.has(id);
    await Promise.all([
      browser.sessions.setTabValue(id, CLOSING_TAB_SESSION_KEY, '1').catch(ignoreInvalidTab),
      ...(preserve
        ? []
        : [WORKSPACE_SESSION_KEY, FOLDER_SESSION_KEY].map((key) =>
            browser.sessions.removeTabValue(id, key).catch(ignoreInvalidTab),
          )),
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

  /** What documents of regular windows may see: no private-window tab. */
  snapshotRegular(): TabSnapshot[] {
    return this.snapshot().filter((tab) => !this.#privateTabIds.has(tab.id));
  }

  /** What one private window's documents see: that window's private tabs. */
  snapshotPrivate(windowId: number): TabSnapshot[] {
    return this.snapshot().filter(
      (tab) => this.#privateTabIds.has(tab.id) && tab.windowId === windowId,
    );
  }

  /** The private window a queued delta is about, or undefined for a regular
   * tab. Decided when the delta was queued: by the time listeners run, a
   * removed tab is already forgotten. */
  privateWindowOf(delta: TabDelta): number | undefined {
    return this.#privateWindowByDelta.get(delta);
  }

  isPrivate(id: number): boolean {
    return this.#privateTabIds.has(id);
  }

  /** The private window a private tab is in, or undefined for a regular or unknown tab. */
  privateWindowOfTab(id: number): number | undefined {
    return this.#privateTabIds.has(id) ? this.#tabs.get(id)?.windowId : undefined;
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
    // The page state is not part of the tabs API tab, so carry over what the experiment told us,
    // and apply an event that arrived before this one (see #onPageErrorChanged).
    const pendingPageError = this.#pendingPageErrors.get(snap.id);
    const pageError = pendingPageError ?? existing?.pageError;
    if (pageError) snap.pageError = pageError;
    this.#pendingPageErrors.delete(snap.id);
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
    const unmarkedBeforeRead = this.#unmarkedClosingTabIds.has(id);
    const [ws, folderId, customTitle, closing] = await Promise.all([
      readWorkspaceId(id),
      readFolderId(id),
      readCustomTitle(id),
      readClosingTab(id),
    ]);
    const tab = this.#tabs.get(id);
    if (!tab) return;
    // A restore validated and replaced these values while this older read was in flight.
    if (!unmarkedBeforeRead && this.#unmarkedClosingTabIds.has(id)) return;
    const changes: Partial<TabSnapshot> = {};
    const markedClosing = closing && !this.#unmarkedClosingTabIds.has(id);
    if (markedClosing) {
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
    if (!markedClosing && folderId !== tab.folderId) {
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
      // Defensive: treat as create if we missed it. Privacy is recorded before the delta
      // is queued: it decides the delta's audience, and a later init cannot change it.
      const snap = { ...toSnapshot(tab), id };
      if (tab.incognito === true) this.#privateTabIds.add(id);
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
      if (!this.#privateTabIds.has(id)) {
        void browser.sessions.setTabValue(id, CUSTOM_TITLE_SESSION_KEY, '').catch((err) => {
          console.warn('[bento-tools] custom title clear on navigation failed:', id, err);
        });
      }
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
    const privateWindowId = this.#privateTabIds.has(id) ? this.#tabs.get(id)?.windowId : undefined;
    this.#pendingWorkspaceAssignments.delete(id);
    this.#pendingFolderAssignments.delete(id);
    this.#pendingPageErrors.delete(id);
    this.#closingTabIds.delete(id);
    this.#unmarkedClosingTabIds.delete(id);
    this.#urlByTabId.delete(id);
    this.#privateTabIds.delete(id);
    this.#releasedTabIds.delete(id);
    this.#activeReads.delete(id);
    if (!this.#tabs.delete(id)) return;
    this.#enqueue({ kind: 'removed', id }, privateWindowId);
  };

  // The tabs API says nothing about the page a tab shows. The bentoTabState experiment reports,
  // from the browser's actual document, when it is Firefox's crashed-tab page or an error page
  // (`pageError`). Cosmetic state: a missing or failing experiment is logged and never blocks
  // the registry.
  #watchPageErrors(): void {
    try {
      browser.bentoTabState.onPageErrorChanged.addListener(this.#onPageErrorChanged);
    } catch (err) {
      console.warn('[bento-tools] page-error events unavailable:', err);
    }
  }

  // Sets every known tab's state from the live tab strips. Used at init and after an attach:
  // Firefox does not carry the `crashed` attribute to the tab element an adopted tab gets, and no
  // event follows the move, so the state is read again from the adopted document.
  async #readPageErrors(): Promise<void> {
    try {
      const live = new Map(
        (await browser.bentoTabState.getPageErrors()).map((e) => [e.tabId, e.pageError] as const),
      );
      for (const id of new Set([...this.#tabs.keys(), ...live.keys()])) {
        this.#onPageErrorChanged(id, live.get(id) ?? null);
      }
    } catch (err) {
      console.warn('[bento-tools] page-error read failed:', err);
    }
  }

  #onPageErrorChanged = (id: number, pageError: TabSnapshot['pageError'] | null) => {
    const tab = this.#tabs.get(id);
    if (!tab) {
      // The tab's onCreated has not arrived yet (or this is a stray event for a closed tab):
      // keep the state for #onCreated, as for an eager workspace assignment.
      if (pageError) this.#pendingPageErrors.set(id, pageError);
      else this.#pendingPageErrors.delete(id);
      return;
    }
    // A state kept from before the tab was known is older than this one.
    this.#pendingPageErrors.delete(id);
    if (tab.pageError === (pageError ?? undefined)) return;
    if (pageError) tab.pageError = pageError;
    else delete tab.pageError;
    this.#enqueue({ kind: 'updated', id, changes: { pageError: pageError ?? undefined } });
  };

  #onActivated = (info: browser.tabs._OnActivatedActiveInfo) => {
    for (const t of this.#tabs.values()) {
      if (t.windowId !== info.windowId) continue;
      this.#nextActiveRead(t.id);
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
    const fromWindowId = t.windowId;
    t.windowId = info.newWindowId;
    t.index = info.newPosition;
    if (this.#privateTabIds.has(id) && fromWindowId !== info.newWindowId) {
      // Two private windows share nothing: the old window's documents must drop the tab and
      // the new window's must learn it whole (an update about an unknown tab is ignored).
      this.#enqueue({ kind: 'removed', id }, fromWindowId);
      this.#enqueue({ kind: 'created', tab: { ...t } }, info.newWindowId);
    } else {
      this.#enqueue({
        kind: 'updated',
        id,
        changes: { windowId: info.newWindowId, index: info.newPosition },
      });
    }
    void this.#syncActive(id);
    void this.#readPageErrors();
  };

  // An adopted tab is not selected in its new window and no activation event follows, so a tab
  // that was active in its old window would keep `active: true` here. Activating its workspace
  // skips choosing a tab while one reads as active, and would leave another workspace's tab in
  // front. The read is asynchronous: it is dropped when a newer attach or activation of the tab
  // arrived meanwhile, or the tab is no longer in the window it was read for.
  async #syncActive(id: number): Promise<void> {
    const read = this.#nextActiveRead(id);
    try {
      const live = await browser.tabs.get(id);
      const tab = this.#tabs.get(id);
      if (!tab || this.#activeReads.get(id) !== read || live.windowId !== tab.windowId) return;
      const active = live.active === true;
      if (tab.active === active) return;
      tab.active = active;
      this.#enqueue({ kind: 'updated', id, changes: { active } });
    } catch {
      // The tab closed in the meantime.
    }
  }

  /** Marks `id`'s `active` flag as changed by a newer event, which makes an older live read stale. */
  #nextActiveRead(id: number): number {
    const read = (this.#activeReads.get(id) ?? 0) + 1;
    this.#activeReads.set(id, read);
    return read;
  }

  #privateWindowFor(delta: TabDelta): number | undefined {
    const id = delta.kind === 'created' ? delta.tab.id : delta.id;
    if (!this.#privateTabIds.has(id)) return undefined;
    if (delta.kind === 'created') return delta.tab.windowId;
    if (delta.kind === 'activated') return delta.windowId;
    return this.#tabs.get(id)?.windowId;
  }

  #enqueue(delta: TabDelta, privateWindowId = this.#privateWindowFor(delta)): void {
    if (privateWindowId !== undefined) this.#privateWindowByDelta.set(delta, privateWindowId);
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
