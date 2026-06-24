import { useEffect } from 'react';
import { MergePalette } from './MergePalette';
import { useExternalMergeStore } from '../../state/externalMerge';

const noop = () => {};
const now = Date.now();

const sources = [
  {
    id: 'chrome-default',
    kind: 'chrome' as const,
    browserName: 'Chrome',
    profileName: 'Default',
    lastModified: now - 4 * 60 * 1000,
    windowCount: 3,
    tabCount: 42,
    groupCount: 5,
  },
  {
    id: 'firefox-personal',
    kind: 'firefox' as const,
    browserName: 'Firefox',
    profileName: 'Personal',
    lastModified: now - 2 * 60 * 60 * 1000,
    windowCount: 1,
    tabCount: 9,
    groupCount: 0,
  },
];

function seed(state: Partial<ReturnType<typeof useExternalMergeStore.getState>> = {}) {
  useExternalMergeStore.getState().setForStory({
    sources: [],
    loadingSources: false,
    activeSourceId: null,
    currentRequestId: null,
    activeOperationId: null,
    summary: null,
    error: null,
    lastOpenNonce: null,
    ...state,
  });
}

export const Loading = () => {
  useEffect(() => {
    seed({ loadingSources: true, currentRequestId: 'request-loading' });
  }, []);
  return <MergePalette onClose={noop} />;
};

export const SourceList = () => {
  useEffect(() => {
    seed({ sources });
  }, []);
  return <MergePalette onClose={noop} />;
};

export const Merging = () => {
  useEffect(() => {
    seed({
      sources,
      activeSourceId: 'chrome-default',
      activeOperationId: 'operation-active',
    });
  }, []);
  return <MergePalette onClose={noop} />;
};

export const Success = () => {
  useEffect(() => {
    seed({
      sources,
      summary: {
        sourceId: 'chrome-default',
        workspacesCreated: 3,
        foldersCreated: 5,
        tabsOpened: 38,
        pinnedTabsOpened: 2,
        skippedDuplicates: 4,
        skippedUnsupportedUrls: 1,
        failedTabs: 0,
      },
    });
  }, []);
  return <MergePalette onClose={noop} />;
};

export const ErrorState = () => {
  useEffect(() => {
    seed({
      sources,
      error: {
        code: 'unreadable',
        message: 'Browser session snapshot is unreadable.',
      },
    });
  }, []);
  return <MergePalette onClose={noop} />;
};

ErrorState.storyName = 'Error';

export const Empty = () => {
  useEffect(() => {
    seed({ sources: [] });
  }, []);
  return <MergePalette onClose={noop} />;
};
