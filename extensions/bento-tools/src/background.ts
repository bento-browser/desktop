// Bento Tools — background entry point.
//
// Owns the persistent state: tab registry, future workspace store, future
// keyboard registry. Accepts long-lived ports from bento-shell, sends an
// initial snapshot + tools/booted Event, then streams batched deltas.

import { handle } from './messaging/protocol-handler';
import { TabRegistry } from './tabs/TabRegistry';
import { SleepPolicy } from './tabs/SleepPolicy';
import { WorkspaceStore } from './workspaces/WorkspaceStore';
import { SettingsStore } from './settings/SettingsStore';
import { KeyRegistry } from './keyboard/KeyRegistry';
import type { Action, Event } from '@shared/protocol';
import { SHELL_TOOLS_PORT } from '@shared/protocol';

console.log('[bento-tools] boot', new Date().toISOString());

const tabs = new TabRegistry();
const workspaces = new WorkspaceStore();
const settings = new SettingsStore();

// Set of currently-connected shell document ports. Tools can broadcast
// events to all of them — needed for tools-initiated UI events like
// ui/openCommandPalette (fired by the global Cmd+K shortcut). Per-port
// state-delta sends still happen inside the onConnect handler closure.
const connectedPorts = new Set<browser.runtime.Port>();
function broadcastEvent(event: Event): void {
  for (const port of connectedPorts) {
    try {
      port.postMessage(event);
    } catch (err) {
      console.warn('[bento-tools] broadcast failed:', err);
    }
  }
}

const keys = new KeyRegistry({ workspaces, broadcastEvent });
const sleep = new SleepPolicy(tabs, settings);
// Sleep depends on TabRegistry + SettingsStore being populated for its first
// sweep (Workspaces only matter if a tab has a workspaceId). Defer init
// until they're ready.
Promise.all([
  tabs.init().catch((err) => console.error('[bento-tools] TabRegistry init failed:', err)),
  workspaces.init().catch((err) => console.error('[bento-tools] WorkspaceStore init failed:', err)),
  settings.init().catch((err) => console.error('[bento-tools] SettingsStore init failed:', err)),
]).then(() => sleep.init());
keys.init();

// Auto-assign newly created tabs to the currently active workspace. Existing
// tabs without an assignment (e.g. first-boot upgrade from a pre-workspaces
// session) are NOT retroactively assigned here — that would clobber a future
// "leave unassigned" semantic if we ever add it. The shell can backfill on
// demand via tab/assignWorkspace.
tabs.onDeltas((deltas) => {
  for (const d of deltas) {
    if (d.kind !== 'created') continue;
    if (d.tab.workspaceId) continue;
    const wsId = workspaces.getActiveId();
    if (!wsId) continue;
    void tabs.assignWorkspace(d.tab.id, wsId);
  }
});

browser.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== SHELL_TOOLS_PORT) {
    console.warn('[bento-tools] rejecting unknown port name:', port.name);
    return;
  }
  console.log('[bento-tools] shell connected:', port.sender?.id);
  connectedPorts.add(port);

  const send = (event: Event) => {
    try {
      port.postMessage(event);
    } catch (err) {
      console.warn('[bento-tools] postMessage failed (port may be disconnected):', err);
    }
  };

  send({ type: 'tools/booted', version: '0.0.0' });
  send({ type: 'tabs/snapshot', tabs: tabs.snapshot() });
  const wsSnap = workspaces.snapshot();
  send({ type: 'workspaces/snapshot', workspaces: wsSnap.workspaces, activeId: wsSnap.activeId });
  send({ type: 'settings/snapshot', settings: settings.snapshot() });

  const unsubTabs = tabs.onDeltas((deltas) => {
    send({ type: 'tabs/changed', deltas });
  });
  const unsubWorkspaces = workspaces.onDeltas((deltas) => {
    send({ type: 'workspaces/changed', deltas });
  });
  const unsubSettings = settings.onChange((next) => {
    send({ type: 'settings/changed', settings: next });
  });

  port.onMessage.addListener((message: object) => {
    handle(message as Action, { tabs, workspaces, settings, send });
  });

  port.onDisconnect.addListener(() => {
    connectedPorts.delete(port);
    unsubTabs();
    unsubWorkspaces();
    unsubSettings();
  });
});
