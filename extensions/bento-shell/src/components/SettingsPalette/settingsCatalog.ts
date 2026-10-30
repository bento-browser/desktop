// Static description of the settings the Settings palette edits: labels, groups, bounds,
// presets and shortcut copy. Values come from tools (`snapshot/get`); nothing here is state.
//
// The bounds mirror `extensions/_shared/settings-rules.ts`, which tools validates against.
// settingsCatalog.test.ts compares the two so they cannot drift.

import type { PrivacyAdvancedKey } from '@shared/protocol';
import type { EditableSettings, SettingsPrivacy } from '@shared/settings-client-protocol';

export type NumberSettingKey = {
  [K in keyof EditableSettings]: EditableSettings[K] extends number ? K : never;
}[keyof EditableSettings];

export type BooleanSettingKey = {
  [K in keyof EditableSettings]: EditableSettings[K] extends boolean ? K : never;
}[keyof EditableSettings];

export interface NumberSpec {
  key: NumberSettingKey;
  label: string;
  /** Suffix shown after the number: `px`, `min` or none. */
  unit: '' | 'px' | 'min';
  min: number;
  max: number;
  defaultValue: number;
  /** Suggested values between the bounds; the bounds and the default are added to the list. */
  presets: readonly number[];
  keywords: readonly string[];
}

export const NUMBER_SPECS: Record<NumberSettingKey, NumberSpec> = {
  tabSleepAfterMinutes: {
    key: 'tabSleepAfterMinutes',
    label: 'Sleep tabs after',
    unit: 'min',
    min: 1,
    max: 1440,
    defaultValue: 30,
    presets: [5, 15, 60, 120, 240],
    keywords: ['tab sleep', 'idle', 'minutes', 'memory'],
  },
  tabSleepKeepAlivePerWorkspace: {
    key: 'tabSleepKeepAlivePerWorkspace',
    label: 'Keep alive per workspace',
    unit: '',
    min: 1,
    max: 50,
    defaultValue: 3,
    presets: [2, 5, 10, 20],
    keywords: ['tab sleep', 'awake', 'recent tabs'],
  },
  defaultPanelWidthPx: {
    key: 'defaultPanelWidthPx',
    label: 'Default new panel width',
    unit: 'px',
    min: 200,
    max: 2400,
    defaultValue: 640,
    presets: [320, 480, 768, 1024, 1280],
    keywords: ['panel', 'size'],
  },
  panelCornerRadiusPx: {
    key: 'panelCornerRadiusPx',
    label: 'Panel corner radius',
    unit: 'px',
    min: 0,
    max: 36,
    defaultValue: 12,
    presets: [8, 16, 24],
    keywords: ['panel', 'roundness', 'rounded'],
  },
  panelSplitterSizePx: {
    key: 'panelSplitterSizePx',
    label: 'Panel gap and splitter size',
    unit: 'px',
    min: 6,
    max: 36,
    defaultValue: 14,
    presets: [8, 10, 20, 24],
    keywords: ['panel', 'gap', 'splitter', 'spacing'],
  },
  autoBackupIntervalMinutes: {
    key: 'autoBackupIntervalMinutes',
    label: 'Backup interval',
    unit: 'min',
    min: 5,
    max: 1440,
    defaultValue: 30,
    presets: [15, 60, 180, 720],
    keywords: ['automatic backups', 'minutes'],
  },
  autoBackupMaxCount: {
    key: 'autoBackupMaxCount',
    label: 'Backups to retain',
    unit: '',
    min: 1,
    max: 20,
    defaultValue: 5,
    presets: [3, 10],
    keywords: ['automatic backups', 'keep', 'retention'],
  },
};

export interface BooleanSpec {
  key: BooleanSettingKey;
  label: string;
  keywords: readonly string[];
}

export const BOOLEAN_SPECS: Record<BooleanSettingKey, BooleanSpec> = {
  tabStateTintsEnabled: {
    key: 'tabStateTintsEnabled',
    label: 'Show tab state tints',
    keywords: ['tab appearance', 'status', 'background', 'color', 'quiet'],
  },
  customTabStateIconsEnabled: {
    key: 'customTabStateIconsEnabled',
    label: 'Use custom tab state icons',
    keywords: ['tab appearance', 'status', 'favicon', 'softcast'],
  },
  tabSleepEnabled: { key: 'tabSleepEnabled', label: 'Sleep idle tabs', keywords: ['tab sleep'] },
  panelCycleWraparound: {
    key: 'panelCycleWraparound',
    label: 'Wrap panel shortcuts at the ends',
    keywords: ['panel', 'cycle', 'wraparound'],
  },
  panelShadowsEnabled: {
    key: 'panelShadowsEnabled',
    label: 'Show panel shadows',
    keywords: ['panel', 'shadow'],
  },
  autoBackupEnabled: {
    key: 'autoBackupEnabled',
    label: 'Automatic backups',
    keywords: ['backup'],
  },
};

