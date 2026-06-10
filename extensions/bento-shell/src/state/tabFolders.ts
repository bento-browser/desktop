import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import type { TabFolder, TabFolderDelta } from '@shared/protocol';

interface TabFoldersState {
  byId: Record<string, TabFolder>;
  hydrated: boolean;
  applySnapshot: (folders: TabFolder[]) => void;
  applyDeltas: (deltas: TabFolderDelta[]) => void;
}

function sortFolders(folders: TabFolder[]): TabFolder[] {
  return [...folders].sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

export const useTabFoldersStore = create<TabFoldersState>((set) => ({
  byId: {},
  hydrated: false,
  applySnapshot: (folders) => {
    const byId: Record<string, TabFolder> = {};
    for (const folder of folders) byId[folder.id] = folder;
    set({ byId, hydrated: true });
  },
  applyDeltas: (deltas) =>
    set((state) => {
      const byId = { ...state.byId };
      for (const delta of deltas) {
        switch (delta.kind) {
          case 'created':
            byId[delta.folder.id] = delta.folder;
            break;
          case 'updated':
            if (byId[delta.id]) {
              const existing = byId[delta.id];
              byId[delta.id] = Object.assign({}, existing, delta.changes);
            }
            break;
          case 'removed':
            delete byId[delta.id];
            break;
        }
      }
      return { byId };
    }),
}));

export function useWorkspaceFolders(workspaceId: string | null): TabFolder[] {
  const folders = useTabFoldersStore(
    useShallow((state) => {
      if (!workspaceId) return [];
      return Object.values(state.byId).filter((folder) => folder.workspaceId === workspaceId);
    }),
  );
  return useMemo(() => sortFolders(folders), [folders]);
}

export function useFolder(id: string): TabFolder | undefined {
  return useTabFoldersStore((state) => state.byId[id]);
}
