import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COLOR_FLIP_LEAD_MS, DEFAULT_SETTINGS, SettingsStore } from './SettingsStore';

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

describe('SettingsStore colorStamp', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('browser', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    });
  });

  it('stamps the state a run starts with, and rises only when uiColorMode changes', async () => {
    const store = new SettingsStore();
    await store.init();
    // Stamped from the start, so the first state chrome hears is ordered too.
    const start = store.colorStamp();
    expect(start.run).toMatch(/\S/);
    expect(start.seq).toBe(1);
    const seen: number[] = [];
    store.onChange(() => seen.push(store.colorStamp().seq));

    await store.update({ panelCornerRadiusPx: 20 });
    expect(store.colorStamp()).toEqual(start);

    await store.update({ uiColorMode: 'dark' });
    expect(store.colorStamp()).toMatchObject({ run: start.run, seq: 2 });
    // The listener of a colour change reads the new stamp, so the direct leg and the settings
    // events carry the same one.
    expect(seen).toEqual([1, 2]);

    // An update that repeats the mode changes nothing.
    await store.update({ uiColorMode: 'dark', panelCornerRadiusPx: 21 });
    expect(store.colorStamp().seq).toBe(2);

    // A reset that changes the mode is a change; one that does not is not.
    await store.reset();
    expect(store.colorStamp().seq).toBe(3);
    await store.reset();
    expect(store.colorStamp().seq).toBe(3);
  });

  it('schedules each colour change one lead ahead and leaves the starting state unscheduled', async () => {
    const store = new SettingsStore();
    await store.init();
    expect(store.colorStamp().flipAt).toBeUndefined();

    vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    await store.update({ uiColorMode: 'dark' });
    expect(store.colorStamp().flipAt).toBe(5_000_000 + COLOR_FLIP_LEAD_MS);

    // Another setting, or the same mode again, keeps the change's own time.
    vi.spyOn(Date, 'now').mockReturnValue(6_000_000);
    await store.update({ panelCornerRadiusPx: 20 });
    await store.update({ uiColorMode: 'dark' });
    expect(store.colorStamp().flipAt).toBe(5_000_000 + COLOR_FLIP_LEAD_MS);

    await store.update({ uiColorMode: 'light' });
    expect(store.colorStamp().flipAt).toBe(6_000_000 + COLOR_FLIP_LEAD_MS);
    vi.restoreAllMocks();
  });

  it('does not depend on the clock, and a new run has its own id', async () => {
    const first = new SettingsStore();
    await first.init();
    await first.update({ uiColorMode: 'dark' });

    // A restart after the clock stepped back: the sequence starts again, under another run.
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    const restarted = new SettingsStore();
    await restarted.init();
    await restarted.update({ uiColorMode: 'dark' });
    expect(restarted.colorStamp().run).not.toBe(first.colorStamp().run);
    expect(restarted.colorStamp().seq).toBe(2);
    vi.restoreAllMocks();
  });
});
