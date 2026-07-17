import type {
  BentoExportSchema,
  BentoSettings,
  PanelLayoutExport,
  PanelLayoutExportHorizontalGroupNode,
  PanelLayoutExportRootNode,
  PanelLayoutExportVerticalBottomNode,
  PanelLayoutExportVerticalTopNode,
} from './protocol';

export const MAX_BACKUP_FILE_BYTES = 10 * 1024 * 1024;

const MAX_WORKSPACES = 256;
const MAX_TABS_TOTAL = 20_000;
const MAX_TABS_PER_WORKSPACE = 5_000;
const MAX_PANELS_PER_WORKSPACE = 512;
const MAX_PINNED_PANELS_PER_WORKSPACE = 512;
const MAX_SAVED_PANELS = 10_000;
const MAX_LAYOUT_ROOTS = 512;
const MAX_CUSTOM_PANEL_SIZES = 64;
const MAX_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 1_024;
const MAX_TITLE_LENGTH = 4_096;
const MAX_URL_LENGTH = 8_192;
const MAX_VERSION_LENGTH = 128;
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'file:', 'ftp:', 'about:']);

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0);
}

function isFiniteNumber(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && isFiniteNumber(value, min, max);
}

function isSafeUrl(value: unknown): value is string {
  if (!isBoundedString(value, MAX_URL_LENGTH, false)) return false;
  try {
    return ALLOWED_URL_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedString(value, maxLength);
}

function isPanelWidth(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value, 1, 10_000);
}

function isRatio(value: unknown): value is number {
  return isFiniteNumber(value, 0.01, 0.99);
}

function isPanelNode(value: unknown, panelKeys: Set<string>): boolean {
  if (!isRecord(value) || value.kind !== 'panel') return false;
  return isBoundedString(value.panelKey, MAX_ID_LENGTH, false) && panelKeys.has(value.panelKey);
}

function isHorizontalGroup(
  value: unknown,
  panelKeys: Set<string>,
): value is PanelLayoutExportHorizontalGroupNode {
  if (!isRecord(value)) return false;
  if (
    value.kind !== 'group' ||
    value.axis !== 'horizontal' ||
    !isBoundedString(value.id, MAX_ID_LENGTH, false) ||
    !isRatio(value.ratio) ||
    !Array.isArray(value.children) ||
    value.children.length !== 2
  ) {
    return false;
  }
  return value.children.every((child) => isPanelNode(child, panelKeys));
}

function isVerticalTopNode(
  value: unknown,
  panelKeys: Set<string>,
): value is PanelLayoutExportVerticalTopNode {
  return isPanelNode(value, panelKeys) || isHorizontalGroup(value, panelKeys);
}

function isVerticalBottomNode(
  value: unknown,
  panelKeys: Set<string>,
): value is PanelLayoutExportVerticalBottomNode {
  if (isPanelNode(value, panelKeys) || isHorizontalGroup(value, panelKeys)) return true;
  return (
    isRecord(value) &&
    value.kind === 'chooser' &&
    isBoundedString(value.id, MAX_ID_LENGTH, false) &&
    isBoundedString(value.ownerPanelKey, MAX_ID_LENGTH, false) &&
    panelKeys.has(value.ownerPanelKey)
  );
}

function isRootNode(value: unknown, panelKeys: Set<string>): value is PanelLayoutExportRootNode {
  if (isPanelNode(value, panelKeys)) return true;
  if (!isRecord(value)) return false;
  if (
    value.kind !== 'group' ||
    value.axis !== 'vertical' ||
    !isBoundedString(value.id, MAX_ID_LENGTH, false) ||
    !isRatio(value.ratio) ||
    !Array.isArray(value.children) ||
    value.children.length !== 2
  ) {
    return false;
  }
  return (
    isVerticalTopNode(value.children[0], panelKeys) &&
    isVerticalBottomNode(value.children[1], panelKeys)
  );
}

function isPanelLayout(value: unknown, panelKeys: Set<string>): value is PanelLayoutExport {
  if (!isRecord(value) || !Array.isArray(value.root) || value.root.length > MAX_LAYOUT_ROOTS) {
    return false;
  }
  return value.root.every((node) => isRootNode(node, panelKeys));
}

