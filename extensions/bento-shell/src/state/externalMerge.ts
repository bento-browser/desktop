import { create } from 'zustand';
import type {
  Action,
  ExternalMergeErrorCode,
  ExternalMergeProgress,
  ExternalMergeProgressActivity,
  ExternalMergeSource,
  ExternalMergeSummary,
} from '@shared/protocol';

export interface ExternalMergeErrorState {
  message: string;
  code?: ExternalMergeErrorCode;
  sourceId?: string;
}

/**
 * How the last merge ended, kept after the operation clears its progress so the sidebar
 * card can stay until the user dismisses it. Transient shell state: tools keeps nothing
 * of it, and a reloaded shell starts without one. `percent` is how far the import had
 * got, for the ring of a card that did not finish.
 */
export type ExternalMergeResult =
  | {
      kind: 'done';
      sourceName: string | null;
      tabsOpened: number;
      workspacesCreated: number;
    }
  // tabsAdded counts tabs that opened, not tabs processed; percent is how far the import got.
  // operationId lets a tab that was in flight at the cancel raise tabsAdded when tools reports it.
  | {
      kind: 'cancelled';
      operationId: string;
      sourceName: string | null;
      tabsAdded: number;
      percent: number;
    }
  | { kind: 'failed'; sourceName: string | null; message: string; percent: number };

type DispatchAction = (action: Action) => void;

/** Whole-number share of the tabs processed so far; 0 until the totals arrive. */
export function mergeProgressPercent(progress: ExternalMergeProgress | null): number {
  if (!progress || progress.totalTabs <= 0) return 0;
  const share = Math.round((progress.completedTabs / progress.totalTabs) * 100);
  return Math.min(100, Math.max(0, share));
}

const FAILURE_REASON_MAX = 120;

/** One short line from an error message; tools has already dropped messages that carry paths. */
function failureReason(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim();
  if (!line) return 'The import could not finish.';
  return line.length > FAILURE_REASON_MAX ? `${line.slice(0, FAILURE_REASON_MAX - 1)}…` : line;
}

interface ExternalMergeState {
  sources: ExternalMergeSource[];
  loadingSources: boolean;
  activeSourceId: string | null;
  currentRequestId: string | null;
  activeOperationId: string | null;
  progress: ExternalMergeProgress | null;
  progressLog: ExternalMergeProgressActivity[];
  /** Browser being imported, from progress events; null until the session is read. */
  activeSourceName: string | null;
  summary: ExternalMergeSummary | null;
  error: ExternalMergeErrorState | null;
  /** The ended merge the sidebar card still shows; replaced by the next merge. */
  result: ExternalMergeResult | null;
  lastOpenNonce: string | null;

  requestSourcesForOpen: (nonce: string, dispatch: DispatchAction) => void;
  refreshSources: (dispatch: DispatchAction) => boolean;
  handleClose: () => void;
  startMerge: (sourceId: string, dispatch: DispatchAction, targetIds?: string[]) => boolean;
  cancelMerge: (dispatch: DispatchAction) => boolean;
  dismissResult: () => void;
  applySources: (
    event: { requestId: string; windowId: number | null; sources: ExternalMergeSource[] },
    currentWindowId: number | null,
  ) => void;
  applyStarted: (
    event: { operationId: string; windowId: number | null; sourceId: string },
    currentWindowId: number | null,
  ) => void;
  applyProgress: (
    event: { operationId: string; windowId: number | null; progress: ExternalMergeProgress },
    currentWindowId: number | null,
  ) => void;
  applyComplete: (
    event: { operationId: string; windowId: number | null; summary: ExternalMergeSummary },
    currentWindowId: number | null,
  ) => void;
  applyError: (
    event: {
      requestId?: string;
      operationId?: string;
      windowId: number | null;
      sourceId?: string;
      code?: ExternalMergeErrorCode;
      message: string;
    },
    currentWindowId: number | null,
  ) => void;
  setForStory: (state: Partial<ExternalMergeState>) => void;
}

