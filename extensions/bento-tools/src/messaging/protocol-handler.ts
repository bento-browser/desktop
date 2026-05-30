// Routes incoming Action messages from bento-shell to the appropriate
// tools-side handler. Each Action either fires a side effect (close tab,
// switch tab, mutate workspace) or asks tools to broadcast state.
//
// Per-tab workspace assignment (tab/assignWorkspace) lands in PR-3b once
// the browser.sessions wrapper exists; until then it's a no-op stub so the
// type union stays exhaustive.

import type { Action, Event, PrivacySettings, WireAction } from '@shared/protocol';
import type { TabRegistry } from '../tabs/TabRegistry';
import type { WorkspaceStore } from '../workspaces/WorkspaceStore';
import type { SettingsStore } from '../settings/SettingsStore';
import type { PanelStore } from '../panels/PanelStore';
import type { PinnedPanelsStore } from '../pinnedPanels/PinnedPanelsStore';
import type { SavedPanelsStore } from '../saved-panels/SavedPanelsStore';
import type { BackupStore } from '../backup/BackupStore';
import { clearPanelMarker } from '../panels/SessionMarker';
import { validateExportSchema } from '../backup/ExportSchema';
import { executeImport } from '../backup/ImportExecutor';

const PANEL_RESTORE_DEBUG = true;
function restoreDebug(label: string, data: Record<string, unknown> = {}): void {
  if (!PANEL_RESTORE_DEBUG) return;
  console.info('[bento-restore-debug][protocol]', label, data);
}

// Read the three Bento-exposed privacy fields in parallel and broadcast a
// snapshot. browser.privacy.* setters return Promise<void> but reading via
// `.get({})` returns the live value — that's the supported shape.
// Tracking protection is intentionally excluded — Firefox's own
// about:preferences#privacy is the source of truth for that pref.
async function emitPrivacySnapshot(ctx: HandlerContext): Promise<void> {
  try {
    const [rfp, np, pc] = await Promise.all([
      browser.privacy.websites.resistFingerprinting.get({}),
      browser.privacy.network.networkPredictionEnabled.get({}),
      browser.privacy.network.peerConnectionEnabled.get({}),
    ]);
    const privacy: PrivacySettings = {
      resistFingerprinting: rfp.value as boolean,
      networkPrediction: np.value as boolean,
      peerConnection: pc.value as boolean,
    };
    ctx.send({ type: 'privacy/snapshot', privacy });
  } catch (err) {
    console.warn('[bento-tools] emitPrivacySnapshot failed:', err);
  }
}

async function promoteLeftmostPanelToTabAfterMove(
  ctx: HandlerContext,
  workspaceId: string,
  tabId: number,
): Promise<void> {
  if (!ctx.panels.remove(workspaceId, tabId)) return;

  // Clear the marker before activation. A promoted panel is now a normal
  // sidebar tab; leaving bento.isPanel set makes the activation guard in
  // background.ts treat it as a restored panel and bounce focus away.
  await clearPanelMarker(tabId);
  ctx.syncPanelMarkers(workspaceId);

  await activateNonPanelTab(ctx, tabId, 'assignWorkspace promote-panel activate');

  ctx.emitPanelsSync(workspaceId);
}

async function promoteLeftmostPanelBeforeMainClose(
  ctx: HandlerContext,
  workspaceId: string,
  tabId: number,
): Promise<boolean> {
  const originalPosition = ctx.panels.getPanels(workspaceId).indexOf(tabId);
  if (!ctx.panels.remove(workspaceId, tabId)) return false;

  // A promoted panel becomes the real main tab before the old main tab
  // is removed. Clearing the marker first prevents the activation guard
  // in background.ts from bouncing focus back to the tab we are closing.
  await clearPanelMarker(tabId);
  ctx.syncPanelMarkers(workspaceId);

  const activated = await activateNonPanelTab(ctx, tabId, 'tab/closeMain promote-panel activate');
  if (!activated) {
    ctx.panels.insertAt(workspaceId, tabId, originalPosition);
    ctx.syncPanelMarkers(workspaceId);
    ctx.emitPanelsSync(workspaceId);
    return false;
  }

  ctx.emitPanelsSync(workspaceId);
  return true;
}

async function closeMainTabWithPanelPromotion(ctx: HandlerContext, tabId: number): Promise<void> {
  const sourceWindowId = ctx.sourceWindowId;
  const tab = ctx.tabs.snapshot().find((candidate) => candidate.id === tabId);
  const workspaceId =
    tab?.workspaceId ??
    (typeof sourceWindowId === 'number' ? ctx.workspaces.getActiveId(sourceWindowId) : null);

  await ctx.tabs.markClosing(tabId);

  if (workspaceId) {
    const panelTabIds = ctx.panels.getPanels(workspaceId);
    const panelTabIdSet = new Set(panelTabIds);
    const remainingNormalTabs = ctx.tabs.snapshot().filter((candidate) => {
      if (candidate.id === tabId) return false;
      if (candidate.workspaceId !== workspaceId) return false;
      if (typeof sourceWindowId === 'number' && candidate.windowId !== sourceWindowId) return false;
      return !panelTabIdSet.has(candidate.id);
    });

    if (remainingNormalTabs.length === 0 && panelTabIds.length > 0) {
      const promoted = await promoteLeftmostPanelBeforeMainClose(ctx, workspaceId, panelTabIds[0]!);
      await closeTabAsRemoved(ctx, tabId, {
        delayMs: promoted ? 80 : 0,
        label: 'tab/closeMain',
      });
      return;
    }
  }

  await closeTabAsRemoved(ctx, tabId, { label: 'tab/closeMain' });
}

