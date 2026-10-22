// Navigation of the Settings palette: a stack of stages, Esc pops one, and the search field
// shows the path. Pure so the rules are tested without rendering.

import type { EnumKey, NumberSettingKey } from './settingsCatalog';

export type ConfirmAction =
  | { kind: 'reset' }
  | { kind: 'restore'; backupId: string; label: string }
  | { kind: 'delete'; backupId: string; label: string };

export type Stage =
  | { kind: 'root' }
  | { kind: 'number'; key: NumberSettingKey }
  | { kind: 'text'; key: 'defaultWorkspaceName' }
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

/** Stages whose field edits a value instead of filtering a list. */
export function isEditorStage(stage: Stage): boolean {
  return stage.kind === 'number' || stage.kind === 'text' || stage.kind === 'sizeEdit';
}

/** Identity of a stage, used to remount the list when the stage changes. */
export function stageKey(stage: Stage): string {
  switch (stage.kind) {
    case 'number':
    case 'text':
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

export interface Crumbs {
  /** Labels of the stages between the root and the current one. */
  trail: string[];
  /** The current stage's label. */
  current: string | null;
}

/** The path for the search field: `Settings / <trail> / ` then the current label. */
export function crumbsFor(stack: readonly Stage[], labelOf: (stage: Stage) => string): Crumbs {
  const labels = stack.filter((stage) => stage.kind !== 'root').map(labelOf);
  const current = labels.length > 0 ? labels[labels.length - 1]! : null;
  return { trail: labels.slice(0, -1), current };
}

/** `Settings / Custom panel sizes / ` for the given trail. */
export function crumbPrefix(trail: readonly string[]): string {
  return ['Settings', ...trail].join(' / ') + ' / ';
}
