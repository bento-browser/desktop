import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_PRIVACY_PREFS, PRIVACY_PRESETS } from '@shared/privacy-levels';
import { detectPrivacyLevelFromSnapshot, readSearchEnginesSnapshot } from './ProtectionLevels';

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
    expect(PRIVACY_PRESETS.standard.prefs['browser.safebrowsing.downloads.remote.enabled']).toBe(
      false,
    );
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
