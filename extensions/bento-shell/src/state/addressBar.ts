import { create } from 'zustand';
import type { AddrResult, AddrbarRestoreOutcome } from '@shared/protocol';

interface AddressBarState {
  query: string;
  requestId: string | null;
  results: AddrResult[];
  pendingRestore: { requestId: string; sessionId: string } | null;
  restored: boolean;
  error: string | null;
  refreshVersion: number;
  beginQuery: (requestId: string, query: string) => void;
  applyResults: (requestId: string, query: string, results: AddrResult[]) => void;
  beginRestore: (requestId: string, sessionId: string) => boolean;
  applyRestoreResult: (
    requestId: string,
    sessionId: string,
    outcome: AddrbarRestoreOutcome,
  ) => void;
  seed: (query: string, results: AddrResult[]) => void;
  clear: () => void;
}

export const useAddressBarStore = create<AddressBarState>((set, get) => ({
  query: '',
  requestId: null,
  results: [],
  pendingRestore: null,
  restored: false,
  error: null,
  refreshVersion: 0,
  beginQuery: (requestId, query) => set({ requestId, query, results: [] }),
  applyResults: (requestId, query, results) => {
    if (get().requestId === requestId && get().query === query) set({ results });
  },
  beginRestore: (requestId, sessionId) => {
    const state = get();
    if (state.pendingRestore || state.restored || !state.requestId || state.query) return false;
    set({ pendingRestore: { requestId, sessionId }, error: null, restored: false });
    return true;
  },
  applyRestoreResult: (requestId, sessionId, outcome) => {
    const state = get();
    if (
      state.pendingRestore?.requestId !== requestId ||
      state.pendingRestore.sessionId !== sessionId
    )
      return;
    if (outcome.status === 'restored') {
      set({ pendingRestore: null, restored: true });
    } else {
      set({
        pendingRestore: null,
        requestId: null,
        results: [],
        error:
          outcome.status === 'unavailable'
            ? 'This closed tab is no longer available.'
            : 'Could not reopen this tab. Try again.',
        refreshVersion: state.refreshVersion + 1,
      });
    }
  },
  seed: (query, results) => set({ query, results }),
  clear: () =>
    set({
      query: '',
      requestId: null,
      results: [],
      pendingRestore: null,
      restored: false,
      error: null,
    }),
}));
