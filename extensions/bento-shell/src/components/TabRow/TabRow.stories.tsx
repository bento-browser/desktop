// Visual states for the layer-2 TabRow component. Iterate styling here
// instead of the deploy+reload loop in real Bento.

import { useEffect } from 'react';
import { TabRow } from './TabRow';
import { makeTab, seedSingle } from '../../state/__fixtures__/tabs';

const noop = () => {};

function SidebarFrame({ children }: { children: React.ReactNode }) {
  // Mimic the real shell sidebar's width + dark canvas so visual states
  // match what they look like inside Bento.
  return (
    <div
      style={{
        width: 240,
        backgroundColor: 'var(--bento-brand-bg)',
        padding: 'var(--space-xs)',
      }}
    >
      {children}
    </div>
  );
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
      makeTab({ id: 14, active: false, audible: true, discarded: true }),
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
      </div>
    </SidebarFrame>
  );
};

PerformanceMatrix.storyName = 'Performance matrix (idle / loading / discarded / audible)';
