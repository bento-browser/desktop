// Fake external-merge state for Ladle stories: seeds useExternalMergeStore the way the
// shell bus would while a session import runs and after it ends, so the sidebar merge
// card can be exercised without bento-tools.

import type { ExternalMergeProgress } from '@shared/protocol';
import { useExternalMergeStore } from '../externalMerge';
import type { ExternalMergeResult } from '../externalMerge';
import type { MergeProgressCardInput } from '../../components/MergeProgressCard/mergeProgressCardModel';

export type MergeFixtureState =
  'idle' | 'preparing' | 'importing' | 'finalizing' | 'done' | 'cancelled' | 'failed';

const SOURCE = 'Firefox';

const IMPORTING: ExternalMergeProgress = {
  stage: 'importing',
  totalWorkspaces: 6,
  completedWorkspaces: 1,
  totalTabs: 608,
  completedTabs: 120,
  importedTabs: 118,
  currentWorkspaceName: 'Work',
  sourceName: SOURCE,
};

const RESULTS: Record<'done' | 'cancelled' | 'failed', ExternalMergeResult> = {
  done: { kind: 'done', sourceName: SOURCE, tabsOpened: 608, workspacesCreated: 6 },
  cancelled: {
    kind: 'cancelled',
    operationId: 'story-operation',
    sourceName: SOURCE,
    tabsAdded: 118,
    percent: 20,
  },
  failed: {
    kind: 'failed',
    sourceName: SOURCE,
    message: 'The session could not be read.',
    percent: 20,
  },
};

const IDLE: MergeProgressCardInput = {
  activeOperationId: null,
  progress: null,
  progressLog: [],
  sourceName: null,
  result: null,
};

const RUNNING = { activeOperationId: 'story-operation', sourceName: SOURCE };

/**
 * What the merge card reads in one phase of a merge. `long` swaps in a workspace name that
 * cannot fit the card, to check truncation. A running phase has an operation id, so the
 * footer and the card treat it as a merge in progress.
 */
export function mergeFixtureInput(
  state: MergeFixtureState,
  { long = false } = {},
): MergeProgressCardInput {
  switch (state) {
    case 'idle':
      return IDLE;
    case 'preparing':
      return {
        ...IDLE,
        ...RUNNING,
        progress: {
          stage: 'preparing',
          totalWorkspaces: 0,
          completedWorkspaces: 0,
          totalTabs: 0,
          completedTabs: 0,
          importedTabs: 0,
          sourceName: SOURCE,
        },
      };
    case 'importing':
      return {
        ...IDLE,
        ...RUNNING,
        progress: long
          ? { ...IMPORTING, currentWorkspaceName: 'Work and side projects, the long-running ones' }
          : IMPORTING,
        progressLog: [
          { kind: 'workspace', name: 'Work', status: 'started' },
          {
            kind: 'site',
            title: 'Bento',
            url: 'https://github.com/Bento-Browser',
            status: 'opened',
          },
        ],
      };
    case 'finalizing':
      return {
        ...IDLE,
        ...RUNNING,
        progress: {
          ...IMPORTING,
          stage: 'finalizing',
          completedTabs: 608,
          importedTabs: 608,
          completedWorkspaces: 6,
        },
      };
    case 'done':
    case 'cancelled':
    case 'failed':
      return { ...IDLE, result: RESULTS[state] };
  }
}

/** Puts the store in one phase of a merge (see mergeFixtureInput). */
export function seedExternalMerge(state: MergeFixtureState, options?: { long?: boolean }): void {
  const input = mergeFixtureInput(state, options);
  useExternalMergeStore.getState().setForStory({
    activeOperationId: input.activeOperationId,
    activeSourceId: input.activeOperationId ? 'story-source' : null,
    activeSourceName: input.sourceName,
    progress: input.progress,
    progressLog: [...input.progressLog],
    result: input.result,
  });
}
