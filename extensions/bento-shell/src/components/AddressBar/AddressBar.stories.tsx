// AddressBar visual stories. The component handles its own chrome close
// signalling through props; stories pass a noop so it stays visible.

import { useEffect } from 'react';
import AddressBar from './AddressBar';
import { seedTabsAcrossWorkspaces, makeTab } from '../../state/__fixtures__/tabs';
import { seedMany } from '../../state/__fixtures__/workspaces';
import {
  seedAddressBarResults,
  seedEmptyAddressBarResults,
} from '../../state/__fixtures__/addressBarResults';
import { usePanelsStore } from '../../state/panels';
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
  usePanelsStore.getState().apply('w-work', [3]);
  seedAddressBarResults(query);
  seedSearchEngines();
}

export const Empty = () => {
  useEffect(() => {
    seedMany();
    useTabsStore.getState().applySnapshot([]);
    usePanelsStore.getState().apply('w-work', []);
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
    usePanelsStore.getState().apply('w-work', []);
    seedAddressBarResults('long');
    seedSearchEngines(true);
  }, []);
  return <AddressBar onClose={noop} mode="current" initialQuery="long" />;
};

LongTitle.storyName = 'Long title truncation';
