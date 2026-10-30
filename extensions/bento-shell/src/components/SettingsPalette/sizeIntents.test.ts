import { describe, expect, it, vi } from 'vitest';
import type { EditableSettings } from './model';
import {
  createSizeRunner,
  stackAfterSizeChange,
  touchesSizeList,
  waitsForSave,
} from './sizeIntents';
import type { Intent } from './rows';
import type { Stage } from './stageStack';
import type { SettingsPaletteModel } from './types';

function setup(initial: number[]) {
  let sizes = initial;
  let pending: ReadonlySet<string> = new Set();
  const gates: Array<(saved: boolean) => void> = [];
  const update = vi.fn((changes: Partial<EditableSettings>) => {
    const next = changes.customPanelSizes as number[];
    return new Promise<boolean>((resolve) =>
      gates.push((saved) => {
        if (saved) sizes = next;
        resolve(saved);
      }),
    );
  });
  const model = () =>
    ({
      settings: { customPanelSizes: sizes, defaultPanelWidthPx: 480 },
      pending,
    }) as unknown as SettingsPaletteModel;
  const runner = createSizeRunner({ model, update });
  return {
    ...runner,
    update,
    gates,
    sizes: () => sizes,
    setPending: (keys: string[]) => (pending = new Set(keys)),
  };
}

const actionsAt = (index: number): Stage[] => [
  { kind: 'root' },
  { kind: 'category', id: 'panels' },
  { kind: 'sizes' },
  { kind: 'sizeActions', index },
];

describe('createSizeRunner', () => {
  it('saves a move and reports it saved only when tools answers', async () => {
    const { run, update, gates, sizes } = setup([320, 480, 640]);
    const moved = run({ type: 'moveSize', index: 0, delta: 1 });
    expect(update).toHaveBeenCalledWith({ customPanelSizes: [480, 320, 640] });
    let settled = false;
    void moved.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    gates[0]!(true);
    await expect(moved).resolves.toBe(true);
    expect(sizes()).toEqual([480, 320, 640]);
  });

  it('reports a refused move as not saved, so the actions stay on the same entry', async () => {
    const { run, gates } = setup([320, 480]);
    const moved = run({ type: 'moveSize', index: 0, delta: 1 });
    gates[0]!(false);
    await expect(moved).resolves.toBe(false);
  });

  it('drops a second action while the first waits, and runs the next from the saved list', async () => {
    const { run, update, gates } = setup([320, 480, 640]);
    const first = run({ type: 'moveSize', index: 0, delta: 1 });
    // Pressing again before the answer would act on the old order: it is ignored.
    await expect(run({ type: 'moveSize', index: 1, delta: 1 })).resolves.toBe(false);
    await expect(run({ type: 'removeSize', index: 1 })).resolves.toBe(false);
    expect(update).toHaveBeenCalledTimes(1);
    gates[0]!(true);
    await first;

    const second = run({ type: 'moveSize', index: 1, delta: 1 });
    expect(update).toHaveBeenLastCalledWith({ customPanelSizes: [480, 640, 320] });
    gates[1]!(true);
    await expect(second).resolves.toBe(true);
  });

  it('frees the runner after a refusal, and removes and adds from the saved list', async () => {
    const { run, update, gates } = setup([320, 480]);
    const refused = run({ type: 'removeSize', index: 0 });
    gates[0]!(false);
    await refused;
    const added = run({ type: 'addSize' });
    expect(update).toHaveBeenLastCalledWith({ customPanelSizes: [320, 480, 480] });
    gates[1]!(true);
    await added;
    const removed = run({ type: 'removeSize', index: 0 });
    expect(update).toHaveBeenLastCalledWith({ customPanelSizes: [480, 480] });
    gates[2]!(true);
    await expect(removed).resolves.toBe(true);
  });
});

describe('stackAfterSizeChange', () => {
  it('follows the moved entry to its new place', () => {
    expect(stackAfterSizeChange(actionsAt(2), { type: 'moveSize', index: 2, delta: -1 })).toEqual(
      actionsAt(1),
    );
  });

  it('leaves the actions of a removed entry', () => {
    expect(stackAfterSizeChange(actionsAt(1), { type: 'removeSize', index: 1 })).toEqual([
      { kind: 'root' },
      { kind: 'category', id: 'panels' },
      { kind: 'sizes' },
    ]);
  });

  it('leaves a stack that moved on while the change was saved', () => {
    const elsewhere: Stage[] = [
      { kind: 'root' },
      { kind: 'category', id: 'panels' },
      { kind: 'sizes' },
    ];
    expect(stackAfterSizeChange(elsewhere, { type: 'moveSize', index: 1, delta: 1 })).toEqual(
      elsewhere,
    );
    expect(stackAfterSizeChange(actionsAt(0), { type: 'removeSize', index: 3 })).toEqual(
      actionsAt(0),
    );
    expect(stackAfterSizeChange(actionsAt(0), { type: 'addSize' })).toEqual(actionsAt(0));
  });
});

describe('while the list is being saved', () => {
  const editEntry = (index: number): Intent => ({
    type: 'push',
    stage: { kind: 'sizeEdit', index },
  });

  it('knows which intents name an entry of the list', () => {
    const touching: Intent[] = [
      { type: 'addSize' },
      { type: 'moveSize', index: 0, delta: 1 },
      { type: 'removeSize', index: 0 },
      editEntry(1),
      { type: 'push', stage: { kind: 'sizeActions', index: 1 } },
    ];
    for (const intent of touching) expect(touchesSizeList(intent)).toBe(true);
    const others: Intent[] = [
      { type: 'push', stage: { kind: 'sizes' } },
      { type: 'push', stage: { kind: 'number', key: 'panelCornerRadiusPx' } },
      { type: 'applyNumber', value: 340 },
      { type: 'back' },
      { type: 'none' },
    ];
    for (const intent of others) expect(touchesSizeList(intent)).toBe(false);
  });

  it('is busy from a move until tools answers, so Edit size cannot be entered meanwhile', async () => {
    // Move 320 below 480, enter Edit on index 1 before it completes and save 340: the list
    // became [340, 320], the edit landing on the neighbour.
    const runner = setup([320, 480]);
    expect(waitsForSave(editEntry(1), runner)).toBe(false);
    const moved = runner.run({ type: 'moveSize', index: 0, delta: 1 });
    expect(waitsForSave(editEntry(1), runner)).toBe(true);
    expect(waitsForSave({ type: 'push', stage: { kind: 'sizeActions', index: 0 } }, runner)).toBe(
      true,
    );
    // What does not name an entry of the list is not held back.
    expect(waitsForSave({ type: 'back' }, runner)).toBe(false);
    runner.gates[0]!(true);
    await moved;
    expect(waitsForSave(editEntry(1), runner)).toBe(false);
  });

  it('is busy as well while a size edited live is still being saved, and runs nothing then', async () => {
    const { run, isBusy, update, setPending } = setup([320, 480]);
    setPending(['customPanelSizes']);
    expect(isBusy()).toBe(true);
    await expect(run({ type: 'removeSize', index: 0 })).resolves.toBe(false);
    expect(update).not.toHaveBeenCalled();
    setPending(['panelCornerRadiusPx']);
    expect(isBusy()).toBe(false);
  });

  it('is free again after a refusal', async () => {
    const { run, isBusy, gates } = setup([320, 480]);
    const moved = run({ type: 'moveSize', index: 0, delta: 1 });
    gates[0]!(false);
    await moved;
    expect(isBusy()).toBe(false);
  });
});
