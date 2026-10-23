import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_PRIVACY_PREFS,
  PRIVACY_PRESETS,
  SHUTDOWN_CLEAR_PREFS,
} from '@shared/privacy-levels';
import {
  applyAdvancedSetting,
  detectPrivacyLevelFromSnapshot,
  readSearchEnginesSnapshot,
  snapshotAdvancedPrefs,
} from './ProtectionLevels';
import { FIREFOX_SHUTDOWN_DEFAULTS, createFakePrefs } from './testPrefs';

const FIREFOX_SHUTDOWN_DEFAULTS_WITH_COOKIES_OFF = {
  ...FIREFOX_SHUTDOWN_DEFAULTS,
  'privacy.clearOnShutdown_v2.cookiesAndStorage': false,
};

describe('privacy protection levels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('includes the expected Standard browser privacy settings and prefs', () => {
    expect(PRIVACY_PRESETS.standard.browserPrivacy['websites.trackingProtectionMode']).toBe(
      'always',
    );
    expect(PRIVACY_PRESETS.standard.browserPrivacy['websites.cookieConfig']).toEqual({
      behavior: 'reject_trackers_and_partition_foreign',
      nonPersistentCookies: false,
    });
    expect(PRIVACY_PRESETS.standard.browserPrivacy['network.networkPredictionEnabled']).toBe(false);
    expect(PRIVACY_PRESETS.standard.prefs['browser.search.suggest.enabled']).toBe(false);
    expect(PRIVACY_PRESETS.standard.prefs['browser.safebrowsing.malware.enabled']).toBe(true);
    expect(PRIVACY_PRESETS.standard.browserPrivacy['network.httpsOnlyMode']).toBe('always');
    expect(PRIVACY_PRESETS.standard.prefs['dom.security.https_only_mode']).toBe(true);
    expect(PRIVACY_PRESETS.standard.prefs).not.toHaveProperty(
      'browser.safebrowsing.downloads.remote.enabled',
    );
    expect(ALLOWED_PRIVACY_PREFS).toContain('browser.safebrowsing.downloads.remote.enabled');
    expect(PRIVACY_PRESETS.hardened.prefs['browser.safebrowsing.malware.enabled']).toBe(true);
    expect(PRIVACY_PRESETS.hardened.prefs['browser.safebrowsing.phishing.enabled']).toBe(true);
    expect(PRIVACY_PRESETS.hardened.prefs['browser.safebrowsing.downloads.enabled']).toBe(true);
    expect(PRIVACY_PRESETS.standard.prefs['network.trr.mode']).toBe(5);
  });

  it('detects exact preset matches', () => {
    for (const [level, preset] of Object.entries(PRIVACY_PRESETS)) {
      expect(detectPrivacyLevelFromSnapshot(preset.browserPrivacy, preset.prefs)).toBe(level);
    }
  });

  it('detects Custom when any preset value diverges', () => {
    expect(
      detectPrivacyLevelFromSnapshot(PRIVACY_PRESETS.enhanced.browserPrivacy, {
        ...PRIVACY_PRESETS.enhanced.prefs,
        'media.eme.enabled': false,
      }),
    ).toBe('custom');
  });

  it('keeps remote download reputation independent of preset detection', () => {
    expect(
      detectPrivacyLevelFromSnapshot(PRIVACY_PRESETS.standard.browserPrivacy, {
        ...PRIVACY_PRESETS.standard.prefs,
        'browser.safebrowsing.downloads.remote.enabled': true,
      }),
    ).toBe('standard');
  });

  it('writes remote download reputation independently from local Safe Browsing', async () => {
    const setPrefs = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', { bentoPrivacy: { setPrefs } });

    await applyAdvancedSetting('remoteSafeBrowsingEnabled', true);

    expect(setPrefs).toHaveBeenCalledWith({
      'browser.safebrowsing.downloads.remote.enabled': true,
    });
  });

  it('clears only cookies, site data and cache on quit in Hardened', () => {
    const { prefs } = PRIVACY_PRESETS.hardened;
    expect(prefs['privacy.sanitize.sanitizeOnShutdown']).toBe(true);
    expect(prefs['privacy.clearOnShutdown_v2.cookiesAndStorage']).toBe(true);
    expect(prefs['privacy.clearOnShutdown_v2.cache']).toBe(true);
    expect(prefs['privacy.clearOnShutdown_v2.browsingHistoryAndDownloads']).toBe(false);
    expect(prefs['privacy.clearOnShutdown_v2.formdata']).toBe(false);
    expect(prefs['privacy.clearOnShutdown_v2.siteSettings']).toBe(false);
    // Without this the first shutdown rewrites the v2 prefs from Firefox's legacy defaults.
    expect(prefs['privacy.sanitize.clearOnShutdown.hasMigratedToNewPrefs3']).toBe(true);
    expect(PRIVACY_PRESETS.standard.prefs['privacy.sanitize.sanitizeOnShutdown']).toBe(false);
    expect(PRIVACY_PRESETS.enhanced.prefs['privacy.sanitize.sanitizeOnShutdown']).toBe(false);
  });

  it('puts the Hardened-only prefs back to Firefox defaults in Standard and Enhanced', () => {
    for (const level of ['standard', 'enhanced'] as const) {
      const { prefs } = PRIVACY_PRESETS[level];
      expect(prefs['network.http.referer.XOriginPolicy']).toBe(0);
      expect(prefs['dom.security.https_only_mode_send_http_background_request']).toBe(true);
    }
    const { hardened, standard } = PRIVACY_PRESETS;
    expect(hardened.prefs['network.http.referer.XOriginPolicy']).toBe(2);
    expect(hardened.prefs['dom.security.https_only_mode_send_http_background_request']).toBe(false);
    // Detection tells a stepped-up Standard from Standard.
    expect(
      detectPrivacyLevelFromSnapshot(standard.browserPrivacy, {
        ...standard.prefs,
        'network.http.referer.XOriginPolicy': 2,
      }),
    ).toBe('custom');
    expect(
      detectPrivacyLevelFromSnapshot(hardened.browserPrivacy, {
        ...hardened.prefs,
        'dom.security.https_only_mode_send_http_background_request': true,
      }),
    ).toBe('custom');
  });

  it('turns shutdown clearing on with the whole pref set and off with the master pref', async () => {
    const { api } = createFakePrefs(FIREFOX_SHUTDOWN_DEFAULTS);
    vi.stubGlobal('browser', { bentoPrivacy: api });

    await applyAdvancedSetting('sanitizeOnShutdown', true);
    expect(api.setPrefs).toHaveBeenLastCalledWith(SHUTDOWN_CLEAR_PREFS);

    await applyAdvancedSetting('sanitizeOnShutdown', false);
    expect(api.setPrefs).toHaveBeenLastCalledWith({ 'privacy.sanitize.sanitizeOnShutdown': false });
  });

  it('rejects when Firefox keeps its own value for a locked pref', async () => {
    const { api } = createFakePrefs(FIREFOX_SHUTDOWN_DEFAULTS, [
      'privacy.clearOnShutdown_v2.browsingHistoryAndDownloads',
    ]);
    vi.stubGlobal('browser', { bentoPrivacy: api });

    await expect(applyAdvancedSetting('sanitizeOnShutdown', true)).rejects.toThrow(
      'privacy.clearOnShutdown_v2.browsingHistoryAndDownloads',
    );
  });

  it('snapshots the raw group values and puts them back, and has no snapshot for single prefs', async () => {
    const { api, store } = createFakePrefs({
      ...FIREFOX_SHUTDOWN_DEFAULTS,
      'privacy.clearOnShutdown_v2.cookiesAndStorage': false,
    });
    vi.stubGlobal('browser', { bentoPrivacy: api });

    const restore = await snapshotAdvancedPrefs('sanitizeOnShutdown');
    await applyAdvancedSetting('sanitizeOnShutdown', true);
    expect(store.get('privacy.clearOnShutdown_v2.cookiesAndStorage')).toBe(true);
    await restore?.();
    expect(Object.fromEntries(store)).toEqual(FIREFOX_SHUTDOWN_DEFAULTS_WITH_COOKIES_OFF);
    await expect(snapshotAdvancedPrefs('drmEnabled')).resolves.toBeNull();
  });

  it('writes the HTTPS-only prefs because browser.privacy cannot set the mode', async () => {
    const { api } = createFakePrefs({});
    const { setPrefs } = api;
    const set = vi.fn().mockResolvedValue(false);
    vi.stubGlobal('browser', {
      bentoPrivacy: api,
      privacy: { network: { httpsOnlyMode: { set } } },
    });

    await applyAdvancedSetting('httpsOnlyMode', 'never');
    expect(setPrefs).toHaveBeenLastCalledWith({
      'dom.security.https_only_mode': false,
      'dom.security.https_only_mode_pbm': false,
    });

    await applyAdvancedSetting('httpsOnlyMode', 'always');
    expect(setPrefs).toHaveBeenLastCalledWith({
      'dom.security.https_only_mode': true,
      'dom.security.https_only_mode_pbm': true,
    });

    await applyAdvancedSetting('httpsOnlyMode', 'private_browsing');
    expect(setPrefs).toHaveBeenLastCalledWith({
      'dom.security.https_only_mode': false,
      'dom.security.https_only_mode_pbm': true,
    });

    await expect(applyAdvancedSetting('httpsOnlyMode', 'sometimes')).rejects.toThrow();
    expect(set).not.toHaveBeenCalled();
  });

  it('keeps all preset prefs in the privileged allowlist', () => {
    const allowed = new Set(ALLOWED_PRIVACY_PREFS);
    for (const preset of Object.values(PRIVACY_PRESETS)) {
      for (const pref of Object.keys(preset.prefs)) {
        expect(allowed.has(pref), pref).toBe(true);
      }
    }
  });

  it('reads the current default and visible search engines', async () => {
    vi.stubGlobal('browser', {
      bentoPrivacy: {
        getSearchEngines: vi.fn().mockResolvedValue([
          {
            id: 'ddg',
            name: 'DuckDuckGo',
            isDefault: false,
            iconUrl: 'data:image/png;base64,ddg',
          },
          { id: 'google', name: 'Google', isDefault: true },
        ]),
        getDefaultSearchEngine: vi.fn().mockResolvedValue('google'),
      },
    });

    await expect(readSearchEnginesSnapshot()).resolves.toEqual({
      defaultSearchEngine: 'google',
      availableSearchEngines: [
        {
          id: 'ddg',
          name: 'DuckDuckGo',
          isDefault: false,
          iconUrl: 'data:image/png;base64,ddg',
        },
        { id: 'google', name: 'Google', isDefault: true },
      ],
    });
  });

  it('falls back to ddg when default search engine is empty', async () => {
    vi.stubGlobal('browser', {
      bentoPrivacy: {
        getSearchEngines: vi.fn().mockResolvedValue([
          { id: 'ddg', name: 'DuckDuckGo', isDefault: false },
          { id: 'google', name: 'Google', isDefault: true },
        ]),
        getDefaultSearchEngine: vi.fn().mockResolvedValue(''),
      },
    });

    await expect(readSearchEnginesSnapshot()).resolves.toEqual({
      defaultSearchEngine: 'ddg',
      availableSearchEngines: [
        { id: 'ddg', name: 'DuckDuckGo', isDefault: true },
        { id: 'google', name: 'Google', isDefault: false },
      ],
    });
  });
});
