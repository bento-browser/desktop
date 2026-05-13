// TabList visual + virtualization stories. The 200-tabs story is the
// main perf check before touching the real browser.

import { useEffect } from 'react';
import { TabList } from './TabList';
import { seedEmpty, seedTabs } from '../../state/__fixtures__/tabs';

const noop = () => {};

function SidebarFrame({
  children,
  height = 600,
  width = 240,
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
      <TabList onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

export const FewTabs = () => {
  useEffect(() => {
    seedTabs(5, 1);
  }, []);
  return (
    <SidebarFrame>
      <TabList onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
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
      <TabList onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
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
      <TabList onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
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
      <TabList onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
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
      <TabList onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
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
      <TabList onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
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
      <TabList onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
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
      <TabList onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

CollapsedMany.storyName = 'Collapsed — 40 tabs (scroll check)';
