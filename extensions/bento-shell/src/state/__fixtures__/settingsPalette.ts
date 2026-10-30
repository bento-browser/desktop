// Fake Settings palette data for Ladle stories and tests. The component takes a model and a set
// of actions, so stories never reach `settings-palette/` or the relay; `useFakeSettingsPalette`
// applies the actions to a local copy so toggles, editors and stages work in a story.

import { useMemo, useState } from 'react';
import type {
  BackupContext,
  EditableSettings,
  ImportPreview,
  SettingsPrivacy,
  SettingsSearch,
} from '@shared/settings-client-protocol';
import type {
  SettingsPaletteActions,
  SettingsPaletteModel,
  SettingsPaletteView,
} from '../../components/SettingsPalette/types';

export const FIXTURE_SETTINGS: EditableSettings = {
  tabStateTintsEnabled: true,
  customTabStateIconsEnabled: true,
  tabSleepEnabled: true,
  tabSleepAfterMinutes: 30,
  tabSleepKeepAlivePerWorkspace: 3,
  uiColorMode: 'system',
  defaultPanelWidthPx: 640,
  sidebarShortcutBehavior: 'collapse',
  customPanelSizes: [320, 480, 640, 768, 1280],
  panelCycleWraparound: false,
  panelShadowsEnabled: true,
  panelCornerRadiusPx: 12,
  panelSplitterSizePx: 14,
  autoBackupEnabled: true,
  autoBackupIntervalMinutes: 30,
  autoBackupMaxCount: 5,
};

export const FIXTURE_PRIVACY: SettingsPrivacy = {
  protectionLevel: 'standard',
  safeBrowsingEnabled: true,
  remoteSafeBrowsingEnabled: false,
  drmEnabled: true,
  sanitizeOnShutdown: false,
  resistFingerprinting: false,
  letterboxing: false,
  networkPrediction: false,
  peerConnection: true,
  webRTCIPHandlingPolicy: 'default',
  httpsOnlyMode: 'always',
  diskCacheEnabled: true,
  webglEnabled: true,
  webgpuEnabled: true,
  passwordSavingEnabled: true,
  formHistoryEnabled: true,
};

export const FIXTURE_SEARCH: SettingsSearch = {
  defaultSearchEngine: 'ddg',
  availableSearchEngines: [
    { id: 'ddg', name: 'DuckDuckGo', isDefault: true },
    { id: 'google', name: 'Google', isDefault: false },
    { id: 'bing', name: 'Bing', isDefault: false },
    { id: 'wikipedia', name: 'Wikipedia (en)', isDefault: false },
  ],
};

const OCTOBER_22 = Date.UTC(2026, 9, 22, 3, 30);

export const FIXTURE_BACKUP: BackupContext = {
  workspaces: [
    { id: 'w1', name: 'Personal', normalTabCount: 14, panelCount: 2, pinCount: 3 },
    { id: 'w2', name: 'Work', normalTabCount: 18, panelCount: 3, pinCount: 2 },
    { id: 'w3', name: 'Research', normalTabCount: 6, panelCount: 0, pinCount: 0 },
    { id: 'w4', name: 'Reading', normalTabCount: 3, panelCount: 1, pinCount: 0 },
  ],
  backups: [
    {
      id: 'b1',
      createdAt: OCTOBER_22,
      workspaceCount: 4,
      tabCount: 41,
      privacySafety: 'private-filtered-v1',
    },
    {
      id: 'b2',
      createdAt: OCTOBER_22 - 30 * 60_000,
      workspaceCount: 4,
      tabCount: 41,
      privacySafety: 'private-filtered-v1',
    },
    {
      id: 'b3',
      createdAt: OCTOBER_22 - 29 * 3_600_000,
      workspaceCount: 4,
      tabCount: 38,
      privacySafety: 'private-filtered-v1',
    },
    {
      id: 'b4',
      createdAt: Date.UTC(2026, 8, 2, 8, 5),
      workspaceCount: 3,
      tabCount: 25,
      privacySafety: 'legacy-unknown',
    },
  ],
  savedPanelCount: 2,
  revision: 1,
};

