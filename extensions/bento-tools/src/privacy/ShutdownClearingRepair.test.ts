import { afterEach, describe, expect, it, vi } from 'vitest';
import { SHUTDOWN_CLEAR_PREFS } from '@shared/privacy-levels';
import { repairLegacyShutdownClearing } from './ShutdownClearingRepair';
import { FIREFOX_SHUTDOWN_DEFAULTS, createFakePrefs } from './testPrefs';

const FLAG = 'bento.shutdownClearingRepaired';

function setup(prefs: Record<string, boolean>, flag = false) {
  const fake = createFakePrefs({ ...FIREFOX_SHUTDOWN_DEFAULTS, ...prefs });
  const storage: Record<string, unknown> = flag ? { [FLAG]: true } : {};
  const get = vi.fn(async (key: string) => (key in storage ? { [key]: storage[key] } : {}));
  const set = vi.fn(async (items: Record<string, unknown>) => void Object.assign(storage, items));
  vi.stubGlobal('browser', { bentoPrivacy: fake.api, storage: { local: { get, set } } });
  return { ...fake, storage };
}

function shutdownPrefs(store: Map<string, unknown>) {
  return Object.fromEntries(
    Object.keys(SHUTDOWN_CLEAR_PREFS).map((name) => [name, store.get(name)]),
  );
}

describe('repairLegacyShutdownClearing', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes the bundle for a switch turned on before Firefox ran its own migration', async () => {
    const { store, storage } = setup({ 'privacy.sanitize.sanitizeOnShutdown': true });
    await repairLegacyShutdownClearing();
    expect(shutdownPrefs(store)).toEqual(SHUTDOWN_CLEAR_PREFS);
    expect(storage[FLAG]).toBe(true);
  });

  it('writes the bundle after the migration copied form data and the flag', async () => {
    const { store } = setup({
      'privacy.sanitize.sanitizeOnShutdown': true,
      'privacy.sanitize.clearOnShutdown.hasMigratedToNewPrefs3': true,
      'privacy.clearOnShutdown_v2.formdata': true,
    });
    await repairLegacyShutdownClearing();
    expect(shutdownPrefs(store)).toEqual(SHUTDOWN_CLEAR_PREFS);
  });

  it('leaves the prefs alone when clearing is off, and still marks the profile done', async () => {
    const { api, storage } = setup({});
    await repairLegacyShutdownClearing();
    expect(api.setPrefs).not.toHaveBeenCalled();
    expect(storage[FLAG]).toBe(true);
  });

  it('does nothing once the flag is set', async () => {
    const { api } = setup({ 'privacy.sanitize.sanitizeOnShutdown': true }, true);
    await repairLegacyShutdownClearing();
    expect(api.getPrefs).not.toHaveBeenCalled();
    expect(api.setPrefs).not.toHaveBeenCalled();
  });

  it('retries next launch when the write fails', async () => {
    const { api, storage } = setup({ 'privacy.sanitize.sanitizeOnShutdown': true });
    api.setPrefs.mockRejectedValueOnce(new Error('experiment unavailable'));
    await expect(repairLegacyShutdownClearing()).rejects.toThrow();
    expect(storage[FLAG]).toBeUndefined();
  });
});
