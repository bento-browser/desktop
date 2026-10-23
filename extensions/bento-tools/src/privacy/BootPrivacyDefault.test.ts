import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BentoMutationCoordinator } from '../mutations/BentoMutationCoordinator';
import { SettingsStore } from '../settings/SettingsStore';
import { WorkspaceStore } from '../workspaces/WorkspaceStore';
import { bootPrivacyLevel, seedBootPrivacyLevel } from './BootPrivacyDefault';
import { applyPrivacyLevel } from './ProtectionLevels';

vi.mock('./ProtectionLevels', () => ({ applyPrivacyLevel: vi.fn(async () => undefined) }));

const WORKSPACES_KEY = 'bento.workspaces';
const SETTINGS_KEY = 'bento.settings';

/** One browser profile: `storage.local` outlives each simulated launch. */
function profile(initial: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = { ...initial };
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async () => ({ ...stored })),
        set: vi.fn(async (payload: Record<string, unknown>) => void Object.assign(stored, payload)),
      },
    },
    windows: { getAll: vi.fn(async () => []) },
    sessions: {
      getWindowValue: vi.fn(async () => undefined),
      setWindowValue: vi.fn(async () => undefined),
      removeWindowValue: vi.fn(async () => undefined),
    },
  });
  return {
    /** What `bootReady` sees: both stores initialised, and the seed issued on the first launch. */
    async launch() {
      const settings = new SettingsStore();
      const workspaces = new WorkspaceStore();
      await Promise.all([settings.init(), workspaces.init()]);
      const coordinator = new BentoMutationCoordinator();
      // The bootstrap persists its workspace after a debounce.
      await vi.advanceTimersByTimeAsync(1000);
      return { settings, workspaces, coordinator };
    },
  };
}

describe('first-launch protection level', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.mocked(applyPrivacyLevel).mockReset();
    vi.mocked(applyPrivacyLevel).mockResolvedValue(undefined);
  });

  it('seeds Standard on the first launch, which has no override to apply', async () => {
    const { launch } = profile();
    const { settings, workspaces, coordinator } = await launch();
    expect(workspaces.firstLaunch).toBe(true);
    expect(settings.hasOverride('privacyProtectionLevel')).toBe(false);

    await seedBootPrivacyLevel(settings, workspaces.firstLaunch, coordinator);

    expect(applyPrivacyLevel).toHaveBeenCalledExactlyOnceWith('standard');
  });

  it('does not seed again on a later launch, so a changed Advanced switch stays changed', async () => {
    const { launch } = profile();
    const first = await launch();
    await seedBootPrivacyLevel(first.settings, first.workspaces.firstLaunch, first.coordinator);
    expect(applyPrivacyLevel).toHaveBeenCalledTimes(1);

    // The user changes an Advanced switch (no protection level involved) and relaunches.
    const second = await launch();
    expect(second.workspaces.firstLaunch).toBe(false);
    await seedBootPrivacyLevel(second.settings, second.workspaces.firstLaunch, second.coordinator);

    expect(applyPrivacyLevel).toHaveBeenCalledTimes(1);
  });

  it('leaves a profile with persisted workspaces alone, whatever its onboarding state', async () => {
    const { launch } = profile({
      [WORKSPACES_KEY]: {
        version: 1,
        workspaces: [{ id: 'w1', name: 'Personal', createdAt: 1 }],
        activeId: 'w1',
      },
    });
    const { settings, workspaces, coordinator } = await launch();
    expect(settings.snapshot().welcomeSeen).toBe(false);
    expect(workspaces.firstLaunch).toBe(false);

    await seedBootPrivacyLevel(settings, workspaces.firstLaunch, coordinator);

    expect(applyPrivacyLevel).not.toHaveBeenCalled();
  });

  it('leaves a stored choice to the override apply', async () => {
    const { launch } = profile({
      [SETTINGS_KEY]: { version: 2, overrides: { privacyProtectionLevel: 'hardened' } },
    });
    const { settings, workspaces, coordinator } = await launch();
    expect(workspaces.firstLaunch).toBe(true);
    expect(bootPrivacyLevel(settings, workspaces.firstLaunch)).toBeNull();

    await seedBootPrivacyLevel(settings, workspaces.firstLaunch, coordinator);

    expect(applyPrivacyLevel).not.toHaveBeenCalled();
  });

  it('applies a pick made during onboarding after the seed', async () => {
    const { launch } = profile();
    const { settings, workspaces, coordinator } = await launch();
    const order: string[] = [];
    vi.mocked(applyPrivacyLevel).mockImplementation(async (level) => {
      await Promise.resolve();
      order.push(level);
    });

    const seed = seedBootPrivacyLevel(settings, workspaces.firstLaunch, coordinator);
    // The privacy step's pick goes through the same lane (SettingsDomainService.setProtectionLevel).
    const pick = coordinator.runExclusive('privacy', async () => {
      await applyPrivacyLevel('hardened');
      await settings.update({ privacyProtectionLevel: 'hardened' });
    });
    await Promise.all([seed, pick]);

    expect(order).toEqual(['standard', 'hardened']);
    expect(settings.snapshot().privacyProtectionLevel).toBe('hardened');
  });

  it('skips the seed when a pick was stored before the lane reached it', async () => {
    const { launch } = profile();
    const { settings, workspaces, coordinator } = await launch();

    const earlier = coordinator.runExclusive('privacy', () =>
      settings.update({ privacyProtectionLevel: 'enhanced' }),
    );
    await Promise.all([
      earlier,
      seedBootPrivacyLevel(settings, workspaces.firstLaunch, coordinator),
    ]);

    expect(applyPrivacyLevel).not.toHaveBeenCalled();
  });

  it('never rejects when the apply fails', async () => {
    const { launch } = profile();
    const { settings, workspaces, coordinator } = await launch();
    vi.mocked(applyPrivacyLevel).mockRejectedValueOnce(new Error('privacy API unavailable'));

    await expect(
      seedBootPrivacyLevel(settings, workspaces.firstLaunch, coordinator),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});