const BOOLEAN_SETTING_KEYS = new Set<keyof BentoSettings>([
  'tabSleepEnabled',
  'commandPaletteEnabled',
  'welcomeSeen',
  'sidebarCollapsed',
  'sidebarHidden',
  'panelCycleWraparound',
  'panelShadowsEnabled',
  'autoBackupEnabled',
]);

const NUMERIC_SETTING_RANGES: Partial<Record<keyof BentoSettings, readonly [number, number]>> = {
  tabSleepAfterMinutes: [1, 1_440],
  tabSleepKeepAlivePerWorkspace: [1, 50],
  defaultPanelWidthPx: [200, 2_400],
  panelCornerRadiusPx: [0, 36],
  panelSplitterSizePx: [6, 36],
  autoBackupIntervalMinutes: [5, 1_440],
  autoBackupMaxCount: [1, 20],
};

const ALL_SETTING_KEYS = new Set<keyof BentoSettings>([
  ...BOOLEAN_SETTING_KEYS,
  ...(Object.keys(NUMERIC_SETTING_RANGES) as Array<keyof BentoSettings>),
  'defaultWorkspaceName',
  'uiColorMode',
  'contentColorMode',
  'sidebarShortcutBehavior',
  'customPanelSizes',
  'privacyProtectionLevel',
  'defaultSearchEngine',
]);

