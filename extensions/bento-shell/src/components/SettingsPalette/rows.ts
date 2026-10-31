// Rows of every Settings palette stage, as data. The component renders them and runs their
// `intent`; keeping both out of React makes the stage contents and the search testable.

import { SETTINGS_CATEGORIES, categoryForRow, categoryLabel, categoryStage } from './categories';
import { PRIVACY_LEVEL_DETAILS } from '@shared/privacy-levels';
import type { PrivacyAdvancedKey } from '@shared/protocol';
import type { BackupListEntry } from '@shared/protocol';
import {
  ADVANCED_PRIVACY_SPECS,
  BOOLEAN_SPECS,
  COLOR_MODE_OPTIONS,
  ENUM_SPECS,
  HTTPS_OPTIONS,
  SHORTCUT_BEHAVIOR_OPTIONS,
  WEBRTC_OPTIONS,
  NUMBER_SPECS,
  PANEL_SIZE_EDITOR,
  PANEL_SIZE_LIMITS,
  SHORTCUTS,
  advancedValue,
  formatNumber,
  presetMarker,
  presetValues,
  type BooleanSettingKey,
  type EditorSpec,
  type EnumKey,
  type NumberSettingKey,
  usesSlider,
} from './settingsCatalog';
import {
  ADVANCED_DESCRIPTIONS,
  BACKUP_ROW_DESCRIPTIONS,
  CONFIRM_DESCRIPTIONS,
  CUSTOM_PROTECTION_DESCRIPTION,
  ENUM_DESCRIPTIONS,
  ENUM_OPTION_DESCRIPTIONS,
  NUMBER_DESCRIPTIONS,
  SIZE_ACTION_DESCRIPTIONS,
  STAGE_DESCRIPTIONS,
} from './settingsCopy';
import { isEditorStage, type ConfirmAction, type Stage } from './stageStack';
import type { EditableSettings } from './model';
import type { SelectablePrivacyLevel, SettingsPaletteModel, SettingsPaletteView } from './types';

export type Intent =
  | { type: 'toggle'; key: BooleanSettingKey }
  | { type: 'toggleAdvanced'; key: PrivacyAdvancedKey; current: boolean }
  | { type: 'push'; stage: Stage }
  | { type: 'change'; changes: Partial<EditableSettings> }
  | { type: 'advanced'; key: PrivacyAdvancedKey; value: boolean | string }
  | { type: 'setProtection'; level: SelectablePrivacyLevel }
  | { type: 'setSearch'; id: string }
  | { type: 'applyNumber'; value: number }
  | { type: 'link'; target: 'firefoxSearch' | 'mergePalette' }
  | { type: 'addSize' }
  | { type: 'moveSize'; index: number; delta: -1 | 1 }
  | { type: 'removeSize'; index: number }
  | { type: 'export' }
  | { type: 'pickFile' }
  | { type: 'confirmImport' }
  | { type: 'cancelImport' }
  | { type: 'confirm'; action: ConfirmAction }
  | { type: 'back' }
  | { type: 'retry' }
  | { type: 'none' };

export interface ProtectionDetail {
  benefits: readonly string[];
  caveats: readonly string[];
}

export interface PaletteRow {
  id: string;
  group: string;
  label: string;
  /** Current value, right-aligned and muted. */
  value?: string;
  /** A short remark right after the label: `Current` on a choice, `Min`, `Default` or `Max` on a
   * preset. */
  note?: string;
  /** A switch row: what its switch shows, which is the new state at once while a write is in
   * flight. The row stays the control; `value` keeps On or Off for the row's text value. */
  switchOn?: boolean;
  /** A second line under the label, always visible: what the option does when that differs
   * between its siblings. Part of the row's accessible description, not its name. */
  description?: string;
  /** What the row does: `›` opens a stage, `↗` leaves Bento, `+` adds. */
  trail?: '›' | '↗' | '+';
  radio?: 'on' | 'off';
  engine?: { name: string };
  tone?: 'danger' | 'muted' | 'warning';
  /** Shown but never selectable: headings of a block, explanations, read-only values. */
  info?: boolean;
  /** Drawn under a rule, setting the row apart from the ones above. */
  separated?: boolean;
  /** Shown only while the row is focused: the protection levels' benefits and caveats, below
   * the row's `description`. */
  detail?: ProtectionDetail;
  pending?: boolean;
  keywords: readonly string[];
  intent: Intent;
}

