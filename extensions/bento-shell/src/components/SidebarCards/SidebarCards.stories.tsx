// The card container over a tab list: with no card the list is whole, with one or two
// the list's end padding (read out below the frame) is their height plus the offset and
// gap. The merge card is the only real card type; the plain card shows how a second one
// stacks above the footer.
import { useEffect } from 'react';
import { SidebarCards } from './SidebarCards';
import { MergeProgressCard } from '../MergeProgressCard/MergeProgressCard';
import { TabList } from '../TabList/TabList';
import { seedExternalMerge } from '../../state/__fixtures__/externalMerge';
import { makeTab } from '../../state/__fixtures__/tabs';
import { seedDefault as seedDefaultWorkspaces } from '../../state/__fixtures__/workspaces';
import { seedPanelsHydrated } from '../../state/__fixtures__/panels';
import { seedTabFolders } from '../../state/__fixtures__/tabFolders';
import { DEFAULT_FIXTURE } from '../../state/__fixtures__/settings';
import { useSettingsStore } from '../../state/settings';
import { useSidebarCardsStore } from '../../state/sidebarCards';
import { useTabsStore } from '../../state/tabs';
// The shell layout: the list region the cards are laid over.
import '../../app.css';

const noop = () => {};

function seedSidebar(): void {
  useSettingsStore.getState().apply({ ...DEFAULT_FIXTURE, sidebarCollapsed: false });
  seedDefaultWorkspaces();
  useTabsStore
    .getState()
    .applySnapshot(
      Array.from({ length: 24 }, (_, i) =>
        makeTab({ id: i + 1, workspaceId: 'w-personal', active: i === 1 }),
      ),
    );
  seedTabFolders([]);
  seedPanelsHydrated(['w-personal']);
}

function InsetReadout() {
  const inset = useSidebarCardsStore((s) => s.inset);
  return <p style={{ margin: 8 }}>List end padding: {inset}px</p>;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div
        style={{
          width: 300,
          height: 520,
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--bento-brand-bg)',
        }}
      >
        <div className="bento-shell-app__list-region">
          <TabList onActivate={noop} onClose={noop} onOpenNewMenu={noop} onOpenInSidePanel={noop} />
          <SidebarCards>{children}</SidebarCards>
        </div>
      </div>
      <InsetReadout />
    </>
  );
}

export const NoCards = () => {
  useEffect(() => {
    seedSidebar();
    seedExternalMerge('idle');
  }, []);
  return (
    <Frame>
      <MergeProgressCard onOpen={noop} />
    </Frame>
  );
};
NoCards.storyName = 'No card (inset 0)';

export const MergeCard = () => {
  useEffect(() => {
    seedSidebar();
    seedExternalMerge('importing');
    return () => seedExternalMerge('idle');
  }, []);
  return (
    <Frame>
      <MergeProgressCard onOpen={noop} />
    </Frame>
  );
};
MergeCard.storyName = 'Merge card';

export const StackedCards = () => {
  useEffect(() => {
    seedSidebar();
    seedExternalMerge('done');
    return () => seedExternalMerge('idle');
  }, []);
  return (
    <Frame>
      <div
        className="bento-sidebar-card"
        style={{ padding: 'var(--bento-sidebar-card-padding)', alignItems: 'center' }}
      >
        A second card stacks above the footer.
      </div>
      <MergeProgressCard onOpen={noop} />
    </Frame>
  );
};
StackedCards.storyName = 'Two cards stacked';
