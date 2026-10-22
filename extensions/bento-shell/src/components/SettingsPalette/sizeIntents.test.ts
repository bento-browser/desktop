import { describe, expect, it, vi } from 'vitest';
import type { EditableSettings } from './model';
import { createSizeRunner, stackAfterSizeChange } from './sizeIntents';
import type { Stage } from './stageStack';
import type { SettingsPaletteModel } from './types';

function setup(initial: number[]) {
  let sizes = initial;
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
    }) as unknown as SettingsPaletteModel;
  return { run: createSizeRunner({ model, update }), update, gates, sizes: () => sizes };
}

const actionsAt = (index: number): Stage[] => [
  { kind: 'root' },
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
      { kind: 'sizes' },
    ]);
  });

  it('leaves a stack that moved on while the change was saved', () => {
    const elsewhere: Stage[] = [{ kind: 'root' }, { kind: 'sizes' }];
    expect(stackAfterSizeChange(elsewhere, { type: 'moveSize', index: 1, delta: 1 })).toEqual(
      elsewhere,
    );
    expect(stackAfterSizeChange(actionsAt(0), { type: 'removeSize', index: 3 })).toEqual(
      actionsAt(0),
    );
    expect(stackAfterSizeChange(actionsAt(0), { type: 'addSize' })).toEqual(actionsAt(0));
  });
});