export function isValidBentoSettingsPatch(value: unknown): value is Partial<BentoSettings> {
  if (!isRecord(value)) return false;
  for (const [rawKey, settingValue] of Object.entries(value)) {
    const key = rawKey as keyof BentoSettings;
    if (!ALL_SETTING_KEYS.has(key)) return false;
    if (BOOLEAN_SETTING_KEYS.has(key)) {
      if (typeof settingValue !== 'boolean') return false;
      continue;
    }
    const range = NUMERIC_SETTING_RANGES[key];
    if (range) {
      if (!isInteger(settingValue, range[0], range[1])) return false;
      continue;
    }
    switch (key) {
      case 'defaultWorkspaceName':
        if (!isBoundedString(settingValue, MAX_NAME_LENGTH)) return false;
        break;
      case 'uiColorMode':
        if (settingValue !== 'light' && settingValue !== 'dark' && settingValue !== 'system') {
          return false;
        }
        break;
      case 'contentColorMode':
        if (settingValue !== 'light' && settingValue !== 'dark') return false;
        break;
      case 'sidebarShortcutBehavior':
        if (settingValue !== 'collapse' && settingValue !== 'hide') return false;
        break;
      case 'customPanelSizes':
        if (
          !Array.isArray(settingValue) ||
          settingValue.length > MAX_CUSTOM_PANEL_SIZES ||
          !settingValue.every((size) => isInteger(size, 120, 2_400))
        ) {
          return false;
        }
        break;
      case 'privacyProtectionLevel':
        if (
          settingValue !== 'standard' &&
          settingValue !== 'enhanced' &&
          settingValue !== 'hardened'
        ) {
          return false;
        }
        break;
      case 'defaultSearchEngine':
        if (!isBoundedString(settingValue, MAX_ID_LENGTH, false)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function isLegacySubdivision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.mode !== 'single' && value.mode !== 'dual') return false;
  if (!isRatio(value.topHeightFraction)) return false;
  if (
    !Array.isArray(value.subPanelUrls) ||
    value.subPanelUrls.length > MAX_PANELS_PER_WORKSPACE ||
    !value.subPanelUrls.every(isSafeUrl)
  ) {
    return false;
  }
  return value.splitRatio === undefined || isRatio(value.splitRatio);
}

export function validateExportSchema(raw: unknown): BentoExportSchema | null {
  if (!isRecord(raw)) return null;
  if (raw.schemaVersion !== 1 && raw.schemaVersion !== 2) return null;
  if (!isBoundedString(raw.bentoVersion, MAX_VERSION_LENGTH, false)) return null;
  if (!isFiniteNumber(raw.exportedAt, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!Array.isArray(raw.workspaces) || raw.workspaces.length > MAX_WORKSPACES) return null;

  let totalTabs = 0;
  for (const workspace of raw.workspaces) {
    if (!isRecord(workspace)) return null;
    if (!isBoundedString(workspace.id, MAX_ID_LENGTH, false)) return null;
    if (!isBoundedString(workspace.name, MAX_NAME_LENGTH)) return null;
    if (!isOptionalBoundedString(workspace.themeId, MAX_ID_LENGTH)) return null;
    if (!isOptionalBoundedString(workspace.icon, MAX_ID_LENGTH)) return null;
    if (!isFiniteNumber(workspace.createdAt, 0, Number.MAX_SAFE_INTEGER)) return null;

    if (!Array.isArray(workspace.tabs) || workspace.tabs.length > MAX_TABS_PER_WORKSPACE) {
      return null;
    }
    totalTabs += workspace.tabs.length;
    if (totalTabs > MAX_TABS_TOTAL) return null;
    for (const tab of workspace.tabs) {
      if (!isRecord(tab)) return null;
      if (!isSafeUrl(tab.url)) return null;
      if (!isBoundedString(tab.title, MAX_TITLE_LENGTH)) return null;
      if (!isOptionalBoundedString(tab.customTitle, MAX_TITLE_LENGTH)) return null;
      if (typeof tab.pinned !== 'boolean') return null;
    }

    if (!Array.isArray(workspace.panels) || workspace.panels.length > MAX_PANELS_PER_WORKSPACE) {
      return null;
    }
    const panelKeys = new Set<string>();
    for (const panel of workspace.panels) {
      if (!isRecord(panel) || !isSafeUrl(panel.url) || !isPanelWidth(panel.widthPx)) return null;
      if (panel.panelKey !== undefined) {
        if (!isBoundedString(panel.panelKey, MAX_ID_LENGTH, false)) return null;
        if (panelKeys.has(panel.panelKey)) return null;
        panelKeys.add(panel.panelKey);
      }
      if (panel.subdivision !== undefined && !isLegacySubdivision(panel.subdivision)) return null;
    }

    if (workspace.mainWidthPx !== undefined) {
      if (raw.schemaVersion !== 2 || !isFiniteNumber(workspace.mainWidthPx, 1, 10_000)) return null;
    }
    if (workspace.stripScrollLeft !== undefined) {
      if (raw.schemaVersion !== 2 || !isFiniteNumber(workspace.stripScrollLeft, 0, 1_000_000)) {
        return null;
      }
    }
    if (workspace.panelLayout !== undefined) {
      if (raw.schemaVersion !== 2 || !isPanelLayout(workspace.panelLayout, panelKeys)) return null;
    }

    if (
      !Array.isArray(workspace.pinnedPanels) ||
      workspace.pinnedPanels.length > MAX_PINNED_PANELS_PER_WORKSPACE
    ) {
      return null;
    }
    for (const pinned of workspace.pinnedPanels) {
      if (!isRecord(pinned)) return null;
      if (pinned.url !== undefined && !isSafeUrl(pinned.url)) return null;
      if (
        pinned.panelKey !== undefined &&
        (!isBoundedString(pinned.panelKey, MAX_ID_LENGTH, false) ||
          (raw.schemaVersion === 2 && !panelKeys.has(pinned.panelKey)))
      ) {
        return null;
      }
      if (pinned.url === undefined && pinned.panelKey === undefined) return null;
      if (!isInteger(pinned.order, 0, MAX_PINNED_PANELS_PER_WORKSPACE)) return null;
      if (!isPanelWidth(pinned.widthPx)) return null;
    }
  }

  if (raw.settings !== undefined && !isValidBentoSettingsPatch(raw.settings)) return null;
  if (!Array.isArray(raw.savedPanels) || raw.savedPanels.length > MAX_SAVED_PANELS) return null;
  for (const savedPanel of raw.savedPanels) {
    if (!isRecord(savedPanel)) return null;
    if (!isBoundedString(savedPanel.title, MAX_TITLE_LENGTH)) return null;
    if (!isSafeUrl(savedPanel.url)) return null;
  }

  return raw as unknown as BentoExportSchema;
}
