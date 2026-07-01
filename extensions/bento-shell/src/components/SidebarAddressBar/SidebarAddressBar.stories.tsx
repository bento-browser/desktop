import { useEffect } from 'react';
import { SidebarAddressBar } from './SidebarAddressBar';
import { seedAddressBarResults } from '../../state/__fixtures__/addressBarResults';
import { seedSidebarAddressSnapshot } from '../../state/__fixtures__/sidebarAddress';
import { seedTabsAcrossWorkspaces } from '../../state/__fixtures__/tabs';
import { seedMany } from '../../state/__fixtures__/workspaces';
import { usePanelsStore } from '../../state/panels';
import { useSearchEnginesStore } from '../../state/searchEngines';

function seedBase() {
  seedMany();
  seedTabsAcrossWorkspaces([{ workspaceId: 'w-work', count: 5 }], 'w-work');
  usePanelsStore.getState().apply('w-work', [3]);
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
