// Where the Settings palette opens when something else points at one setting: a result of the
// command palette, the privacy command. A target is the id of a control row (`rows.ts`), so the
// command palette's static index and this map keep the same stable control ids.

import {
  ADVANCED_PRIVACY_SPECS,
  BOOLEAN_SPECS,
  NUMBER_SPECS,
  type EnumKey,
  type NumberSettingKey,
} from './settingsCatalog';
import { settingPath } from './categories';
import { rowsForStage } from './rows';
import { ROOT_STAGE, stageKey, type Stage } from './stageStack';
import type { SettingsPaletteModel } from './types';

export interface SettingsTarget {
  /** Stages to start on, root first. */
  stages: readonly Stage[];
  /** Search text to start with: the setting's own label when it has no list of its own. */
  query: string;
}

/** The first list: what a show that names no target, or one this build does not know, opens. */
export const ROOT_TARGET: SettingsTarget = { stages: [ROOT_STAGE], query: '' };

const STAGE_BY_ROW_ID: Readonly<Record<string, Stage>> = {
  'setting:customPanelSizes': { kind: 'sizes' },
  'privacy:level': { kind: 'protection' },
  'privacy:search': { kind: 'search' },
  'privacy:advanced': { kind: 'advanced' },
  'backup:open': { kind: 'backups' },
  'shortcuts:open': { kind: 'shortcuts' },
};

/** The stages and search text for a target, or null for an id the palette does not know. */
export function resolveSettingsTarget(id: string): SettingsTarget | null {
  const known = Object.hasOwn(STAGE_BY_ROW_ID, id) ? STAGE_BY_ROW_ID[id] : undefined;
  if (known) return { stages: settingPath(id, known), query: '' };

  if (id.startsWith('setting:')) {
    const key = id.slice('setting:'.length);
    if (Object.hasOwn(NUMBER_SPECS, key)) {
      return {
        stages: settingPath(id, { kind: 'number', key: key as NumberSettingKey }),
        query: '',
      };
    }
    if (key === 'uiColorMode' || key === 'sidebarShortcutBehavior') {
      return { stages: settingPath(id, { kind: 'enum', key: key as EnumKey }), query: '' };
    }
    // A switch has no list: filter its category to its own label.
    const toggle = Object.entries(BOOLEAN_SPECS).find(([name]) => name === key)?.[1];
    return toggle ? { stages: settingPath(id), query: toggle.label } : null;
  }

  if (id.startsWith('advanced:')) {
    const spec = ADVANCED_PRIVACY_SPECS.find((entry) => `advanced:${entry.key}` === id);
    return spec ? { stages: settingPath(id), query: spec.label } : null;
  }

  if (id === 'privacy:manage-search') {
    return { stages: settingPath(id), query: 'Manage search engines' };
  }
  return null;
}

/** Resolve visibility only once the snapshot is ready. Every ancestor must have a visible
 * opener, so a private, unhydrated or build-gated category cannot be entered by a deep link. */
export function targetForModel(
  target: SettingsTarget,
  model: SettingsPaletteModel,
): SettingsTarget {
  if (target.stages[0]?.kind !== 'root') return ROOT_TARGET;
  for (let depth = 1; depth < target.stages.length; depth += 1) {
    const parent = target.stages[depth - 1]!;
    const next = stageKey(target.stages[depth]!);
    const available = rowsForStage(parent, model).some(
      (row) => row.intent.type === 'push' && stageKey(row.intent.stage) === next,
    );
    if (!available) return ROOT_TARGET;
  }
  return target;
}
