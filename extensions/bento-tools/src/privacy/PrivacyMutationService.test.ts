import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRIVACY_PRESETS, SHUTDOWN_CLEAR_PREFS } from '@shared/privacy-levels';
import type { PrivacyPrefMap } from '@shared/privacy-levels';
import type { SettingsStore } from '../settings/SettingsStore';
import { PrivacyMutationService } from './PrivacyMutationService';
import { FIREFOX_SHUTDOWN_DEFAULTS, createFakePrefs } from './testPrefs';

/** Installs fake `browser.bentoPrivacy` and `browser.privacy` APIs over one pref store. */
function setup(initial: PrivacyPrefMap, locked: readonly string[] = []) {
  const fake = createFakePrefs(
    { ...PRIVACY_PRESETS.standard.prefs, ...FIREFOX_SHUTDOWN_DEFAULTS, ...initial },
    locked,
  );
  const privacy: Record<string, Record<string, { get(): Promise<{ value: unknown }> }>> = {};
  for (const [path, value] of Object.entries(PRIVACY_PRESETS.standard.browserPrivacy)) {
    const [area, name] = path.split('.') as [string, string];
    privacy[area] ??= {};
    privacy[area][name] = {
      get: async () => ({
        value:
          path === 'network.httpsOnlyMode'
            ? fake.store.get('dom.security.https_only_mode')
              ? 'always'
              : fake.store.get('dom.security.https_only_mode_pbm')
                ? 'private_browsing'
                : 'never'
            : value,
      }),
    };
  }
  vi.stubGlobal('browser', {
    bentoPrivacy: {
      ...fake.api,
      getSearchEngines: async () => [],
      getDefaultSearchEngine: async () => 'ddg',
    },
    privacy,
  });
  const service = new PrivacyMutationService({ update: vi.fn() } as unknown as SettingsStore);
  return { ...fake, service };
}

function shutdownPrefs(store: Map<string, unknown>) {
  return Object.fromEntries(
    Object.keys(SHUTDOWN_CLEAR_PREFS).map((name) => [name, store.get(name)]),
  );
}

describe('PrivacyMutationService.setAdvanced for the shutdown switch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes the whole bundle and reports success', async () => {
    const { service, store } = setup({});
    const outcome = await service.setAdvanced('sanitizeOnShutdown', true);
    expect(outcome.state).toBe('succeeded');
    expect(shutdownPrefs(store)).toEqual(SHUTDOWN_CLEAR_PREFS);
  });

  it('fails and restores the raw prefs when a policy locks one item pref', async () => {
    // The user keeps site data and history clearing is locked on, so enabling cannot do what it says.
    const raw = { 'privacy.clearOnShutdown_v2.cookiesAndStorage': false };
    const { service, store } = setup(raw, [
      'privacy.clearOnShutdown_v2.browsingHistoryAndDownloads',
    ]);
    const before = shutdownPrefs(store);
    const outcome = await service.setAdvanced('sanitizeOnShutdown', true);
    expect(outcome.state).toBe('partial');
    expect(outcome.component.state).toBe('failed');
    expect(shutdownPrefs(store)).toEqual(before);
    expect(outcome.value.sanitizeOnShutdown).toBe(false);
  });

  it('restores the raw item prefs, not the old boolean, when a later step fails', async () => {
    // Switch on with the user's own item choices (site data off, history kept).
    const raw = {
      'privacy.sanitize.sanitizeOnShutdown': true,
      'privacy.sanitize.clearOnShutdown.hasMigratedToNewPrefs3': true,
      'privacy.clearOnShutdown_v2.cookiesAndStorage': false,
      'privacy.clearOnShutdown_v2.formdata': true,
    };
    const { service, store, api } = setup(raw);
    const before = shutdownPrefs(store);
    // Turning it off succeeds, then the snapshot read that follows the write fails once.
    const realGet = api.getPrefs.getMockImplementation()!;
    let writes = 0;
    api.setPrefs.mockImplementation(async (values) => {
      writes += 1;
      for (const [name, value] of Object.entries(values)) store.set(name, value);
    });
    api.getPrefs.mockImplementation(async (names) => {
      if (writes === 1 && names.length > 10) {
        writes += 1;
        throw new Error('read failed');
      }
      return realGet(names);
    });
    const outcome = await service.setAdvanced('sanitizeOnShutdown', false);
    expect(outcome.state).toBe('partial');
    expect(shutdownPrefs(store)).toEqual(before);
    expect(store.get('privacy.clearOnShutdown_v2.cookiesAndStorage')).toBe(false);
    expect(store.get('privacy.clearOnShutdown_v2.formdata')).toBe(true);
  });
});

describe('PrivacyMutationService.setAdvanced for HTTPS-only mode', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('turns it off and on through the prefs', async () => {
    const { service, store } = setup({});
    expect((await service.setAdvanced('httpsOnlyMode', 'never')).state).toBe('succeeded');
    expect([
      store.get('dom.security.https_only_mode'),
      store.get('dom.security.https_only_mode_pbm'),
    ]).toEqual([false, false]);
    expect((await service.setAdvanced('httpsOnlyMode', 'always')).state).toBe('succeeded');
    expect([
      store.get('dom.security.https_only_mode'),
      store.get('dom.security.https_only_mode_pbm'),
    ]).toEqual([true, true]);
  });

  it('puts both prefs back as they were when one is locked', async () => {
    // Main on, private-window pref locked on: Off can only half apply.
    const { service, store } = setup({}, ['dom.security.https_only_mode_pbm']);
    const outcome = await service.setAdvanced('httpsOnlyMode', 'never');
    expect(outcome.state).toBe('partial');
    expect([
      store.get('dom.security.https_only_mode'),
      store.get('dom.security.https_only_mode_pbm'),
    ]).toEqual([true, true]);
  });
});
