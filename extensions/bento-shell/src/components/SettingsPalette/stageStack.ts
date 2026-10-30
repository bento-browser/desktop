// Navigation of the Settings palette: a stack of stages, Esc pops one, and the nav row shows
// the path. Pure so the rules are tested without rendering.

import type { SettingsCategoryId } from './categories';
import type { EnumKey, NumberSettingKey } from './settingsCatalog';

export type ConfirmAction =
  | { kind: 'reset' }
  | { kind: 'restore'; backupId: string; label: string }
  | { kind: 'delete'; backupId: string; label: string };

export type Stage =
  | { kind: 'root' }
  | { kind: 'category'; id: Exclude<SettingsCategoryId, 'shortcuts'> }
  | { kind: 'number'; key: NumberSettingKey }
  | { kind: 'enum'; key: EnumKey }
  | { kind: 'protection' }
  | { kind: 'search' }
  | { kind: 'sizes' }
  | { kind: 'sizeActions'; index: number }
  | { kind: 'sizeEdit'; index: number }
  | { kind: 'advanced' }
  | { kind: 'shortcuts' }
  | { kind: 'backups' }
  | { kind: 'backupRow'; backupId: string; label: string }
  | { kind: 'confirm'; action: ConfirmAction };

export const ROOT_STAGE: Stage = { kind: 'root' };

export function initialStack(top?: Stage): Stage[] {
  return top && top.kind !== 'root' ? [ROOT_STAGE, top] : [ROOT_STAGE];
}

export function pushStage(stack: readonly Stage[], stage: Stage): Stage[] {
  return [...stack, stage];
}

/** One step back. The root stays: the palette closes from the root, not from here. */
export function popStage(stack: readonly Stage[]): Stage[] {
  return stack.length > 1 ? stack.slice(0, -1) : [...stack];
}

/** Drops the stages above the topmost one of `kind`; the stack is kept when there is none. */
export function popToKind(stack: readonly Stage[], kind: Stage['kind']): Stage[] {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    if (stack[index]!.kind === kind) return stack.slice(0, index + 1);
  }
  return [...stack];
}

export function replaceTop(stack: readonly Stage[], stage: Stage): Stage[] {
  return [...stack.slice(0, -1), stage];
}

export function topStage(stack: readonly Stage[]): Stage {
  return stack[stack.length - 1] ?? ROOT_STAGE;
}

export type EscapeOutcome = 'clearQuery' | 'cancelImport' | 'back' | 'close';

/** What Esc does, one step at a time: it clears a search first, dismisses a pending import
 * preview (a state of the Backups stage, not a stage of its own), goes back one stage, and
 * closes only from the root. An editor stage's field is its value, never a search. */
export function escapeOutcome(
  stack: readonly Stage[],
  state: { query: string; importPreview: boolean },
): EscapeOutcome {
  const stage = topStage(stack);
  if (!isEditorStage(stage) && state.query !== '') return 'clearQuery';
  if (stage.kind === 'backups' && state.importPreview) return 'cancelImport';
  return stack.length > 1 ? 'back' : 'close';
}

/** Stages whose field edits a value instead of filtering a list. */
export function isEditorStage(stage: Stage): boolean {
  return stage.kind === 'number' || stage.kind === 'sizeEdit';
}

/** Identity of a stage, used to remount the list when the stage changes. */
export function stageKey(stage: Stage): string {
  switch (stage.kind) {
    case 'category':
      return `category:${stage.id}`;
    case 'number':
    case 'enum':
      return `${stage.kind}:${stage.key}`;
    case 'sizeActions':
    case 'sizeEdit':
      return `${stage.kind}:${stage.index}`;
    case 'backupRow':
      return `${stage.kind}:${stage.backupId}`;
    case 'confirm':
      return `confirm:${stage.action.kind}`;
    default:
      return stage.kind;
  }
}

/** The stack with only the stages up to and including `index` (the root stays). */
export function popToIndex(stack: readonly Stage[], index: number): Stage[] {
  return stack.slice(0, Math.max(1, Math.min(index + 1, stack.length)));
}

/** The labels of the path to the current stage, root first: `Settings`, then each stage. The
 * last is the current page; every earlier one is a stage the user can go back to. */
export function pathLabels(stack: readonly Stage[], labelOf: (stage: Stage) => string): string[] {
  return stack.map(labelOf);
}
