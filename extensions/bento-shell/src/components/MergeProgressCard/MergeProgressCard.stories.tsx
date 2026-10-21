// The sidebar merge progress card over a populated tab list, in every phase of a
// merge, in the narrow rail, with long text, and scrolled to the end of the list. The
// card is always the opposite colour scheme to the sidebar, so Ladle's theme switch
// shows one inversion and the two Inverted stories show both side by side. Phases are
// seeded through state/__fixtures__/externalMerge.ts; the Lifecycle story drives the
// real store actions from buttons.
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Button } from '@muxui/react';
import { MergeProgressCard, MergeProgressCardView } from './MergeProgressCard';
import { mergeProgressCardModel } from './mergeProgressCardModel';
import type { MergeProgressCardModel } from './mergeProgressCardModel';
import { SidebarCards } from '../SidebarCards/SidebarCards';
import { TabList } from '../TabList/TabList';
import { mergeFixtureInput, seedExternalMerge } from '../../state/__fixtures__/externalMerge';
import type { MergeFixtureState } from '../../state/__fixtures__/externalMerge';
import { makeTab } from '../../state/__fixtures__/tabs';
import { seedDefault as seedDefaultWorkspaces } from '../../state/__fixtures__/workspaces';
import { seedPanelsHydrated } from '../../state/__fixtures__/panels';
import { seedTabFolders } from '../../state/__fixtures__/tabFolders';
import { DEFAULT_FIXTURE } from '../../state/__fixtures__/settings';
import { useExternalMergeStore } from '../../state/externalMerge';
import { useSettingsStore } from '../../state/settings';
import { useTabsStore } from '../../state/tabs';
import { getThemeScopeAttributes } from '../../theme/themeScope';
// The shell layout: the list region the cards are laid over, and the rail rules.
import '../../app.css';

const noop = () => {};
const COLLAPSED_SIDEBAR_WIDTH = 'var(--bento-tab-strip-width-collapsed)';

// TabList renders the skeleton until tabs, folders and the active workspace's panels
// have hydrated; the fixtures replace each store, so a story never sees another's data.
function seedSidebar(tabCount: number, collapsed: boolean): void {
  useSettingsStore.getState().apply({ ...DEFAULT_FIXTURE, sidebarCollapsed: collapsed });
  seedDefaultWorkspaces();
  useTabsStore
    .getState()
    .applySnapshot(
      Array.from({ length: tabCount }, (_, i) =>
        makeTab({ id: i + 1, workspaceId: 'w-personal', active: i === 1 }),
      ),
    );
  seedTabFolders([]);
  seedPanelsHydrated(['w-personal']);
}

// The rail rules key off data-bento-collapsed on <html>; the frame's width is what turns
// them on in the real shell. Cleanup keeps the attribute from leaking into other stories.
function useRailAttribute(rail: boolean) {
  useEffect(() => {
    const html = document.documentElement;
    if (rail) html.setAttribute('data-bento-collapsed', 'true');
    else html.removeAttribute('data-bento-collapsed');
    return () => html.removeAttribute('data-bento-collapsed');
  }, [rail]);
}

const frameStyle = (width: number | string): CSSProperties => ({
  width,
  height: 520,
  display: 'flex',
  flexDirection: 'column',
  backgroundColor: 'var(--bento-brand-bg)',
  color: 'var(--neutral-90)',
});

/** The shell's list region with the card laid over its end, as App.tsx builds it. */
function SidebarList({
  rail = false,
  width = rail ? COLLAPSED_SIDEBAR_WIDTH : 300,
  scrollToEnd = false,
}: {
  rail?: boolean;
  width?: number | string;
  scrollToEnd?: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!scrollToEnd) return;
    // The list pads its end once the card has measured; scroll after that settles.
    const timer = setTimeout(() => {
      const scroller = frameRef.current?.querySelector('.bento-tab-list-pane__scroller');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }, 100);
    return () => clearTimeout(timer);
  }, [scrollToEnd]);
  return (
    <div ref={frameRef} style={frameStyle(width)}>
      <div className="bento-shell-app__list-region">
        <TabList onActivate={noop} onClose={noop} onOpenNewMenu={noop} onOpenInSidePanel={noop} />
        <SidebarCards>
          <MergeProgressCard rail={rail} onOpen={noop} />
        </SidebarCards>
      </div>
    </div>
  );
}

function Phase({
  state,
  long,
  rail = false,
  tabs = 24,
  scrollToEnd = false,
}: {
  state: MergeFixtureState;
  long?: boolean;
  rail?: boolean;
  tabs?: number;
  scrollToEnd?: boolean;
}) {
  useRailAttribute(rail);
  useEffect(() => {
    seedSidebar(tabs, rail);
    seedExternalMerge(state, { long });
    return () => seedExternalMerge('idle');
  }, [state, long, rail, tabs]);
  return <SidebarList rail={rail} scrollToEnd={scrollToEnd} />;
}

export const Preparing = () => <Phase state="preparing" />;
export const Importing = () => <Phase state="importing" />;
export const ImportingLongText = () => <Phase state="importing" long />;
ImportingLongText.storyName = 'Importing, long text';
export const Finalizing = () => <Phase state="finalizing" />;
export const Done = () => <Phase state="done" />;
export const Cancelled = () => <Phase state="cancelled" />;
export const Failed = () => <Phase state="failed" />;

export const ListScrolledToEnd = () => <Phase state="importing" tabs={60} scrollToEnd />;
ListScrolledToEnd.storyName = 'List scrolled to the end (last row clears the card)';

