// Visual states for the PinnedPanels sidebar section.
// Pinned panels live above the TabList and are GLOBAL across workspaces,
// so seeding multiple workspaceIds is meaningful here (unlike TabRow).

import { useEffect } from 'react';
import { PinnedPanels } from './PinnedPanels';
import { makePinnedEntry, seedPinnedPanels } from '../../state/__fixtures__/pinnedPanels';
import { makeTab } from '../../state/__fixtures__/tabs';
import { useTabsStore } from '../../state/tabs';

const COLLAPSED_SIDEBAR_WIDTH = 'var(--bento-tab-strip-width-collapsed)';

function SidebarFrame({
  children,
  collapsed = false,
}: {
  children: React.ReactNode;
  collapsed?: boolean;
}) {
  return (
    <div
      style={{
        width: collapsed ? COLLAPSED_SIDEBAR_WIDTH : 300,
        backgroundColor: 'var(--bento-brand-bg)',
        padding: collapsed ? 0 : 'var(--space-xs)',
      }}
    >
      {children}
    </div>
  );
}

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
    seedPinnedPanels([]);
  }, []);
  return (
    <SidebarFrame>
      <PinnedPanels />
    </SidebarFrame>
  );
};

Empty.storyName = 'Empty (renders nothing)';

export const SinglePin = () => {
  useEffect(() => {
    useTabsStore.getState().applySnapshot([makeTab({ id: 101, title: 'Claude — Bento UI' })]);
    seedPinnedPanels([makePinnedEntry({ workspaceId: 'w-personal', tabId: 101, order: 0 })]);
  }, []);
  return (
    <SidebarFrame>
      <PinnedPanels />
    </SidebarFrame>
  );
};

export const MultiWorkspace = () => {
  useEffect(() => {
    useTabsStore
      .getState()
      .applySnapshot([
        makeTab({ id: 101, title: 'Claude — Personal' }),
        makeTab({ id: 102, title: 'Linear — Work backlog' }),
        makeTab({ id: 103, title: 'Figma — Bento UI' }),
      ]);
    seedPinnedPanels([
      makePinnedEntry({ workspaceId: 'w-personal', tabId: 101, order: 0 }),
      makePinnedEntry({ workspaceId: 'w-work', tabId: 102, order: 1 }),
      makePinnedEntry({ workspaceId: 'w-side', tabId: 103, order: 2 }),
    ]);
  }, []);
  return (
    <SidebarFrame>
      <PinnedPanels />
    </SidebarFrame>
  );
};

MultiWorkspace.storyName = 'Multi-workspace (no workspace indicator on rows)';

export const LongTitles = () => {
  useEffect(() => {
    useTabsStore.getState().applySnapshot([
      makeTab({
        id: 201,
        title:
          'A Very Long Pinned Panel Title That Should Definitely Get Truncated With An Ellipsis',
      }),
      makeTab({
        id: 202,
        title: 'Another Extremely Long Title For The Second Pinned Panel Row',
      }),
    ]);
    seedPinnedPanels([
      makePinnedEntry({ workspaceId: 'w-personal', tabId: 201, order: 0 }),
      makePinnedEntry({ workspaceId: 'w-work', tabId: 202, order: 1 }),
    ]);
  }, []);
  return (
    <SidebarFrame>
      <PinnedPanels />
    </SidebarFrame>
  );
};

export const ManyPins = () => {
  useEffect(() => {
    const tabs = Array.from({ length: 12 }, (_, i) =>
      makeTab({ id: 300 + i, title: `Pinned panel ${i + 1}` }),
    );
    useTabsStore.getState().applySnapshot(tabs);
    seedPinnedPanels(
      tabs.map((t, i) =>
        makePinnedEntry({
          workspaceId: i % 2 === 0 ? 'w-personal' : 'w-work',
          tabId: t.id,
          order: i,
        }),
      ),
    );
  }, []);
  return (
    <SidebarFrame>
      <PinnedPanels />
    </SidebarFrame>
  );
};

ManyPins.storyName = 'Many pins (scrolls internally past max-height)';

export const UnknownTab = () => {
  // Tab not in this shell's store — exercises the cross-window
  // fallback where useTab returns undefined.
  useEffect(() => {
    useTabsStore.getState().applySnapshot([]);
    seedPinnedPanels([makePinnedEntry({ workspaceId: 'w-personal', tabId: 999, order: 0 })]);
  }, []);
  return (
    <SidebarFrame>
      <PinnedPanels />
    </SidebarFrame>
  );
};

UnknownTab.storyName = 'Unknown tab (cross-window fallback label)';

export const Collapsed = () => {
  useEffect(() => {
    useTabsStore
      .getState()
      .applySnapshot([
        makeTab({ id: 401, title: 'Claude — Personal' }),
        makeTab({ id: 402, title: 'Linear — Work' }),
      ]);
    seedPinnedPanels([
      makePinnedEntry({ workspaceId: 'w-personal', tabId: 401, order: 0 }),
      makePinnedEntry({ workspaceId: 'w-work', tabId: 402, order: 1 }),
    ]);
  }, []);
  useCollapsedAttribute(true);
  return (
    <SidebarFrame collapsed>
      <PinnedPanels />
    </SidebarFrame>
  );
};

Collapsed.storyName = 'Collapsed (narrow rail, favicon-only)';
