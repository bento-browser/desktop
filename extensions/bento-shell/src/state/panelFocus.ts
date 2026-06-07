import { create } from 'zustand';

interface PanelFocusState {
  focusedTabId: number | null;
  apply: (tabId: number | null) => void;
}

export const usePanelFocusStore = create<PanelFocusState>((set) => ({
  focusedTabId: null,
  apply: (tabId) => set({ focusedTabId: tabId }),
}));
