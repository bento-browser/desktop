// TabList visual + virtualization stories. The 200-tabs story is the
// main perf check before touching the real browser.

import { useEffect, useState } from 'react';
import type { Action, TabSnapshot } from '@shared/protocol';
import { TabList } from './TabList';
import { openSearchForStory } from './openSearchForStory';
import { makeTab, seedTabsAcrossWorkspaces } from '../../state/__fixtures__/tabs';
import { seedDefault as seedDefaultWorkspaces } from '../../state/__fixtures__/workspaces';
import { seedPanelsByWorkspace, seedPanelsHydrated } from '../../state/__fixtures__/panels';
import { makeFolder, seedTabFolders } from '../../state/__fixtures__/tabFolders';
import { DEFAULT_FIXTURE } from '../../state/__fixtures__/settings';
import { useWorkspacesStore } from '../../state/workspaces';
import { useSettingsStore } from '../../state/settings';
import { useTabsStore } from '../../state/tabs';
import { useUiStore } from '../../state/ui';

const noop = () => {};
const defaultTabListProps = {
  onActivate: noop,
  onClose: noop,
  onOpenNewMenu: noop,
  onOpenInSidePanel: noop,
};

const COLLAPSED_SIDEBAR_WIDTH = 'var(--bento-tab-strip-width-collapsed)';