function makeId(prefix: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isForCurrentWindow(eventWindowId: number | null, currentWindowId: number | null): boolean {
  return (
    typeof eventWindowId !== 'number' ||
    currentWindowId === null ||
    eventWindowId === currentWindowId
  );
}

export const useExternalMergeStore = create<ExternalMergeState>((set, get) => ({
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

  requestSourcesForOpen: (nonce, dispatch) => {
    const requestId = makeId('external-merge-sources');
    const activeOperationId = get().activeOperationId;
    set({
      sources: [],
      loadingSources: true,
      currentRequestId: requestId,
      summary: null,
      error: null,
      lastOpenNonce: nonce,
      ...(activeOperationId ? {} : { activeSourceId: null }),
      ...(activeOperationId ? {} : { progress: null, progressLog: [] }),
    });
    dispatch({ type: 'externalMerge/requestSources', requestId });
  },

  refreshSources: (dispatch) => {
    if (get().activeOperationId) return false;
    const requestId = makeId('external-merge-sources');
    set({
      loadingSources: true,
      currentRequestId: requestId,
      summary: null,
      error: null,
      activeSourceId: null,
      progress: null,
      progressLog: [],
    });
    dispatch({ type: 'externalMerge/requestSources', requestId });
    return true;
  },

  handleClose: () => {
    if (get().activeOperationId) return;
    set({
      loadingSources: false,
      summary: null,
      error: null,
      activeSourceId: null,
      currentRequestId: null,
      progress: null,
      progressLog: [],
    });
  },

  startMerge: (sourceId, dispatch, targetIds) => {
    if (get().activeOperationId) return false;
    const operationId = makeId('external-merge-operation');
    const selectedTargetIds = targetIds?.filter(Boolean) ?? [];
    set({
      activeOperationId: operationId,
      activeSourceId: sourceId,
      activeSourceName: null,
      progress: null,
      progressLog: [],
      summary: null,
      error: null,
      result: null,
    });
    dispatch({
      type: 'externalMerge/merge',
      sourceId,
      operationId,
      ...(selectedTargetIds.length > 0 ? { targetIds: selectedTargetIds } : {}),
    });
    return true;
  },

  cancelMerge: (dispatch) => {
    const operationId = get().activeOperationId;
    if (!operationId) return false;
    dispatch({ type: 'externalMerge/cancel', operationId });
    return true;
  },

  dismissResult: () => {
    set({ result: null });
  },

  applySources: (event, currentWindowId) => {
    if (!isForCurrentWindow(event.windowId, currentWindowId)) return;
    if (event.requestId !== get().currentRequestId) return;
    set({ sources: event.sources, loadingSources: false });
  },

  applyStarted: (event, currentWindowId) => {
    if (!isForCurrentWindow(event.windowId, currentWindowId)) return;
    const activeOperationId = get().activeOperationId;
    if (activeOperationId && event.operationId !== activeOperationId) return;
    set({
      activeOperationId: event.operationId,
      activeSourceId: event.sourceId,
      activeSourceName: null,
      progress: null,
      progressLog: [],
      error: null,
      result: null,
    });
  },

  applyProgress: (event, currentWindowId) => {
    if (!isForCurrentWindow(event.windowId, currentWindowId)) return;
    const { activeOperationId, result } = get();
    if (event.operationId !== activeOperationId) {
      // The cancel is shown at once, but a tab in flight still opens and tools reports it
      // afterwards. Only that operation can raise the cancelled count, and never lower it.
      if (result?.kind === 'cancelled' && result.operationId === event.operationId) {
        const opened = event.progress.importedTabs;
        if (opened !== undefined && opened > result.tabsAdded) {
          set({ result: { ...result, tabsAdded: opened } });
        }
      }
      return;
    }
    const activity = event.progress.activity;
    set((state) => ({
      progress: event.progress,
      progressLog: activity ? [...state.progressLog, activity].slice(-100) : state.progressLog,
      activeSourceName: event.progress.sourceName ?? state.activeSourceName,
    }));
  },

  applyComplete: (event, currentWindowId) => {
    if (!isForCurrentWindow(event.windowId, currentWindowId)) return;
    if (event.operationId !== get().activeOperationId) return;
    set((state) => ({
      activeOperationId: null,
      activeSourceId: null,
      activeSourceName: null,
      progress: null,
      progressLog: [],
      summary: event.summary,
      error: null,
      result: {
        kind: 'done',
        sourceName: state.activeSourceName,
        tabsOpened: event.summary.tabsOpened,
        workspacesCreated: event.summary.workspacesCreated,
      },
    }));
  },

  applyError: (event, currentWindowId) => {
    if (!isForCurrentWindow(event.windowId, currentWindowId)) return;
    if (event.requestId) {
      if (event.requestId !== get().currentRequestId) return;
      set({
        loadingSources: false,
        error: { message: event.message, code: event.code, sourceId: event.sourceId },
      });
      return;
    }
    const { operationId } = event;
    if (operationId) {
      if (operationId !== get().activeOperationId) return;
      set((state) => ({
        activeOperationId: null,
        activeSourceId: null,
        activeSourceName: null,
        progress: null,
        progressLog: [],
        error: { message: event.message, code: event.code, sourceId: event.sourceId },
        result:
          event.code === 'cancelled'
            ? {
                kind: 'cancelled',
                operationId,
                sourceName: state.activeSourceName,
                tabsAdded: state.progress?.importedTabs ?? state.progress?.completedTabs ?? 0,
                percent: mergeProgressPercent(state.progress),
              }
            : {
                kind: 'failed',
                sourceName: state.activeSourceName,
                message: failureReason(event.message),
                percent: mergeProgressPercent(state.progress),
              },
      }));
    }
  },

  setForStory: (state) => {
    set(state);
  },
}));
