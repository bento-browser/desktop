import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_PRIVACY_PREFS, PRIVACY_PRESETS } from '@shared/privacy-levels';
import {
  applyAdvancedSetting,
  detectPrivacyLevelFromSnapshot,
  readSearchEnginesSnapshot,
} from './ProtectionLevels';

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
