import { describe, expect, it } from 'vitest';
import {
  pathLabels,
  popToIndex,
  initialStack,
  isEditorStage,
  popStage,
  popToKind,
  pushStage,
  replaceTop,
  stageKey,
  topStage,
  ROOT_STAGE,
  type Stage,
} from './stageStack';

const sizes: Stage = { kind: 'sizes' };
const actions: Stage = { kind: 'sizeActions', index: 2 };

describe('stage stack', () => {
  it('starts on the root, or on a stage opened from a deep link', () => {
    expect(initialStack()).toEqual([{ kind: 'root' }]);
    expect(initialStack({ kind: 'protection' })).toEqual([
      { kind: 'root' },
      { kind: 'protection' },
    ]);
    expect(initialStack({ kind: 'root' })).toEqual([{ kind: 'root' }]);
  });

  it('pushes and pops one stage at a time and never pops the root', () => {
    let stack = pushStage(pushStage(initialStack(), sizes), actions);
    expect(topStage(stack)).toBe(actions);
    stack = popStage(stack);
    expect(topStage(stack)).toBe(sizes);
    stack = popStage(popStage(stack));
    expect(stack).toEqual([{ kind: 'root' }]);
  });

  it('does not change the stack it was given', () => {
    const stack = pushStage(initialStack(), sizes);
    popStage(stack);
    replaceTop(stack, actions);
    expect(stack).toHaveLength(2);
  });

  it('replaces the top stage', () => {
    const stack = replaceTop(pushStage(pushStage(initialStack(), sizes), actions), {
      kind: 'sizeActions',
      index: 1,
    });
    expect(topStage(stack)).toEqual({ kind: 'sizeActions', index: 1 });
    expect(stack).toHaveLength(3);
  });

  it('pops back to the topmost stage of a kind, and stays put when there is none', () => {
    const confirm: Stage = { kind: 'confirm', action: { kind: 'reset' } };
    const stack = [
      { kind: 'root' },
      { kind: 'backups' },
      { kind: 'backupRow', backupId: 'b', label: 'L' },
      confirm,
    ] as Stage[];
    expect(popToKind(stack, 'backups')).toEqual(stack.slice(0, 2));
    expect(popToKind(stack, 'advanced')).toEqual(stack);
  });

  it('knows which stages edit a value in the field', () => {
    expect(isEditorStage({ kind: 'number', key: 'panelCornerRadiusPx' })).toBe(true);
    expect(isEditorStage({ kind: 'sizeEdit', index: 0 })).toBe(true);
    expect(isEditorStage({ kind: 'protection' })).toBe(false);
    expect(isEditorStage({ kind: 'root' })).toBe(false);
  });

  it('gives stages of one kind different keys when they show different things', () => {
    expect(stageKey({ kind: 'sizeActions', index: 1 })).not.toBe(
      stageKey({ kind: 'sizeActions', index: 2 }),
    );
    expect(stageKey({ kind: 'enum', key: 'uiColorMode' })).not.toBe(
      stageKey({ kind: 'enum', key: 'httpsOnlyMode' }),
    );
    expect(stageKey({ kind: 'category', id: 'appearance' })).not.toBe(
      stageKey({ kind: 'category', id: 'panels' }),
    );
    expect(stageKey({ kind: 'sizes' })).not.toBe(stageKey({ kind: 'root' }));
  });
});

describe('path', () => {
  const label = (stage: Stage) =>
    stage.kind === 'sizeActions'
      ? '640 px'
      : stage.kind === 'sizes'
        ? 'Custom panel sizes'
        : 'Settings';

  it('is the root alone at the root', () => {
    expect(pathLabels(initialStack(), label)).toEqual(['Settings']);
  });

  it('lists every stage from the root to the current one', () => {
    const stack = pushStage(pushStage(initialStack(), sizes), actions);
    expect(pathLabels(stack, label)).toEqual(['Settings', 'Custom panel sizes', '640 px']);
  });

  it('goes back to any stage on it, and never past the root', () => {
    const stack = pushStage(pushStage(initialStack(), sizes), actions);
    expect(popToIndex(stack, 1)).toEqual(stack.slice(0, 2));
    expect(popToIndex(stack, 0)).toEqual([ROOT_STAGE]);
    expect(popToIndex(stack, -3)).toEqual([ROOT_STAGE]);
    expect(popToIndex(stack, 9)).toEqual(stack);
  });
});