export interface RowContext {
  model: SettingsPaletteModel;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `22 Oct 2026, 14:30` in local time, 24-hour, independent of the locale's month names. */
export function formatBackupDate(timestamp: number): string {
  const date = new Date(timestamp);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function onOff(value: boolean): string {
  return value ? 'On' : 'Off';
}

function enumLabel(key: EnumKey, value: string): string {
  return ENUM_SPECS[key].options.find((option) => option.value === value)?.label ?? value;
}

function settingPending(model: SettingsPaletteModel, key: string): boolean {
  return model.pending.has(key);
}

// ---- Root ----

const NO_KEYWORDS: readonly string[] = [];

/** What a switch shows: the state its write in flight asked for, else the stored one. The
 * target is what was asked for, not the opposite of the latest stored value, so a change notice
 * that stores the new value before the reply does not flip the switch back; a write that
 * fails drops its target and leaves the stored state. */
function switchState(stored: boolean, pending: boolean, target: boolean | undefined): boolean {
  return pending && target !== undefined ? target : stored;
}

/** What assistive technology reads as a row's name. A switch row names its state, "Sleep idle
 * tabs, On" (the switch itself is hidden from it), and follows the state the switch shows. A
 * row with a `description` is named by its own label, note and value, so the description is
 * read as its description and not twice. Any other row is named by its content. */
export function rowAriaLabel(row: PaletteRow): string | undefined {
  if (row.switchOn !== undefined) return `${row.label}, ${onOff(row.switchOn)}`;
  if (row.description === undefined) return undefined;
  return [row.label, row.note, row.value].filter(Boolean).join(', ');
}

function toggleRow(model: SettingsPaletteModel, group: string, key: BooleanSettingKey): PaletteRow {
  const spec = BOOLEAN_SPECS[key];
  const pending = settingPending(model, key);
  return {
    id: `setting:${key}`,
    group,
    label: spec.label,
    value: onOff(model.settings[key]),
    switchOn: switchState(model.settings[key], pending, model.pendingTargets.get(key)),
    pending,
    keywords: spec.keywords,
    intent: { type: 'toggle', key },
  };
}

function numberRow(model: SettingsPaletteModel, group: string, key: NumberSettingKey): PaletteRow {
  const spec = NUMBER_SPECS[key];
  return {
    id: `setting:${key}`,
    group,
    label: spec.label,
    value: formatNumber(spec, model.settings[key]),
    trail: '›',
    pending: settingPending(model, key),
    keywords: spec.keywords,
    intent: { type: 'push', stage: { kind: 'number', key } },
  };
}

function enumRow(
  model: SettingsPaletteModel,
  group: string,
  key: 'uiColorMode' | 'sidebarShortcutBehavior',
): PaletteRow {
  const spec = ENUM_SPECS[key];
  return {
    id: `setting:${key}`,
    group,
    label: spec.label,
    value: enumLabel(key, model.settings[key]),
    trail: '›',
    pending: settingPending(model, key),
    keywords: spec.keywords,
    intent: { type: 'push', stage: { kind: 'enum', key } },
  };
}

export function advancedRows(
  model: SettingsPaletteModel,
  group = 'Advanced privacy',
): PaletteRow[] {
  const privacy = model.privacy;
  if (!privacy) return [];
  return ADVANCED_PRIVACY_SPECS.map((spec): PaletteRow => {
    const value = advancedValue(privacy, spec.key);
    const pending = settingPending(model, `advanced:${spec.key}`);
    if (spec.enumKey) {
      return {
        id: `advanced:${spec.key}`,
        group,
        label: spec.label,
        description: ADVANCED_DESCRIPTIONS[spec.key],
        value: enumLabel(spec.enumKey, String(value)),
        trail: '›',
        pending,
        keywords: ['advanced privacy', ...spec.keywords],
        intent: { type: 'push', stage: { kind: 'enum', key: spec.enumKey } },
      };
    }
    return {
      id: `advanced:${spec.key}`,
      group,
      label: spec.label,
      description: ADVANCED_DESCRIPTIONS[spec.key],
      value: onOff(value === true),
      switchOn: switchState(
        value === true,
        pending,
        model.pendingTargets.get(`advanced:${spec.key}`),
      ),
      pending,
      keywords: ['advanced privacy', ...spec.keywords],
      intent: { type: 'toggleAdvanced', key: spec.key, current: value === true },
    };
  });
}

export function shortcutRows(group = 'Keyboard shortcuts'): PaletteRow[] {
  return SHORTCUTS.map((shortcut, index) => ({
    id: `shortcut:${index}`,
    group,
    label: shortcut.label,
    value: shortcut.keys,
    info: true,
    keywords: ['shortcut', 'keyboard'],
    intent: { type: 'none' },
  }));
}

function protectionLabel(model: SettingsPaletteModel): string {
  const level = model.privacy?.protectionLevel;
  if (!level) return '';
  return level === 'custom' ? 'Custom' : PRIVACY_LEVEL_DETAILS[level].label;
}

function searchLabel(model: SettingsPaletteModel): string {
  const search = model.search;
  if (!search) return '';
  return (
    search.availableSearchEngines.find((engine) => engine.id === search.defaultSearchEngine)
      ?.name ?? search.defaultSearchEngine
  );
}

export function controlRows(model: SettingsPaletteModel): PaletteRow[] {
  const rows: PaletteRow[] = [
    enumRow(model, 'Appearance', 'uiColorMode'),
    toggleRow(model, 'Tab appearance', 'tabStateTintsEnabled'),
    toggleRow(model, 'Tab appearance', 'customTabStateIconsEnabled'),
    toggleRow(model, 'Performance', 'tabSleepEnabled'),
    numberRow(model, 'Performance', 'tabSleepAfterMinutes'),
    numberRow(model, 'Performance', 'tabSleepKeepAlivePerWorkspace'),
    enumRow(model, 'Workspaces', 'sidebarShortcutBehavior'),
    numberRow(model, 'Panels', 'defaultPanelWidthPx'),
    toggleRow(model, 'Panels', 'panelCycleWraparound'),
    toggleRow(model, 'Panels', 'panelShadowsEnabled'),
    numberRow(model, 'Panels', 'panelCornerRadiusPx'),
    numberRow(model, 'Panels', 'panelSplitterSizePx'),
    {
      id: 'setting:customPanelSizes',
      group: 'Panels',
      label: 'Custom panel sizes',
      value: model.settings.customPanelSizes.join(', '),
      trail: '›',
      pending: settingPending(model, 'customPanelSizes'),
      keywords: ['panel', 'presets', 'widths', 'menu'],
      intent: { type: 'push', stage: { kind: 'sizes' } },
    },
  ];
  if (model.privacy && model.search) {
    rows.push(
      {
        id: 'privacy:level',
        group: 'Privacy and search',
        label: 'Protection level',
        value: protectionLabel(model),
        trail: '›',
        pending: settingPending(model, 'protection'),
        keywords: ['privacy', 'standard', 'enhanced', 'hardened', 'tracking', 'security'],
        intent: { type: 'push', stage: { kind: 'protection' } },
      },
      {
        id: 'privacy:search',
        group: 'Privacy and search',
        label: 'Default search engine',
        value: searchLabel(model),
        trail: '›',
        pending: settingPending(model, 'search'),
        keywords: ['search', 'engine', 'duckduckgo', 'google'],
        intent: { type: 'push', stage: { kind: 'search' } },
      },
      {
        id: 'privacy:manage-search',
        group: 'Privacy and search',
        label: 'Manage search engines',
        value: 'Firefox settings',
        trail: '↗',
        keywords: ['search', 'engines', 'add', 'remove', 'custom'],
        intent: { type: 'link', target: 'firefoxSearch' },
      },
      {
        id: 'privacy:advanced',
        group: 'Privacy and search',
        label: 'Advanced privacy',
        value: plural(ADVANCED_PRIVACY_SPECS.length, 'setting'),
        trail: '›',
        keywords: ['privacy', 'fingerprinting', 'webrtc', 'https', 'cookies'],
        intent: { type: 'push', stage: { kind: 'advanced' } },
      },
    );
  }
  if (!model.isPrivate) {
    rows.push(
      toggleRow(model, 'Backup and data', 'autoBackupEnabled'),
      numberRow(model, 'Backup and data', 'autoBackupIntervalMinutes'),
      numberRow(model, 'Backup and data', 'autoBackupMaxCount'),
      {
        id: 'backup:open',
        group: 'Backup and data',
        label: 'Export, import and stored backups',
        value: model.backup ? plural(model.backup.backups.length, 'stored backup') : undefined,
        trail: '›',
        keywords: ['backup', 'export', 'import', 'restore', 'data'],
        intent: { type: 'push', stage: { kind: 'backups' } },
      },
      {
        id: 'backup:merge',
        group: 'Backup and data',
        label: 'Merge browser session',
        trail: '↗',
        keywords: ['import', 'session', 'chrome', 'firefox', 'tabs'],
        intent: { type: 'link', target: 'mergePalette' },
      },
    );
  }
  rows.push({
    id: 'shortcuts:open',
    group: 'Keyboard shortcuts',
    label: 'View keyboard shortcuts',
    value: String(SHORTCUTS.length),
    trail: '›',
    keywords: ['shortcuts', 'keys', 'hotkeys'],
    intent: { type: 'push', stage: { kind: 'shortcuts' } },
  });
  // Tools refuses a reset from a private window: it rewrites the whole profile.
  if (!model.isPrivate) {
    rows.push({
      id: 'reset:open',
      group: 'Reset Bento',
      label: 'Reset Bento settings…',
      tone: 'danger',
      keywords: ['defaults', 'restore', 'welcome', 'onboarding'],
      intent: { type: 'push', stage: { kind: 'confirm', action: { kind: 'reset' } } },
    });
  }
  return rows;
}

/** The unfiltered root contains only visible categories, in their established order. */
export function rootRows(model: SettingsPaletteModel): PaletteRow[] {
  const visible = new Set(controlRows(model).map((row) => categoryForRow(row.id)));
  return SETTINGS_CATEGORIES.filter(({ id }) => visible.has(id)).map((category) => ({
    id: `category:${category.id}`,
    group: category.label,
    label: category.label,
    description: category.description,
    trail: '›',
    keywords: NO_KEYWORDS,
    intent: { type: 'push', stage: categoryStage(category.id) },
  }));
}

/** Everything the root search can reach: the flat controls, the advanced privacy rows and the
 * shortcuts. The results stay one line each: the advanced rows lose their description. */
export function searchableRows(model: SettingsPaletteModel): PaletteRow[] {
  return [
    ...controlRows(model),
    ...(model.privacy && model.search ? advancedRows(model) : []).map((row) => ({
      ...row,
      description: undefined,
    })),
    ...shortcutRows().map((row) => ({ ...row, info: false, intent: pushShortcuts })),
  ];
}

const pushShortcuts: Intent = { type: 'push', stage: { kind: 'shortcuts' } };

/** Rows whose label, group, value or keywords contain every word of the query. */
export function filterRows(rows: readonly PaletteRow[], query: string): PaletteRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const haystack = [row.label, row.group, row.value ?? '', ...row.keywords]
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

// ---- Stages ----

/** The number editor a stage shows, or null for a stage that is not one. */
export function editorSpecFor(stage: Stage): EditorSpec | null {
  if (stage.kind === 'number') return NUMBER_SPECS[stage.key];
  if (stage.kind === 'sizeEdit') return PANEL_SIZE_EDITOR;
  return null;
}

/** The slider a stage shows, or null when it is a field with presets or not an editor. */
export function sliderSpecFor(stage: Stage): EditorSpec | null {
  const spec = editorSpecFor(stage);
  return spec && usesSlider(spec) ? spec : null;
}

/** A slider page lists nothing: the slider holds the focus and the keys. */
function numberStageRows(spec: EditorSpec): PaletteRow[] {
  if (usesSlider(spec)) return [];
  return presetValues(spec).map((value) => ({
    id: `preset:${value}`,
    group: 'Presets',
    label: formatNumber(spec, value),
    note: presetMarker(spec, value),
    keywords: NO_KEYWORDS,
    intent: { type: 'applyNumber', value },
  }));
}

function enumStageRows(model: SettingsPaletteModel, key: EnumKey): PaletteRow[] {
  const choose = (
    options: readonly { value: string; label: string }[],
    current: string,
    intentOf: (value: string) => Intent,
  ): PaletteRow[] =>
    options.map((option) => ({
      id: `option:${option.value}`,
      group: ENUM_SPECS[key].label,
      label: option.label,
      description: ENUM_OPTION_DESCRIPTIONS[key][option.value],
      note: option.value === current ? 'Current' : undefined,
      radio: option.value === current ? 'on' : 'off',
      keywords: NO_KEYWORDS,
      intent: intentOf(option.value),
    }));
  switch (key) {
    case 'uiColorMode':
      return COLOR_MODE_OPTIONS.map((option) => ({
        id: `option:${option.value}`,
        group: ENUM_SPECS[key].label,
        label: option.label,
        description: ENUM_OPTION_DESCRIPTIONS[key][option.value],
        note: option.value === model.settings.uiColorMode ? 'Current' : undefined,
        radio: option.value === model.settings.uiColorMode ? 'on' : 'off',
        keywords: NO_KEYWORDS,
        intent: { type: 'change', changes: { uiColorMode: option.value } },
      }));
    case 'sidebarShortcutBehavior':
      return SHORTCUT_BEHAVIOR_OPTIONS.map((option) => ({
        id: `option:${option.value}`,
        group: ENUM_SPECS[key].label,
        label: option.label,
        description: ENUM_OPTION_DESCRIPTIONS[key][option.value],
        note: option.value === model.settings.sidebarShortcutBehavior ? 'Current' : undefined,
        radio: option.value === model.settings.sidebarShortcutBehavior ? 'on' : 'off',
        keywords: NO_KEYWORDS,
        intent: { type: 'change', changes: { sidebarShortcutBehavior: option.value } },
      }));
    case 'webRTCIPHandlingPolicy':
      return choose(WEBRTC_OPTIONS, model.privacy?.webRTCIPHandlingPolicy ?? '', (value) => ({
        type: 'advanced',
        key,
        value,
      }));
    case 'httpsOnlyMode':
      return choose(HTTPS_OPTIONS, model.privacy?.httpsOnlyMode ?? '', (value) => ({
        type: 'advanced',
        key,
        value,
      }));
  }
}

function protectionStageRows(model: SettingsPaletteModel): PaletteRow[] {
  const current = model.privacy?.protectionLevel;
  const rows: PaletteRow[] = (['standard', 'enhanced', 'hardened'] as const).map((level) => {
    const details = PRIVACY_LEVEL_DETAILS[level];
    return {
      id: `level:${level}`,
      group: 'Protection level',
      label: details.label,
      description: details.summary,
      note: current === level ? 'Current' : undefined,
      radio: current === level ? 'on' : 'off',
      detail: {
        benefits: details.benefits,
        caveats: details.caveats,
      },
      keywords: NO_KEYWORDS,
      intent: { type: 'setProtection', level },
    };
  });
  rows.push({
    id: 'level:custom',
    group: 'Protection level',
    label: 'Custom',
    description: CUSTOM_PROTECTION_DESCRIPTION,
    note: current === 'custom' ? 'Current' : 'Detected only',
    radio: current === 'custom' ? 'on' : 'off',
    tone: 'muted',
    info: true,
    keywords: NO_KEYWORDS,
    intent: { type: 'none' },
  });
  return rows;
}

function searchStageRows(model: SettingsPaletteModel): PaletteRow[] {
  const search = model.search;
  const rows: PaletteRow[] = (search?.availableSearchEngines ?? []).map((engine) => ({
    id: `engine:${engine.id}`,
    group: 'Default search engine',
    label: engine.name,
    note: engine.id === search?.defaultSearchEngine ? 'Current' : undefined,
    radio: engine.id === search?.defaultSearchEngine ? 'on' : 'off',
    engine: { name: engine.name },
    keywords: NO_KEYWORDS,
    intent: { type: 'setSearch', id: engine.id },
  }));
  rows.push({
    id: 'engine:manage',
    group: 'Default search engine',
    label: 'Manage search engines',
    value: 'Firefox settings',
    trail: '↗',
    separated: true,
    keywords: NO_KEYWORDS,
    intent: { type: 'link', target: 'firefoxSearch' },
  });
  return rows;
}

function sizesStageRows(model: SettingsPaletteModel): PaletteRow[] {
  const sizes = model.settings.customPanelSizes;
  const atLimit = sizes.length >= PANEL_SIZE_LIMITS.maxItems;
  const rows: PaletteRow[] = sizes.map((size, index) => ({
    id: `size:${index}`,
    group: 'Custom panel sizes',
    label: `${size} px`,
    trail: '›',
    keywords: NO_KEYWORDS,
    intent: { type: 'push', stage: { kind: 'sizeActions', index } },
  }));
  const next = Math.min(
    PANEL_SIZE_LIMITS.max,
    Math.max(PANEL_SIZE_LIMITS.min, model.settings.defaultPanelWidthPx),
  );
  rows.push({
    id: 'size:add',
    group: 'Custom panel sizes',
    label: 'Add size',
    value: atLimit ? 'Limit reached' : `${next} px`,
    trail: '+',
    separated: true,
    info: atLimit,
    keywords: NO_KEYWORDS,
    intent: atLimit ? { type: 'none' } : { type: 'addSize' },
  });
  return rows;
}

function sizeActionRows(model: SettingsPaletteModel, index: number): PaletteRow[] {
  const sizes = model.settings.customPanelSizes;
  const group = `${sizes[index] ?? ''} px`;
  const rows: PaletteRow[] = [
    {
      id: 'size-action:edit',
      group,
      label: 'Edit size',
      description: SIZE_ACTION_DESCRIPTIONS.edit,
      value: `${PANEL_SIZE_LIMITS.min} to ${PANEL_SIZE_LIMITS.max}`,
      trail: '›',
      keywords: NO_KEYWORDS,
      intent: { type: 'push', stage: { kind: 'sizeEdit', index } },
    },
  ];
  if (index > 0) {
    rows.push({
      id: 'size-action:up',
      group,
      label: 'Move up',
      description: SIZE_ACTION_DESCRIPTIONS.move,
      value: `To position ${index}`,
      keywords: NO_KEYWORDS,
      intent: { type: 'moveSize', index, delta: -1 },
    });
  }
  if (index < sizes.length - 1) {
    rows.push({
      id: 'size-action:down',
      group,
      label: 'Move down',
      description: SIZE_ACTION_DESCRIPTIONS.move,
      value: `To position ${index + 2}`,
      keywords: NO_KEYWORDS,
      intent: { type: 'moveSize', index, delta: 1 },
    });
  }
  rows.push({
    id: 'size-action:remove',
    group,
    label: 'Remove',
    description: SIZE_ACTION_DESCRIPTIONS.remove,
    tone: 'danger',
    keywords: NO_KEYWORDS,
    intent: { type: 'removeSize', index },
  });
  return rows;
}

function backupRows(model: SettingsPaletteModel): PaletteRow[] {
  const rows: PaletteRow[] = [];
  const preview = model.importPreview;
  if (preview) {
    const group = 'Import Bento data?';
    const totals = preview.preview.totals;
    const info = (id: string, label: string, value: string): PaletteRow => ({
      id: `import:${id}`,
      group,
      label,
      value,
      info: true,
      keywords: NO_KEYWORDS,
      intent: { type: 'none' },
    });
    rows.push(
      info('file', 'File', preview.fileName),
      info('workspaces', 'Workspaces', String(totals.workspaceCount)),
      info('tabs', 'Tabs', String(totals.normalTabCount)),
    );
    if (preview.preview.hasSettings) rows.push(info('settings', 'Settings', 'Included'));
    if (preview.preview.savedPanelCount > 0) {
      rows.push(info('saved', 'Saved panels', String(preview.preview.savedPanelCount)));
    }
    rows.push(
      {
        id: 'import:confirm',
        group,
        label: `Import ${plural(totals.workspaceCount, 'workspace')} and ${plural(totals.normalTabCount, 'tab')}`,
        pending: model.pending.has('backup'),
        keywords: NO_KEYWORDS,
        intent: { type: 'confirmImport' },
      },
      {
        id: 'import:cancel',
        group,
        label: 'Cancel',
        keywords: NO_KEYWORDS,
        intent: { type: 'cancelImport' },
      },
    );
  } else {
    const group = 'Export and import';
    const workspaces = model.backup?.workspaces.length ?? 0;
    rows.push(
      {
        id: 'backup:export',
        group,
        label: 'Export Bento data',
        description: BACKUP_ROW_DESCRIPTIONS.export,
        value: plural(workspaces, 'workspace'),
        pending: model.pending.has('backup'),
        keywords: ['download', 'save', 'file'],
        intent: { type: 'export' },
      },
      {
        id: 'backup:import',
        group,
        label: 'Import Bento data',
        description: BACKUP_ROW_DESCRIPTIONS.import,
        value: 'Choose a file',
        keywords: ['upload', 'open', 'file', 'json'],
        intent: { type: 'pickFile' },
      },
      {
        id: 'backup:merge',
        group,
        label: 'Merge browser session',
        description: BACKUP_ROW_DESCRIPTIONS.merge,
        trail: '↗',
        keywords: NO_KEYWORDS,
        intent: { type: 'link', target: 'mergePalette' },
      },
    );
  }
  rows.push(...storedBackupRows(model.backup?.backups ?? []));
  return rows;
}

function storedBackupRows(backups: readonly BackupListEntry[]): PaletteRow[] {
  const group = 'Stored backups';
  if (backups.length === 0) {
    return [
      {
        id: 'stored:empty',
        group,
        label: 'No stored backups yet.',
        info: true,
        tone: 'muted',
        keywords: NO_KEYWORDS,
        intent: { type: 'none' },
      },
    ];
  }
  return backups.flatMap((backup): PaletteRow[] => {
    const label = formatBackupDate(backup.createdAt);
    const row: PaletteRow = {
      id: `stored:${backup.id}`,
      group,
      label,
      value: `${plural(backup.workspaceCount, 'workspace')}, ${plural(backup.tabCount, 'tab')}`,
      trail: '›',
      keywords: NO_KEYWORDS,
      intent: { type: 'push', stage: { kind: 'backupRow', backupId: backup.id, label } },
    };
    if (backup.privacySafety !== 'legacy-unknown') return [row];
    return [
      row,
      {
        id: `stored:${backup.id}:legacy`,
        group,
        label: 'This backup predates private-data filtering. Its privacy safety is unknown.',
        info: true,
        tone: 'warning',
        keywords: NO_KEYWORDS,
        intent: { type: 'none' },
      },
    ];
  });
}

function backupRowStageRows(backupId: string, label: string): PaletteRow[] {
  return [
    {
      id: 'stored-action:restore',
      group: label,
      label: 'Restore…',
      description: BACKUP_ROW_DESCRIPTIONS.restore,
      keywords: NO_KEYWORDS,
      intent: {
        type: 'push',
        stage: { kind: 'confirm', action: { kind: 'restore', backupId, label } },
      },
    },
    {
      id: 'stored-action:delete',
      group: label,
      label: 'Delete…',
      description: BACKUP_ROW_DESCRIPTIONS.delete,
      tone: 'danger',
      keywords: NO_KEYWORDS,
      intent: {
        type: 'push',
        stage: { kind: 'confirm', action: { kind: 'delete', backupId, label } },
      },
    },
  ];
}

export interface ConfirmCopy {
  title: string;
  confirmLabel: string;
  danger: boolean;
}

export function confirmCopy(action: ConfirmAction): ConfirmCopy {
  switch (action.kind) {
    case 'reset':
      return { title: 'Reset Bento settings?', confirmLabel: 'Reset Bento settings', danger: true };
    case 'restore':
      return { title: 'Restore this backup?', confirmLabel: 'Restore backup', danger: false };
    case 'delete':
      return { title: 'Delete this backup?', confirmLabel: 'Delete backup', danger: true };
  }
}

/** The actions of a confirmation; what it does is the page description above the list. */
function confirmStageRows(action: ConfirmAction, busy: boolean): PaletteRow[] {
  const copy = confirmCopy(action);
  const group = copy.title;
  return [
    {
      id: 'confirm:cancel',
      group,
      label: 'Cancel',
      keywords: NO_KEYWORDS,
      intent: { type: 'back' },
    },
    {
      id: 'confirm:run',
      group,
      label: copy.confirmLabel,
      tone: copy.danger ? 'danger' : undefined,
      pending: busy,
      keywords: NO_KEYWORDS,
      intent: { type: 'confirm', action },
    },
  ];
}

/** Rows of a list stage (the root and the filterable lists apply the query on top). */
export function rowsForStage(stage: Stage, model: SettingsPaletteModel): PaletteRow[] {
  switch (stage.kind) {
    case 'root':
      return rootRows(model);
    case 'category':
      return controlRows(model).filter((row) => categoryForRow(row.id) === stage.id);
    case 'number':
      return numberStageRows(NUMBER_SPECS[stage.key]);
    case 'sizeEdit':
      return numberStageRows(PANEL_SIZE_EDITOR);
    case 'enum':
      return enumStageRows(model, stage.key);
    case 'protection':
      return protectionStageRows(model);
    case 'search':
      return searchStageRows(model);
    case 'sizes':
      return sizesStageRows(model);
    case 'sizeActions':
      return sizeActionRows(model, stage.index);
    case 'advanced':
      return advancedRows(model);
    case 'shortcuts':
      return shortcutRows();
    case 'backups':
      return backupRows(model);
    case 'backupRow':
      return backupRowStageRows(stage.backupId, stage.label);
    case 'confirm':
      return confirmStageRows(
        stage.action,
        model.pending.has(stage.action.kind === 'reset' ? 'reset' : 'backup'),
      );
  }
}

/** A list this short is read at a glance: its field row is dropped. */
const MAX_ROWS_WITHOUT_FIELD = 4;

/** Whether the stage shows its field row. The root, an editor (the field holds the value), any
 * list of more than four rows and any list with a filter typed do; a shorter list keeps the
 * field only as the keyboard's hidden focus holder. `listRowCount` is the stage's rows before
 * the filter, so a list that shrinks while a filter is active (a model update) keeps the field
 * and its Clear button in view until the filter is cleared. */
export function showsFieldRow(stage: Stage, listRowCount: number, query = ''): boolean {
  return (
    stage.kind === 'root' ||
    isEditorStage(stage) ||
    listRowCount > MAX_ROWS_WITHOUT_FIELD ||
    query !== ''
  );
}

/** Whether typing in the stage's field narrows its rows. */
export function isFilterable(stage: Stage): boolean {
  return (
    stage.kind === 'root' ||
    stage.kind === 'category' ||
    stage.kind === 'advanced' ||
    stage.kind === 'shortcuts' ||
    stage.kind === 'search' ||
    stage.kind === 'enum'
  );
}

/** What a page is for, shown under the path where a value or option changes; null on the root
 * and the shortcuts, which change nothing. */
export function pageDescription(stage: Stage): string | null {
  switch (stage.kind) {
    case 'root':
    case 'category':
    case 'shortcuts':
      return null;
    case 'number':
      return NUMBER_DESCRIPTIONS[stage.key];
    case 'enum':
      return ENUM_DESCRIPTIONS[stage.key];
    case 'confirm':
      return CONFIRM_DESCRIPTIONS[stage.action.kind];
    default:
      return STAGE_DESCRIPTIONS[stage.kind];
  }
}

export interface FooterCopy {
  /** A standing notice, shown first and in full contrast. */
  note?: string;
  hints: readonly string[];
  /** Right-aligned status. */
  status?: string;
}

/** The Esc hint, which says what Esc will do in the state the palette is in. */
function escHint(stage: Stage, model: SettingsPaletteModel, query: string): string {
  if (isEditorStage(stage)) return 'Esc cancel';
  if (query !== '') return 'Esc clear';
  if (stage.kind === 'backups' && model.importPreview) return 'Esc cancel import';
  return stage.kind === 'root' ? 'Esc close' : 'Esc back';
}

/** The footer of a stage. `query` is the text in its field when the field is a filter. */
export function footerFor(
  stage: Stage,
  model: SettingsPaletteModel,
  rowCount: number,
  query = '',
): FooterCopy {
  const move = '↑↓ move';
  const esc = escHint(stage, model, query);
  switch (stage.kind) {
    case 'root':
      return {
        note: model.isPrivate ? 'Backup management is unavailable in private windows.' : undefined,
        hints: [move, query ? 'Enter open or toggle' : 'Enter open', esc],
        status: query
          ? plural(rowCount, 'result')
          : `${rowCount} categor${rowCount === 1 ? 'y' : 'ies'}`,
      };
    case 'category': {
      const controls = rowsForStage(stage, model);
      const action = controls.every((row) => row.intent.type === 'toggle')
        ? 'Enter toggle'
        : controls.every((row) => row.intent.type === 'push' || row.intent.type === 'link')
          ? 'Enter open'
          : 'Enter open or toggle';
      return { hints: [move, action, esc] };
    }
    case 'number':
    case 'sizeEdit':
      return {
        hints: sliderSpecFor(stage)
          ? ['←→ adjust', 'Home End min max', 'Enter keep', esc]
          : ['Type a value', '↑↓ presets', 'Enter keep', esc],
        status: 'Live preview',
      };
    case 'enum':
    case 'protection':
      return { hints: [move, 'Enter apply', esc] };
    case 'search':
      return { hints: [move, 'Enter apply or open', esc] };
    case 'sizes':
      return {
        hints: [move, 'Enter row actions', esc],
        status: `${model.settings.customPanelSizes.length} of ${PANEL_SIZE_LIMITS.maxItems} sizes`,
      };
    case 'sizeActions':
      return {
        hints: [move, 'Enter run', esc],
        status: `Size ${stage.index + 1} of ${model.settings.customPanelSizes.length}`,
      };
    case 'advanced':
      return {
        hints: [move, 'Enter toggle, or open enum', esc],
        status: plural(rowCount, 'setting'),
      };
    case 'shortcuts':
      // The rows are static: nothing moves, so there is no arrow hint.
      return { hints: [esc], status: plural(rowCount, 'shortcut') };
    case 'backups':
      return { hints: [move, 'Enter run or open row', esc] };
    case 'backupRow':
      return { hints: [move, 'Enter run', esc] };
    case 'confirm':
      return { hints: [move, 'Enter confirm', esc] };
  }
}

/** The label a stage contributes to the path in the search field. */
export function stageLabel(stage: Stage, model: SettingsPaletteModel): string {
  switch (stage.kind) {
    case 'root':
      return 'Settings';
    case 'category':
      return categoryLabel(stage.id);
    case 'number':
      return NUMBER_SPECS[stage.key].label;
    case 'enum':
      return ENUM_SPECS[stage.key].label;
    case 'protection':
      return 'Protection level';
    case 'search':
      return 'Default search engine';
    case 'sizes':
      return 'Custom panel sizes';
    case 'sizeActions':
      return `${model.settings.customPanelSizes[stage.index] ?? ''} px`;
    case 'sizeEdit':
      return 'Edit size';
    case 'advanced':
      return 'Advanced privacy';
    case 'shortcuts':
      return 'Keyboard shortcuts';
    case 'backups':
      return 'Backups';
    case 'backupRow':
      return stage.label;
    case 'confirm':
      return stage.action.kind === 'reset'
        ? 'Reset Bento settings'
        : stage.action.kind === 'restore'
          ? 'Restore backup'
          : 'Delete backup';
  }
}

/** The only rows of a palette that has no snapshot yet. */
export function statusRows(view: Exclude<SettingsPaletteView, { kind: 'ready' }>): PaletteRow[] {
  if (view.kind === 'loading') {
    return [
      {
        id: 'status:loading',
        group: 'Settings',
        label: 'Loading settings…',
        tone: 'muted',
        info: true,
        keywords: NO_KEYWORDS,
        intent: { type: 'none' },
      },
    ];
  }
  return [
    {
      id: 'status:error',
      group: 'Settings',
      label: view.message,
      tone: 'warning',
      info: true,
      keywords: NO_KEYWORDS,
      intent: { type: 'none' },
    },
    {
      id: 'status:retry',
      group: 'Settings',
      label: 'Try again',
      keywords: NO_KEYWORDS,
      intent: { type: 'retry' },
    },
  ];
}
