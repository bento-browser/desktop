// Top-level App stories. Beyond proving Mux UI renders inside Ladle, the
// Collapsed and CollapseToggle stories are how we iterate on the narrow-rail
// behaviour without rebuilding the whole browser. CollapseToggle is the
// interactive demo: clicking the collapse/expand IconButton in the footer
// updates the settings store via the same BroadcastChannel the real shell
// uses, so the layout transitions exactly as it does in chrome.
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
  // #bento-shell-host.
  return (
    <div
      style={{
        width,
        height: 600,
        backgroundColor: 'var(--bento-brand-bg)',
        display: 'flex',
        flexDirection: 'column',
        // Smooth width changes in CollapseToggle so the demo mirrors the
        // reveal-role transition the chrome host uses when the rail
        // expands/collapses.
        transition: 'width var(--muxui-semantic-motion-reveal-transition)',
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

// Apply data-bento-collapsed to <html> so component CSS (TabRow,
// WorkspaceSwitcher, footer column-reverse) reacts. Cleanup on unmount so
// switching between stories doesn't leak the attribute.
function useCollapsedAttribute(collapsed: boolean) {
  useEffect(() => {
    const html = document.documentElement;
    if (collapsed) html.setAttribute('data-bento-collapsed', 'true');
    else html.removeAttribute('data-bento-collapsed');
    return () => {
      html.removeAttribute('data-bento-collapsed');
    };
  }, [collapsed]);
}

export const Default = () => {
  useEffect(() => {
    seedShell(false);
  }, []);
  useCollapsedAttribute(false);
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
  useCollapsedAttribute(true);
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
  // sidebarCollapsed from the store and the layout transitions live.
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
  // Mirror the App's own useEffect for data-bento-collapsed by reading
  // the store directly here. Subscribing to the store keeps the attribute
  // in sync even though the App is what actually toggles it (the App's
  // effect fires too, but on a different render cycle — driving it from
  // the story keeps the demo robust if the App's effect timing changes).
  const collapsed = useSettingsStore((s) => s.current?.sidebarCollapsed ?? false);
  useCollapsedAttribute(collapsed);
  return (
    <ShellFrame width={collapsed ? COLLAPSED_SIDEBAR_WIDTH : 300}>
      <App />
    </ShellFrame>
  );
};

CollapseToggle.storyName = 'Collapse toggle (interactive)';
