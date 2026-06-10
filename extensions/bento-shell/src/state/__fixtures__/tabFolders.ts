import type { TabFolder } from '@shared/protocol';
import { useTabFoldersStore } from '../tabFolders';

export function makeFolder(
  partial: Partial<TabFolder> & Pick<TabFolder, 'id' | 'workspaceId'>,
): TabFolder {
  return {
    name: 'Folder',
    order: 0,
    collapsed: false,
    createdAt: 1,
    ...partial,
  };
}

export function seedTabFolders(folders: TabFolder[]): void {
  useTabFoldersStore.getState().applySnapshot(folders);
}

export function clearTabFolders(): void {
  useTabFoldersStore.getState().applySnapshot([]);
}
