'use strict';

/* globals ChromeUtils, Cu, ExtensionAPI, Services */

const { SearchService } = ChromeUtils.importESModule(
  'moz-src:///toolkit/components/search/SearchService.sys.mjs',
);
const { SearchUtils } = ChromeUtils.importESModule(
  'moz-src:///toolkit/components/search/SearchUtils.sys.mjs',
);
// An experiment's scope has none of the web globals the search icon pipeline uses. A missing one
// throws a ReferenceError that the pipeline's catch blocks turn into "no icon", so list every
// global the file touches here, and take the timers from their module.
Cu.importGlobalProperties(['AbortController', 'TextDecoder', 'btoa', 'fetch']);
const { setTimeout, clearTimeout } = ChromeUtils.importESModule(
  'resource://gre/modules/Timer.sys.mjs',
);

const MAX_SEARCH_ICON_BYTES = 512 * 1024;
const MAX_SEARCH_ICON_DATA_URL_CHARS = Math.ceil((MAX_SEARCH_ICON_BYTES * 4) / 3) + 256;
const SEARCH_ICON_FETCH_TIMEOUT_MS = 5000;
const SEARCH_ICON_CONCURRENCY = 4;
const FETCHABLE_SEARCH_ICON_SCHEMES = new Set(['https', 'moz-extension']);
const CHANNEL_SEARCH_ICON_SCHEMES = new Set(['chrome', 'resource', 'moz-icon']);
// Firefox makes the icons of its configured engines with URL.createObjectURL in a system scope
// (IconHandler.createIconURL), so SearchEngine.getIconURL() returns blob:system/<uuid>. No other
// blob origin (a page's, or a null principal's) is fetched.
const SYSTEM_BLOB_ICON_URL = /^blob:system\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const BUNDLED_SEARCH_ICON_PATHS = Object.freeze({
  bing: {
    path: 'experiments/bento-privacy/search-icons/bing.ico',
    contentType: 'image/x-icon',
  },
  ddg: {
    path: 'experiments/bento-privacy/search-icons/duckduckgo.svg',
    contentType: 'image/svg+xml',
  },
  ebay: {
    path: 'experiments/bento-privacy/search-icons/ebay.ico',
    contentType: 'image/x-icon',
  },
  google: {
    path: 'experiments/bento-privacy/search-icons/google.ico',
    contentType: 'image/x-icon',
  },
  perplexity: {
    path: 'experiments/bento-privacy/search-icons/perplexity.svg',
    contentType: 'image/svg+xml',
  },
  wikipedia: {
    path: 'experiments/bento-privacy/search-icons/wikipedia.ico',
    contentType: 'image/x-icon',
  },
});

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
  'privacy.clearOnShutdown_v2.browsingHistoryAndDownloads',
  'privacy.clearOnShutdown_v2.cache',
  'privacy.clearOnShutdown_v2.cookiesAndStorage',
  'privacy.clearOnShutdown_v2.formdata',
  'privacy.clearOnShutdown_v2.siteSettings',
  'privacy.globalprivacycontrol.enabled',
  'privacy.query_stripping.enabled',
  'privacy.query_stripping.enabled.pbmode',
  'privacy.resistFingerprinting.letterboxing',
  'privacy.sanitize.clearOnShutdown.hasMigratedToNewPrefs3',
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

function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function inferImageContentType(bytes, fallback = '') {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01) {
    return 'image/x-icon';
  }
  try {
    const text = new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 256)));
    if (/<svg[\s>]/i.test(text)) return 'image/svg+xml';
  } catch {
    /* Ignore undecodable binary content. */
  }
  return fallback && fallback.startsWith('image/') ? fallback : '';
}

function assertBoundedIconBytes(bytes) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length === 0 ||
    bytes.length > MAX_SEARCH_ICON_BYTES
  ) {
    throw new Error('Search engine icon exceeds the allowed size.');
  }
  return bytes;
}