export const FIXTURE_IMPORT_PREVIEW: ImportPreview = {
  schemaVersion: 2,
  totals: { workspaceCount: 4, normalTabCount: 37, panelCount: 5, pinCount: 4 },
  workspaces: [],
  hasSettings: true,
  savedPanelCount: 2,
  privacySafety: 'file-unclassified',
};

export const REGULAR_MODEL: SettingsPaletteModel = {
  isPrivate: false,
  settings: FIXTURE_SETTINGS,
  privacy: FIXTURE_PRIVACY,
  search: FIXTURE_SEARCH,
  backup: FIXTURE_BACKUP,
  pending: new Set(),
  pendingTargets: new Map(),
  notice: null,
  importPreview: null,
};

/** A private-window caller: tools sends no backup domain. */
export const PRIVATE_MODEL: SettingsPaletteModel = {
  ...REGULAR_MODEL,
  isPrivate: true,
  backup: null,
};

export const IMPORT_PREVIEW_MODEL: SettingsPaletteModel = {
  ...REGULAR_MODEL,
  importPreview: {
    fileName: 'bento-backup-2026-10-18.json',
    validationToken: 'token',
    preview: FIXTURE_IMPORT_PREVIEW,
  },
};

export const NOOP_ACTIONS: SettingsPaletteActions = {
  update: async () => true,
  setProtectionLevel: async () => true,
  setAdvanced: async () => true,
  setSearchEngine: async () => true,
  reset: async () => true,
  exportBackup: async () => true,
  pickImportFile: async () => true,
  confirmImport: async () => true,
  cancelImport: () => {},
  restoreBackup: async () => true,
  deleteBackup: async () => true,
  openFirefoxSearchSettings: () => {},
  openMergePalette: () => {},
  refresh: () => {},
  clearNotice: () => {},
  setVisible: () => {},
};

/** A model and actions that edit a local copy of `initial`. */
export function useFakeSettingsPalette(initial: SettingsPaletteModel): {
  view: SettingsPaletteView;
  actions: SettingsPaletteActions;
} {
  const [model, setModel] = useState(initial);
  const actions = useMemo<SettingsPaletteActions>(() => {
    const patch = (change: Partial<SettingsPaletteModel>) =>
      setModel((current) => ({ ...current, ...change }));
    return {
      ...NOOP_ACTIONS,
      async update(changes) {
        setModel((current) => ({ ...current, settings: { ...current.settings, ...changes } }));
        return true;
      },
      async setProtectionLevel(level) {
        setModel((current) =>
          current.privacy
            ? { ...current, privacy: { ...current.privacy, protectionLevel: level } }
            : current,
        );
        return true;
      },
      async setAdvanced(key, value) {
        setModel((current) =>
          current.privacy ? { ...current, privacy: { ...current.privacy, [key]: value } } : current,
        );
        return true;
      },
      async setSearchEngine(id) {
        setModel((current) =>
          current.search
            ? {
                ...current,
                search: {
                  defaultSearchEngine: id,
                  availableSearchEngines: current.search.availableSearchEngines.map((engine) => ({
                    ...engine,
                    isDefault: engine.id === id,
                  })),
                },
              }
            : current,
        );
        return true;
      },
      async pickImportFile(file) {
        patch({
          importPreview: {
            fileName: file.name,
            validationToken: 'token',
            preview: FIXTURE_IMPORT_PREVIEW,
          },
        });
        return true;
      },
      async confirmImport() {
        patch({ importPreview: null });
        return true;
      },
      cancelImport: () => patch({ importPreview: null }),
      async deleteBackup(id) {
        setModel((current) =>
          current.backup
            ? {
                ...current,
                backup: {
                  ...current.backup,
                  backups: current.backup.backups.filter((b) => b.id !== id),
                },
              }
            : current,
        );
        return true;
      },
      clearNotice: () => patch({ notice: null }),
      setVisible: () => {},
    };
  }, []);
  return { view: { kind: 'ready', model }, actions };
}