function pickAvailableWorkspaceAfterDeleting(
  ctx: HandlerContext,
  deletingWorkspaceId: string,
  preferredWorkspaceId: string,
  windowId: number,
): string | null {
  const ownedByOthers = new Set(
    Object.entries(ctx.workspaces.getActiveIdByWindow())
      .filter(([k]) => Number(k) !== windowId)
      .map(([, v]) => v),
  );
  const workspaces = ctx.workspaces.snapshot().workspaces;
  const preferred = workspaces.find(
    (w) =>
      w.id === preferredWorkspaceId && w.id !== deletingWorkspaceId && !ownedByOthers.has(w.id),
  );
  if (preferred) return preferred.id;
  return (
    workspaces.find((w) => w.id !== deletingWorkspaceId && !ownedByOthers.has(w.id))?.id ?? null
  );
}

async function cleanupWorkspaceAfterTabMove(
  ctx: HandlerContext,
  movedTabId: number,
  fromWorkspaceId: string,
  toWorkspaceId: string,
): Promise<void> {
  const panelTabIds = ctx.panels.getPanels(fromWorkspaceId);
  const panelTabIdSet = new Set(panelTabIds);
  const remainingNormalTabs = ctx.tabs
    .snapshot()
    .filter(
      (t) => t.id !== movedTabId && t.workspaceId === fromWorkspaceId && !panelTabIdSet.has(t.id),
    );
  if (remainingNormalTabs.length > 0) return;

  if (panelTabIds.length > 0) {
    await promoteLeftmostPanelToTabAfterMove(ctx, fromWorkspaceId, panelTabIds[0]!);
    return;
  }

  const sourceWindowId = ctx.sourceWindowId;
  const isActiveInSourceWindow =
    typeof sourceWindowId === 'number' &&
    ctx.workspaces.getActiveId(sourceWindowId) === fromWorkspaceId;

  if (isActiveInSourceWindow) {
    const candidate = pickAvailableWorkspaceAfterDeleting(
      ctx,
      fromWorkspaceId,
      toWorkspaceId,
      sourceWindowId,
    );
    if (candidate) {
      ctx.workspaces.forgetWindow(sourceWindowId);
      ctx.workspaces.delete(fromWorkspaceId);
      const result = ctx.workspaces.activate(candidate, sourceWindowId);
      if (result !== 'activated' && result !== 'noop') {
        console.warn(
          '[bento-tools] assignWorkspace post-delete activate returned',
          result,
          '— window may be left with no active workspace',
        );
      }
      return;
    }
  }

  ctx.workspaces.delete(fromWorkspaceId);
}

