import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeProgressPercent, useExternalMergeStore } from './externalMerge';

function resetStore() {
  useExternalMergeStore.getState().setForStory({
    sources: [],
    loadingSources: false,
    activeSourceId: null,
    currentRequestId: null,
    activeOperationId: null,
    progress: null,
    progressLog: [],
    activeSourceName: null,
    summary: null,
    error: null,
    result: null,
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

  it('dispatches target ids when starting a targeted merge', () => {
    const dispatch = vi.fn();
    expect(useExternalMergeStore.getState().startMerge('source-1', dispatch, ['window:one'])).toBe(
      true,
    );

    expect(dispatch).toHaveBeenCalledWith({
      type: 'externalMerge/merge',
      sourceId: 'source-1',
      operationId: useExternalMergeStore.getState().activeOperationId,
      targetIds: ['window:one'],
    });
  });

  it('dispatches cancel for the active merge operation only', () => {
    const dispatch = vi.fn();
    expect(useExternalMergeStore.getState().cancelMerge(dispatch)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();

    expect(useExternalMergeStore.getState().startMerge('source-1', dispatch)).toBe(true);
    const operationId = useExternalMergeStore.getState().activeOperationId!;

    expect(useExternalMergeStore.getState().cancelMerge(dispatch)).toBe(true);
    expect(dispatch).toHaveBeenLastCalledWith({
      type: 'externalMerge/cancel',
      operationId,
    });
  });

  it('mirrors a merge operation started by another shell document', () => {
    useExternalMergeStore.getState().applyStarted(
      {
        operationId: 'operation-remote',
        windowId: 1,
        sourceId: 'source-1',
      },
      1,
    );

    expect(useExternalMergeStore.getState().activeOperationId).toBe('operation-remote');
    expect(useExternalMergeStore.getState().activeSourceId).toBe('source-1');

    useExternalMergeStore.getState().applyComplete(
      {
        operationId: 'operation-remote',
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
    expect(useExternalMergeStore.getState().summary?.sourceId).toBe('source-1');
  });

  it('tracks progress and activity only for the active operation', () => {
    const dispatch = vi.fn();
    useExternalMergeStore.getState().startMerge('source-1', dispatch);
    const operationId = useExternalMergeStore.getState().activeOperationId!;

    useExternalMergeStore.getState().applyProgress(
      {
        operationId: 'stale',
        windowId: 1,
        progress: {
          stage: 'importing',
          totalWorkspaces: 1,
          completedWorkspaces: 0,
          totalTabs: 1,
          completedTabs: 1,
          importedTabs: 1,
        },
      },
      1,
    );
    expect(useExternalMergeStore.getState().progress).toBeNull();

    useExternalMergeStore.getState().applyProgress(
      {
        operationId,
        windowId: 1,
        progress: {
          stage: 'importing',
          totalWorkspaces: 2,
          completedWorkspaces: 0,
          totalTabs: 4,
          completedTabs: 1,
          importedTabs: 1,
          currentWorkspaceName: 'Firefox: Research',
          activity: {
            kind: 'site',
            title: 'Example',
            url: 'https://example.com/',
            status: 'opened',
          },
        },
      },
      1,
    );

    expect(useExternalMergeStore.getState().progress?.completedTabs).toBe(1);
    expect(useExternalMergeStore.getState().progressLog).toEqual([
      {
        kind: 'site',
        title: 'Example',
        url: 'https://example.com/',
        status: 'opened',
      },
    ]);
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

  describe('result snapshot for the sidebar card', () => {
    const summary = {
      sourceId: 'source-1',
      workspacesCreated: 6,
      foldersCreated: 0,
      tabsOpened: 608,
      pinnedTabsOpened: 2,
      skippedDuplicates: 0,
      skippedUnsupportedUrls: 0,
      failedTabs: 0,
    };
    const importing = {
      stage: 'importing' as const,
      totalWorkspaces: 6,
      completedWorkspaces: 1,
      totalTabs: 608,
      completedTabs: 120,
      importedTabs: 100,
      sourceName: 'Firefox',
    };

    function startAndProgress() {
      useExternalMergeStore.getState().startMerge('source-1', vi.fn());
      const operationId = useExternalMergeStore.getState().activeOperationId!;
      useExternalMergeStore
        .getState()
        .applyProgress({ operationId, windowId: 1, progress: importing }, 1);
      return operationId;
    }

    it('keeps the browser name from progress and a done result after completion', () => {
      const operationId = startAndProgress();
      expect(useExternalMergeStore.getState().activeSourceName).toBe('Firefox');

      useExternalMergeStore.getState().applyComplete({ operationId, windowId: 1, summary }, 1);

      const state = useExternalMergeStore.getState();
      expect(state.activeOperationId).toBeNull();
      expect(state.activeSourceName).toBeNull();
      expect(state.result).toEqual({
        kind: 'done',
        sourceName: 'Firefox',
        tabsOpened: 608,
        workspacesCreated: 6,
      });
    });

    it('turns a cancellation into a partial result', () => {
      const operationId = startAndProgress();
      useExternalMergeStore.getState().applyError(
        {
          operationId,
          windowId: 1,
          code: 'cancelled',
          message: 'Browser session merge was cancelled.',
        },
        1,
      );

      expect(useExternalMergeStore.getState().result).toEqual({
        kind: 'cancelled',
        sourceName: 'Firefox',
        // 120 tabs processed, 100 of them opened: the card counts the opened ones.
        tabsAdded: 100,
        percent: 20,
      });
    });

    it('turns any other operation error into a failed result with one short line', () => {
      const operationId = startAndProgress();
      useExternalMergeStore.getState().applyError(
        {
          operationId,
          windowId: 1,
          code: 'unreadable',
          message: `  The session\n could not be read.  ${'x'.repeat(200)}`,
        },
        1,
      );

      const result = useExternalMergeStore.getState().result;
      expect(result?.kind).toBe('failed');
      if (result?.kind !== 'failed') return;
      expect(result.message.startsWith('The session could not be read.')).toBe(true);
      expect(result.message.length).toBeLessThanOrEqual(120);
      expect(result.message.endsWith('…')).toBe(true);
      expect(result.percent).toBe(20);
    });

    it('names a failure that has no message', () => {
      useExternalMergeStore.getState().startMerge('source-1', vi.fn());
      const operationId = useExternalMergeStore.getState().activeOperationId!;
      useExternalMergeStore.getState().applyError({ operationId, windowId: 1, message: '  ' }, 1);

      expect(useExternalMergeStore.getState().result).toEqual({
        kind: 'failed',
        sourceName: null,
        message: 'The import could not finish.',
        percent: 0,
      });
    });

    it('ignores source-list errors and errors for another operation', () => {
      const dispatch = vi.fn();
      useExternalMergeStore.getState().requestSourcesForOpen('open-1', dispatch);
      const requestId = useExternalMergeStore.getState().currentRequestId!;
      useExternalMergeStore
        .getState()
        .applyError({ requestId, windowId: 1, message: 'Discovery failed.' }, 1);
      expect(useExternalMergeStore.getState().result).toBeNull();

      startAndProgress();
      useExternalMergeStore
        .getState()
        .applyError({ operationId: 'stale', windowId: 1, message: 'Nope.' }, 1);
      expect(useExternalMergeStore.getState().result).toBeNull();
    });

    it('dismisses the result, and a palette open or close leaves it alone', () => {
      const operationId = startAndProgress();
      useExternalMergeStore.getState().applyComplete({ operationId, windowId: 1, summary }, 1);

      useExternalMergeStore.getState().requestSourcesForOpen('open-1', vi.fn());
      useExternalMergeStore.getState().handleClose();
      expect(useExternalMergeStore.getState().result?.kind).toBe('done');
      expect(useExternalMergeStore.getState().summary).toBeNull();

      useExternalMergeStore.getState().dismissResult();
      expect(useExternalMergeStore.getState().result).toBeNull();
    });

    it('replaces a lingering result when the next merge starts, here or in another document', () => {
      const first = startAndProgress();
      useExternalMergeStore
        .getState()
        .applyComplete({ operationId: first, windowId: 1, summary }, 1);
      expect(useExternalMergeStore.getState().result).not.toBeNull();

      useExternalMergeStore.getState().startMerge('source-2', vi.fn());
      expect(useExternalMergeStore.getState().result).toBeNull();

      const second = useExternalMergeStore.getState().activeOperationId!;
      useExternalMergeStore
        .getState()
        .applyError({ operationId: second, windowId: 1, code: 'cancelled', message: 'x' }, 1);
      expect(useExternalMergeStore.getState().result?.kind).toBe('cancelled');

      useExternalMergeStore
        .getState()
        .applyStarted({ operationId: 'remote-3', windowId: 1, sourceId: 'source-3' }, 1);
      expect(useExternalMergeStore.getState().result).toBeNull();
      expect(useExternalMergeStore.getState().activeSourceName).toBeNull();
    });
  });

  describe('mergeProgressPercent', () => {
    const progress = (completedTabs: number, totalTabs: number) => ({
      stage: 'importing' as const,
      totalWorkspaces: 1,
      completedWorkspaces: 0,
      totalTabs,
      completedTabs,
      importedTabs: completedTabs,
    });

    it('is 0 without totals and a rounded share with them', () => {
      expect(mergeProgressPercent(null)).toBe(0);
      expect(mergeProgressPercent(progress(0, 0))).toBe(0);
      expect(mergeProgressPercent(progress(120, 608))).toBe(20);
      expect(mergeProgressPercent(progress(608, 608))).toBe(100);
      expect(mergeProgressPercent(progress(9, 4))).toBe(100);
    });
  });
});
