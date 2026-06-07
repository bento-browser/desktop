import type {
  PrivacyAdvancedKey,
  PrivacyProtectionLevel,
  PrivacySettings,
  SearchEngineId,
  SelectablePrivacyProtectionLevel,
} from '@shared/protocol';
import {
  ALLOWED_PRIVACY_PREFS,
  PRIVACY_PRESETS,
  browserPrivacyPathForAdvancedKey,
  isSelectablePrivacyLevel,
  prefNameForAdvancedKey,
  type BrowserPrivacyValue,
  type PrivacyPrefMap,
  type PrivacyPrefValue,
} from '@shared/privacy-levels';

type BrowserPrivacyPath = keyof (typeof PRIVACY_PRESETS)['standard']['browserPrivacy'] & string;

const SAFE_BROWSING_PREFS = [
  'browser.safebrowsing.malware.enabled',
  'browser.safebrowsing.phishing.enabled',
  'browser.safebrowsing.downloads.enabled',
] as const;

function getSetting(path: string): browser.types.Setting {
  const [area, setting] = path.split('.') as [string, string];
  const target = (
    browser.privacy as unknown as Record<string, Record<string, browser.types.Setting>>
  )[area]?.[setting];
  if (!target) throw new Error(`Unsupported browser.privacy setting: ${path}`);
  return target;
}

async function getBrowserPrivacy(path: string): Promise<BrowserPrivacyValue> {
  const result = await getSetting(path).get({});
  return result.value as BrowserPrivacyValue;
}

async function setBrowserPrivacy(path: string, value: BrowserPrivacyValue): Promise<void> {
  await getSetting(path).set({ value });
}

