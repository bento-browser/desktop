import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useExternalMergeStore } from './externalMerge';

function resetStore() {
  useExternalMergeStore.getState().setForStory({
    sources: [],
    loadingSources: false,
    activeSourceId: null,
    currentRequestId: null,
    activeOperationId: null,
    summary: null,
    error: null,
    lastOpenNonce: null,
  });
}

describe('external merge shell store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('ignores events for stale request ids and other windows', () => {
    const dispatch = vi.fn();
    useExternalMergeStore.getState().requestSourcesForOpen('open-1', dispatch);
    const requestId = useExternalMergeStore.getState().currentRequestId!;

    useExternalMergeStore.getState().applySources(
      {
        requestId: 'stale',
        windowId: 3,
        sources: [
          {
            id: 'wrong',
            kind: 'firefox',
            browserName: 'Firefox',
            profileName: 'Wrong',
            lastModified: 1,
            windowCount: 1,
            tabCount: 1,
            groupCount: 0,
          },
        ],
      },
      3,
    );
    expect(useExternalMergeStore.getState().sources).toEqual([]);

    useExternalMergeStore.getState().applySources(
      {
        requestId,
        windowId: 4,
        sources: [
          {
            id: 'other-window',
            kind: 'firefox',
            browserName: 'Firefox',
            profileName: 'Other',
            lastModified: 1,
            windowCount: 1,
            tabCount: 1,
            groupCount: 0,
          },
        ],
      },
      3,
    );
    expect(useExternalMergeStore.getState().sources).toEqual([]);
  });

  it('does not dispatch a second merge while an operation is active', () => {
    const dispatch = vi.fn();
    expect(useExternalMergeStore.getState().startMerge('source-1', dispatch)).toBe(true);
    const operationId = useExternalMergeStore.getState().activeOperationId;
    expect(useExternalMergeStore.getState().startMerge('source-2', dispatch)).toBe(false);

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(useExternalMergeStore.getState().activeOperationId).toBe(operationId);
    expect(useExternalMergeStore.getState().activeSourceId).toBe('source-1');
  });

  it('refreshes sources without clearing visible rows and blocks refresh while merging', () => {
    const dispatch = vi.fn();
    const existingSource = {
      id: 'source-1',
      kind: 'chrome' as const,
      browserName: 'Chrome',
      profileName: 'Default',
      lastModified: 1,
      windowCount: 1,
      tabCount: 1,
      groupCount: 0,
    };
    useExternalMergeStore.getState().setForStory({ sources: [existingSource] });

    expect(useExternalMergeStore.getState().refreshSources(dispatch)).toBe(true);
    expect(useExternalMergeStore.getState().loadingSources).toBe(true);
    expect(useExternalMergeStore.getState().sources).toEqual([existingSource]);
    expect(dispatch).toHaveBeenCalledWith({
      type: 'externalMerge/requestSources',
      requestId: useExternalMergeStore.getState().currentRequestId,
    });

    useExternalMergeStore.getState().setForStory({ activeOperationId: 'operation-active' });
    expect(useExternalMergeStore.getState().refreshSources(dispatch)).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('ignores stale operation completion and accepts the active one', () => {
    const dispatch = vi.fn();
    useExternalMergeStore.getState().startMerge('source-1', dispatch);
    const operationId = useExternalMergeStore.getState().activeOperationId!;

    useExternalMergeStore.getState().applyComplete(
      {
        operationId: 'stale',
        windowId: 1,
        summary: {
          sourceId: 'source-1',
          workspacesCreated: 1,
          foldersCreated: 0,
          tabsOpened: 1,
          pinnedTabsOpened: 0,
          skippedDuplicates: 0,
          skippedUnsupportedUrls: 0,
          failedTabs: 0,
        },
      },
      1,
    );
    expect(useExternalMergeStore.getState().activeOperationId).toBe(operationId);

    useExternalMergeStore.getState().applyComplete(
      {
        operationId,
        windowId: 1,
        summary: {
          sourceId: 'source-1',
          workspacesCreated: 1,
          foldersCreated: 0,
          tabsOpened: 1,
          pinnedTabsOpened: 0,
          skippedDuplicates: 0,
          skippedUnsupportedUrls: 0,
          failedTabs: 0,
        },
      },
      1,
    );
    expect(useExternalMergeStore.getState().activeOperationId).toBeNull();
    expect(useExternalMergeStore.getState().summary?.tabsOpened).toBe(1);
  });
});
