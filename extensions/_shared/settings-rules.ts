// What the Settings palette may write, and the size limits of its requests.
//
// bento-tools validates every settings request against these rules, and the shell's catalog
// (`SettingsPalette/settingsCatalog.ts`) is tested against them, so the labels, bounds and
// presets the palette offers cannot drift from what tools accepts. The type annotations make
// the compiler check that the rules cover exactly the editable settings and the advanced
// privacy keys.

import type { PrivacyAdvancedKey } from './protocol';
import type { EditableSettings, SettingsDomain } from './settings-client-protocol';

export const SETTINGS_LIMITS = {
  /** Largest backup file, as text or as UTF-8 bytes. */
  backupFileBytes: 10_485_760,
  /** Workspaces one export or restore may name. */
  workspaceCount: 256,
  /** Code units of an opaque id (search engine id, backup id, workspace id). */
  idCodeUnits: 256,
  /** How long an import validation token stays usable. */
  validationTokenMs: 300_000,
} as const;

/** The domains a `snapshot/get` may ask for. */
export const SNAPSHOT_DOMAINS: readonly SettingsDomain[] = [
  'settings',
  'privacy',
  'search',
  'backup',
];

export type SettingRule =
  | { type: 'boolean' }
  | { type: 'integer'; min: number; max: number }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'integerArray'; min: number; max: number; maxItems: number };

export const EDITABLE_SETTING_RULES = {
  tabStateTintsEnabled: { type: 'boolean' },
  customTabStateIconsEnabled: { type: 'boolean' },
  tabSleepEnabled: { type: 'boolean' },
  tabSleepAfterMinutes: { type: 'integer', min: 1, max: 1440 },
  tabSleepKeepAlivePerWorkspace: { type: 'integer', min: 1, max: 50 },
  uiColorMode: { type: 'enum', values: ['light', 'dark', 'system'] },
  sidebarShortcutBehavior: { type: 'enum', values: ['collapse', 'hide'] },
  defaultPanelWidthPx: { type: 'integer', min: 200, max: 2400 },
  customPanelSizes: { type: 'integerArray', min: 120, max: 2400, maxItems: 64 },
  panelCycleWraparound: { type: 'boolean' },
  panelShadowsEnabled: { type: 'boolean' },
  panelCornerRadiusPx: { type: 'integer', min: 0, max: 36 },
  panelSplitterSizePx: { type: 'integer', min: 6, max: 36 },
  autoBackupEnabled: { type: 'boolean' },
  autoBackupIntervalMinutes: { type: 'integer', min: 5, max: 1440 },
  autoBackupMaxCount: { type: 'integer', min: 1, max: 20 },
} as const satisfies Record<keyof EditableSettings, SettingRule>;

export const ADVANCED_PRIVACY_RULES = {
  safeBrowsingEnabled: { type: 'boolean' },
  remoteSafeBrowsingEnabled: { type: 'boolean' },
  resistFingerprinting: { type: 'boolean' },
  letterboxing: { type: 'boolean' },
  networkPrediction: { type: 'boolean' },
  peerConnection: { type: 'boolean' },
  webRTCIPHandlingPolicy: { type: 'enum', values: ['default', 'disable_non_proxied_udp'] },
  httpsOnlyMode: { type: 'enum', values: ['never', 'always'] },
  drmEnabled: { type: 'boolean' },
  diskCacheEnabled: { type: 'boolean' },
  webglEnabled: { type: 'boolean' },
  webgpuEnabled: { type: 'boolean' },
  passwordSavingEnabled: { type: 'boolean' },
  formHistoryEnabled: { type: 'boolean' },
  sanitizeOnShutdown: { type: 'boolean' },
} as const satisfies Record<Exclude<PrivacyAdvancedKey, 'searchSuggestionsEnabled'>, SettingRule>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateValue(rule: SettingRule, value: unknown): boolean {
  switch (rule.type) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return (
        Number.isInteger(value) && (value as number) >= rule.min && (value as number) <= rule.max
      );
    case 'enum':
      return typeof value === 'string' && rule.values.includes(value);
    case 'integerArray':
      return (
        Array.isArray(value) &&
        value.length <= rule.maxItems &&
        value.every(
          (entry) =>
            Number.isInteger(entry) &&
            (entry as number) >= rule.min &&
            (entry as number) <= rule.max,
        )
      );
  }
}

/** A non-empty plain object of editable settings, each inside its bounds. */
export function validateSettingsChanges(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > Object.keys(EDITABLE_SETTING_RULES).length) {
    return false;
  }
  return entries.every(
    ([key, entry]) =>
      Object.hasOwn(EDITABLE_SETTING_RULES, key) &&
      validateValue(EDITABLE_SETTING_RULES[key as keyof typeof EDITABLE_SETTING_RULES], entry),
  );
}

/** Exactly `{key, value}` for one advanced privacy key, the value inside its rule. */
export function validateAdvancedPrivacyChange(value: unknown): boolean {
  if (!isPlainObject(value) || Object.keys(value).length !== 2) return false;
  const { key } = value;
  if (typeof key !== 'string' || !Object.hasOwn(ADVANCED_PRIVACY_RULES, key)) return false;
  return (
    Object.hasOwn(value, 'value') &&
    validateValue(ADVANCED_PRIVACY_RULES[key as keyof typeof ADVANCED_PRIVACY_RULES], value.value)
  );
}
