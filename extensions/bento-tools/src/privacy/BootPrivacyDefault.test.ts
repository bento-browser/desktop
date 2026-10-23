import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BentoMutationCoordinator } from '../mutations/BentoMutationCoordinator';
import { SettingsStore } from '../settings/SettingsStore';
import { bootPrivacyLevel, seedBootPrivacyLevel } from './BootPrivacyDefault';
import { applyPrivacyLevel } from './ProtectionLevels';

vi.mock('./ProtectionLevels', () => ({ applyPrivacyLevel: vi.fn(async () => undefined) }));

const STORAGE_KEY = 'bento.settings';

/** A profile's storage.local, as it is at boot. */
async function boot(overrides?: Record<string, unknown>): Promise<SettingsStore> {
  const stored: Record<string, unknown> = overrides
    ? { [STORAGE_KEY]: { version: 2, overrides } }
    : {};
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async () => ({ ...stored })),
        set: vi.fn(async (payload: Record<string, unknown>) => void Object.assign(stored, payload)),
      },
    },
  });
  const settings = new SettingsStore();
  await settings.init();
  return settings;
}

describe('boot protection level', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.mocked(applyPrivacyLevel).mockClear();
  });

  it('seeds Standard on a fresh profile, which has no override to apply', async () => {
    const settings = await boot();
    expect(settings.hasOverride('privacyProtectionLevel')).toBe(false);
    expect(bootPrivacyLevel(settings)).toBe('standard');

    await seedBootPrivacyLevel(settings, new BentoMutationCoordinator());

    expect(applyPrivacyLevel).toHaveBeenCalledExactlyOnceWith('standard');
  });

  it('leaves a profile that finished onboarding alone', async () => {
    const settings = await boot({ welcomeSeen: true });
    expect(bootPrivacyLevel(settings)).toBeNull();

    await seedBootPrivacyLevel(settings, new BentoMutationCoordinator());

    expect(applyPrivacyLevel).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'leaves a stored choice to the override apply (welcomeSeen %s)',
    async (welcomeSeen) => {
      const settings = await boot({ privacyProtectionLevel: 'hardened', welcomeSeen });
      expect(bootPrivacyLevel(settings)).toBeNull();

      await seedBootPrivacyLevel(settings, new BentoMutationCoordinator());

      expect(applyPrivacyLevel).not.toHaveBeenCalled();
    },
  );

  it('applies a pick made during onboarding after the seed', async () => {
    const settings = await boot();
    const coordinator = new BentoMutationCoordinator();
    const order: string[] = [];
    vi.mocked(applyPrivacyLevel).mockImplementation(async (level) => {
      await Promise.resolve();
      order.push(level);
    });

    const seed = seedBootPrivacyLevel(settings, coordinator);
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
    const settings = await boot();
    const coordinator = new BentoMutationCoordinator();

    const earlier = coordinator.runExclusive('privacy', () =>
      settings.update({ privacyProtectionLevel: 'enhanced' }),
    );
    await Promise.all([earlier, seedBootPrivacyLevel(settings, coordinator)]);

    expect(applyPrivacyLevel).not.toHaveBeenCalled();
  });

  it('never rejects when the apply fails', async () => {
    const settings = await boot();
    vi.mocked(applyPrivacyLevel).mockRejectedValueOnce(new Error('privacy API unavailable'));

    await expect(
      seedBootPrivacyLevel(settings, new BentoMutationCoordinator()),
    ).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});
