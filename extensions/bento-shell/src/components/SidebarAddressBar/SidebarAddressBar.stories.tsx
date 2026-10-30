import { useEffect } from 'react';
import { SidebarAddressBar } from './SidebarAddressBar';
import { seedAddressBarResults } from '../../state/__fixtures__/addressBarResults';
import {
  seedPaletteOverRow,
  seedSidebarAddressSnapshot,
} from '../../state/__fixtures__/sidebarAddress';
import { seedPanelsByWorkspace } from '../../state/__fixtures__/panels';
import { seedTabsAcrossWorkspaces } from '../../state/__fixtures__/tabs';
import { seedMany } from '../../state/__fixtures__/workspaces';
import { useSearchEnginesStore } from '../../state/searchEngines';

function seedBase() {
  seedMany();
  seedTabsAcrossWorkspaces([{ workspaceId: 'w-work', count: 5 }], 'w-work');
  seedPanelsByWorkspace({ 'w-work': [3] });
  seedAddressBarResults('bento');
  useSearchEnginesStore.getState().apply({
    defaultSearchEngine: 'ddg',
    availableSearchEngines: [
      { id: 'ddg', name: 'DuckDuckGo', isDefault: true },
      { id: 'google', name: 'Google', isDefault: false },
    ],
  });
}

export const Secure = () => {
  useEffect(() => {
    seedBase();
    seedSidebarAddressSnapshot();
  }, []);
  return <SidebarAddressBar />;
};

Secure.storyName = 'Secure page';

export const InsecureBookmarked = () => {
  useEffect(() => {
    seedBase();
    seedSidebarAddressSnapshot({
      url: 'http://example.test/a/very/long/path/that/should/truncate/in/the/sidebar/address/row',
      displayUrl: 'example.test/a/very/long/path/that/should/truncate/in/the/sidebar/address/row',
      security: {
        kind: 'insecure',
        label: 'Not secure',
        tooltip: 'Connection is not secure',
        canOpenIdentity: true,
      },
      bookmark: {
        isBookmarked: true,
        canBookmark: true,
      },
    });
  }, []);
  return <SidebarAddressBar />;
};

InsecureBookmarked.storyName = 'Insecure bookmarked long URL';

export const PendingLoading = () => {
  useEffect(() => {
    seedBase();
    seedSidebarAddressSnapshot({
      snapshotToken: 2,
      loading: true,
      bookmark: {
        isBookmarked: false,
        canBookmark: false,
      },
    });
  }, []);
  return <SidebarAddressBar />;
};

PendingLoading.storyName = 'Loading non-bookmarkable';

export const PaletteOverRow = () => {
  useEffect(() => {
    seedBase();
    seedSidebarAddressSnapshot();
    seedPaletteOverRow();
  }, []);
  return <SidebarAddressBar />;
};

PaletteOverRow.storyName = 'Palette over the row (border faded out)';
