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

    const pending = store.update({ panelCornerRadiusPx: 20 });
    await Promise.resolve();
    expect(store.snapshot().panelCornerRadiusPx).toBe(12);
    expect(listener).not.toHaveBeenCalled();

    finishWrite?.();
    const commit = await pending;
    expect(commit).toMatchObject({ durableRevision: 1 });
    expect(commit.settings.panelCornerRadiusPx).toBe(20);
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
    const first = store.update({ panelCornerRadiusPx: 1 });
    const second = store.update({ panelCornerRadiusPx: 2 });

    await expect(first).resolves.toMatchObject({ durableRevision: 1 });
    await expect(second).resolves.toMatchObject({ durableRevision: 2 });
    expect(store.snapshot().panelCornerRadiusPx).toBe(2);
    expect(writes).toHaveLength(2);

    await store.reset();
    expect(writes.at(-1)).toEqual({
      'bento.settings': { version: 2, overrides: {} },
    });
    expect(store.snapshot()).toEqual(DEFAULT_SETTINGS);
  });

  it('loads a profile that still stores the retired default workspace name and drops the key', async () => {
    const writes: unknown[] = [];
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({
            'bento.settings': {
              version: 2,
              overrides: { defaultWorkspaceName: 'Work', panelCornerRadiusPx: 20 },
            },
          })),
          set: vi.fn(async (payload: unknown) => {
            writes.push(payload);
          }),
        },
      },
    });

    const store = new SettingsStore();
    await store.init();

    // The other override survives; the retired one is not a setting any more.
    expect(store.snapshot().panelCornerRadiusPx).toBe(20);
    expect(store.snapshot()).not.toHaveProperty('defaultWorkspaceName');
    expect(store.hasOverride('panelCornerRadiusPx')).toBe(true);
    expect('defaultWorkspaceName' in DEFAULT_SETTINGS).toBe(false);

    await store.update({ panelShadowsEnabled: false });
    expect(writes.at(-1)).toEqual({
      'bento.settings': {
        version: 2,
        overrides: { panelCornerRadiusPx: 20, panelShadowsEnabled: false },
      },
    });
  });
});