const TAB_REMOVE_RETRY_DELAYS_MS = [150, 500, 1200];

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tabStillExists(tabId: number): Promise<boolean> {
  try {
    await browser.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

function removeMarkedTabWithRetries(tabId: number, label: string, attempt = 0): void {
  void browser.tabs.remove(tabId).catch(async (err) => {
    await sleepMs(80);
    if (!(await tabStillExists(tabId))) return;
    if (attempt < TAB_REMOVE_RETRY_DELAYS_MS.length) {
      setTimeout(
        () => removeMarkedTabWithRetries(tabId, label, attempt + 1),
        TAB_REMOVE_RETRY_DELAYS_MS[attempt],
      );
      return;
    }
    if (!String(err).includes('Invalid tab ID')) {
      console.warn(`[bento-tools] ${label}: tabs.remove failed after retries:`, tabId, err);
    }
  });
}

async function closeTabAsRemoved(
  ctx: HandlerContext,
  tabId: number,
  options: { delayMs?: number; label?: string; clearPanelMarker?: boolean } = {},
): Promise<void> {
  await ctx.tabs.markClosing(tabId);
  if (options.clearPanelMarker) void clearPanelMarker(tabId);
  const start = () => removeMarkedTabWithRetries(tabId, options.label ?? 'tab/close');
  if (typeof options.delayMs === 'number' && options.delayMs > 0) {
    setTimeout(start, options.delayMs);
  } else {
    start();
  }
}

async function activateNonPanelTab(
  ctx: HandlerContext,
  tabId: number,
  label: string,
): Promise<boolean> {
  if (!Number.isFinite(tabId)) return false;
  if (ctx.tabs.isClosing(tabId)) return false;
  if (ctx.panels.findWorkspacesContainingPanelOrSubPanel(tabId).length > 0) return false;
  if (!ctx.tabs.snapshot().some((tab) => tab.id === tabId)) return false;
  try {
    await browser.tabs.get(tabId);
    await browser.tabs.update(tabId, { active: true });
    return true;
  } catch (err) {
    console.warn(`[bento-tools] ${label} failed:`, tabId, err);
    return false;
  }
}

function insertPanelAfterSource(
  ctx: HandlerContext,
  workspaceId: string,
  tabId: number,
  sourceTabId: number | null,
): boolean {
  if (sourceTabId === null) return ctx.panels.insertAt(workspaceId, tabId, 0);
  if (!ctx.panels.containsPanel(workspaceId, sourceTabId)) {
    return ctx.panels.insertAt(workspaceId, tabId, ctx.panels.getRootNodeIds(workspaceId).length);
  }
  return ctx.panels.insertAtRestoreLocation(
    workspaceId,
    tabId,
    ctx.panels.getPanelRestoreLocation(workspaceId, sourceTabId),
  );
}

export interface HandlerContext {
  tabs: TabRegistry;
  workspaces: WorkspaceStore;
  settings: SettingsStore;
  panels: PanelStore;
  pinnedPanels: PinnedPanelsStore;
  savedPanels: SavedPanelsStore;
  backup: BackupStore;
  send: (event: Event) => void;
  /** Resolve the active workspace's panel tabIds to {tabId, url} and
   * broadcast a panels/sync event. Lives on background.ts (it needs
   * broadcast access + browser.tabs.get for URL resolution); the handler
   * only triggers it when panel state changes. */
  emitPanelsSync: (workspaceId: string, options?: { scrollToPanelTabId?: number }) => void;
  /** Rewrite session markers for every panel in the workspace with
   * their current indexes. Call after any mutation that changes panel
   * order so Cmd+Shift+T restores land in the right slot. */
  syncPanelMarkers: (workspaceId: string) => void;
  /** WebExtension windowId of the chrome window whose shell document
   * dispatched the current action. Plumbed via the WireAction `__windowId`
   * envelope. Null for actions that arrived before the shell document
   * resolved its windowId (the brief async gap between mount and
   * `browser.windows.getCurrent()` resolving), for tools-internal
   * dispatches that bypass the bus (none today), and for any future
   * caller that doesn't know its window. Phase A handlers that don't
   * need per-window routing simply ignore it; phases B+ that DO need it
   * fall back to legacy single-window behaviour when null so this stays
   * additive. */
  sourceWindowId: number | null;
}

export function handle(wireAction: WireAction, ctx: HandlerContext): void {
  // Strip the routing envelope so the rest of the handler sees a clean
  // Action (existing exhaustive switch keeps working unchanged). The
  // windowId is exposed via ctx.sourceWindowId — set by the caller
  // (background.ts) before invoking handle(), so this function doesn't
  // need to extract it; it just narrows the type back to Action.
  const action: Action = wireAction;
  switch (action.type) {
    case 'ping':
      ctx.send({ type: 'pong', ts: Date.now() });
      return;
    case 'shell/hello': {
      // Auto-assign this window an active workspace if it doesn't already
      // own one. The "one workspace per window" invariant means we can't
      // have window B silently inherit window A's workspace — the panel
      // reconciler can't render the same tabs in two windows (Phase C
      // territory) and trying to do so produces missing panels and
      // workspace-switcher confusion. Picking the first available
      // workspace ensures each window has its own isolated state from
      // the moment it connects. When every workspace is taken (more
      // windows than workspaces), create a fresh one automatically —
      // leaving the window in a "No workspace" empty state has been
      // user-reported as confusing and also breaks the chrome color-
      // mode plumbing (which rides on panels/sync, which only fires for
      // a window with an active workspace).
      const wid = action.windowId;
      if (typeof wid === 'number' && wid >= 0) {
        let picked = ctx.workspaces.assignAvailable(wid);
        if (!picked) {
          const existing = ctx.workspaces.snapshot().workspaces;
          // Pick "Workspace 2", "Workspace 3", … skipping names already
          // taken so a delete-and-recreate cycle doesn't collide.
          const taken = new Set(existing.map((w) => w.name));
          let idx = existing.length + 1;
          let name = `Workspace ${idx}`;
          while (taken.has(name)) {
            idx += 1;
            name = `Workspace ${idx}`;
          }
          const ws = ctx.workspaces.create({ name }, wid);
          picked = ws.id;
        }
      }
      return;
    }
    case 'tabs/requestSnapshot':
      ctx.send({ type: 'tabs/snapshot', tabs: ctx.tabs.snapshot() });
      return;
    case 'tab/activate': {
      // Clear stale `bento.isPanel` marker if this tab isn't currently a
      // panel. The marker exists to let Cmd+Shift+T restore a closed
      // panel back to its slot, but it can stick around on tabs that
      // were once panels and got demoted (panel/remove path was missed
      // for some prior code path, or a session restore re-attached the
      // marker to a tab whose workspace assignment changed). When that
      // happens, the onActivated revert in background.ts treats the
      // user's click as a Cmd+Shift+T-style restore and snaps the
      // activation back to lastActiveNonPanelTabId — symptom: clicking
      // a sidebar tab flickers content briefly then reverts. A tab the
      // user is actively activating is by definition not a "to-be-
      // restored panel", so it's safe to clear the marker here.
      const isPanelTab = ctx.panels.findWorkspacesContainingPanelOrSubPanel(action.id).length > 0;
      if (!isPanelTab) {
        void clearPanelMarker(action.id);
      }
      void activateNonPanelTab(ctx, action.id, 'tab/activate');
      return;
    }
    case 'tab/close':
      {
        void (async () => {
          await ctx.tabs.markClosing(action.id);
          const affected = ctx.panels.findWorkspacesContainingTab(action.id);
          let delayActualTabRemove = false;
          const statuses: Record<string, string> = {};
          if (affected.length > 0) {
            for (const wsId of affected) {
              const status = ctx.panels.getPanelLayoutStatus(wsId, action.id);
              statuses[wsId] = status;
              const promoted =
                status === 'subdivision-top' ||
                status === 'chooser-owner' ||
                status === 'subdivision-bottom' ||
                status === 'split-child';
              if (ctx.panels.remove(wsId, action.id) && promoted) {
                delayActualTabRemove = true;
              }
              ctx.syncPanelMarkers(wsId);
              ctx.emitPanelsSync(wsId);
            }
            // Keep the closing tab's bento.isPanel session marker in place.
            // Firefox carries it through the closed-tab entry, and
            // Cmd+Shift+T uses it to restore the tab back as a panel instead
            // of reopening it as a normal tab.
          }
          restoreDebug('tab-close-panel-path', {
            tabId: action.id,
            affected,
            statuses,
            delayActualTabRemove,
            markerPreservedForUndoClose: affected.length > 0,
          });
          const delayMs = delayActualTabRemove ? 500 : 0;
          await closeTabAsRemoved(ctx, action.id, { delayMs, label: 'tab/close' });
        })();
      }
      return;
    case 'tab/closeMain':
      void closeMainTabWithPanelPromotion(ctx, action.id);
      return;
    case 'tab/rename':
      void ctx.tabs.rename(action.id, action.title);
      return;
    case 'tab/assignWorkspace':
      // Pins are anchored to (workspaceId, tabId). When the user moves a
      // tab into a different workspace, the pin's stored workspaceId
      // would become stale — and a panel can only live in one workspace
      // at a time, so the binding is effectively gone. Drop the pin
      // BEFORE the assignment fires so the resulting panels/sync carries
      // the post-cleanup pin set.
      void (async () => {
        const before = ctx.tabs.snapshot().find((t) => t.id === action.id);
        const fromWorkspaceId = before?.workspaceId;
        ctx.pinnedPanels.removeForTab(action.id);
        await ctx.tabs.assignWorkspace(action.id, action.workspaceId);
        if (fromWorkspaceId && fromWorkspaceId !== action.workspaceId) {
          await cleanupWorkspaceAfterTabMove(ctx, action.id, fromWorkspaceId, action.workspaceId);
        }
      })();
      return;
    case 'tab/openUrl':
      // Background script always has browser.tabs available; the chrome-
      // mounted shell document doesn't, which is why this round-trip exists.
      //
      // Pass `windowId` so the tab lands in the source window even when
      // Firefox's "current window" tracking differs from the window the
      // user actually clicked in. Eagerly assign workspaceId via
      // TabRegistry so the 'updated' delta batches with the 'created'
      // delta in a single rAF — without this, the sidebar's
      // workspaceId filter excludes the new tab on first paint and only
      // catches it after a workspace round-trip forces re-filter.
      void (async () => {
        try {
          const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
          // focusExisting: if a tab with this URL already lives in the
          // source workspace, activate it instead of stacking a
          // duplicate. Used for singleton internal pages (Settings,
          // Privacy). TabSnapshot doesn't carry `url` (§6.5 perf
          // budget), so cross-reference workspace-membership from the
          // registry with the URL from browser.tabs.query. Panel tabs
          // are excluded because activating them as the main tab fires
          // the panel-revert path in onActivated (background.ts) —
          // briefly activates the panel then snaps back to the last
          // non-panel tab, which the user reads as the click being
          // ignored. Falling through to create-new gives them a real
          // main-area Settings tab alongside the panel.
          if (action.focusExisting && wsId) {
            const panelIds = new Set(ctx.panels.getPanels(wsId));
            const wsTabIds = new Set(
              ctx.tabs
                .snapshot()
                .filter((t) => t.workspaceId === wsId && !panelIds.has(t.id))
                .map((t) => t.id),
            );
            if (wsTabIds.size > 0) {
              const candidates = await browser.tabs.query({ url: action.url });
              const match = candidates.find((t) => typeof t.id === 'number' && wsTabIds.has(t.id));
              if (match && typeof match.id === 'number') {
                const activated = await activateNonPanelTab(
                  ctx,
                  match.id,
                  'tab/openUrl focus existing',
                );
                if (!activated) return;
                if (typeof match.windowId === 'number' && match.windowId >= 0) {
                  await browser.windows
                    .update(match.windowId, { focused: true })
                    .catch((err) =>
                      console.warn('[bento-tools] tab/openUrl: focus window failed:', err),
                    );
                }
                return;
              }
            }
          }
          const created = await browser.tabs.create({
            url: action.url,
            active: action.active ?? true,
            ...(typeof ctx.sourceWindowId === 'number' ? { windowId: ctx.sourceWindowId } : {}),
          });
          if (typeof created.id !== 'number') return;
          if (wsId) ctx.tabs.assignWorkspaceEagerly(created.id, wsId);
        } catch (err) {
          console.warn('[bento-tools] tab/openUrl failed:', err);
        }
      })();
      return;
    case 'tab/create':
      // Same windowId + eager-assign rationale as tab/openUrl above.
      void (async () => {
        try {
          const created = await browser.tabs.create({
            active: action.active ?? true,
            ...(typeof ctx.sourceWindowId === 'number' ? { windowId: ctx.sourceWindowId } : {}),
          });
          if (typeof created.id !== 'number') return;
          const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
          if (wsId) ctx.tabs.assignWorkspaceEagerly(created.id, wsId);
        } catch (err) {
          console.warn('[bento-tools] tab/create failed:', err);
        }
      })();
      return;
    case 'tab/reload':
      browser.tabs
        .reload(action.id, { bypassCache: action.bypassCache ?? false })
        .catch((err) => console.warn('[bento-tools] tab/reload failed:', err));
      return;
    case 'tab/togglePin':
      browser.tabs
        .get(action.id)
        .then((tab) => browser.tabs.update(action.id, { pinned: !tab.pinned }))
        .catch((err) => console.warn('[bento-tools] tab/togglePin failed:', err));
      return;
    case 'workspaces/requestSnapshot': {
      const snap = ctx.workspaces.snapshot();
      ctx.send({
        type: 'workspaces/snapshot',
        workspaces: snap.workspaces,
        activeId: snap.activeId,
        activeIdByWindow: snap.activeIdByWindow,
      });
      return;
    }
    case 'workspace/create':
      // Per-window auto-activation: when the requesting shell knows its
      // windowId, the new workspace foregrounds only in that window.
      // Other windows keep whatever they were on. Falls back to global
      // activation when sourceWindowId is null (legacy / dev-loop).
      ctx.workspaces.create(
        { name: action.name, themeId: action.themeId, icon: action.icon },
        ctx.sourceWindowId,
      );
      return;
    case 'workspace/rename':
      ctx.workspaces.rename(action.id, action.name);
      return;
    case 'workspace/update':
      ctx.workspaces.update(action.id, action.changes);
      return;
    case 'workspace/delete': {
      // Close the workspace's tabs FIRST (browser.tabs.remove is async but
      // fire-and-forget here; the actual removals will trigger onRemoved
      // and the shell will see the deltas in the same rAF batch as the
      // workspace removal). Then delete the workspace metadata so the
      // panel store cleanup + active-workspace fallback in WorkspaceStore
      // run in their normal order.
      if (action.closeTabs) {
        const tabIds = ctx.tabs
          .snapshot()
          .filter((t) => t.workspaceId === action.id)
          .map((t) => t.id);
        if (tabIds.length > 0) {
          browser.tabs
            .remove(tabIds)
            .catch((err) =>
              console.warn('[bento-tools] workspace/delete: tabs.remove failed:', err),
            );
        }
      }
      ctx.workspaces.delete(action.id);
      return;
    }
    case 'workspace/activate': {
      // Scope the activation to the requesting window when available.
      // sourceWindowId null falls back to legacy global activation so
      // older shells / tools-internal callers keep working unchanged.
      const result = ctx.workspaces.activate(action.id, ctx.sourceWindowId);
      if (result === 'conflict') {
        // Another window already owns this workspace. Bento enforces
        // "one workspace per window" because two windows rendering the
        // same workspace's panels currently produce broken state (the
        // panel reconciler resolves panel tabs against gBrowser, which
        // is per-window — Phase C twin-tabs will fix this and let
        // synced display work). Until then, the friendlier behaviour is
        // to focus the window already showing the workspace. The
        // requesting shell's UI will reconcile on its next workspaces/
        // changed delta (its activeIdByWindow entry stays unchanged
        // since no 'activated' delta fired).
        const owner = ctx.workspaces.findOwningWindow(action.id);
        if (owner !== null) {
          browser.windows
            .update(owner, { focused: true })
            .catch((err) =>
              console.warn('[bento-tools] workspace/activate: focus owner failed:', err),
            );
        }
      }
      return;
    }
    case 'settings/requestSnapshot':
      ctx.send({ type: 'settings/snapshot', settings: ctx.settings.snapshot() });
      return;
    case 'settings/update':
      ctx.settings.update(action.changes);
      return;
    case 'settings/reset':
      ctx.settings.reset();
      return;
    case 'panel/add': {
      const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
      if (!wsId) return;
      if (ctx.panels.add(wsId, action.id)) {
        // Stamp the configured default width so the new panel renders
        // at the user's preferred size on first paint. Same logic in
        // background.ts maybeHandleAddPanelMarker for the chrome-side
        // "Add panel" button path.
        const defaultWidth = ctx.settings.snapshot().defaultPanelWidthPx;
        if (defaultWidth > 0) ctx.panels.setWidth(action.id, defaultWidth);
        // syncPanelMarkers writes the new tab's marker (it's now in
        // panels.getPanels at the last index) plus refreshes any
        // existing markers — covers add, idempotent for the rest.
        ctx.syncPanelMarkers(wsId);
        ctx.emitPanelsSync(wsId, { scrollToPanelTabId: action.id });
      }
      return;
    }
    case 'panel/openAt': {
      const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
      if (!wsId) {
        console.warn('[bento-tools] panel/openAt: no active workspace — bailing');
        return;
      }
      // Compute insert position from sourceTabId and the optional
      // position hint:
      //   position 'end' → currentPanels.length (append). Used by the
      //     Add-panel trailer ("+" button and saved-panel favicon
      //     buttons) where "after which panel" doesn't apply — the
      //     trailer always inserts at the rightmost slot.
      //   null sourceTabId, no position hint → 0 (immediately right
      //     of main panel). Used by link context-menu "Open in new
      //     panel" when the right-click happened in the main panel.
      //   id sourceTabId → that panel's index + 1 (immediately right
      //     of it).
      //   not-a-panel id → append (defensive: shouldn't normally happen
      //     because the menu item only shows when the right-click was
      //     inside a known panel)
      let position: number;
      if (action.position === 'end') {
        position = ctx.panels.getRootNodeIds(wsId).length;
      } else if (action.sourceTabId === null) {
        position = 0;
      } else {
        position = ctx.panels.getRootNodeIds(wsId).length;
      }
      // WebExtensions' tabs.create rejects most `about:*` URLs as "Illegal
      // URL". `about:newtab` specifically is the user's configured new-tab
      // page; tabs.create with NO `url` field resolves to it via Firefox's
      // AboutNewTabRedirector. Treat that string as a sentinel meaning
      // "the default new tab page" and omit `url` accordingly. Same
      // workaround the `tab/create` action already uses.
      const isDefaultNewTab = !action.url || action.url === 'about:newtab';
      browser.tabs
        .create({
          ...(isDefaultNewTab ? {} : { url: action.url }),
          active: false,
          ...(typeof ctx.sourceWindowId === 'number' ? { windowId: ctx.sourceWindowId } : {}),
        })
        .then((tab) => {
          if (typeof tab.id !== 'number') {
            console.warn('[bento-tools] panel/openAt: tab.id not a number — bailing');
            return;
          }
          const inserted =
            action.position === 'after' || action.position === undefined
              ? insertPanelAfterSource(ctx, wsId, tab.id, action.sourceTabId)
              : ctx.panels.insertAt(wsId, tab.id, position);
          if (!inserted) {
            console.warn(
              '[bento-tools] panel/openAt: insertAt returned false (tab already in panel list?) — bailing without sync',
            );
            return;
          }
          ctx.tabs.assignWorkspaceEagerly(tab.id, wsId);
          const defaultWidth = ctx.settings.snapshot().defaultPanelWidthPx;
          if (defaultWidth > 0) ctx.panels.setWidth(tab.id, defaultWidth);
          ctx.syncPanelMarkers(wsId);
          ctx.emitPanelsSync(wsId, { scrollToPanelTabId: tab.id });
        })
        .catch((err) => console.warn('[bento-tools] panel/openAt failed:', err));
      return;
    }
    case 'panel/remove': {
      const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
      if (!wsId) return;
      const subVictims = ctx.panels.removeWithSubPanels(wsId, action.id);
      for (const spId of subVictims) {
        void closeTabAsRemoved(ctx, spId, { label: 'panel/remove sub-panel' });
      }
      void clearPanelMarker(action.id);
      ctx.syncPanelMarkers(wsId);
      ctx.emitPanelsSync(wsId);
      return;
    }
    case 'panels/clear': {
      const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
      if (!wsId) return;
      const current = ctx.panels.getPanels(wsId);
      if (current.length === 0) return;
      for (const id of current) {
        const subVictims = ctx.panels.removeWithSubPanels(wsId, id);
        for (const spId of subVictims) {
          void closeTabAsRemoved(ctx, spId, { label: 'panels/clear sub-panel' });
        }
        void clearPanelMarker(id);
      }
      ctx.emitPanelsSync(wsId);
      return;
    }
    case 'panelLayout/reorderRoot': {
      const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
      if (!wsId) return;
      if (ctx.panels.reorderRootNodes(wsId, action.rootNodeIds)) {
        ctx.syncPanelMarkers(wsId);
        ctx.emitPanelsSync(wsId);
      }
      return;
    }
    case 'panel/setWidth': {
      // Width is per-tabId — workspace ownership is informational. The
      // setter no-ops on no-change so a noisy chrome-side dispatch
      // (multiple endPanelDrag fires for the same width) doesn't
      // re-trigger persistence. We do NOT emit panels/sync here:
      // chrome already has the live width on the dragged panel
      // element, and a sync round-trip would clobber the in-flight
      // layout with stale values from the broadcast.
      ctx.panels.setWidth(action.id, action.widthPx);
      return;
    }
    case 'panel/setMainWidth': {
      // Main content slot width is workspace-scoped. Same no-emit-after-set
      // reasoning as panel/setWidth — chrome already has the live width on
      // the main slot's element, and a sync round-trip would clobber the
      // in-flight layout with stale values from the broadcast.
      const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
      if (!wsId) return;
      ctx.panels.setMainWidth(wsId, action.widthPx);
      return;
    }
    case 'panel/setStripScroll': {
      if (!ctx.workspaces.has(action.workspaceId)) return;
      ctx.panels.setStripScroll(action.workspaceId, action.scrollLeft);
      return;
    }
    case 'panelLayout/subdivide': {
      const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
      if (!wsId) return;
      const subdivided = ctx.panels.subdivide(wsId, action.tabId);
      if (subdivided) {
        ctx.emitPanelsSync(wsId);
      }
      return;
    }
    case 'panelLayout/splitTopPanel': {
      const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
      if (!wsId) return;
      if (!ctx.panels.canSplitTopPanel(wsId, action.tabId)) return;
      void (async () => {
        try {
          const isDefaultNewTab = !action.url || action.url === 'about:newtab';
          const tab = await browser.tabs.create({
            ...(isDefaultNewTab ? {} : { url: action.url }),
            active: false,
            ...(typeof ctx.sourceWindowId === 'number' ? { windowId: ctx.sourceWindowId } : {}),
          });
          if (typeof tab.id !== 'number') return;
          ctx.tabs.assignWorkspaceEagerly(tab.id, wsId);
          if (ctx.panels.splitTopPanel(wsId, action.tabId, tab.id)) {
            ctx.syncPanelMarkers(wsId);
            ctx.emitPanelsSync(wsId);
          }
        } catch (err) {
          console.warn('[bento-tools] panelLayout/splitTopPanel failed:', err);
        }
      })();
      return;
    }
    case 'panelLayout/splitBottomPanel': {
      const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
      if (!wsId) return;
      if (!ctx.panels.canSplitBottomPanel(wsId, action.tabId)) return;
      void (async () => {
        try {
          const isDefaultNewTab = !action.url || action.url === 'about:newtab';
          const tab = await browser.tabs.create({
            ...(isDefaultNewTab ? {} : { url: action.url }),
            active: false,
            ...(typeof ctx.sourceWindowId === 'number' ? { windowId: ctx.sourceWindowId } : {}),
          });
          if (typeof tab.id !== 'number') return;
          ctx.tabs.assignWorkspaceEagerly(tab.id, wsId);
          if (ctx.panels.splitBottomPanel(wsId, action.tabId, tab.id)) {
            ctx.syncPanelMarkers(wsId);
            ctx.emitPanelsSync(wsId);
          }
        } catch (err) {
          console.warn('[bento-tools] panelLayout/splitBottomPanel failed:', err);
        }
      })();
      return;
    }
    case 'panelLayout/removeVerticalGroup': {
      const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
      if (!wsId) return;
      const victims = ctx.panels.removeVerticalGroup(wsId, action.groupId);
      for (const spId of victims) {
        void closeTabAsRemoved(ctx, spId, {
          delayMs: action.closeDelayMs,
          label: 'panelLayout/removeVerticalGroup child',
        });
      }
      ctx.emitPanelsSync(wsId);
      return;
    }
    case 'panelLayout/breakOut': {
      const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
      if (!wsId) return;
      const result = ctx.panels.breakOut(wsId, action.tabId);
      if (!result) return;
      ctx.syncPanelMarkers(wsId);
      ctx.emitPanelsSync(wsId);
      return;
    }
    case 'panelLayout/fillChooser': {
      const wsId = ctx.workspaces.getActiveId(ctx.sourceWindowId);
      if (!wsId) return;
      const expected = action.mode === 'single' ? 1 : 2;
      const urls = action.urls.slice(0, expected);
      if (urls.length !== expected) return;
      void (async () => {
        try {
          const newTabIds: number[] = [];
          for (const url of urls) {
            const isDefaultNewTab = !url || url === 'about:newtab';
            const tab = await browser.tabs.create({
              ...(isDefaultNewTab ? {} : { url }),
              active: false,
              ...(typeof ctx.sourceWindowId === 'number' ? { windowId: ctx.sourceWindowId } : {}),
            });
            if (typeof tab.id === 'number') newTabIds.push(tab.id);
          }
          if (newTabIds.length !== expected) return;
          for (const tabId of newTabIds) {
            ctx.tabs.assignWorkspaceEagerly(tabId, wsId);
          }
          if (ctx.panels.fillChooser(wsId, action.chooserId, action.mode, newTabIds)) {
            ctx.syncPanelMarkers(wsId);
            ctx.emitPanelsSync(wsId);
          }
        } catch (err) {
          console.warn('[bento-tools] panelLayout/fillChooser failed:', err);
        }
      })();
      return;
    }
    case 'panelLayout/setGroupRatio': {
      ctx.panels.setGroupRatio(action.groupId, action.ratio);
      return;
    }
    case 'pinnedPanel/add': {
      // Validate that the workspace exists AND the tab is currently a
      // panel or nested sub-panel in that workspace. Full-slot survivor
      // panels are still represented as sub-panels under a hidden
      // top-closed parent, and ordinary subdivided panels are legitimate
      // visible panel surfaces too, so top-level-only validation rejects
      // valid header menu requests. Silent no-op on duplicate — the
      // store's add() returns false in that case and we don't emit.
      if (!ctx.workspaces.has(action.workspaceId)) return;
      if (
        !ctx.panels
          .findWorkspacesContainingPanelOrSubPanel(action.tabId)
          .includes(action.workspaceId)
      )
        return;
      if (ctx.pinnedPanels.add(action.workspaceId, action.tabId)) {
        // Re-emit panels/sync for the affected workspace so chrome's
        // kebab menu (which reads pinnedTabIdsInWorkspace from the
        // payload) picks up the new state on its next open. Active-
        // workspace-only filtering happens in the shell mirror.
        ctx.emitPanelsSync(action.workspaceId);
      }
      return;
    }
    case 'pinnedPanel/remove': {
      if (ctx.pinnedPanels.remove(action.workspaceId, action.tabId)) {
        ctx.emitPanelsSync(action.workspaceId);
      }
      return;
    }
    case 'pinnedPanel/activate': {
      // Switch to the workspace that owns the pinned panel; the panel
      // tab is NOT activated as the main tab. Activating it would
      // relocate the panel's <browser> into the main content slot
      // (chrome's reconciler routes the selected tab there), which is
      // the opposite of what a pinned panel should do — the panel
      // stays in its side slot.
      //
      // Scrolling the panel strip + focusing the panel's <browser> is
      // handled chrome-side: the React caller writes a
      // BENTO_FOCUS_PANEL:<ts>:<tabId> title alongside the dispatch,
      // and chrome retries the scroll+focus until the workspace
      // reconcile has materialized the panel element.
      const owner = ctx.workspaces.findOwningWindow(action.workspaceId);
      if (owner !== null && owner !== ctx.sourceWindowId) {
        // Another window already owns the workspace. Focus that window
        // and stop — its shell will see the pin row activate via its
        // own user gesture if the user wants to focus the panel there.
        browser.windows
          .update(owner, { focused: true })
          .catch((err) =>
            console.warn('[bento-tools] pinnedPanel/activate: focus owner failed:', err),
          );
        return;
      }
      ctx.workspaces.activate(action.workspaceId, ctx.sourceWindowId);
      return;
    }
    case 'pinnedPanels/requestSnapshot':
      ctx.send({ type: 'pinnedPanels/snapshot', entries: ctx.pinnedPanels.entries() });
      return;
    case 'savedPanels/save':
      // Fire-and-forget — SavedPanelsStore's onCreated listener picks
      // up the new bookmark, refreshes the list, and broadcasts via
      // savedPanels.onChange so chrome's trailer iframe re-renders.
      // De-dupe + folder lazy-recreate live inside `save()`.
      void ctx.savedPanels.save(action.url, action.title, action.favIconUrl);
      return;
    case 'savedPanels/requestSnapshot':
      ctx.send({ type: 'savedPanels/snapshot', items: ctx.savedPanels.list() });
      return;
    case 'privacy/requestSnapshot':
      void emitPrivacySnapshot(ctx);
      return;
    case 'privacy/setResistFingerprinting':
      browser.privacy.websites.resistFingerprinting
        .set({ value: action.enabled })
        .catch((err) => console.warn('[bento-tools] privacy/setResistFingerprinting failed:', err))
        .finally(() => void emitPrivacySnapshot(ctx));
      return;
    case 'privacy/setNetworkPrediction':
      browser.privacy.network.networkPredictionEnabled
        .set({ value: action.enabled })
        .catch((err) => console.warn('[bento-tools] privacy/setNetworkPrediction failed:', err))
        .finally(() => void emitPrivacySnapshot(ctx));
      return;
    case 'privacy/setPeerConnection':
      browser.privacy.network.peerConnectionEnabled
        .set({ value: action.enabled })
        .catch((err) => console.warn('[bento-tools] privacy/setPeerConnection failed:', err))
        .finally(() => void emitPrivacySnapshot(ctx));
      return;
    case 'backup/export':
      void (async () => {
        try {
          const data = await ctx.backup.collectSnapshot(action.workspaceIds);
          const json = JSON.stringify(data, null, 2);
          const date = new Date().toISOString().slice(0, 10);
          ctx.send({ type: 'backup/exportReady', json, filename: `bento-backup-${date}.json` });
        } catch (err) {
          console.warn('[bento-tools] backup/export failed:', err);
        }
      })();
      return;
    case 'backup/import': {
      const validated = validateExportSchema(action.data);
      if (!validated) {
        ctx.send({ type: 'backup/importError', message: 'Invalid export file format.' });
        return;
      }
      void (async () => {
        try {
          const summary = await executeImport(validated, action.options, {
            workspaces: ctx.workspaces,
            tabs: ctx.tabs,
            panels: ctx.panels,
            pinnedPanels: ctx.pinnedPanels,
            settings: ctx.settings,
            savedPanels: ctx.savedPanels,
          });
          ctx.send({ type: 'backup/importComplete', summary });
        } catch (err) {
          console.warn('[bento-tools] backup/import failed:', err);
          ctx.send({ type: 'backup/importError', message: String(err) });
        }
      })();
      return;
    }
    case 'backup/requestList':
      void (async () => {
        const backups = await ctx.backup.listBackups();
        ctx.send({ type: 'backup/list', backups });
      })();
      return;
    case 'backup/restore':
      void (async () => {
        try {
          const data = await ctx.backup.getBackupData(action.backupId);
          if (!data) {
            ctx.send({ type: 'backup/importError', message: 'Backup not found.' });
            return;
          }
          const summary = await executeImport(
            data,
            { importSettings: false, importSavedPanels: false, replaceExisting: false },
            {
              workspaces: ctx.workspaces,
              tabs: ctx.tabs,
              panels: ctx.panels,
              pinnedPanels: ctx.pinnedPanels,
              settings: ctx.settings,
              savedPanels: ctx.savedPanels,
            },
          );
          ctx.send({ type: 'backup/importComplete', summary });
        } catch (err) {
          console.warn('[bento-tools] backup/restore failed:', err);
          ctx.send({ type: 'backup/importError', message: String(err) });
        }
      })();
      return;
    case 'backup/delete':
      void (async () => {
        await ctx.backup.deleteBackup(action.backupId);
        const backups = await ctx.backup.listBackups();
        ctx.send({ type: 'backup/list', backups });
      })();
      return;
    default: {
      const _exhaustive: never = action;
      console.warn('[bento-tools] unhandled action:', _exhaustive);
    }
  }
}
