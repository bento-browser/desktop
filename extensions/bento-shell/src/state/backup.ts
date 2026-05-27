import { create } from 'zustand';
import type { BackupListEntry } from '@shared/protocol';

interface BackupState {
  backups: BackupListEntry[];
  apply: (backups: BackupListEntry[]) => void;
}

export const useBackupStore = create<BackupState>((set) => ({
  backups: [],
  apply: (backups) => set({ backups }),
}));
