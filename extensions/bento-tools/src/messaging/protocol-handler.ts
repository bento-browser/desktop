// Routes incoming Action messages from bento-shell to the appropriate
// tools-side handler. Each Action either fires a side effect (close tab,
// switch tab, mutate workspace) or asks tools to broadcast state.
//
// Per-tab workspace assignment (tab/assignWorkspace) lands in PR-3b once
// the browser.sessions wrapper exists; until then it's a no-op stub so the
// type union stays exhaustive.

import type { Action, Event } from '@shared/protocol';
import type { TabRegistry } from '../tabs/TabRegistry';
import type { WorkspaceStore } from '../workspaces/WorkspaceStore';
import type { SettingsStore } from '../settings/SettingsStore';
import type { PanelStore } from '../panels/PanelStore';

export interface HandlerContext {
  tabs: TabRegistry;
  workspaces: WorkspaceStore;
  settings: SettingsStore;
  panels: PanelStore;
  send: (event: Event) => void;
  /** Resolve the active workspace's panel tabIds to {tabId, url} and
   * broadcast a panels/sync event. Lives on background.ts (it needs
   * broadcast access + browser.tabs.get for URL resolution); the handler
   * only triggers it when panel state changes. */
  emitPanelsSync: (workspaceId: string) => void;
}

export function handle(action: Action, ctx: HandlerContext): void {
  switch (action.type) {
    case 'ping':
      ctx.send({ type: 'pong', ts: Date.now() });
      return;
    case 'tabs/requestSnapshot':
      ctx.send({ type: 'tabs/snapshot', tabs: ctx.tabs.snapshot() });
      return;
    case 'tab/activate':
      browser.tabs.update(action.id, { active: true }).catch((err) => {
        console.warn('[bento-tools] tab/activate failed:', action.id, err);
      });
      return;
    case 'tab/close':
      browser.tabs.remove(action.id).catch((err) => {
        console.warn('[bento-tools] tab/close failed:', action.id, err);
      });
      return;
    case 'tab/assignWorkspace':
      void ctx.tabs.assignWorkspace(action.id, action.workspaceId);
      return;
    case 'tab/openUrl':
      // Background script always has browser.tabs available; the chrome-
      // mounted shell document doesn't, which is why this round-trip exists.
      browser.tabs
        .create({ url: action.url, active: action.active ?? true })
        .catch((err) => console.warn('[bento-tools] tab/openUrl failed:', err));
      return;
    case 'tab/create':
      browser.tabs
        .create({ active: action.active ?? true })
        .catch((err) => console.warn('[bento-tools] tab/create failed:', err));
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
      });
      return;
    }
    case 'workspace/create':
      ctx.workspaces.create({ name: action.name, color: action.color, icon: action.icon });
      return;
    case 'workspace/rename':
      ctx.workspaces.rename(action.id, action.name);
      return;
    case 'workspace/recolor':
      ctx.workspaces.recolor(action.id, action.color);
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
    case 'workspace/activate':
      ctx.workspaces.activate(action.id);
      return;
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
      const wsId = ctx.workspaces.getActiveId();
      if (!wsId) return;
      if (ctx.panels.add(wsId, action.id)) ctx.emitPanelsSync(wsId);
      return;
    }
    case 'panel/remove': {
      const wsId = ctx.workspaces.getActiveId();
      if (!wsId) return;
      if (ctx.panels.remove(wsId, action.id)) ctx.emitPanelsSync(wsId);
      return;
    }
    case 'panels/clear': {
      const wsId = ctx.workspaces.getActiveId();
      if (!wsId) return;
      const current = ctx.panels.getPanels(wsId);
      if (current.length === 0) return;
      for (const id of current) ctx.panels.remove(wsId, id);
      ctx.emitPanelsSync(wsId);
      return;
    }
    default: {
      const _exhaustive: never = action;
      console.warn('[bento-tools] unhandled action:', _exhaustive);
    }
  }
}
