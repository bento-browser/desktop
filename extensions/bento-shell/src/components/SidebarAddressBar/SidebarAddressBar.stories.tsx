import { useEffect } from 'react';
import { SidebarAddressBar } from './SidebarAddressBar';
import { BOOKMARK_POPUP_BUS_NAME } from '../../bridge/bookmarkPopup';
import { SAMPLE_SNAPSHOT } from '../../state/__fixtures__/bookmarks';
import { DEFAULT_FIXTURE } from '../../state/__fixtures__/settings';
import { seedAddressBarResults } from '../../state/__fixtures__/addressBarResults';
import {
  seedPaletteOverRow,
  seedSidebarAddressSnapshot,
} from '../../state/__fixtures__/sidebarAddress';
import { seedPanelsByWorkspace } from '../../state/__fixtures__/panels';
import { seedTabsAcrossWorkspaces } from '../../state/__fixtures__/tabs';
import { seedMany, seedPrivate } from '../../state/__fixtures__/workspaces';
import { useBookmarksStore } from '../../state/bookmarks';
import { useSearchEnginesStore } from '../../state/searchEngines';
import { useSettingsStore } from '../../state/settings';

const PAGE_URL = 'https://example.com/docs/sidebar-address-bar';

/** Bento's bookmark manager is in charge of the star (a regular window, the Settings switch on),
 * and its store holds the sample links plus, when `saved`, this page. */
function seedManager({ saved }: { saved: boolean }) {
  useSettingsStore.getState().apply(DEFAULT_FIXTURE);
  useBookmarksStore.getState().apply({
    ...SAMPLE_SNAPSHOT,
    items: saved
      ? [
          ...SAMPLE_SNAPSHOT.items,
          {
            id: 'item-this-page',
            groupId: 'group-apps',
            order: 99,
            createdAt: 1_700_000_100_000,
            kind: 'link',
            url: PAGE_URL,
            title: 'Sidebar address bar',
          },
        ]
      : SAMPLE_SNAPSHOT.items,
  });
}

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
    seedManager({ saved: false });
    seedSidebarAddressSnapshot();
  }, []);
  return <SidebarAddressBar />;
};

Secure.storyName = 'Secure page, not bookmarked (Bento bookmarks)';

export const InsecureBookmarked = () => {
  useEffect(() => {
    seedBase();
    // The Settings switch is off, so the star is Firefox's own bookmark toggle.
    useSettingsStore.getState().apply({ ...DEFAULT_FIXTURE, bookmarksEnabled: false });
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

InsecureBookmarked.storyName = 'Insecure bookmarked long URL (Firefox bookmarks, manager off)';

export const PendingLoading = () => {
  useEffect(() => {
    seedBase();
    seedManager({ saved: false });
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

export const BentoBookmarked = () => {
  useEffect(() => {
    seedBase();
    seedManager({ saved: true });
    seedSidebarAddressSnapshot();
  }, []);
  return <SidebarAddressBar />;
};

BentoBookmarked.storyName = 'Saved in Bento bookmarks (star filled)';

/** The save popover is open over the star: the star is pressed. */
export const BentoPopupOpen = () => {
  useEffect(() => {
    seedBase();
    seedManager({ saved: true });
    seedSidebarAddressSnapshot();
    const bus = new BroadcastChannel(BOOKMARK_POPUP_BUS_NAME);
    bus.postMessage({ kind: 'opened', windowId: null, key: 'edit' });
    return () => bus.close();
  }, []);
  return <SidebarAddressBar />;
};

BentoPopupOpen.storyName = 'Save popover open (star pressed)';

/** A page the store does not save (Firefox's own pages): the star is disabled. */
export const BentoUnsavablePage = () => {
  useEffect(() => {
    seedBase();
    seedManager({ saved: false });
    seedSidebarAddressSnapshot({
      url: 'about:preferences',
      displayUrl: 'about:preferences',
      security: {
        kind: 'internal',
        label: 'Firefox page',
        tooltip: 'Firefox page',
        canOpenIdentity: false,
      },
      bookmark: { isBookmarked: false, canBookmark: false },
    });
  }, []);
  return <SidebarAddressBar />;
};

BentoUnsavablePage.storyName = 'Page that cannot be saved (star disabled)';

/** A private window keeps Firefox's bookmark toggle; the Bento store is not in play. */
export const PrivateWindow = () => {
  useEffect(() => {
    seedBase();
    seedPrivate();
    useSettingsStore.getState().apply(DEFAULT_FIXTURE);
    seedSidebarAddressSnapshot({ bookmark: { isBookmarked: true, canBookmark: true } });
  }, []);
  return <SidebarAddressBar />;
};

PrivateWindow.storyName = 'Private window (Firefox bookmarks)';
