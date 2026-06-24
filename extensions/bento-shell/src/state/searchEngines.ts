import { create } from 'zustand';
import type { SearchEngineChoice, SearchEngineId, SearchEnginesSnapshot } from '@shared/protocol';

interface SearchEnginesState {
  defaultSearchEngine: SearchEngineId | null;
  availableSearchEngines: SearchEngineChoice[];
  hydrated: boolean;
  apply: (snapshot: SearchEnginesSnapshot) => void;
  clear: () => void;
}

export const useSearchEnginesStore = create<SearchEnginesState>((set) => ({
  defaultSearchEngine: null,
  availableSearchEngines: [],
  hydrated: false,
  apply: (snapshot) =>
    set({
      defaultSearchEngine: snapshot.defaultSearchEngine || null,
      availableSearchEngines: snapshot.availableSearchEngines,
      hydrated: true,
    }),
  clear: () =>
    set({
      defaultSearchEngine: null,
      availableSearchEngines: [],
      hydrated: false,
    }),
}));
