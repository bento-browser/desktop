// Fake settings data for Ladle stories and tests, applied to useSettingsStore
// so components can be exercised without a live bento-tools connection.

import type { BentoSettings } from '@shared/protocol';
import { useSettingsStore } from '../settings';

export const DEFAULT_FIXTURE: BentoSettings = {
  tabStateTintsEnabled: true,
  customTabStateIconsEnabled: true,
  tabSleepEnabled: true,
  tabSleepAfterMinutes: 30,
  tabSleepKeepAlivePerWorkspace: 3,
  // Default to seen=true so stories aren't covered by the welcome flow.
  welcomeSeen: true,
  uiColorMode: 'light',
  uiScale: '1',
  contentColorMode: 'light',
  defaultPanelWidthPx: 640,
  sidebarCollapsed: false,
  sidebarHidden: false,
  sidebarShortcutBehavior: 'collapse',
  customPanelSizes: [320, 480, 768, 1280],
  panelCycleWraparound: false,
  panelShadowsEnabled: true,
  panelCornerRadiusPx: 12,
  panelSplitterSizePx: 14,
  bookmarksEnabled: true,
  autoBackupEnabled: true,
  autoBackupIntervalMinutes: 30,
  autoBackupMaxCount: 5,
  privacyProtectionLevel: 'standard',
  defaultSearchEngine: 'ddg',
};

export function seedDefault(): void {
  useSettingsStore.getState().apply(DEFAULT_FIXTURE);
}