function SidebarFrame({
  children,
  height = 600,
  width = 300,
}: {
  children: React.ReactNode;
  height?: number;
  width?: number | string;
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

// TabList draws the collapsed rail's custom scrollbar only when the settings
// store says the sidebar is collapsed. Seed it so a story does not inherit
// whatever an earlier story, such as an App one, left there.
function seedSidebarSettings(collapsed = false): void {
  useSettingsStore.getState().apply({ ...DEFAULT_FIXTURE, sidebarCollapsed: collapsed });
}

// TabList renders the skeleton until tabs, folders and the active workspace's
// panels have all hydrated, and it lists only the active workspace's tabs. Seed
// all of that together so a story renders on a fresh page load, not just after
// another story has hydrated the stores. The fixtures replace each store, so a
// story never sees the previous story's workspaces, tabs, folders or panels.
function seedSidebarTabs(count: number, activeIndex = 0, collapsed = false): void {
  seedSidebarSettings(collapsed);
  seedDefaultWorkspaces();
  const tabs = Array.from({ length: count }, (_, i) =>
    makeTab({ id: i + 1, workspaceId: 'w-personal', active: i === activeIndex }),
  );
  useTabsStore.getState().applySnapshot(tabs);
  seedTabFolders([]);
  seedPanelsHydrated(['w-personal']);
}

export const Empty = () => {
  useEffect(() => {
    seedSidebarTabs(0);
  }, []);
  return (
    <SidebarFrame>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

export const FewTabs = () => {
  useEffect(() => {
    seedSidebarTabs(5, 1);
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
    seedSidebarTabs(20, 3);
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
    seedSidebarTabs(200, 50);
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
    seedSidebarTabs(1000, 500);
  }, []);
  return (
    <SidebarFrame>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

HugeStress.storyName = '1000 tabs (extreme stress; should still scroll at 60fps)';

// The chrome overlay's menu is not rendered in Ladle; seeding the store is what
// bridge/newMenu.ts does when the overlay shows the New menu.
export const NewMenuOpen = () => {
  useEffect(() => {
    seedSidebarTabs(5);
    useUiStore.getState().setNewMenuContextId('story-menu');
    return () => useUiStore.getState().setNewMenuContextId(null);
  }, []);
  return (
    <SidebarFrame>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

NewMenuOpen.storyName = 'New menu open';

export const NarrowSidebar = () => {
  useEffect(() => {
    seedSidebarTabs(10, 0);
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
    seedSidebarTabs(10, 0);
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
    seedSidebarTabs(8, 2, true);
  }, []);
  useCollapsedAttribute(true);
  return (
    <SidebarFrame width={COLLAPSED_SIDEBAR_WIDTH}>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

Collapsed.storyName = 'Collapsed (favicon-only stack, Search square under New)';

// A query typed into the open field, then the sidebar collapses: TabList parks the query and
// the rail's Search square keeps the field's ring and a dot. The frame snaps (no chrome push
// here; the App choreography story animates it).
export const CollapsedSearchParked = () => {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    seedSidebarTabs(8, 2);
    const stopSearch = openSearchForStory('bento');
    const timer = setTimeout(() => {
      seedSidebarSettings(true);
      setCollapsed(true);
    }, 800);
    return () => {
      stopSearch();
      clearTimeout(timer);
    };
  }, []);
  useCollapsedAttribute(collapsed);
  return (
    <SidebarFrame width={collapsed ? COLLAPSED_SIDEBAR_WIDTH : 300}>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

CollapsedSearchParked.storyName = 'Collapsed, query parked (ring and dot on the Search square)';

export const CollapsedMany = () => {
  // Verifies the favicon-only layout still virtualizes cleanly when more
  // tabs exist than fit on screen — the rail should scroll vertically
  // without any title text overflowing horizontally.
  useEffect(() => {
    seedSidebarTabs(40, 5, true);
  }, []);
  useCollapsedAttribute(true);
  return (
    <SidebarFrame width={COLLAPSED_SIDEBAR_WIDTH}>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

CollapsedMany.storyName = 'Collapsed — 40 tabs (scroll check)';

// Interactive drag-and-drop reorder demo. Seeds a pinned tab and a folder
// in the active workspace so the drag flow has real drop targets. The
// onReorder callback applies the browser.tabs.move semantics locally to
// the store so the resulting order is visible without a real bento-tools
// port.
export const DragReorder = () => {
  const [log, setLog] = useState<string[]>([]);
  useEffect(() => {
    seedSidebarSettings();
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
    seedSidebarSettings();
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
    seedTabFolders([]);
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

// Opens the field and types `query`, as a user would (see openSearchForStory).
function useOpenSearch(query: string) {
  useEffect(() => openSearchForStory(query), [query]);
}

// Search results with the domain under the title: normal, long title, long
// domain, www kept, an about: page, a panel, and a moz-extension page with no
// domain (single-line row).
export const SearchResultDomains = () => {
  useOpenSearch('bento');
  useEffect(() => {
    seedSidebarSettings();
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
    const tabs = [
      makeTab({
        id: 1,
        workspaceId: 'w-personal',
        active: true,
        title: 'Bento Browser on GitHub',
        url: 'https://github.com/andrewtran/bento-browser',
      }),
      makeTab({
        id: 2,
        workspaceId: 'w-personal',
        title: 'Bento roadmap',
        url: 'https://www.notion.so/bento/roadmap',
      }),
      makeTab({
        id: 3,
        workspaceId: 'w-work',
        title:
          'Bento: a very long tab title that should definitely get truncated with an ellipsis when it runs out of space',
        url: 'https://mail.google.com/mail/u/0/#inbox',
      }),
      makeTab({
        id: 4,
        workspaceId: 'w-work',
        title: 'Bento staging dashboard',
        url: 'https://bento-staging-environment.internal.some-very-long-company-name.example.com/dashboard',
      }),
      makeTab({ id: 5, workspaceId: 'w-side', title: 'Bento new tab', url: 'about:blank' }),
      makeTab({
        id: 6,
        workspaceId: 'w-side',
        title: 'Bento extension settings',
        url: 'moz-extension://bento-shell/settings.html',
      }),
      makeTab({
        id: 7,
        workspaceId: 'w-work',
        title: 'Bento docs (panel)',
        url: 'https://docs.bento.example/guide',
      }),
    ];
    useTabsStore.getState().applySnapshot(tabs);
    seedTabFolders([]);
    seedPanelsByWorkspace({ 'w-personal': [], 'w-work': [7], 'w-side': [] });
  }, []);
  return (
    <SidebarFrame>
      <TabList {...defaultTabListProps} />
    </SidebarFrame>
  );
};

SearchResultDomains.storyName = 'Search result domains';
