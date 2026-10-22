// The custom panel size list actions (add, move, remove), kept free of React so the order of
// events is tested directly. The list is rewritten as a whole, so each action starts from the
// list as it is when it runs and the next one waits for its answer; the stage that follows the
// entry (Move) or leaves it (Remove) changes only once tools has saved the new list.

import { moveEntry, removeAt } from './editing';
import type { Intent } from './rows';
import { PANEL_SIZE_LIMITS } from './settingsCatalog';
import { popStage, replaceTop, topStage, type Stage } from './stageStack';
import type { SettingsPaletteModel } from './types';
import type { EditableSettings } from './model';

export type SizeIntent = Extract<Intent, { type: 'addSize' | 'moveSize' | 'removeSize' }>;

export interface SizeRunnerDeps {
  /** The latest model, read when an action runs. */
  model(): SettingsPaletteModel | null;
  /** Resolves whether tools saved the change. */
  update(changes: Partial<EditableSettings>): Promise<boolean>;
}

/** Runs one size action. Resolves true when the new list was saved, false when it was refused
 * or another size action was still waiting for its answer (this one is dropped, not queued:
 * it was chosen from a list that is about to change). */
export function createSizeRunner({ model, update }: SizeRunnerDeps) {
  let busy = false;
  return async function run(intent: SizeIntent): Promise<boolean> {
    const current = model();
    if (busy || !current) return false;
    const sizes = current.settings.customPanelSizes;
    busy = true;
    try {
      switch (intent.type) {
        case 'addSize': {
          const size = Math.min(
            PANEL_SIZE_LIMITS.max,
            Math.max(PANEL_SIZE_LIMITS.min, current.settings.defaultPanelWidthPx),
          );
          return await update({ customPanelSizes: [...sizes, size] });
        }
        case 'moveSize':
          return await update({ customPanelSizes: moveEntry(sizes, intent.index, intent.delta) });
        case 'removeSize':
          return await update({ customPanelSizes: removeAt(sizes, intent.index) });
      }
    } finally {
      busy = false;
    }
  };
}

/** The stack once `intent` was saved: Move shows the actions of the entry at its new place,
 * Remove leaves them. A stack that moved on meanwhile (Esc, another stage) is kept. */
export function stackAfterSizeChange(stack: readonly Stage[], intent: SizeIntent): Stage[] {
  const top = topStage(stack);
  if (top.kind !== 'sizeActions' || intent.type === 'addSize' || top.index !== intent.index) {
    return [...stack];
  }
  return intent.type === 'moveSize'
    ? replaceTop(stack, { kind: 'sizeActions', index: intent.index + intent.delta })
    : popStage(stack);
}