export const RailImporting = () => <Phase state="importing" rail />;
RailImporting.storyName = 'Rail, importing';
export const RailPreparing = () => <Phase state="preparing" rail />;
RailPreparing.storyName = 'Rail, preparing';
export const RailDone = () => <Phase state="done" rail />;
RailDone.storyName = 'Rail, done (click opens and dismisses)';
export const RailCancelled = () => <Phase state="cancelled" rail />;
RailCancelled.storyName = 'Rail, cancelled';
export const RailFailed = () => <Phase state="failed" rail />;
RailFailed.storyName = 'Rail, failed';

const SCHEMES = ['light', 'dark'] as const;
type Scheme = (typeof SCHEMES)[number];
const opposite = (scheme: Scheme): Scheme => (scheme === 'dark' ? 'light' : 'dark');

/** The card model of one phase of a merge. */
function modelOf(state: MergeFixtureState): MergeProgressCardModel {
  const model = mergeProgressCardModel(mergeFixtureInput(state));
  if (!model) throw new Error(`No card for ${state}`);
  return model;
}

const PHASES = ['importing', 'done', 'cancelled', 'failed'] as const;

/**
 * A sidebar in the page scheme `page`, with each phase's card in the opposite scheme: its
 * own scope, as in the shell. Both page schemes sit side by side whatever Ladle's theme is.
 */
function InvertedSidebar({ page, rail = false }: { page: Scheme; rail?: boolean }) {
  const scope = getThemeScopeAttributes('default', opposite(page));
  return (
    <div
      {...getThemeScopeAttributes('default', page)}
      data-color-mode={page}
      style={{
        width: rail ? COLLAPSED_SIDEBAR_WIDTH : 300,
        padding: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        backgroundColor: 'var(--muxui-semantic-surface-background)',
        color: 'var(--muxui-semantic-content-default)',
      }}
    >
      {PHASES.map((phase) => (
        <div key={phase} className="bento-sidebar-cards" style={{ position: 'static', padding: 0 }}>
          <MergeProgressCardView
            model={modelOf(phase)}
            scope={scope}
            rail={rail}
            onOpen={noop}
            onDismiss={noop}
          />
        </div>
      ))}
    </div>
  );
}

export const InvertedOnLightAndDark = () => (
  <div style={{ display: 'flex', gap: 16 }}>
    {SCHEMES.map((page) => (
      <InvertedSidebar key={page} page={page} />
    ))}
  </div>
);
InvertedOnLightAndDark.storyName = 'Inverted: a dark card on light, a light card on dark';

export const InvertedRailOnLightAndDark = () => {
  useRailAttribute(true);
  return (
    <div style={{ display: 'flex', gap: 16 }}>
      {SCHEMES.map((page) => (
        <InvertedSidebar key={page} page={page} rail />
      ))}
    </div>
  );
};
InvertedRailOnLightAndDark.storyName = 'Inverted rail: a dark ring on light, a light ring on dark';

/** Drives the real store actions, as the shell bus does, one step at a time. */
export const Lifecycle = () => {
  useEffect(() => {
    seedSidebar(24, false);
    seedExternalMerge('idle');
    return () => seedExternalMerge('idle');
  }, []);
  const store = useExternalMergeStore.getState;
  const WINDOW = null;
  const OPERATION = 'story-operation';
  const progress = (completedTabs: number) => ({
    operationId: OPERATION,
    windowId: WINDOW,
    progress: {
      stage: 'importing' as const,
      totalWorkspaces: 6,
      completedWorkspaces: 1,
      totalTabs: 608,
      completedTabs,
      importedTabs: completedTabs,
      currentWorkspaceName: 'Work',
      sourceName: 'Firefox',
      activity: {
        kind: 'site' as const,
        title: 'Bento',
        url: 'https://github.com/Bento-Browser',
        status: 'opened' as const,
      },
    },
  });
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button
          variant="neutral"
          size="sm"
          onActivate={() =>
            store().applyStarted({ operationId: OPERATION, windowId: WINDOW, sourceId: 's' }, null)
          }
        >
          Start
        </Button>
        <Button
          variant="neutral"
          size="sm"
          onActivate={() => store().applyProgress(progress(Math.floor(Math.random() * 600)), null)}
        >
          Progress
        </Button>
        <Button
          variant="neutral"
          size="sm"
          onActivate={() =>
            store().applyComplete(
              {
                operationId: OPERATION,
                windowId: WINDOW,
                summary: {
                  sourceId: 's',
                  workspacesCreated: 6,
                  foldersCreated: 0,
                  tabsOpened: 608,
                  pinnedTabsOpened: 0,
                  skippedDuplicates: 0,
                  skippedUnsupportedUrls: 0,
                  failedTabs: 0,
                },
              },
              null,
            )
          }
        >
          Complete
        </Button>
        <Button
          variant="neutral"
          size="sm"
          onActivate={() =>
            store().applyError(
              {
                operationId: OPERATION,
                windowId: WINDOW,
                code: 'cancelled',
                message: 'Cancelled.',
              },
              null,
            )
          }
        >
          Cancel
        </Button>
        <Button
          variant="neutral"
          size="sm"
          onActivate={() =>
            store().applyError(
              {
                operationId: OPERATION,
                windowId: WINDOW,
                message: 'The session could not be read.',
              },
              null,
            )
          }
        >
          Fail
        </Button>
      </div>
      <SidebarList />
    </div>
  );
};
Lifecycle.storyName = 'Lifecycle (buttons drive the store)';
