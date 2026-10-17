import { create } from 'zustand';

export type RenameRequest = { kind: 'tab'; id: number } | { kind: 'folder'; id: string };

interface UiState {
  renameRequest: RenameRequest | null;
  requestRename: (target: RenameRequest) => void;
  clearRenameRequest: () => void;
  /**
   * Context id of the chrome menu opened from the New button while it is up, else
   * null. Transient: it mirrors the menu overlay (bridge/newMenu.ts) and is never
   * persisted. It lives here, not in TabList, because a workspace switch remounts
   * the pane that holds the button while the menu stays open.
   */
  newMenuContextId: string | null;
  setNewMenuContextId: (contextId: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  renameRequest: null,
  requestRename: (target) => set({ renameRequest: target }),
  clearRenameRequest: () => set({ renameRequest: null }),
  newMenuContextId: null,
  setNewMenuContextId: (contextId) => set({ newMenuContextId: contextId }),
}));
