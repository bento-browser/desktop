import { create } from 'zustand';

export type RenameRequest = { kind: 'tab'; id: number } | { kind: 'folder'; id: string };

interface UiState {
  renameRequest: RenameRequest | null;
  requestRename: (target: RenameRequest) => void;
  clearRenameRequest: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  renameRequest: null,
  requestRename: (target) => set({ renameRequest: target }),
  clearRenameRequest: () => set({ renameRequest: null }),
}));
