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

type DispatchAction = (action: Action) => void;

interface ExternalMergeState {
  sources: ExternalMergeSource[];
  loadingSources: boolean;
  activeSourceId: string | null;
  currentRequestId: string | null;
  activeOperationId: string | null;
  progress: ExternalMergeProgress | null;
  progressLog: ExternalMergeProgressActivity[];
  summary: ExternalMergeSummary | null;
  error: ExternalMergeErrorState | null;
  lastOpenNonce: string | null;

  requestSourcesForOpen: (nonce: string, dispatch: DispatchAction) => void;
  refreshSources: (dispatch: DispatchAction) => boolean;
  handleClose: () => void;
  startMerge: (sourceId: string, dispatch: DispatchAction, targetIds?: string[]) => boolean;
  cancelMerge: (dispatch: DispatchAction) => boolean;
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
  summary: null,
  error: null,
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
      progress: null,
      progressLog: [],
      summary: null,
      error: null,
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
      progress: null,
      progressLog: [],
      error: null,
    });
  },

  applyProgress: (event, currentWindowId) => {
    if (!isForCurrentWindow(event.windowId, currentWindowId)) return;
    if (event.operationId !== get().activeOperationId) return;
    const activity = event.progress.activity;
    set((state) => ({
      progress: event.progress,
      progressLog: activity ? [...state.progressLog, activity].slice(-100) : state.progressLog,
    }));
  },

  applyComplete: (event, currentWindowId) => {
    if (!isForCurrentWindow(event.windowId, currentWindowId)) return;
    if (event.operationId !== get().activeOperationId) return;
    set({
      activeOperationId: null,
      activeSourceId: null,
      progress: null,
      progressLog: [],
      summary: event.summary,
      error: null,
    });
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
    if (event.operationId) {
      if (event.operationId !== get().activeOperationId) return;
      set({
        activeOperationId: null,
        activeSourceId: null,
        progress: null,
        progressLog: [],
        error: { message: event.message, code: event.code, sourceId: event.sourceId },
      });
    }
  },

  setForStory: (state) => {
    set(state);
  },
}));
