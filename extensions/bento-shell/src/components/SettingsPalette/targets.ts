// Where the Settings palette opens when something else points at one setting: a result of the
// command palette, the privacy command. A target is the id of a root row (`rows.ts`), so the
// command palette's static index and this map cannot name a row the palette does not have.

import {
  ADVANCED_PRIVACY_SPECS,
  BOOLEAN_SPECS,
  NUMBER_SPECS,
  type EnumKey,
  type NumberSettingKey,
} from './settingsCatalog';
import { ROOT_STAGE, type Stage } from './stageStack';

export interface SettingsTarget {
  /** Stages to start on, root first. */
  stages: readonly Stage[];
  /** Search text to start with: the setting's own label when it has no list of its own. */
  query: string;
}

/** The first list: what a show that names no target, or one this build does not know, opens. */
export const ROOT_TARGET: SettingsTarget = { stages: [ROOT_STAGE], query: '' };

const STAGE_BY_ROW_ID: Readonly<Record<string, Stage>> = {
  'setting:defaultWorkspaceName': { kind: 'text', key: 'defaultWorkspaceName' },
  'setting:customPanelSizes': { kind: 'sizes' },
  'privacy:level': { kind: 'protection' },
  'privacy:search': { kind: 'search' },
  'privacy:advanced': { kind: 'advanced' },
  'backup:open': { kind: 'backups' },
  'shortcuts:open': { kind: 'shortcuts' },
};

/** The stages and search text for a target, or null for an id the palette does not know. */
export function resolveSettingsTarget(id: string): SettingsTarget | null {
  const known = STAGE_BY_ROW_ID[id];
  if (known) return { stages: [ROOT_STAGE, known], query: '' };

  if (id.startsWith('setting:')) {
    const key = id.slice('setting:'.length);
    if (Object.hasOwn(NUMBER_SPECS, key)) {
      return { stages: [ROOT_STAGE, { kind: 'number', key: key as NumberSettingKey }], query: '' };
    }
    if (key === 'uiColorMode' || key === 'sidebarShortcutBehavior') {
      return { stages: [ROOT_STAGE, { kind: 'enum', key: key as EnumKey }], query: '' };
    }
    // A switch has no list: the root with its label typed in leaves it as the first row.
    const toggle = Object.entries(BOOLEAN_SPECS).find(([name]) => name === key)?.[1];
    return toggle ? { stages: [ROOT_STAGE], query: toggle.label } : null;
  }

  if (id.startsWith('advanced:')) {
    const spec = ADVANCED_PRIVACY_SPECS.find((entry) => `advanced:${entry.key}` === id);
    return spec ? { stages: [ROOT_STAGE, { kind: 'advanced' }], query: spec.label } : null;
  }

  if (id === 'privacy:manage-search') {
    return { stages: [ROOT_STAGE], query: 'Manage search engines' };
  }
  return null;
}
