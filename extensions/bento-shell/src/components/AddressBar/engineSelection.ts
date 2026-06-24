import type { SearchEngineId } from '@shared/protocol';

export interface EngineSelectionState {
  selectedSearchEngineId: SearchEngineId | null;
  engineSelectionDirty: boolean;
}

export function resetEngineSelection(
  defaultSearchEngine: SearchEngineId | null,
): EngineSelectionState {
  return {
    selectedSearchEngineId: defaultSearchEngine,
    engineSelectionDirty: false,
  };
}

export function applyDefaultEngineIfClean(
  state: EngineSelectionState,
  defaultSearchEngine: SearchEngineId | null,
): EngineSelectionState {
  if (state.engineSelectionDirty) return state;
  return {
    ...state,
    selectedSearchEngineId: defaultSearchEngine,
  };
}

export function chooseEngine(
  state: EngineSelectionState,
  selectedSearchEngineId: SearchEngineId | null,
): EngineSelectionState {
  return {
    ...state,
    selectedSearchEngineId,
    engineSelectionDirty: true,
  };
}
