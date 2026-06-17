// TabList visual + virtualization stories. The 200-tabs story is the
// main perf check before touching the real browser.

import { useEffect, useState } from 'react';
import type { Action, TabSnapshot } from '@shared/protocol';
import { TabList } from './TabList';
import { seedEmpty, seedTabs, seedTabsAcrossWorkspaces } from '../../state/__fixtures__/tabs';
import { seedDefault as seedDefaultWorkspaces } from '../../state/__fixtures__/workspaces';
import { seedPanelsByWorkspace, seedPanelsHydrated } from '../../state/__fixtures__/panels';
import { makeFolder, seedTabFolders } from '../../state/__fixtures__/tabFolders';
import { useWorkspacesStore } from '../../state/workspaces';
import { useTabsStore } from '../../state/tabs';

const noop = () => {};
const defaultTabListProps = {
  onActivate: noop,
  onClose: noop,
  onCreateTab: noop,
  onCreatePanel: noop,
  onOpenInSidePanel: noop,
};

function SidebarFrame({
  children,
  height = 600,
  width = 300,
}: {
  children: React.ReactNode;
  height?: number;
  width?: number;
}) {
  return (
    <div
      style={{
        width,
        height,
        backgroundColor: 'var(--bento-brand-bg)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </div>
  );
}

// Toggle data-bento-collapsed on <html> for the collapsed-rail stories.
// Cleanup on unmount keeps the attribute from leaking into other stories.
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

export const Empty = () => {
  useEffect(() => {
    seedEmpty();
  }, []);
  return (
    <SidebarFrame>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

export const FewTabs = () => {
  useEffect(() => {
    seedTabs(5, 1);
  }, []);
  return (
    <SidebarFrame>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

FewTabs.storyName = '5 tabs';

export const TwentyTabs = () => {
  useEffect(() => {
    seedTabs(20, 3);
  }, []);
  return (
    <SidebarFrame>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

TwentyTabs.storyName = '20 tabs (no scroll needed at default height)';

export const VirtualizationStress = () => {
  useEffect(() => {
    seedTabs(200, 50);
  }, []);
  return (
    <SidebarFrame>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

VirtualizationStress.storyName = '200 tabs (virtualization perf check)';

export const HugeStress = () => {
  useEffect(() => {
    seedTabs(1000, 500);
  }, []);
  return (
    <SidebarFrame>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

HugeStress.storyName = '1000 tabs (extreme stress; should still scroll at 60fps)';

export const NarrowSidebar = () => {
  useEffect(() => {
    seedTabs(10, 0);
  }, []);
  return (
    <SidebarFrame width={200}>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

NarrowSidebar.storyName = 'Narrow (200px min)';

export const WideSidebar = () => {
  useEffect(() => {
    seedTabs(10, 0);
  }, []);
  return (
    <SidebarFrame width={500}>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

WideSidebar.storyName = 'Wide (500px)';

export const Collapsed = () => {
  useEffect(() => {
    seedTabs(8, 2);
  }, []);
  useCollapsedAttribute(true);
  return (
    <SidebarFrame width={64}>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

Collapsed.storyName = 'Collapsed (favicon-only stack)';

export const CollapsedMany = () => {
  // Verifies the favicon-only layout still virtualizes cleanly when more
  // tabs exist than fit on screen — the rail should scroll vertically
  // without any title text overflowing horizontally.
  useEffect(() => {
    seedTabs(40, 5);
  }, []);
  useCollapsedAttribute(true);
  return (
    <SidebarFrame width={64}>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

CollapsedMany.storyName = 'Collapsed — 40 tabs (scroll check)';

// Interactive drag-and-drop reorder demo. Seeds a workspace + panels so
// TabList's readiness gate releases (the unfiltered stories above show
// rows because the gate's `activeWorkspaceId` falls back to null —
// rendering the unfiltered list — but the drag flow needs a real
// active workspace so useWorkspaceTabIds returns the seeded set and
// drop targets resolve correctly). The onReorder callback applies the
// browser.tabs.move semantics locally to the store so the resulting
// order is visible without a real bento-tools port.
export const DragReorder = () => {
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    seedDefaultWorkspaces();
    const tabs = seedTabsAcrossWorkspaces([{ workspaceId: 'w-personal', count: 8 }], 'w-personal');
    useTabsStore.getState().applySnapshot(
      tabs.map((tab) => {
        if (tab.id === 1) return { ...tab, pinned: true };
        if (tab.id === 2 || tab.id === 3) return { ...tab, folderId: 'folder-research' };
        return tab;
      }),
    );
    seedTabFolders([
      makeFolder({
        id: 'folder-research',
        workspaceId: 'w-personal',
        name: 'Research',
        order: 0,
      }),
    ]);
    seedPanelsHydrated(['w-personal']);

    const channel = new BroadcastChannel('bento-shell-bus');
    channel.addEventListener('message', (message) => {
      const data = message.data;
      if (!data || data.kind !== 'action') return;
      const action = data.action as Action;
      if (action.type === 'tab/setPinned') {
        setLog((prev) =>
          [`tab/setPinned { id: ${action.id}, pinned: ${action.pinned} }`, ...prev].slice(0, 6),
        );
        const state = useTabsStore.getState();
        const next = Object.values(state.byId)
          .sort((a, b) => a.index - b.index)
          .map((tab): TabSnapshot => {
            if (tab.id !== action.id) return tab;
            const updated: TabSnapshot = { ...tab, pinned: action.pinned };
            delete updated.folderId;
            return updated;
          });
        state.applySnapshot(next);
      } else if (action.type === 'tabs/setFolder') {
        setLog((prev) =>
          [
            `tabs/setFolder { ids: [${action.ids.join(', ')}], folderId: ${
              action.folderId ?? 'null'
            } }`,
            ...prev,
          ].slice(0, 6),
        );
        const ids = new Set(action.ids);
        const state = useTabsStore.getState();
        const next = Object.values(state.byId)
          .sort((a, b) => a.index - b.index)
          .map((tab): TabSnapshot => {
            if (!ids.has(tab.id)) return tab;
            const updated: TabSnapshot = { ...tab, pinned: false };
            if (action.folderId) updated.folderId = action.folderId;
            else delete updated.folderId;
            return updated;
          });
        state.applySnapshot(next);
      }
    });
    return () => channel.close();
  }, []);
  const onReorder = (id: number, anchorId: number, before: boolean) => {
    setLog((prev) =>
      [`tab/move { id: ${id}, ${before ? 'before' : 'after'}: ${anchorId} }`, ...prev].slice(0, 6),
    );
    // Mirror gBrowser.moveTabBefore/After locally: remove the tab from
    // its current slot and reinsert relative to the anchor, then rewrite
    // every tab's `index` so useWorkspaceTabIds re-derives the new
    // ordering on the next pass.
    const state = useTabsStore.getState();
    const sorted = Object.values(state.byId).sort((a, b) => a.index - b.index);
    const fromIdx = sorted.findIndex((t) => t.id === id);
    if (fromIdx < 0) return;
    const [moved] = sorted.splice(fromIdx, 1);
    if (!moved) return;
    const anchorIdx = sorted.findIndex((t) => t.id === anchorId);
    if (anchorIdx < 0) return;
    sorted.splice(before ? anchorIdx : anchorIdx + 1, 0, moved);
    useTabsStore.getState().applySnapshot(sorted.map((t, i) => ({ ...t, index: i })));
  };
  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <SidebarFrame>
        <TabList {...defaultTabListProps} onReorder={onReorder} />
      </SidebarFrame>
      <div style={{ fontFamily: 'monospace', fontSize: 12, color: 'var(--neutral-70)' }}>
        <div style={{ marginBottom: 8 }}>
          Drag rows to reorder, pin at the top, or drop onto Research. Recent dispatches:
        </div>
        {log.length === 0 ? <div>(none yet)</div> : log.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
};

DragReorder.storyName = 'Drag reorder, pin, and folder drops (interactive)';

export const CrossWorkspaceSearch = () => {
  useEffect(() => {
    seedDefaultWorkspaces();
    useWorkspacesStore.getState().applySnapshot(
      [
        { id: 'w-personal', name: 'Personal', icon: 'P', createdAt: 1 },
        { id: 'w-work', name: 'Work', icon: 'W', themeId: 'teal', createdAt: 2 },
        { id: 'w-side', name: 'Side project', icon: 'S', themeId: 'terracotta', createdAt: 3 },
      ],
      'w-personal',
      {},
    );
    const tabs = seedTabsAcrossWorkspaces(
      [
        { workspaceId: 'w-personal', count: 5 },
        { workspaceId: 'w-work', count: 5 },
        { workspaceId: 'w-side', count: 5 },
      ],
      'w-personal',
    );
    seedPanelsByWorkspace({
      'w-personal': [tabs[2]?.id].filter((id): id is number => typeof id === 'number'),
      'w-work': [tabs[6]?.id].filter((id): id is number => typeof id === 'number'),
      'w-side': [tabs[11]?.id].filter((id): id is number => typeof id === 'number'),
    });
  }, []);
  return (
    <SidebarFrame>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

CrossWorkspaceSearch.storyName = 'Cross-workspace search';
