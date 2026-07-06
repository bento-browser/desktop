// Visual states for the layer-2 TabRow component. Iterate styling here
// instead of the deploy+reload loop in real Bento.

import { useEffect } from 'react';
import { TabRow } from './TabRow';
import { makeTab, seedSingle } from '../../state/__fixtures__/tabs';

const noop = () => {};
const COLLAPSED_SIDEBAR_WIDTH = 'var(--bento-tab-strip-width-collapsed)';

function SidebarFrame({
  children,
  collapsed = false,
}: {
  children: React.ReactNode;
  collapsed?: boolean;
}) {
  // Mimic the real shell sidebar's width + dark canvas so visual states
  // match what they look like inside Bento. collapsed=true uses the same
  // collapsed host-width token as chrome.
  return (
    <div
      style={{
        width: collapsed ? COLLAPSED_SIDEBAR_WIDTH : 300,
        boxSizing: 'border-box',
        backgroundColor: 'var(--bento-brand-bg)',
        padding: collapsed ? '0 var(--bento-sidebar-collapsed-inline-padding)' : 'var(--space-xs)',
        display: collapsed ? 'flex' : undefined,
        justifyContent: collapsed ? 'center' : undefined,
      }}
    >
      {children}
    </div>
  );
}

// Toggle data-bento-collapsed on <html> for the duration of the story so
// TabRow's collapsed CSS rules (grid-template-columns: 0.625rem, hide title /
// audible / actions) take effect. Cleanup on unmount keeps the attribute
// from leaking into other stories.
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

export const Inactive = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: false }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={1} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

export const Active = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: true }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={1} active={true} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

export const LongTitle = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 4, active: false }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={4} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

export const NoFavicon = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 3, favIconUrl: undefined }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={3} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

export const ActiveWithLongTitle = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 4, active: true }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={4} active={true} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

export const StateMatrix = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: false }));
  }, []);
  return (
    <SidebarFrame>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <TabRow id={1} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
        <TabRow id={1} active={true} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
      </div>
    </SidebarFrame>
  );
};

StateMatrix.storyName = 'State matrix (inactive + active)';

export const Loading = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: false, loading: true }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={1} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

export const Discarded = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: false, discarded: true }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={1} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

export const Audible = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: false, audible: true }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={1} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

export const Muted = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: false, muted: true }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={1} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

export const PerformanceMatrix = () => {
  useEffect(() => {
    // Seed five rows with id-keyed combinations so each row reads from a
    // distinct store entry (otherwise useTab(id) would alias the same data
    // across rows). seedSingle replaces the snapshot, so use applySnapshot
    // via a local construction to keep all five tabs alive at once.
    const tabs = [
      makeTab({ id: 10, active: false }),
      makeTab({ id: 11, active: false, loading: true }),
      makeTab({ id: 12, active: false, discarded: true }),
      makeTab({ id: 13, active: false, audible: true }),
      makeTab({ id: 14, active: false, muted: true }),
      makeTab({ id: 15, active: false, audible: true, discarded: true }),
    ];
    // Lazy import to avoid a top-of-file dep just for stories.
    void import('../../state/tabs').then((m) => m.useTabsStore.getState().applySnapshot(tabs));
  }, []);
  return (
    <SidebarFrame>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <TabRow id={10} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
        <TabRow id={11} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
        <TabRow id={12} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
        <TabRow id={13} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
        <TabRow id={14} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
        <TabRow id={15} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
      </div>
    </SidebarFrame>
  );
};

PerformanceMatrix.storyName = 'Performance matrix (idle / loading / discarded / audible / muted)';

export const Collapsed = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: false }));
  }, []);
  useCollapsedAttribute(true);
  return (
    <SidebarFrame collapsed>
      <TabRow id={1} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

Collapsed.storyName = 'Collapsed (narrow rail, favicon-only)';

export const CollapsedActive = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: true }));
  }, []);
  useCollapsedAttribute(true);
  return (
    <SidebarFrame collapsed>
      <TabRow id={1} active={true} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

CollapsedActive.storyName = 'Collapsed — active tab';

export const CollapsedAudible = () => {
  // Audible badge is hidden in collapsed mode (no room in the rail) — this
  // story verifies the favicon centering still works when the audible
  // class would otherwise add a third grid column.
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: false, audible: true }));
  }, []);
  useCollapsedAttribute(true);
  return (
    <SidebarFrame collapsed>
      <TabRow id={1} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

CollapsedAudible.storyName = 'Collapsed — audible (badge hidden)';

export const CollapsedDiscarded = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: false, discarded: true }));
  }, []);
  useCollapsedAttribute(true);
  return (
    <SidebarFrame collapsed>
      <TabRow id={1} active={false} onActivate={noop} onClose={noop} onOpenInSidePanel={noop} />
    </SidebarFrame>
  );
};

CollapsedDiscarded.storyName = 'Collapsed — discarded (dimmed favicon)';

export const Dragging = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: false }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow
        id={1}
        active={false}
        dragging
        onActivate={noop}
        onClose={noop}
        onOpenInSidePanel={noop}
        onDragStart={noop}
        onDragEnd={noop}
      />
    </SidebarFrame>
  );
};

Dragging.storyName = 'Dragging (source row dim)';

export const DraggingActive = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: true }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow
        id={1}
        active
        dragging
        onActivate={noop}
        onClose={noop}
        onOpenInSidePanel={noop}
        onDragStart={noop}
        onDragEnd={noop}
      />
    </SidebarFrame>
  );
};

DraggingActive.storyName = 'Dragging — active tab';