function sameValue(left: unknown, right: unknown): boolean {
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return left === right;
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function boolPref(snapshot: PrivacyPrefMap, name: string): boolean {
  return snapshot[name] === true;
}

function invertedBoolPref(snapshot: PrivacyPrefMap, name: string): boolean {
  return snapshot[name] !== true;
}

export async function applyPrivacyLevel(level: SelectablePrivacyProtectionLevel): Promise<void> {
  if (!isSelectablePrivacyLevel(level)) throw new Error(`Unsupported privacy level: ${level}`);
  const preset = PRIVACY_PRESETS[level];
  await Promise.all([
    ...Object.entries(preset.browserPrivacy).map(([path, value]) => setBrowserPrivacy(path, value)),
    browser.bentoPrivacy.setPrefs(preset.prefs),
  ]);
}

export async function applyAdvancedSetting(
  key: PrivacyAdvancedKey,
  value: boolean | string,
): Promise<void> {
  if (key === 'safeBrowsingEnabled') {
    if (typeof value !== 'boolean') throw new Error('safeBrowsingEnabled expects a boolean');
    await browser.bentoPrivacy.setPrefs(
      Object.fromEntries(SAFE_BROWSING_PREFS.map((pref) => [pref, value])),
    );
    return;
  }

  if (key === 'webglEnabled') {
    if (typeof value !== 'boolean') throw new Error('webglEnabled expects a boolean');
    await browser.bentoPrivacy.setPrefs({ 'webgl.disabled': !value });
    return;
  }

  const browserPrivacyPath = browserPrivacyPathForAdvancedKey(key);
  if (browserPrivacyPath) {
    await setBrowserPrivacy(browserPrivacyPath, value as BrowserPrivacyValue);
    return;
  }

  const prefName = prefNameForAdvancedKey(key);
  if (!prefName) throw new Error(`Unsupported advanced privacy key: ${key}`);
  await browser.bentoPrivacy.setPrefs({ [prefName]: value as PrivacyPrefValue });
}

async function readBrowserPrivacySnapshot(): Promise<
  Record<BrowserPrivacyPath, BrowserPrivacyValue>
> {
  const paths = Object.keys(PRIVACY_PRESETS.standard.browserPrivacy) as BrowserPrivacyPath[];
  const entries = await Promise.all(
    paths.map(async (path) => [path, await getBrowserPrivacy(path)]),
  );
  return Object.fromEntries(entries) as Record<BrowserPrivacyPath, BrowserPrivacyValue>;
}

async function readPrefSnapshot(): Promise<PrivacyPrefMap> {
  return browser.bentoPrivacy.getPrefs([...ALLOWED_PRIVACY_PREFS]);
}

export function detectPrivacyLevelFromSnapshot(
  browserPrivacy: Record<string, BrowserPrivacyValue>,
  prefs: PrivacyPrefMap,
): PrivacyProtectionLevel {
  for (const [level, preset] of Object.entries(PRIVACY_PRESETS) as [
    SelectablePrivacyProtectionLevel,
    (typeof PRIVACY_PRESETS)[SelectablePrivacyProtectionLevel],
  ][]) {
    const browserMatches = Object.entries(preset.browserPrivacy).every(([path, value]) =>
      sameValue(browserPrivacy[path], value),
    );
    const prefsMatch = Object.entries(preset.prefs).every(([name, value]) =>
      sameValue(prefs[name], value),
    );
    if (browserMatches && prefsMatch) return level;
  }
  return 'custom';
}

export async function detectPrivacyLevel(): Promise<PrivacyProtectionLevel> {
  const [browserPrivacy, prefs] = await Promise.all([
    readBrowserPrivacySnapshot(),
    readPrefSnapshot(),
  ]);
  return detectPrivacyLevelFromSnapshot(browserPrivacy, prefs);
}

export async function readPrivacySnapshot(): Promise<PrivacySettings> {
  const [browserPrivacy, prefs, engines, defaultSearchEngine] = await Promise.all([
    readBrowserPrivacySnapshot(),
    readPrefSnapshot(),
    browser.bentoPrivacy.getSearchEngines(),
    browser.bentoPrivacy.getDefaultSearchEngine(),
  ]);
  const safeBrowsingEnabled = SAFE_BROWSING_PREFS.every((pref) => boolPref(prefs, pref));
  const detectedDefault =
    typeof defaultSearchEngine === 'string' && defaultSearchEngine.length > 0
      ? defaultSearchEngine
      : 'ddg';
  return {
    protectionLevel: detectPrivacyLevelFromSnapshot(browserPrivacy, prefs),
    defaultSearchEngine: detectedDefault,
    availableSearchEngines: engines,
    safeBrowsingEnabled,
    drmEnabled: boolPref(prefs, 'media.eme.enabled'),
    sanitizeOnShutdown: boolPref(prefs, 'privacy.sanitize.sanitizeOnShutdown'),
    resistFingerprinting: browserPrivacy['websites.resistFingerprinting'] === true,
    letterboxing: boolPref(prefs, 'privacy.resistFingerprinting.letterboxing'),
    networkPrediction: browserPrivacy['network.networkPredictionEnabled'] === true,
    peerConnection: browserPrivacy['network.peerConnectionEnabled'] === true,
    webRTCIPHandlingPolicy: String(browserPrivacy['network.webRTCIPHandlingPolicy'] ?? 'default'),
    httpsOnlyMode: String(browserPrivacy['network.httpsOnlyMode'] ?? 'never'),
    searchSuggestionsEnabled: boolPref(prefs, 'browser.search.suggest.enabled'),
    diskCacheEnabled: boolPref(prefs, 'browser.cache.disk.enable'),
    webglEnabled: invertedBoolPref(prefs, 'webgl.disabled'),
    webgpuEnabled: boolPref(prefs, 'dom.webgpu.enabled'),
    passwordSavingEnabled: browserPrivacy['services.passwordSavingEnabled'] === true,
    formHistoryEnabled: boolPref(prefs, 'browser.formfill.enable'),
  };
}

export async function setDefaultSearchEngine(id: SearchEngineId): Promise<void> {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`Unsupported search engine: ${id}`);
  }
  await browser.bentoPrivacy.setDefaultSearchEngine(id);
}
