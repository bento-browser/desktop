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
      <TabRow id={1} active={false} onActivate={noop} onClose={noop} />
    </SidebarFrame>
  );
};

export const Active = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 1, active: true }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={1} active={true} onActivate={noop} onClose={noop} />
    </SidebarFrame>
  );
};

export const LongTitle = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 4, active: false }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={4} active={false} onActivate={noop} onClose={noop} />
    </SidebarFrame>
  );
};

export const NoFavicon = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 3, favIconUrl: undefined }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={3} active={false} onActivate={noop} onClose={noop} />
    </SidebarFrame>
  );
};

export const ActiveWithLongTitle = () => {
  useEffect(() => {
    seedSingle(makeTab({ id: 4, active: true }));
  }, []);
  return (
    <SidebarFrame>
      <TabRow id={4} active={true} onActivate={noop} onClose={noop} />
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
        <TabRow id={1} active={false} onActivate={noop} onClose={noop} />
        <TabRow id={1} active={true} onActivate={noop} onClose={noop} />
      </div>
    </SidebarFrame>
  );
};

StateMatrix.storyName = 'State matrix (inactive + active)';