/** Settings that open a list of fixed choices. */
export type EnumKey =
  'uiColorMode' | 'sidebarShortcutBehavior' | 'webRTCIPHandlingPolicy' | 'httpsOnlyMode';

export interface EnumOption<V extends string = string> {
  value: V;
  label: string;
}

export const COLOR_MODE_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Follow system' },
] as const satisfies readonly EnumOption<EditableSettings['uiColorMode']>[];

export const SHORTCUT_BEHAVIOR_OPTIONS = [
  { value: 'collapse', label: 'Collapse the sidebar' },
  { value: 'hide', label: 'Hide the sidebar' },
] as const satisfies readonly EnumOption<EditableSettings['sidebarShortcutBehavior']>[];

export const WEBRTC_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'disable_non_proxied_udp', label: 'Disable non-proxied UDP' },
] as const satisfies readonly EnumOption[];

export const HTTPS_OPTIONS = [
  { value: 'never', label: 'Off' },
  { value: 'always', label: 'Always' },
] as const satisfies readonly EnumOption[];

export interface EnumSpec {
  key: EnumKey;
  label: string;
  options: readonly EnumOption[];
  keywords: readonly string[];
}

export const ENUM_SPECS: Record<EnumKey, EnumSpec> = {
  uiColorMode: {
    key: 'uiColorMode',
    label: 'Bento color mode',
    options: COLOR_MODE_OPTIONS,
    keywords: ['appearance', 'theme', 'dark mode', 'light mode'],
  },
  sidebarShortcutBehavior: {
    key: 'sidebarShortcutBehavior',
    label: 'Sidebar collapse type',
    options: SHORTCUT_BEHAVIOR_OPTIONS,
    keywords: ['sidebar', 'minimize', 'shortcut', 'cmd s', 'ctrl s'],
  },
  webRTCIPHandlingPolicy: {
    key: 'webRTCIPHandlingPolicy',
    label: 'WebRTC IP handling',
    options: WEBRTC_OPTIONS,
    keywords: ['privacy', 'webrtc', 'ip leak'],
  },
  httpsOnlyMode: {
    key: 'httpsOnlyMode',
    label: 'HTTPS-only mode',
    options: HTTPS_OPTIONS,
    keywords: ['privacy', 'https', 'secure'],
  },
};

/** The advanced privacy switches and choices, in display order. */
export interface AdvancedPrivacySpec {
  key: Exclude<PrivacyAdvancedKey, 'searchSuggestionsEnabled'>;
  label: string;
  /** Set for the two choices that open a list instead of toggling. */
  enumKey?: EnumKey;
  keywords: readonly string[];
}

export const ADVANCED_PRIVACY_SPECS: readonly AdvancedPrivacySpec[] = [
  { key: 'safeBrowsingEnabled', label: 'Local Safe Browsing', keywords: ['malware', 'phishing'] },
  {
    key: 'remoteSafeBrowsingEnabled',
    label: 'Remote download reputation',
    keywords: ['safe browsing', 'downloads'],
  },
  { key: 'resistFingerprinting', label: 'Resist fingerprinting', keywords: ['tracking'] },
  { key: 'letterboxing', label: 'Letterboxing', keywords: ['fingerprinting', 'window size'] },
  { key: 'networkPrediction', label: 'Network prediction', keywords: ['prefetch', 'preconnect'] },
  { key: 'peerConnection', label: 'WebRTC peer connections', keywords: ['webrtc', 'video calls'] },
  {
    key: 'webRTCIPHandlingPolicy',
    label: 'WebRTC IP handling',
    enumKey: 'webRTCIPHandlingPolicy',
    keywords: ['webrtc', 'ip'],
  },
  {
    key: 'httpsOnlyMode',
    label: 'HTTPS-only mode',
    enumKey: 'httpsOnlyMode',
    keywords: ['https', 'secure'],
  },
  { key: 'drmEnabled', label: 'DRM protected content', keywords: ['widevine', 'streaming'] },
  { key: 'diskCacheEnabled', label: 'Disk cache', keywords: ['cache'] },
  { key: 'webglEnabled', label: 'WebGL', keywords: ['graphics', '3d'] },
  { key: 'webgpuEnabled', label: 'WebGPU', keywords: ['graphics', 'gpu'] },
  { key: 'passwordSavingEnabled', label: 'Password saving', keywords: ['passwords', 'logins'] },
  { key: 'formHistoryEnabled', label: 'Form history', keywords: ['autofill', 'forms'] },
  {
    key: 'sanitizeOnShutdown',
    label: 'Clear cookies and cache on shutdown',
    keywords: ['cookies', 'sanitize', 'quit'],
  },
];

