// Settings that a private window keeps for itself.
//
// A private window's sidebar collapse, hidden state and colour mode live in the
// shell background's memory, per window, and are never saved: a private window
// must not write what the regular windows share. Both extensions read this list
// (the shell to keep the values, tools to refuse them from a private source), so
// the keys cannot drift apart.

import type { BentoSettings } from './protocol';

export const WINDOW_LOCAL_SETTING_KEYS = [
  'sidebarCollapsed',
  'sidebarHidden',
  'uiColorMode',
] as const;

export type WindowLocalSettings = Pick<BentoSettings, (typeof WINDOW_LOCAL_SETTING_KEYS)[number]>;

/** The window-local part of a settings update, and the rest of it. */
export interface SplitSettingsChanges {
  local: Partial<WindowLocalSettings>;
  rest: Partial<BentoSettings>;
}

/** Splits an update into the window-local keys and everything else. A
 * window-local value of the wrong type is dropped, not kept for the window. */
export function splitWindowLocalSettings(changes: Partial<BentoSettings>): SplitSettingsChanges {
  const { sidebarCollapsed, sidebarHidden, uiColorMode, ...rest } = changes;
  const local: Partial<WindowLocalSettings> = {};
  if (typeof sidebarCollapsed === 'boolean') local.sidebarCollapsed = sidebarCollapsed;
  if (typeof sidebarHidden === 'boolean') local.sidebarHidden = sidebarHidden;
  if (uiColorMode === 'light' || uiColorMode === 'dark' || uiColorMode === 'system') {
    local.uiColorMode = uiColorMode;
  }
  return { local, rest };
}

/** The window-local values of a full settings object. */
export function pickWindowLocalSettings(settings: BentoSettings): WindowLocalSettings {
  return {
    sidebarCollapsed: settings.sidebarCollapsed,
    sidebarHidden: settings.sidebarHidden,
    uiColorMode: settings.uiColorMode,
  };
}
