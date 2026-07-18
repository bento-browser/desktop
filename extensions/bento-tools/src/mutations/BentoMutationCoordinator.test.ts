import { describe, expect, it } from 'vitest';
import { BentoMutationCoordinator } from './BentoMutationCoordinator';

describe('BentoMutationCoordinator', () => {
  it('serializes mutations in dispatch order', async () => {
    const coordinator = new BentoMutationCoordinator();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = coordinator.runExclusive('settings', async () => {
      order.push('first-start');
      await gate;
      order.push('first-end');
    });
    const second = coordinator.runExclusive('backup-write', async () => {
      order.push('second');
    });
    await Promise.resolve();
    expect(order).toEqual(['first-start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first-start', 'first-end', 'second']);
  });

  it('rejects a snapshot that changes on every bounded attempt', async () => {
    const coordinator = new BentoMutationCoordinator();
    await expect(
      coordinator.readStableSnapshot(async () => {
        coordinator.noteExternalGraphChange();
        return {};
      }),
    ).rejects.toThrow('snapshot_changed');
  });
});
