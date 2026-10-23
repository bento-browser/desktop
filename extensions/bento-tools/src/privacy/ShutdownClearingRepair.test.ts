import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHUTDOWN_CLEAR_PREFS } from '@shared/privacy-levels';
import { repairLegacyShutdownClearing } from './ShutdownClearingRepair';
import { FIREFOX_SHUTDOWN_DEFAULTS, createFakePrefs } from './testPrefs';

const FLAG = 'bento.shutdownClearingRepaired';
const MASTER = 'privacy.sanitize.sanitizeOnShutdown';
const MIGRATED = 'privacy.sanitize.clearOnShutdown.hasMigratedToNewPrefs3';
const FORMDATA = 'privacy.clearOnShutdown_v2.formdata';
const HISTORY = 'privacy.clearOnShutdown_v2.browsingHistoryAndDownloads';
const COOKIES = 'privacy.clearOnShutdown_v2.cookiesAndStorage';

function setup(prefs: Record<string, boolean>, { flag = false, locked = [] as string[] } = {}) {
  const fake = createFakePrefs({ ...FIREFOX_SHUTDOWN_DEFAULTS, ...prefs }, locked);
  const storage: Record<string, unknown> = flag ? { [FLAG]: true } : {};
  const get = vi.fn(async (key: string) => (key in storage ? { [key]: storage[key] } : {}));
  const set = vi.fn(async (items: Record<string, unknown>) => void Object.assign(storage, items));
  vi.stubGlobal('browser', { bentoPrivacy: fake.api, storage: { local: { get, set } } });
  return { ...fake, storage, before: Object.fromEntries(fake.store) };
}

function bundleOf(store: Map<string, unknown>) {
  return Object.fromEntries(
    Object.keys(SHUTDOWN_CLEAR_PREFS).map((name) => [name, store.get(name)]),
  );
}

describe('repairLegacyShutdownClearing', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('writes the bundle for a switch turned on before Firefox ran its own migration', async () => {
    const { store, storage } = setup({ [MASTER]: true });
    await repairLegacyShutdownClearing();
    expect(bundleOf(store)).toEqual(SHUTDOWN_CLEAR_PREFS);
    expect(storage[FLAG]).toBe(true);
  });

  it('writes the bundle after Firefox migrated the defaults (form data copied, flag set)', async () => {
    const { store } = setup({ [MASTER]: true, [MIGRATED]: true, [FORMDATA]: true });
    await repairLegacyShutdownClearing();
    expect(bundleOf(store)).toEqual(SHUTDOWN_CLEAR_PREFS);
  });

  it.each([
    [
      'history only, cookies and cache kept',
      { [HISTORY]: true, [COOKIES]: false, 'privacy.clearOnShutdown_v2.cache': false },
    ],
    ['cookies only', { [HISTORY]: false }],
    ['site settings added', { 'privacy.clearOnShutdown_v2.siteSettings': true }],
    ['migrated but form data kept', { [MIGRATED]: true, [FORMDATA]: false }],
    ['form data on without a migration', { [FORMDATA]: true }],
  ])('leaves a custom setup alone: %s', async (_name, custom) => {
    const { api, store, storage, before } = setup({ [MASTER]: true, ...custom });
    await repairLegacyShutdownClearing();
    expect(api.setPrefs).not.toHaveBeenCalled();
    expect(Object.fromEntries(store)).toEqual(before);
    expect(storage[FLAG]).toBe(true);
  });

  it('leaves the prefs alone when clearing is off, and still marks the profile done', async () => {
    const { api, storage } = setup({});
    await repairLegacyShutdownClearing();
    expect(api.setPrefs).not.toHaveBeenCalled();
    expect(storage[FLAG]).toBe(true);
  });

  it('does nothing once the flag is set', async () => {
    const { api } = setup({ [MASTER]: true }, { flag: true });
    await repairLegacyShutdownClearing();
    expect(api.getPrefs).not.toHaveBeenCalled();
    expect(api.setPrefs).not.toHaveBeenCalled();
  });

  it('puts the prefs back and retries next launch when a locked pref refuses the write', async () => {
    // With the migration flag stuck at false, Firefox's next shutdown would turn history back on.
    const { store, storage, before } = setup({ [MASTER]: true }, { locked: [MIGRATED] });
    await repairLegacyShutdownClearing();
    expect(Object.fromEntries(store)).toEqual(before);
    expect(storage[FLAG]).toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });

  it('retries next launch when the write fails', async () => {
    const { api, storage } = setup({ [MASTER]: true });
    api.setPrefs.mockRejectedValueOnce(new Error('experiment unavailable'));
    await expect(repairLegacyShutdownClearing()).resolves.toBeUndefined();
    expect(storage[FLAG]).toBeUndefined();
  });
});
