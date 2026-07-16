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
    targets: [
      {
        id: 'window:chrome-window-1',
        kind: 'window' as const,
        name: 'Window 1',
        windowCount: 1,
        tabCount: 18,
        groupCount: 2,
        previewTabs: Array.from({ length: 10 }, (_, index) => ({
          title: `Chrome research tab ${index + 1}`,
          url: `https://research.example/${index + 1}`,
          ...(index === 0 ? { active: true } : {}),
        })),
      },
      {
        id: 'window:chrome-window-2',
        kind: 'window' as const,
        name: 'Planning',
        windowCount: 1,
        tabCount: 9,
        groupCount: 1,
        previewTabs: Array.from({ length: 9 }, (_, index) => ({
          title: `Planning tab ${index + 1}`,
          url: `https://planning.example/${index + 1}`,
        })),
      },
    ],
  },
  {
    id: 'firefox-personal',
    kind: 'zen' as const,
    browserName: 'Zen Browser',
    profileName: 'Personal',
    lastModified: now - 2 * 60 * 60 * 1000,
    windowCount: 2,
    tabCount: 16,
    groupCount: 2,
    targets: [
      {
        id: 'workspace:space-personal',
        kind: 'workspace' as const,
        name: 'Personal',
        windowCount: 1,
        tabCount: 7,
        groupCount: 0,
        previewTabs: Array.from({ length: 7 }, (_, index) => ({
          title: `Personal tab ${index + 1}`,
          url: `https://personal.example/${index + 1}`,
        })),
      },
      {
        id: 'workspace:space-work',
        kind: 'workspace' as const,
        name: 'Work',
        windowCount: 1,
        tabCount: 9,
        groupCount: 2,
        previewTabs: Array.from({ length: 9 }, (_, index) => ({
          title: `Work tab ${index + 1}`,
          url: `https://work.example/${index + 1}`,
          ...(index === 1 ? { pinned: true } : {}),
        })),
      },
    ],
  },
];

function seed(state: Partial<ReturnType<typeof useExternalMergeStore.getState>> = {}) {
  useExternalMergeStore.getState().setForStory({
    sources: [],
    loadingSources: false,
    activeSourceId: null,
    currentRequestId: null,
    activeOperationId: null,
    progress: null,
    progressLog: [],
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
      progress: {
        stage: 'importing',
        totalWorkspaces: 3,
        completedWorkspaces: 1,
        totalTabs: 38,
        completedTabs: 17,
        currentWorkspaceName: 'Chrome: Planning',
      },
      progressLog: [
        { kind: 'workspace', name: 'Chrome: Research', status: 'started' },
        {
          kind: 'site',
          title: 'Tale UI component documentation',
          url: 'https://tale-ui.dev/components/progress-bar',
          status: 'opened',
        },
        {
          kind: 'site',
          title: 'Project notes',
          url: 'https://notion.so/example',
          status: 'opened',
        },
        { kind: 'workspace', name: 'Chrome: Research', status: 'completed' },
        { kind: 'workspace', name: 'Chrome: Planning', status: 'started' },
        {
          kind: 'site',
          title: 'Weekly plan',
          url: 'https://planning.example/week',
          status: 'opened',
        },
      ],
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
