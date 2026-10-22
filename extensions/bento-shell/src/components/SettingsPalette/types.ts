import type { PrivacyAdvancedKey, SearchEngineId } from '@shared/protocol';
import type {
  BackupContext,
  EditableSettings,
  ImportPreview,
  SelectablePrivacyLevel,
  SettingsPrivacy,
  SettingsSearch,
} from './model';

export type { SelectablePrivacyLevel };

/** A stored file the user picked and tools validated; waits for Import or Cancel. */
export interface ImportPreviewState {
  fileName: string;
  validationToken: string;
  preview: ImportPreview;
}

/** What the palette renders once a snapshot has arrived. Owned by the settings store
 * (`state/settingsPalette.ts`). */
export interface SettingsPaletteModel {
  /** Tools omits the backup domain for a private-window caller. */
  isPrivate: boolean;
  settings: EditableSettings;
  privacy: SettingsPrivacy | null;
  search: SettingsSearch | null;
  backup: BackupContext | null;
  /** Writes in flight: a setting key, `protection`, `search`, `advanced:<key>`, `reset`, `backup`. */
  pending: ReadonlySet<string>;
  /** The latest failed write, until the next action. */
  notice: string | null;
  importPreview: ImportPreviewState | null;
}

/** The palette before and after the first snapshot. A later failed refresh keeps the last
 * model and reports through `notice`. */
export type SettingsPaletteView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; model: SettingsPaletteModel };

/** Every write the palette can make. Each resolves to whether tools applied it. */
export interface SettingsPaletteActions {
  update(changes: Partial<EditableSettings>): Promise<boolean>;
  setProtectionLevel(level: SelectablePrivacyLevel): Promise<boolean>;
  setAdvanced(key: PrivacyAdvancedKey, value: boolean | string): Promise<boolean>;
  setSearchEngine(id: SearchEngineId): Promise<boolean>;
  /** Durable. Resolves true once tools reports the reset done. */
  reset(): Promise<boolean>;
  exportBackup(): Promise<boolean>;
  /** Reads the chosen file and asks tools to validate it; fills `importPreview`. */
  pickImportFile(file: File): Promise<boolean>;
  confirmImport(): Promise<boolean>;
  cancelImport(): void;
  restoreBackup(id: string): Promise<boolean>;
  deleteBackup(id: string): Promise<boolean>;
  openFirefoxSearchSettings(): void;
  openMergePalette(): void;
  /** Reloads the snapshot (also the retry after a failed load). */
  refresh(): void;
  clearNotice(): void;
  /** Tells the store whether the palette is on screen. A show clears the notice and then reports
   * the operations that ended while it was hidden; those are acknowledged only once shown. */
  setVisible(visible: boolean): void;
}
