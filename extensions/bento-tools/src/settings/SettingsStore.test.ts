import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, SettingsStore } from './SettingsStore';

describe('SettingsStore durable commits', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes only after storage acknowledges the commit', async () => {
    let finishWrite: (() => void) | undefined;
    const set = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve;
        }),
    );
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set,
        },
      },
    });

    const store = new SettingsStore();
    await store.init();
    const listener = vi.fn();
    store.onChange(listener);

    const pending = store.update({ defaultWorkspaceName: 'Work' });
    await Promise.resolve();
    expect(store.snapshot().defaultWorkspaceName).toBe('Personal');
    expect(listener).not.toHaveBeenCalled();

    finishWrite?.();
    const commit = await pending;
    expect(commit).toMatchObject({ durableRevision: 1 });
    expect(commit.settings.defaultWorkspaceName).toBe('Work');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('serializes concurrent writes and keeps default arrays sparse', async () => {
    const writes: unknown[] = [];
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async (payload: unknown) => {
            writes.push(payload);
          }),
        },
      },
    });

    const store = new SettingsStore();
    await store.init();
    const first = store.update({ defaultWorkspaceName: 'One' });
    const second = store.update({ defaultWorkspaceName: 'Two' });

    await expect(first).resolves.toMatchObject({ durableRevision: 1 });
    await expect(second).resolves.toMatchObject({ durableRevision: 2 });
    expect(store.snapshot().defaultWorkspaceName).toBe('Two');
    expect(writes).toHaveLength(2);

    await store.reset();
    expect(writes.at(-1)).toEqual({
      'bento.settings': { version: 2, overrides: {} },
    });
    expect(store.snapshot()).toEqual(DEFAULT_SETTINGS);
  });
});