async function readBoundedResponseBytes(response) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_SEARCH_ICON_BYTES) {
    throw new Error('Search engine icon exceeds the allowed size.');
  }
  if (!response.body?.getReader) {
    return assertBoundedIconBytes(new Uint8Array(await response.arrayBuffer()));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      length += chunk.length;
      if (length > MAX_SEARCH_ICON_BYTES) {
        await reader.cancel();
        throw new Error('Search engine icon exceeds the allowed size.');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return assertBoundedIconBytes(bytes);
}

/**
 * Gives up on a fetch: cancels what is left of the response body and aborts the request, so the
 * connection closes. Firefox buffers unread response data in an unbounded pipe, so an early
 * rejection that only dropped the response would let a hostile or broken server keep streaming.
 */
function abandonIconFetch(controller, response) {
  try {
    response?.body?.cancel().catch(() => {});
  } catch {
    /* The body is locked or already consumed. */
  }
  controller.abort();
}

async function fetchBoundedIcon(iconUrl) {
  const controller = new AbortController();
  // The timer aborts the request too, which also fails a body read that is still pending.
  const timeout = setTimeout(() => controller.abort(), SEARCH_ICON_FETCH_TIMEOUT_MS);
  let response;
  let completed = false;
  try {
    response = await fetch(iconUrl, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) throw new Error(`Search engine icon request failed: ${response.status}`);
    const result = {
      bytes: await readBoundedResponseBytes(response),
      contentType: response.headers.get('content-type') || '',
    };
    completed = true;
    return result;
  } finally {
    clearTimeout(timeout);
    if (!completed) abandonIconFetch(controller, response);
  }
}

async function iconUrlToDataUrl(iconUrl, contentTypeHint = '') {
  if (iconUrl.startsWith('data:image/')) {
    return iconUrl.length <= MAX_SEARCH_ICON_DATA_URL_CHARS ? iconUrl : undefined;
  }

  let uri;
  try {
    uri = Services.io.newURI(iconUrl);
  } catch {
    return undefined;
  }

  let bytes;
  let contentType = contentTypeHint;
  try {
    if (
      FETCHABLE_SEARCH_ICON_SCHEMES.has(uri.scheme) ||
      (uri.scheme === 'blob' && SYSTEM_BLOB_ICON_URL.test(iconUrl))
    ) {
      const fetched = await fetchBoundedIcon(iconUrl);
      bytes = fetched.bytes;
      contentType = fetched.contentType || contentType;
    } else if (CHANNEL_SEARCH_ICON_SCHEMES.has(uri.scheme)) {
      const fetched = await SearchUtils.fetchIcon(uri);
      bytes = assertBoundedIconBytes(fetched[0]);
      contentType = fetched[1] || contentType;
    } else {
      return undefined;
    }
    const resolvedType = inferImageContentType(bytes, contentType);
    if (!resolvedType.startsWith('image/')) return undefined;
    return `data:${resolvedType};base64,${bytesToBase64(bytes)}`;
  } catch {
    return undefined;
  }
}

async function mapWithConcurrency(values, limit, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function bundledIconKeyForEngine(engine) {
  const id = String(engine.id || '').toLowerCase();
  const name = String(engine.name || '').toLowerCase();
  if (id === 'bing' || name === 'bing') return 'bing';
  if (id === 'ddg' || id === 'duckduckgo' || name === 'duckduckgo') return 'ddg';
  if (id.startsWith('ebay') || name === 'ebay') return 'ebay';
  if (id === 'google' || name === 'google') return 'google';
  if (id === 'perplexity' || name === 'perplexity') return 'perplexity';
  if (id.startsWith('wikipedia') || name.startsWith('wikipedia')) return 'wikipedia';
  return null;
}

async function getBundledEngineIconUrl(engine, extensionBaseURI) {
  const key = bundledIconKeyForEngine(engine);
  if (!key || !extensionBaseURI) return undefined;
  const icon = BUNDLED_SEARCH_ICON_PATHS[key];
  if (!icon) return undefined;
  return iconUrlToDataUrl(extensionBaseURI.resolve(icon.path), icon.contentType);
}

async function getEngineIconUrl(engine, extensionBaseURI) {
  const preferredWidths = [16, 32, 64, undefined];
  for (const width of preferredWidths) {
    try {
      const iconUrl = await engine.getIconURL?.(width);
      if (typeof iconUrl !== 'string' || iconUrl.length === 0) continue;
      const dataUrl = await iconUrlToDataUrl(iconUrl);
      if (dataUrl) return dataUrl;
    } catch {
      /* Try the next available engine icon size. */
    }
  }
  return getBundledEngineIconUrl(engine, extensionBaseURI);
}

// Add-panel grants are issued by bento-shell-mount.js as
// `nativeTab.bentoAddPanelGrant = { token, windowId, source, expiresAt,
// acknowledge }` on the XUL tab element, which web content cannot reach.
// Consuming checks (tabId, token), deletes the grant before any other check
// so it is single-use, then returns the recorded metadata. Anything that does
// not match a live grant returns null; the URL alone is never authority.
// The whole function is synchronous, so check-and-delete is atomic.
function consumeAddPanelGrant(extension, tabId, token) {
  let tab = null;
  try {
    tab = extension.tabManager.get(tabId, null);
  } catch {
    return null;
  }
  const nativeTab = tab?.nativeTab;
  const grant = nativeTab?.bentoAddPanelGrant;
  if (!grant || typeof token !== 'string' || grant.token !== token) return null;
  delete nativeTab.bentoAddPanelGrant;
  try {
    grant.acknowledge?.();
  } catch {
    // The acknowledgement only lets chrome navigate away sooner.
  }
  if (!(Date.now() <= grant.expiresAt)) return null;
  const windowId = tab.windowId;
  if (!Number.isInteger(windowId) || windowId < 0) return null;
  if (grant.windowId !== null && grant.windowId !== windowId) return null;
  const source = grant.source;
  const validSource =
    source === 'main' || source === 'end' || (Number.isInteger(source) && source >= 0);
  return validSource ? { windowId, source } : null;
}

// The window event the mount script (bento-shell-mount.js) listens for. detail is { mode, stamp }:
// the pref and SettingsStore.colorStamp(), the order stamp chrome compares with the panels payload's
// (run, seq) plus the time the change should show (flipAt, absent from an older caller).
const UI_COLOR_MODE_EVENT = 'bento-ui-color-mode-set';

this.bentoPrivacy = class extends ExtensionAPI {
  getAPI(context) {
    const extensionBaseURI = this.extension?.baseURI;
    return {
      bentoPrivacy: {
        async consumeAddPanelGrant(tabId, token) {
          return consumeAddPanelGrant(context.extension, tabId, token);
        },

        // Tells each browser window's mount script the new UI colour mode pref the moment it
        // changes, so chrome starts its mode fade with the other documents instead of waiting for
        // the panels/sync payload (which carries the same value and stays the backstop). The mount
        // script ignores it in a private window, which keeps its own mode.
        async notifyUiColorMode(mode, stamp) {
          if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return;
          // The stamp is copied so the window gets a plain object of this scope's own.
          const detail = {
            mode,
            stamp:
              stamp && typeof stamp.run === 'string' && Number.isFinite(stamp.seq)
                ? Number.isFinite(stamp.flipAt)
                  ? { run: stamp.run, seq: stamp.seq, flipAt: stamp.flipAt }
                  : { run: stamp.run, seq: stamp.seq }
                : null,
          };
          for (const win of Services.wm.getEnumerator('navigator:browser')) {
            if (win.closed) continue;
            win.dispatchEvent(new win.CustomEvent(UI_COLOR_MODE_EVENT, { detail }));
          }
        },

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
          return mapWithConcurrency(
            await SearchService.getVisibleEngines(),
            SEARCH_ICON_CONCURRENCY,
            async (engine) => {
              const iconUrl = await getEngineIconUrl(engine, extensionBaseURI);
              return {
                id: engine.id,
                name: engine.name || engine.id,
                isDefault: engine.id === defaultId,
                ...(iconUrl ? { iconUrl } : {}),
              };
            },
          );
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
          if (!Services.prefs.getBoolPref('browser.search.separatePrivateDefault.enabled', false)) {
            await SearchService.setDefaultPrivate(engine, SearchService.CHANGE_REASON.USER);
          }
        },
      },
    };
  }
};
