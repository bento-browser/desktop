// AddressBar visual stories. The component handles its own chrome close
// signalling through props; stories pass a noop so it stays visible.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import AddressBar from './AddressBar';
import { growClipPaths } from './useAddressBarGrow';
import { SidebarAddressBar } from '../SidebarAddressBar/SidebarAddressBar';
import type { AddrbarPlacement } from '../../bridge/useAddrbar';
import {
  seedPaletteOverRow,
  seedSidebarAddressSnapshot,
} from '../../state/__fixtures__/sidebarAddress';
import { seedTabsAcrossWorkspaces, makeTab } from '../../state/__fixtures__/tabs';
import { seedPanelsByWorkspace } from '../../state/__fixtures__/panels';
import { seedMany } from '../../state/__fixtures__/workspaces';
import {
  seedAddressBarResults,
  seedEmptyAddressBarResults,
  seedGroupedAddressBarResults,
} from '../../state/__fixtures__/addressBarResults';
import { useSearchEnginesStore } from '../../state/searchEngines';
import { useTabsStore } from '../../state/tabs';

const noop = () => {};

function seedSearchEngines(longName = false) {
  useSearchEnginesStore.getState().apply({
    defaultSearchEngine: 'ddg',
    availableSearchEngines: [
      { id: 'ddg', name: 'DuckDuckGo', isDefault: true },
      {
        id: 'google',
        name: longName ? 'Google Search with a Very Long Search Engine Display Name' : 'Google',
        isDefault: false,
      },
      { id: 'bing', name: 'Bing', isDefault: false },
    ],
  });
}

function seedBase(query = 'bento') {
  seedMany();
  seedTabsAcrossWorkspaces([{ workspaceId: 'w-work', count: 6 }], 'w-work');
  seedPanelsByWorkspace({ 'w-work': [3] });
  seedAddressBarResults(query);
  seedSearchEngines();
}

export const Empty = () => {
  useEffect(() => {
    seedMany();
    useTabsStore.getState().applySnapshot([]);
    seedPanelsByWorkspace({ 'w-work': [] });
    seedEmptyAddressBarResults();
    seedSearchEngines();
  }, []);
  return <AddressBar onClose={noop} mode="current" />;
};

Empty.storyName = 'Empty';

export const SearchLooking = () => {
  useEffect(() => {
    seedBase('bento');
  }, []);
  return <AddressBar onClose={noop} mode="current" initialQuery="bento" />;
};

SearchLooking.storyName = 'Search-looking with rows';

export const UrlLookingNewTab = () => {
  useEffect(() => {
    seedBase('example.com');
  }, []);
  return <AddressBar onClose={noop} mode="newTab" initialQuery="example.com" />;
};

UrlLookingNewTab.storyName = 'URL-looking, Cmd+T mode';

export const LongTitle = () => {
  useEffect(() => {
    seedMany();
    useTabsStore.getState().applySnapshot([
      makeTab({
        id: 1,
        workspaceId: 'w-work',
        active: true,
        url: 'https://example.com/a-very-long-open-tab-title',
        title:
          'A Very Long Open Tab Title That Should Definitely Get Truncated With An Ellipsis In The Floating Address Bar Result Row',
      }),
    ]);
    seedPanelsByWorkspace({ 'w-work': [] });
    seedAddressBarResults('long');
    seedSearchEngines(true);
  }, []);
  return <AddressBar onClose={noop} mode="current" initialQuery="long" />;
};

LongTitle.storyName = 'Long title truncation';

// The popup anchored over the sidebar address row (Cmd+L, or a click on the row). The
// popup's top-left corner is the row's, and its header repeats the row's height, search icon
// slot, text start and font. Chrome computes this placement from the row's rect; the story
// reads the rect from the real row, which renders under the popup.
const ANCHORED_WIDTH_PX = 512;
const ANCHORED_HEIGHT_PX = 378;

function AnchoredOverRow({ frozenStart = false }: { frozenStart?: boolean }) {
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<AddrbarPlacement | null>(null);
  const [rowRadius, setRowRadius] = useState(0);

  useEffect(() => {
    seedBase('example');
    seedSidebarAddressSnapshot();
    // Chrome sets this while the anchored palette is shown: the row's border is faded out.
    seedPaletteOverRow();
  }, []);

  useLayoutEffect(() => {
    const row = sidebarRef.current?.querySelector('.bento-sidebar-address-bar__row');
    if (!row) return;
    const rect = row.getBoundingClientRect();
    setRowRadius(parseFloat(getComputedStyle(row).borderTopLeftRadius) || 0);
    setPlacement({
      left: rect.left,
      top: rect.top,
      width: ANCHORED_WIDTH_PX,
      height: ANCHORED_HEIGHT_PX,
      anchorWidth: rect.width,
      anchorHeight: rect.height,
    });
  }, []);

  // The start-of-grow frame: the clip the grow begins from, held (only `.from` is used).
  const hold = placement ? growClipPaths(placement, { from: rowRadius, to: 0 }).from : '';

  return (
    <>
      {frozenStart ? (
        <style>{`.muxui-command-palette__popup { clip-path: ${hold} !important; transition: none !important; }`}</style>
      ) : null}
      <div
        ref={sidebarRef}
        // z-index 0: the row's own z-index 2 must not outrank the popup's fixed stacking context.
        style={{
          position: 'relative',
          zIndex: 0,
          width: 280,
          padding: '48px 0 0',
          backgroundColor: 'var(--bento-brand-bg)',
        }}
      >
        <SidebarAddressBar />
      </div>
      {placement ? (
        <AddressBar
          onClose={noop}
          mode="current"
          initialQuery="https://example.com/docs/sidebar-address-bar"
          placement={placement}
        />
      ) : null}
    </>
  );
}

export const AnchoredOverSidebarRow = () => <AnchoredOverRow />;

AnchoredOverSidebarRow.storyName = 'Anchored over the sidebar row';

export const AnchoredGrowStart = () => <AnchoredOverRow frozenStart />;

AnchoredGrowStart.storyName = 'Anchored, start of the grow (row-sized)';

export const GroupedRecents = () => {
  useEffect(() => {
    seedMany();
    useTabsStore.getState().applySnapshot([]);
    seedPanelsByWorkspace({ 'w-work': [] });
    seedGroupedAddressBarResults();
    seedSearchEngines();
  }, []);
  return (
    <AddressBar
      onClose={noop}
      mode="current"
      placement={{
        left: 32,
        top: 48,
        width: ANCHORED_WIDTH_PX,
        height: ANCHORED_HEIGHT_PX,
        anchorWidth: 280,
        anchorHeight: 32,
      }}
    />
  );
};
GroupedRecents.storyName = 'Grouped recents, six rows';
