// Top-level App stories. Beyond proving Mux UI renders inside Ladle, the
// Collapsed and CollapseToggle stories are how we iterate on the narrow-rail
// behaviour without rebuilding the whole browser. CollapseToggle is the
// interactive demo: clicking the collapse/expand IconButton in the footer
// updates the settings store via the same BroadcastChannel the real shell
// uses. The App switches to the rail layout from the width of its own frame,
// the way the real shell does from the width chrome gives its host, so the
// frame width is what these stories set (chrome's slide animation is not
// reproduced here; the frame snaps).
import { useEffect } from 'react';
import { App } from './App';
// The shell layout (sidebar column, footer stacking in the collapsed rail). Every
// selector in it is scoped to the shell's own classes, so loading it here does not
// touch other stories. Its bento.app layer ranks above bento.components through the
// order statement in theme/muxui.css, whatever order the imports run in.
import './app.css';
import { seedTabsAcrossWorkspaces } from './state/__fixtures__/tabs';
import { seedMany as seedManyWorkspaces } from './state/__fixtures__/workspaces';
import { seedPanelsHydrated } from './state/__fixtures__/panels';
import { seedTabFolders } from './state/__fixtures__/tabFolders';
import { seedEmptyPinnedPanels } from './state/__fixtures__/pinnedPanels';
import { DEFAULT_FIXTURE } from './state/__fixtures__/settings';
import { markToolsBootedForStory } from './state/__fixtures__/bus';
import { useExternalMergeStore } from './state/externalMerge';
import { useSettingsStore } from './state/settings';
import { useSidebarAddressStore } from './state/sidebarAddress';
import type { Action } from '@shared/protocol';

const COLLAPSED_SIDEBAR_WIDTH = 'var(--bento-tab-strip-width-collapsed)';

function ShellFrame({
  children,
  width = 300,
}: {
  children: React.ReactNode;
  width?: number | string;
}) {
  // Match the real shell's host frame: fixed-width column on a brand-bg
  // canvas. Collapsed stories use the same token chrome applies to
  // #bento-shell-host, which is what turns the rail visuals on.
  return (
    <div
      style={{
        width,
        height: 600,
        backgroundColor: 'var(--bento-brand-bg)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </div>
  );
}

// Seed the full shell: 3 workspaces (Personal blue / Work emerald / Side
// project amber, Work active), tabs spread across all three so switching
// workspaces in the demo shows distinct lists, an empty folder list, and
// panels marked hydrated for every workspace. TabList shows its skeleton
// until tabs, folders and the active workspace's panels have all hydrated,
// so every one of those is seeded. Settings carry the requested
// sidebarCollapsed value. The sidebar address, pinned-panel and external-merge
// stores are reset: a fresh shell has no address snapshot, no pinned panels and
// no import running until the chrome bridge sends them, and these stores
// outlive a story switch, so another story's data would otherwise stay.
function seedShell(sidebarCollapsed: boolean) {
  const workspaces = seedManyWorkspaces();
  seedTabsAcrossWorkspaces(
    [
      { workspaceId: 'w-personal', count: 5 },
      { workspaceId: 'w-work', count: 8 },
      { workspaceId: 'w-side', count: 3 },
    ],
    'w-work',
  );
  seedTabFolders([]);
  seedPanelsHydrated(workspaces.map((w) => w.id));
  useSettingsStore.getState().apply({ ...DEFAULT_FIXTURE, sidebarCollapsed });
  useSidebarAddressStore.getState().reset();
  seedEmptyPinnedPanels();
  useExternalMergeStore.setState(useExternalMergeStore.getInitialState());
  // Fake a tools/booted event AFTER seeding so the App's "connecting…"
  // indicator clears. Order matters: useToolsPort responds to booted by
  // re-requesting snapshots; nothing answers those in Ladle, but if we
  // primed the bus before seeding we'd have a brief window where the
  // store transitions through whatever-was-there before our snapshot.
  markToolsBootedForStory();
}

export const Default = () => {
  useEffect(() => {
    seedShell(false);
  }, []);
  return (
    <ShellFrame>
      <App />
    </ShellFrame>
  );
};

export const Collapsed = () => {
  useEffect(() => {
    seedShell(true);
  }, []);
  return (
    <ShellFrame width={COLLAPSED_SIDEBAR_WIDTH}>
      <App />
    </ShellFrame>
  );
};

Collapsed.storyName = 'Collapsed (narrow rail)';

export const CollapseToggle = () => {
  // Interactive demo. The App's collapse IconButton dispatches
  // { type: 'settings/update', changes: { sidebarCollapsed } } onto the
  // 'bento-shell-bus' BroadcastChannel; in real Bento the background page
  // forwards that to bento-tools which writes the setting and broadcasts
  // back. Here we short-circuit by listening on the same channel and
  // applying the change directly to useSettingsStore — the App re-reads
  // sidebarCollapsed from the store and the frame below resizes.
  useEffect(() => {
    seedShell(false);
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('bento-shell-bus');
    const onMessage = (msg: MessageEvent) => {
      const data = msg.data as { kind?: string; action?: Action } | null;
      if (!data || data.kind !== 'action' || !data.action) return;
      if (data.action.type !== 'settings/update') return;
      const cur = useSettingsStore.getState().current ?? DEFAULT_FIXTURE;
      useSettingsStore.getState().apply({ ...cur, ...data.action.changes });
    };
    channel.addEventListener('message', onMessage);
    return () => {
      channel.removeEventListener('message', onMessage);
      channel.close();
    };
  }, []);
  // The frame is the shell's viewport here: it takes the setting's width at
  // once, and the App's own width observer flips the rail visuals with it.
  const collapsed = useSettingsStore((s) => s.current?.sidebarCollapsed ?? false);
  return (
    <ShellFrame width={collapsed ? COLLAPSED_SIDEBAR_WIDTH : 300}>
      <App />
    </ShellFrame>
  );
};

CollapseToggle.storyName = 'Collapse toggle (interactive)';
