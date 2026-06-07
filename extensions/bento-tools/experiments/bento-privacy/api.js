'use strict';

/* globals ChromeUtils, ExtensionAPI, Services */

const { SearchService } = ChromeUtils.importESModule(
  'moz-src:///toolkit/components/search/SearchService.sys.mjs',
);

const ALLOWED_PREFS = new Set([
  'browser.cache.disk.enable',
  'browser.formfill.enable',
  'browser.ml.enable',
  'browser.ml.chat.enabled',
  'browser.newtabpage.activity-stream.discoverystream.enabled',
  'browser.newtabpage.activity-stream.showSponsored',
  'browser.newtabpage.activity-stream.showSponsoredTopSites',
  'browser.places.speculativeConnect.enabled',
  'browser.safebrowsing.downloads.enabled',
  'browser.safebrowsing.downloads.remote.enabled',
  'browser.safebrowsing.malware.enabled',
  'browser.safebrowsing.phishing.enabled',
  'browser.search.suggest.enabled',
  'browser.urlbar.quicksuggest.enabled',
  'browser.urlbar.suggest.quicksuggest.nonsponsored',
  'browser.urlbar.suggest.quicksuggest.sponsored',
  'browser.urlbar.suggest.searches',
  'dom.security.https_only_mode',
  'dom.security.https_only_mode_pbm',
  'dom.security.https_only_mode_send_http_background_request',
  'dom.webgpu.enabled',
  'media.eme.enabled',
  'network.dns.disablePrefetch',
  'network.http.referer.XOriginPolicy',
  'network.http.speculative-parallel-limit',
  'network.prefetch-next',
  'network.trr.mode',
  'privacy.globalprivacycontrol.enabled',
  'privacy.query_stripping.enabled',
  'privacy.query_stripping.enabled.pbmode',
  'privacy.resistFingerprinting.letterboxing',
  'privacy.sanitize.clearOnShutdown.cache',
  'privacy.sanitize.clearOnShutdown.cookies',
  'privacy.sanitize.clearOnShutdown.offlineApps',
  'privacy.sanitize.sanitizeOnShutdown',
  'webgl.disabled',
]);

function assertAllowedPref(name) {
  if (!ALLOWED_PREFS.has(name)) {
    throw new Error(`Bento privacy pref is not allowlisted: ${name}`);
  }
}

function getPref(name) {
  switch (Services.prefs.getPrefType(name)) {
    case Services.prefs.PREF_BOOL:
      return Services.prefs.getBoolPref(name);
    case Services.prefs.PREF_INT:
      return Services.prefs.getIntPref(name);
    case Services.prefs.PREF_STRING:
      return Services.prefs.getStringPref(name);
    default:
      return Services.prefs.getStringPref(name, '');
  }
}

function setPref(name, value) {
  if (typeof value === 'boolean') {
    Services.prefs.setBoolPref(name, value);
    return;
  }
  if (Number.isInteger(value)) {
    Services.prefs.setIntPref(name, value);
    return;
  }
  if (typeof value === 'string') {
    Services.prefs.setStringPref(name, value);
    return;
  }
  throw new Error(`Unsupported pref value type for ${name}`);
}

async function ensureSearchReady() {
  await SearchService.promiseInitialized;
}

function getEngine(id) {
  if (typeof id !== 'string' || !id) {
    throw new Error(`Unsupported search engine id: ${id}`);
  }
  const engine = SearchService.getEngineById(id);
  if (!engine) throw new Error(`Search engine is not available: ${id}`);
  return engine;
}

this.bentoPrivacy = class extends ExtensionAPI {
  getAPI() {
    return {
      bentoPrivacy: {
        async getPrefs(names) {
          const result = {};
          for (const name of names) {
            assertAllowedPref(name);
            result[name] = getPref(name);
          }
          return result;
        },

        async setPrefs(values) {
          for (const name of Object.keys(values)) {
            assertAllowedPref(name);
          }
          for (const [name, value] of Object.entries(values)) {
            setPref(name, value);
          }
        },

        async clearPrefs(names) {
          for (const name of names) {
            assertAllowedPref(name);
            Services.prefs.clearUserPref(name);
          }
        },

        async getSearchEngines() {
          await ensureSearchReady();
          const defaultEngine = await SearchService.getDefault();
          const defaultId = defaultEngine?.id;
          return (await SearchService.getVisibleEngines()).map((engine) => ({
            id: engine.id,
            name: engine.name || engine.id,
            isDefault: engine.id === defaultId,
          }));
        },

        async getDefaultSearchEngine() {
          await ensureSearchReady();
          const engine = await SearchService.getDefault();
          const id = engine?.id;
          if (typeof id === 'string' && id) return id;
          return 'ddg';
        },

        async setDefaultSearchEngine(id) {
          await ensureSearchReady();
          const engine = getEngine(id);
          await SearchService.setDefault(engine, SearchService.CHANGE_REASON.USER);
          if (!Services.prefs.getBoolPref('browser.search.separatePrivateDefault', false)) {
            await SearchService.setDefaultPrivate(engine, SearchService.CHANGE_REASON.USER);
          }
        },
      },
    };
  }
};