export function advancedValue(
  privacy: SettingsPrivacy,
  key: AdvancedPrivacySpec['key'],
): boolean | string {
  return privacy[key];
}

/** Bounds that apply to the list of custom panel sizes. */
export const PANEL_SIZE_LIMITS = { min: 120, max: 2400, maxItems: 64 } as const;

export interface ShortcutEntry {
  label: string;
  keys: string;
}

/** Read-only catalogue of the keyboard shortcuts. The command palette is bound to
 * Cmd/Ctrl+Alt+P in the mount script. */
export const SHORTCUTS: readonly ShortcutEntry[] = [
  { label: 'Switch workspace by index', keys: 'Cmd/Ctrl + Alt + 1–9' },
  { label: 'Minimize sidebar', keys: 'Cmd/Ctrl + S' },
  { label: 'Previous panel', keys: 'Cmd/Ctrl + Shift + Left' },
  { label: 'Next panel', keys: 'Cmd/Ctrl + Shift + Right' },
  { label: 'Open command palette', keys: 'Cmd/Ctrl + Alt + P' },
  { label: 'Close overlay', keys: 'Escape' },
  { label: 'Close tab with pointer', keys: 'Middle click' },
  { label: 'New tab', keys: 'Cmd/Ctrl + T' },
  { label: 'Close tab', keys: 'Cmd/Ctrl + W' },
  { label: 'Reopen closed tab', keys: 'Cmd/Ctrl + Shift + T' },
  { label: 'Switch tab by index', keys: 'Cmd/Ctrl + 1–9' },
  { label: 'Reload Bento shell', keys: 'Alt + Shift + R' },
];

export function formatNumber(spec: Pick<NumberSpec, 'unit'>, value: number): string {
  return spec.unit ? `${value} ${spec.unit}` : String(value);
}

/** What a number editor needs: the bounds, the unit and the suggested values. */
export interface EditorSpec {
  label: string;
  unit: NumberSpec['unit'];
  min: number;
  max: number;
  /** The setting's own default; absent for a list entry that has none. */
  defaultValue?: number;
  presets: readonly number[];
}

/** Editor for one entry of the custom panel sizes list. */
export const PANEL_SIZE_EDITOR: EditorSpec = {
  label: 'Edit size',
  unit: 'px',
  min: PANEL_SIZE_LIMITS.min,
  max: PANEL_SIZE_LIMITS.max,
  presets: [320, 480, 640, 768, 1024, 1280],
};

/** The widest range (max minus min) that gets a slider; a wider one keeps the typed field and
 * its presets, where a slider's track would be too coarse to hit a value. */
export const SLIDER_MAX_SPAN = 50;

/** Whether a number editor is a slider (step 1) instead of a field with presets. Decided by the
 * range alone, so a new small-range setting gets one without another list to update. */
export function usesSlider(spec: Pick<EditorSpec, 'min' | 'max'>): boolean {
  return spec.max - spec.min <= SLIDER_MAX_SPAN;
}

/** Preset values for a number editor: the bounds, the default and the suggestions, ascending. */
export function presetValues(spec: EditorSpec): number[] {
  const values = [spec.min, spec.max, ...spec.presets];
  if (spec.defaultValue !== undefined) values.push(spec.defaultValue);
  return Array.from(new Set(values)).sort((left, right) => left - right);
}

/** Marker shown next to a preset: `Min`, `Default` or `Max`. */
export function presetMarker(spec: EditorSpec, value: number): string | undefined {
  if (value === spec.defaultValue) return 'Default';
  if (value === spec.min) return 'Min';
  if (value === spec.max) return 'Max';
  return undefined;
}

export type ParsedNumber = { ok: true; value: number } | { ok: false; reason: string };

/** Parses what the user typed. Anything that is not a whole number inside the bounds is
 * refused, never clamped, so an invalid entry is never saved as some other value. */
export function parseNumber(text: string, bounds: { min: number; max: number }): ParsedNumber {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reason: 'Enter a number' };
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: 'Whole numbers only' };
  const value = Number(trimmed);
  if (value < bounds.min || value > bounds.max) {
    return { ok: false, reason: `Use ${bounds.min} to ${bounds.max}` };
  }
  return { ok: true, value };
}
