// Fake settings data for Ladle stories — seeds useSettingsStore so the
// Settings layer-3 feature can be exercised in isolation without a live
// bento-tools connection.

import type { BentoSettings } from '@shared/protocol';
import { useSettingsStore } from '../settings';

export const DEFAULT_FIXTURE: BentoSettings = {
  tabSleepEnabled: true,
  tabSleepAfterMinutes: 30,
  tabSleepKeepAlivePerWorkspace: 10,
  defaultWorkspaceName: 'Personal',
  commandPaletteEnabled: true,
  // Default to seen=true so existing stories aren't covered by the
  // welcome banner. The WelcomeBanner stories provide their own state.
  welcomeSeen: true,
  uiColorMode: 'dark',
  contentColorMode: 'light',
  defaultPanelWidthPx: 640,
  sidebarCollapsed: false,
  customPanelSizes: [320, 480, 768, 1280],
  panelCycleWraparound: false,
  panelShadowsEnabled: true,
};

export function seedDefault(): void {
  useSettingsStore.getState().apply(DEFAULT_FIXTURE);
}

export function seedDisabledSleep(): void {
  useSettingsStore.getState().apply({ ...DEFAULT_FIXTURE, tabSleepEnabled: false });
}

export function seedLoading(): void {
  useSettingsStore.setState({ current: null });
}
