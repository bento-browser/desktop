// Category identity and paths are shared by command targets and Settings search drilldowns.
import { ROOT_STAGE, stageKey, type Stage } from './stageStack';

export const SETTINGS_CATEGORIES = [
  { id: 'appearance', label: 'Appearance', description: 'Bento interface color mode' },
  {
    id: 'tabAppearance',
    label: 'Tab appearance',
    description: 'State tints and custom state icons',
  },
  { id: 'performance', label: 'Performance', description: 'Tab sleep and workspace keep-alive' },
  { id: 'workspaces', label: 'Workspaces', description: 'Sidebar collapse behavior' },
  { id: 'panels', label: 'Panels', description: 'Panel size, layout and appearance' },
  { id: 'privacy', label: 'Privacy and search', description: 'Protection and search engines' },
  { id: 'backup', label: 'Backup and data', description: 'Backups, import and session merge' },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    description: 'Browse Bento’s keyboard shortcuts',
  },
  { id: 'reset', label: 'Reset Bento', description: 'Reset settings with confirmation' },
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORIES)[number]['id'];

const ROW_CATEGORIES: Readonly<Record<string, SettingsCategoryId>> = {
  'setting:uiColorMode': 'appearance',
  'setting:tabStateTintsEnabled': 'tabAppearance',
  'setting:customTabStateIconsEnabled': 'tabAppearance',
  'setting:tabSleepEnabled': 'performance',
  'setting:tabSleepAfterMinutes': 'performance',
  'setting:tabSleepKeepAlivePerWorkspace': 'performance',
  'setting:sidebarShortcutBehavior': 'workspaces',
  'setting:defaultPanelWidthPx': 'panels',
  'setting:panelCycleWraparound': 'panels',
  'setting:panelShadowsEnabled': 'panels',
  'setting:panelCornerRadiusPx': 'panels',
  'setting:panelSplitterSizePx': 'panels',
  'setting:customPanelSizes': 'panels',
  'privacy:level': 'privacy',
  'privacy:search': 'privacy',
  'privacy:manage-search': 'privacy',
  'privacy:advanced': 'privacy',
  'setting:autoBackupEnabled': 'backup',
  'setting:autoBackupIntervalMinutes': 'backup',
  'setting:autoBackupMaxCount': 'backup',
  'backup:open': 'backup',
  'backup:merge': 'backup',
  'shortcuts:open': 'shortcuts',
  'reset:open': 'reset',
};

export function categoryForRow(id: string): SettingsCategoryId | undefined {
  if (id.startsWith('advanced:')) return 'privacy';
  if (id.startsWith('shortcut:')) return 'shortcuts';
  return Object.hasOwn(ROW_CATEGORIES, id) ? ROW_CATEGORIES[id] : undefined;
}

/** The shortcuts category opens its reference directly, with no intermediate action row. */
export function categoryStage(id: SettingsCategoryId): Stage {
  return id === 'shortcuts' ? { kind: 'shortcuts' } : { kind: 'category', id };
}

export function categoryLabel(id: SettingsCategoryId): string {
  return SETTINGS_CATEGORIES.find((category) => category.id === id)!.label;
}

/** Complete ancestry of a control or global search result. A destination already in the path
 * (the shortcuts reference or Advanced privacy itself) is added only once. */
export function settingPath(id: string, destination?: Stage): Stage[] {
  const category = categoryForRow(id);
  const stages: Stage[] = [ROOT_STAGE];
  if (category) stages.push(categoryStage(category));
  if (id.startsWith('advanced:')) stages.push({ kind: 'advanced' });
  if (destination && stageKey(stages.at(-1)!) !== stageKey(destination)) stages.push(destination);
  return stages;
}

/** The opener at each depth, including synthetic ancestors of a command/search deep link.
 * Returning to the category-only root must focus a category, never a former control row. */
export function openerRows(stages: readonly Stage[]): (string | undefined)[] {
  return stages.slice(1).map((stage, index) => {
    const parent = stages[index];
    switch (stage.kind) {
      case 'category':
        return `category:${stage.id}`;
      case 'shortcuts':
        return 'category:shortcuts';
      case 'number':
        return `setting:${stage.key}`;
      case 'enum':
        return `${parent?.kind === 'advanced' ? 'advanced' : 'setting'}:${stage.key}`;
      case 'protection':
        return 'privacy:level';
      case 'search':
        return 'privacy:search';
      case 'sizes':
        return 'setting:customPanelSizes';
      case 'sizeActions':
        return `size:${stage.index}`;
      case 'sizeEdit':
        return 'size-action:edit';
      case 'advanced':
        return 'privacy:advanced';
      case 'backups':
        return 'backup:open';
      case 'backupRow':
        return `stored:${stage.backupId}`;
      case 'confirm':
        return stage.action.kind === 'reset' ? 'reset:open' : `stored-action:${stage.action.kind}`;
      case 'root':
        return undefined;
    }
  });
}
