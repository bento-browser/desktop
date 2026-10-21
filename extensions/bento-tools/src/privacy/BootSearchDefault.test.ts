import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../settings/SettingsStore';
import { applyBootDefaultSearchEngine, bootDefaultSearchEngine } from './BootSearchDefault';

const STORAGE_KEY = 'bento.settings';

/** A profile's storage.local, shared across "boots", plus a recording search experiment. */
function stubProfile(overrides?: Record<string, unknown>) {
  const stored: Record<string, unknown> = overrides
    ? { [STORAGE_KEY]: { version: 2, overrides } }
    : {};
  const setDefaultSearchEngine = vi.fn<(id: string) => Promise<void>>(async () => undefined);
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async () => ({ ...stored })),
        set: vi.fn(async (payload: Record<string, unknown>) => {
          Object.assign(stored, payload);
        }),
      },
    },
    bentoPrivacy: { setDefaultSearchEngine },
  });
  return { setDefaultSearchEngine };
}

async function boot(): Promise<SettingsStore> {
  const settings = new SettingsStore();
  await settings.init();
  return settings;
}

describe('boot default search engine', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('seeds ddg on a fresh profile, which has no override to apply', async () => {
    const { setDefaultSearchEngine } = stubProfile();
    const settings = await boot();

    expect(settings.hasOverride('defaultSearchEngine')).toBe(false);
    await applyBootDefaultSearchEngine(settings);

    expect(setDefaultSearchEngine).toHaveBeenCalledExactlyOnceWith('ddg');
  });

  it('applies the stored engine, with onboarding finished or not', async () => {
    for (const welcomeSeen of [false, true]) {
      const { setDefaultSearchEngine } = stubProfile({ defaultSearchEngine: 'bing', welcomeSeen });
      await applyBootDefaultSearchEngine(await boot());
      expect(setDefaultSearchEngine).toHaveBeenCalledExactlyOnceWith('bing');
    }
  });

  it('applies nothing once onboarding finished without an override', async () => {
    const { setDefaultSearchEngine } = stubProfile({ welcomeSeen: true });
    const settings = await boot();

    expect(bootDefaultSearchEngine(settings)).toBeNull();
    await applyBootDefaultSearchEngine(settings);

    expect(setDefaultSearchEngine).not.toHaveBeenCalled();
  });

  it('keeps Firefox as it is and does not throw when the engine is unavailable', async () => {
    const { setDefaultSearchEngine } = stubProfile();
    setDefaultSearchEngine.mockRejectedValue(new Error('Search engine is not available: ddg'));

    await expect(applyBootDefaultSearchEngine(await boot())).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledOnce();
  });

  it('does not reapply after ddg was picked during onboarding, which stores no override', async () => {
    const { setDefaultSearchEngine } = stubProfile();
    const onboarding = await boot();
    await onboarding.update({ defaultSearchEngine: 'ddg' });
    expect(onboarding.hasOverride('defaultSearchEngine')).toBe(false);
    await onboarding.update({ welcomeSeen: true });

    await applyBootDefaultSearchEngine(await boot());

    expect(setDefaultSearchEngine).not.toHaveBeenCalled();
  });
});
