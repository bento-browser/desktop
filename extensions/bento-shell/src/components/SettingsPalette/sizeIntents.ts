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

/** The key `settings/update` is tracked under in `SettingsPaletteModel.pending`. */
const SIZES_KEY = 'customPanelSizes';

/** Whether an intent reads or rewrites the size list: the actions themselves, and entering the
 * stage of one entry (its index is only good for the list it was built from). */
export function touchesSizeList(intent: Intent): boolean {
  if (intent.type === 'addSize' || intent.type === 'moveSize' || intent.type === 'removeSize') {
    return true;
  }
  return (
    intent.type === 'push' &&
    (intent.stage.kind === 'sizeActions' || intent.stage.kind === 'sizeEdit')
  );
}

/** Whether `intent` has to be ignored because the list is still being saved. */
export function waitsForSave(intent: Intent, runner: { isBusy(): boolean }): boolean {
  return touchesSizeList(intent) && runner.isBusy();
}

/** Runs one size action. `run` resolves true when the new list was saved, false when it was
 * refused or the list was still being saved (this one is dropped, not queued: it was chosen from
 * a list that is about to change). `isBusy` says so, for the intents that must wait the same way:
 * `Edit size` entered during a move would edit whichever entry lands on its index. */
export function createSizeRunner({ model, update }: SizeRunnerDeps) {
  let busy = false;
  // Another write to the list also counts: a size being edited live is applied the same way.
  const isBusy = () => busy || (model()?.pending.has(SIZES_KEY) ?? false);
  async function run(intent: SizeIntent): Promise<boolean> {
    const current = model();
    if (isBusy() || !current) return false;
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
  }
  return { run, isBusy };
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
