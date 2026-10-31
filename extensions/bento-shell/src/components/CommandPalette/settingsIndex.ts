// Static index of the settings the command palette can open the Settings palette at: ids, labels
// and search words only, no values (the palette holds no settings state, and the Settings palette
// shows the current value once it is open). Each id is the id of a control row of the Settings
// palette (`SettingsPalette/rows.ts`); `settingsIndex.test.ts` keeps the two lists equal, and
// `SettingsPalette/targets.ts` says where each one opens.
//
// Kept to plain strings on purpose: this file is in the command palette's cold-start chunk.

export interface SettingsIndexEntry {
  id: string;
  label: string;
  /** The Settings palette's group, which also names the row's description. */
  group: string;
  keywords: readonly string[];
  /** Backup rows: a private window's Settings palette has none. */
  regularOnly?: true;
}

export const SETTINGS_INDEX: readonly SettingsIndexEntry[] = [
  {
    id: 'setting:uiColorMode',
    label: 'Bento color mode',
    group: 'Appearance',
    keywords: ['theme', 'dark mode', 'light mode'],
  },
  {
    id: 'setting:tabStateTintsEnabled',
    label: 'Show tab state tints',
    group: 'Tab appearance',
    keywords: ['status', 'background', 'color', 'quiet'],
  },
  {
    id: 'setting:customTabStateIconsEnabled',
    label: 'Use custom tab state icons',
    group: 'Tab appearance',
    keywords: ['status', 'favicon', 'icon'],
  },
  {
    id: 'setting:tabSleepEnabled',
    label: 'Sleep idle tabs',
    group: 'Performance',
    keywords: [],
  },
  {
    id: 'setting:tabSleepAfterMinutes',
    label: 'Sleep tabs after',
    group: 'Performance',
    keywords: ['idle', 'memory'],
  },
  {
    id: 'setting:tabSleepKeepAlivePerWorkspace',
    label: 'Keep alive per workspace',
    group: 'Performance',
    keywords: ['awake'],
  },
  {
    id: 'setting:sidebarShortcutBehavior',
    label: 'Sidebar collapse type',
    group: 'Workspaces',
    keywords: ['sidebar', 'minimize', 'shortcut', 'cmd s', 'ctrl s'],
  },
  {
    id: 'setting:defaultPanelWidthPx',
    label: 'Default new panel width',
    group: 'Panels',
    keywords: ['size'],
  },
  {
    id: 'setting:panelCycleWraparound',
    label: 'Wrap panel shortcuts at the ends',
    group: 'Panels',
    keywords: ['cycle'],
  },
  {
    id: 'setting:panelShadowsEnabled',
    label: 'Show panel shadows',
    group: 'Panels',
    keywords: ['shadow'],
  },
  {
    id: 'setting:panelCornerRadiusPx',
    label: 'Panel corner radius',
    group: 'Panels',
    keywords: ['roundness', 'rounded'],
  },
  {
    id: 'setting:panelSplitterSizePx',
    label: 'Panel gap and splitter size',
    group: 'Panels',
    keywords: ['spacing'],
  },
  {
    id: 'setting:customPanelSizes',
    label: 'Custom panel sizes',
    group: 'Panels',
    keywords: ['widths', 'presets'],
  },
  {
    id: 'privacy:level',
    label: 'Protection level',
    group: 'Privacy and search',
    keywords: ['standard', 'enhanced', 'hardened', 'tracking'],
  },
  {
    id: 'privacy:search',
    label: 'Default search engine',
    group: 'Privacy and search',
    keywords: ['duckduckgo', 'google'],
  },
  {
    id: 'privacy:manage-search',
    label: 'Manage search engines',
    group: 'Privacy and search',
    keywords: ['add', 'custom'],
  },
  {
    id: 'privacy:advanced',
    label: 'Advanced privacy',
    group: 'Privacy and search',
    keywords: ['fingerprinting', 'webrtc', 'https', 'cookies'],
  },
  {
    id: 'setting:autoBackupEnabled',
    label: 'Automatic backups',
    group: 'Backup and data',
    keywords: [],
    regularOnly: true,
  },
  {
    id: 'setting:autoBackupIntervalMinutes',
    label: 'Backup interval',
    group: 'Backup and data',
    keywords: [],
    regularOnly: true,
  },
  {
    id: 'setting:autoBackupMaxCount',
    label: 'Backups to retain',
    group: 'Backup and data',
    keywords: ['retention'],
    regularOnly: true,
  },
  {
    id: 'backup:open',
    label: 'Export, import and stored backups',
    group: 'Backup and data',
    keywords: ['restore'],
    regularOnly: true,
  },
  {
    id: 'shortcuts:open',
    label: 'View keyboard shortcuts',
    group: 'Keyboard shortcuts',
    keywords: ['keys', 'hotkeys'],
  },
];
