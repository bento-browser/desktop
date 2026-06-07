import type {
  PrivacyAdvancedKey,
  PrivacyProtectionLevel,
  SelectablePrivacyProtectionLevel,
} from './protocol';

export type PrivacyPrefValue = boolean | number | string;
export type PrivacyPrefMap = Record<string, PrivacyPrefValue>;
export type BrowserPrivacyValue =
  | boolean
  | string
  | { behavior: 'reject_trackers_and_partition_foreign'; nonPersistentCookies: false };

export interface PrivacyLevelMetadata {
  id: SelectablePrivacyProtectionLevel;
  label: string;
  summary: string;
}

export interface PrivacyLevelDetails extends PrivacyLevelMetadata {
  bestFor: string;
  benefits: readonly string[];
  caveats: readonly string[];
}

export interface PrivacyPreset {
  browserPrivacy: Record<string, BrowserPrivacyValue>;
  prefs: PrivacyPrefMap;
}

export const PRIVACY_LEVELS: readonly PrivacyLevelMetadata[] = [
  {
    id: 'standard',
    label: 'Standard',
    summary: 'Strong defaults with the fewest site compatibility surprises.',
  },
  {
    id: 'enhanced',
    label: 'Enhanced',
    summary: 'Adds HTTPS-only mode and tighter WebRTC exposure.',
  },
  {
    id: 'hardened',
    label: 'Hardened',
    summary: 'Reduces persistence and fingerprinting surfaces; more sites may need exceptions.',
  },
] as const;

export const SELECTABLE_PRIVACY_LEVELS = PRIVACY_LEVELS.map((level) => level.id);

export const PRIVACY_LEVEL_DETAILS: Record<SelectablePrivacyProtectionLevel, PrivacyLevelDetails> =
  {
    standard: {
      id: 'standard',
      label: 'Standard',
      summary: 'Strong defaults with the fewest site compatibility surprises.',
      bestFor: 'Best for most users and the default for fresh profiles.',
      benefits: [
        'Strict tracking protection, tracker-cookie partitioning, GPC, query stripping, and uBlock Origin are enabled.',
        'Search suggestions and speculative network connections are off.',
        'Local Safe Browsing checks stay on; remote download lookups stay off.',
        'Highest compatibility of the three levels.',
      ],
      caveats: [
        'HTTPS-only mode and resist fingerprinting are off.',
        'WebRTC, DRM, disk cache, WebGL/WebGPU, password saving, and form history stay enabled.',
      ],
    },
    enhanced: {
      id: 'enhanced',
      label: 'Enhanced',
      summary: 'Adds HTTPS-only mode and tighter WebRTC exposure.',
      bestFor: 'Best for stronger browser-level privacy with moderate compatibility risk.',
      benefits: [
        'Includes Standard protections.',
        'Turns on HTTPS-only mode and resist fingerprinting.',
        'Restricts WebRTC IP handling with disable_non_proxied_udp.',
      ],
      caveats: [
        'HTTP-only sites and local device pages may need manual approval.',
        'Fingerprinting resistance can break or alter some sites.',
        'Some video-call or peer-to-peer apps may behave differently.',
        'DRM, disk cache, WebGL/WebGPU, password saving, and form history stay enabled.',
      ],
    },
    hardened: {
      id: 'hardened',
      label: 'Hardened',
      summary: 'Reduces persistence and fingerprinting surfaces; more sites may need exceptions.',
      bestFor: 'Best for maximum Bento hardening when site breakage is acceptable.',
      benefits: [
        'Includes Enhanced protections.',
        'Adds letterboxing and disables WebRTC peer connections.',
        'Disables DRM, disk cache, WebGL/WebGPU, password saving, and form history.',
        'Clears cookies, offline site data, and cache on shutdown.',
      ],
      caveats: [
        'Video calls, WebRTC apps, and DRM streaming sites will break.',
        'Maps, games, design tools, and 3D demos that need WebGL/WebGPU may fail.',
        'Sites may forget sessions after shutdown.',
        'Local Safe Browsing is off, so phishing and malware protection depends more on uBlock Origin and user judgment.',
      ],
    },
  } as const;

export const ADVANCED_KEY_TO_PREF: Partial<Record<PrivacyAdvancedKey, string>> = {
  safeBrowsingEnabled: 'browser.safebrowsing.malware.enabled',
  drmEnabled: 'media.eme.enabled',
  sanitizeOnShutdown: 'privacy.sanitize.sanitizeOnShutdown',
  letterboxing: 'privacy.resistFingerprinting.letterboxing',
  searchSuggestionsEnabled: 'browser.search.suggest.enabled',
  diskCacheEnabled: 'browser.cache.disk.enable',
  webglEnabled: 'webgl.disabled',
  webgpuEnabled: 'dom.webgpu.enabled',
  formHistoryEnabled: 'browser.formfill.enable',
};

export const ADVANCED_KEY_TO_BROWSER_PRIVACY: Partial<Record<PrivacyAdvancedKey, string>> = {
  resistFingerprinting: 'websites.resistFingerprinting',
  networkPrediction: 'network.networkPredictionEnabled',
  peerConnection: 'network.peerConnectionEnabled',
  webRTCIPHandlingPolicy: 'network.webRTCIPHandlingPolicy',
  httpsOnlyMode: 'network.httpsOnlyMode',
  passwordSavingEnabled: 'services.passwordSavingEnabled',
};

export const PRIVACY_PRESETS: Record<SelectablePrivacyProtectionLevel, PrivacyPreset> = {
  standard: {
    browserPrivacy: {
      'websites.trackingProtectionMode': 'always',
      'websites.cookieConfig': {
        behavior: 'reject_trackers_and_partition_foreign',
        nonPersistentCookies: false,
      },
      'websites.resistFingerprinting': false,
      'network.networkPredictionEnabled': false,
      'network.peerConnectionEnabled': true,
      'network.webRTCIPHandlingPolicy': 'default',
      'network.httpsOnlyMode': 'never',
      'network.globalPrivacyControl': true,
      'services.passwordSavingEnabled': true,
    },
    prefs: {
      'browser.cache.disk.enable': true,
      'browser.formfill.enable': true,
      'browser.ml.enable': false,
      'browser.ml.chat.enabled': false,
      'browser.newtabpage.activity-stream.discoverystream.enabled': false,
      'browser.newtabpage.activity-stream.showSponsored': false,
      'browser.newtabpage.activity-stream.showSponsoredTopSites': false,
      'browser.places.speculativeConnect.enabled': false,
      'browser.safebrowsing.downloads.enabled': true,
      'browser.safebrowsing.downloads.remote.enabled': false,
      'browser.safebrowsing.malware.enabled': true,
      'browser.safebrowsing.phishing.enabled': true,
      'browser.search.suggest.enabled': false,
      'browser.urlbar.quicksuggest.enabled': false,
      'browser.urlbar.suggest.quicksuggest.nonsponsored': false,
      'browser.urlbar.suggest.quicksuggest.sponsored': false,
      'browser.urlbar.suggest.searches': false,
      'dom.security.https_only_mode': false,
      'dom.security.https_only_mode_pbm': false,
      'dom.webgpu.enabled': true,
      'media.eme.enabled': true,
      'network.dns.disablePrefetch': true,
      'network.http.speculative-parallel-limit': 0,
      'network.prefetch-next': false,
      'network.trr.mode': 5,
      'privacy.globalprivacycontrol.enabled': true,
      'privacy.query_stripping.enabled': true,
      'privacy.query_stripping.enabled.pbmode': true,
      'privacy.resistFingerprinting.letterboxing': false,
      'privacy.sanitize.clearOnShutdown.cache': false,
      'privacy.sanitize.clearOnShutdown.cookies': false,
      'privacy.sanitize.clearOnShutdown.offlineApps': false,
      'privacy.sanitize.sanitizeOnShutdown': false,
      'webgl.disabled': false,
    },
  },
  enhanced: {
    browserPrivacy: {
      'websites.trackingProtectionMode': 'always',
      'websites.cookieConfig': {
        behavior: 'reject_trackers_and_partition_foreign',
        nonPersistentCookies: false,
      },
      'websites.resistFingerprinting': true,
      'network.networkPredictionEnabled': false,
      'network.peerConnectionEnabled': true,
      'network.webRTCIPHandlingPolicy': 'disable_non_proxied_udp',
      'network.httpsOnlyMode': 'always',
      'network.globalPrivacyControl': true,
      'services.passwordSavingEnabled': true,
    },
    prefs: {
      'browser.cache.disk.enable': true,
      'browser.formfill.enable': true,
      'browser.ml.enable': false,
      'browser.ml.chat.enabled': false,
      'browser.newtabpage.activity-stream.discoverystream.enabled': false,
      'browser.newtabpage.activity-stream.showSponsored': false,
      'browser.newtabpage.activity-stream.showSponsoredTopSites': false,
      'browser.places.speculativeConnect.enabled': false,
      'browser.safebrowsing.downloads.enabled': true,
      'browser.safebrowsing.downloads.remote.enabled': false,
      'browser.safebrowsing.malware.enabled': true,
      'browser.safebrowsing.phishing.enabled': true,
      'browser.search.suggest.enabled': false,
      'browser.urlbar.quicksuggest.enabled': false,
      'browser.urlbar.suggest.quicksuggest.nonsponsored': false,
      'browser.urlbar.suggest.quicksuggest.sponsored': false,
      'browser.urlbar.suggest.searches': false,
      'dom.security.https_only_mode': true,
      'dom.security.https_only_mode_pbm': true,
      'dom.webgpu.enabled': true,
      'media.eme.enabled': true,
      'network.dns.disablePrefetch': true,
      'network.http.speculative-parallel-limit': 0,
      'network.prefetch-next': false,
      'network.trr.mode': 5,
      'privacy.globalprivacycontrol.enabled': true,
      'privacy.query_stripping.enabled': true,
      'privacy.query_stripping.enabled.pbmode': true,
      'privacy.resistFingerprinting.letterboxing': false,
      'privacy.sanitize.clearOnShutdown.cache': false,
      'privacy.sanitize.clearOnShutdown.cookies': false,
      'privacy.sanitize.clearOnShutdown.offlineApps': false,
      'privacy.sanitize.sanitizeOnShutdown': false,
      'webgl.disabled': false,
    },
  },
  hardened: {
    browserPrivacy: {
      'websites.trackingProtectionMode': 'always',
      'websites.cookieConfig': {
        behavior: 'reject_trackers_and_partition_foreign',
        nonPersistentCookies: false,
      },
      'websites.resistFingerprinting': true,
      'network.networkPredictionEnabled': false,
      'network.peerConnectionEnabled': false,
      'network.webRTCIPHandlingPolicy': 'disable_non_proxied_udp',
      'network.httpsOnlyMode': 'always',
      'network.globalPrivacyControl': true,
      'services.passwordSavingEnabled': false,
    },
    prefs: {
      'browser.cache.disk.enable': false,
      'browser.formfill.enable': false,
      'browser.ml.enable': false,
      'browser.ml.chat.enabled': false,
      'browser.newtabpage.activity-stream.discoverystream.enabled': false,
      'browser.newtabpage.activity-stream.showSponsored': false,
      'browser.newtabpage.activity-stream.showSponsoredTopSites': false,
      'browser.places.speculativeConnect.enabled': false,
      'browser.safebrowsing.downloads.enabled': false,
      'browser.safebrowsing.downloads.remote.enabled': false,
      'browser.safebrowsing.malware.enabled': false,
      'browser.safebrowsing.phishing.enabled': false,
      'browser.search.suggest.enabled': false,
      'browser.urlbar.quicksuggest.enabled': false,
      'browser.urlbar.suggest.quicksuggest.nonsponsored': false,
      'browser.urlbar.suggest.quicksuggest.sponsored': false,
      'browser.urlbar.suggest.searches': false,
      'dom.security.https_only_mode': true,
      'dom.security.https_only_mode_pbm': true,
      'dom.security.https_only_mode_send_http_background_request': false,
      'dom.webgpu.enabled': false,
      'media.eme.enabled': false,
      'network.dns.disablePrefetch': true,
      'network.http.speculative-parallel-limit': 0,
      'network.prefetch-next': false,
      'network.trr.mode': 5,
      'privacy.globalprivacycontrol.enabled': true,
      'privacy.query_stripping.enabled': true,
      'privacy.query_stripping.enabled.pbmode': true,
      'privacy.resistFingerprinting.letterboxing': true,
      'privacy.sanitize.clearOnShutdown.cache': true,
      'privacy.sanitize.clearOnShutdown.cookies': true,
      'privacy.sanitize.clearOnShutdown.offlineApps': true,
      'privacy.sanitize.sanitizeOnShutdown': true,
      'network.http.referer.XOriginPolicy': 2,
      'webgl.disabled': true,
    },
  },
};

export const ALLOWED_PRIVACY_PREFS = Object.freeze(
  Array.from(
    new Set(Object.values(PRIVACY_PRESETS).flatMap((preset) => Object.keys(preset.prefs))),
  ).sort(),
);

export function isSelectablePrivacyLevel(
  value: unknown,
): value is SelectablePrivacyProtectionLevel {
  return SELECTABLE_PRIVACY_LEVELS.includes(value as SelectablePrivacyProtectionLevel);
}

export function browserPrivacyPathForAdvancedKey(key: PrivacyAdvancedKey): string | undefined {
  return ADVANCED_KEY_TO_BROWSER_PRIVACY[key];
}

export function prefNameForAdvancedKey(key: PrivacyAdvancedKey): string | undefined {
  return ADVANCED_KEY_TO_PREF[key];
}

export function privacyLevelLabel(level: PrivacyProtectionLevel): string {
  return PRIVACY_LEVELS.find((entry) => entry.id === level)?.label ?? 'Custom';
}

export function privacyLevelDetails(level: PrivacyProtectionLevel): PrivacyLevelDetails | null {
  if (level === 'custom') return null;
  return PRIVACY_LEVEL_DETAILS[level];
}
