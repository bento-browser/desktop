import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const apiPath = path.resolve(
  import.meta.dirname,
  '../extensions/bento-tools/experiments/bento-privacy/api.js',
);
const apiSource = fs.readFileSync(apiPath, 'utf8');

const WEB_GLOBALS = { AbortController, TextDecoder, btoa };

/**
 * Loads api.js in a scope that, like an experiment's real one, has none of the web globals it
 * uses: only `Cu.importGlobalProperties` and the Timer module provide them. A global the file
 * forgets to request is a ReferenceError that the icon pipeline turns into "no icon".
 */
function loadApi({
  fetch = async () => {
    throw new Error('Unexpected fetch');
  },
  timers = { setTimeout, clearTimeout },
  windows = [],
} = {}) {
  const requested = [];
  const context = {
    Cu: {
      importGlobalProperties(names) {
        for (const name of names) {
          requested.push(name);
          context[name] = name === 'fetch' ? fetch : WEB_GLOBALS[name];
          if (context[name] === undefined) throw new Error(`Unavailable global: ${name}`);
        }
      },
    },
    ExtensionAPI: class {},
    Services: {
      wm: { getEnumerator: () => windows },
      io: {
        newURI(value) {
          return { scheme: String(value).split(':', 1)[0].toLowerCase() };
        },
      },
    },
    Uint8Array,
    console,
  };
  context.ChromeUtils = {
    importESModule(specifier) {
      if (specifier.includes('Timer.sys.mjs')) return timers;
      if (specifier.includes('SearchService')) return { SearchService: {} };
      if (specifier.includes('SearchUtils')) {
        return {
          SearchUtils: {
            fetchIcon: async () => {
              throw new Error('Unexpected channel');
            },
          },
        };
      }
      throw new Error(`Unexpected module: ${specifier}`);
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${apiSource}\n;globalThis.__securityTest = { iconUrlToDataUrl, getEngineIconUrl, mapWithConcurrency, consumeAddPanelGrant, bentoPrivacy: globalThis.bentoPrivacy };`,
    context,
    { filename: apiPath },
  );
  return Object.assign(context.__securityTest, { requested });
}

test('search icons reject non-allowlisted schemes without fetching', async () => {
  let fetches = 0;
  const api = loadApi({
    fetch: async () => {
      fetches += 1;
    },
  });
  assert.equal(await api.iconUrlToDataUrl('http://example.invalid/icon.png'), undefined);
  assert.equal(await api.iconUrlToDataUrl('file:///tmp/icon.png'), undefined);
  assert.equal(fetches, 0);
});

test('search icon fetches omit ambient credentials and referrers', async () => {
  let options;
  const pngHeader = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const api = loadApi({
    fetch: async (_url, receivedOptions) => {
      options = receivedOptions;
      return new Response(pngHeader, { headers: { 'content-type': 'image/png' } });
    },
  });
  const result = await api.iconUrlToDataUrl('https://example.invalid/icon.png');
  assert.match(result, /^data:image\/png;base64,/);
  assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
});

const ICON_CAP = 524288;
const CHUNK = 65536;
const PNG_HEADER = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * A Response whose body is a stream of `size` bytes that start with a valid PNG signature,
 * declared image/png, so only a size check can reject it. `state` records how far the stream was
 * read and whether it was cancelled.
 */
function pngResponse({ size, status = 200, headers = {} }) {
  const state = { readBytes: 0, cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      if (state.readBytes >= size) {
        controller.close();
        return;
      }
      const chunk = new Uint8Array(Math.min(CHUNK, size - state.readBytes));
      if (state.readBytes === 0) chunk.set(PNG_HEADER);
      state.readBytes += chunk.length;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const response = new Response(body, {
    status,
    headers: { 'content-type': 'image/png', ...headers },
  });
  return { response, state };
}

/** Loads the API with a fetch that answers `response` and records each call. */
function loadApiFetching(response) {
  const calls = [];
  const api = loadApi({
    fetch: async (url, options) => {
      calls.push({ url, signal: options.signal });
      return response;
    },
  });
  return { api, calls };
}

/** An unsuccessful fetch must stop the transfer: the body is cancelled and the request aborted. */
function assertAbandoned({ calls, state }, url) {
  assert.equal(calls.length, 1, 'the icon was fetched');
  assert.equal(calls[0].url, url);
  assert.equal(state.cancelled, true, 'the unread body was cancelled');
  assert.equal(calls[0].signal.aborted, true, 'the request was aborted');
}

test('a declared size over 512 KiB is rejected before the body is read', async () => {
  // The body itself is a small valid PNG, so the declared size is the only thing that rejects it.
  const { response, state } = pngResponse({
    size: PNG_HEADER.length,
    headers: { 'content-length': String(ICON_CAP + 1) },
  });
  const { api, calls } = loadApiFetching(response);
  const url = 'https://example.invalid/declared.png';
  assert.equal(await api.iconUrlToDataUrl(url), undefined);
  assertAbandoned({ calls, state }, url);
});

test('a streamed body over 512 KiB stops being read at the cap', async () => {
  // A valid PNG start, image/png, no declared length: only the streamed count can stop it, and it
  // has to do so before the 4 MiB body is pulled through.
  const { response, state } = pngResponse({ size: 8 * ICON_CAP });
  const { api, calls } = loadApiFetching(response);
  const url = 'https://example.invalid/streamed.png';
  assert.equal(await api.iconUrlToDataUrl(url), undefined);
  assertAbandoned({ calls, state }, url);
  assert.ok(state.readBytes <= ICON_CAP + 3 * CHUNK, `read ${state.readBytes} bytes`);
});

test('a non-ok response is abandoned without reading its body', async () => {
  const { response, state } = pngResponse({ size: 8 * ICON_CAP, status: 404 });
  const { api, calls } = loadApiFetching(response);
  const url = 'https://example.invalid/missing.png';
  assert.equal(await api.iconUrlToDataUrl(url), undefined);
  assertAbandoned({ calls, state }, url);
  assert.ok(state.readBytes <= 2 * CHUNK, `read ${state.readBytes} bytes`);
});

test('the fetch timer aborts the request', { timeout: 3000 }, async () => {
  let fire;
  let delay;
  let signal;
  const api = loadApi({
    timers: {
      setTimeout(callback, ms) {
        fire = callback;
        delay = ms;
        return 1;
      },
      clearTimeout() {},
    },
    fetch: (_url, options) =>
      new Promise((_resolve, reject) => {
        signal = options.signal;
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  const pending = api.iconUrlToDataUrl('https://example.invalid/slow.png');
  assert.equal(delay, 5000);
  fire();
  assert.equal(await pending, undefined);
  assert.equal(signal.aborted, true);
});

test('search icon pipeline asks the experiment scope for every web global it uses', async () => {
  const api = loadApi({
    fetch: async () => new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  });
  // The SVG is typed by sniffing its text, which needs TextDecoder; the fetch needs
  // AbortController, fetch and the Timer module's setTimeout.
  assert.match(
    await api.iconUrlToDataUrl('https://example.invalid/icon'),
    /^data:image\/svg\+xml;/,
  );
  assert.deepEqual([...api.requested].sort(), ['AbortController', 'TextDecoder', 'btoa', 'fetch']);
});

const SYSTEM_BLOB = 'blob:system/592b2101-081e-4542-bb5f-49bfb2335dc5';
test('search icons fetch the system blob URLs Firefox returns from getIconURL', async () => {
  const urls = [];
  const api = loadApi({
    fetch: async (url) => {
      urls.push(url);
      return new Response(PNG_HEADER, { headers: { 'content-type': 'image/png' } });
    },
  });
  assert.match(await api.iconUrlToDataUrl(SYSTEM_BLOB), /^data:image\/png;base64,/);
  assert.deepEqual(urls, [SYSTEM_BLOB]);
});

test('search icons refuse every other blob URL without fetching', async () => {
  let fetches = 0;
  const api = loadApi({
    fetch: async () => {
      fetches += 1;
      return new Response(PNG_HEADER);
    },
  });
  for (const url of [
    'blob:https://example.invalid/592b2101-081e-4542-bb5f-49bfb2335dc5',
    'blob:null/592b2101-081e-4542-bb5f-49bfb2335dc5',
    'blob:resource://gre/592b2101-081e-4542-bb5f-49bfb2335dc5',
    'blob:system/not-a-uuid',
    `${SYSTEM_BLOB}/more`,
    `${SYSTEM_BLOB}?query`,
    `x${SYSTEM_BLOB}`,
  ]) {
    assert.equal(await api.iconUrlToDataUrl(url), undefined, url);
  }
  assert.equal(fetches, 0);
});

test('search icon size bounds apply to blob icons too', async () => {
  const { response, state } = pngResponse({ size: 8 * ICON_CAP });
  const { api, calls } = loadApiFetching(response);
  assert.equal(await api.iconUrlToDataUrl(SYSTEM_BLOB), undefined);
  assertAbandoned({ calls, state }, SYSTEM_BLOB);
  assert.ok(state.readBytes <= ICON_CAP + 3 * CHUNK, `read ${state.readBytes} bytes`);
});

test('an engine whose blob icon cannot be read falls back to its bundled icon', async () => {
  const urls = [];
  const icoHeader = Uint8Array.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
  const api = loadApi({
    fetch: async (url) => {
      urls.push(url);
      if (url.startsWith('blob:')) throw new Error('blob is gone');
      return new Response(icoHeader, { headers: { 'content-type': 'image/x-icon' } });
    },
  });
  const engine = { id: 'google', name: 'Google', getIconURL: async () => SYSTEM_BLOB };
  const base = { resolve: (path) => `moz-extension://bento/${path}` };
  assert.match(await api.getEngineIconUrl(engine, base), /^data:image\/x-icon;base64,/);
  assert.ok(urls[0].startsWith('blob:'));
  assert.ok(
    urls.at(-1).startsWith('moz-extension://bento/experiments/bento-privacy/search-icons/'),
  );
});

test('engine icon mapping obeys the concurrency bound', async () => {
  const api = loadApi();
  let active = 0;
  let peak = 0;
  await api.mapWithConcurrency(
    Array.from({ length: 16 }, (_, index) => index),
    4,
    async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
    },
  );
  assert.equal(peak, 4);
});

const GRANT_TOKEN = '3f1c2a4e-9b7d-4c1a-8e5f-0a1b2c3d4e5f';

/** A tabManager whose tabs carry the chrome-issued grant on the native tab. */
function grantFixture({ windowId = 7, grantOverrides = {}, tabWindowId = windowId } = {}) {
  let acknowledged = 0;
  const nativeTab = {
    bentoAddPanelGrant: {
      token: GRANT_TOKEN,
      windowId,
      source: 'end',
      expiresAt: Date.now() + 60_000,
      acknowledge: () => {
        acknowledged += 1;
      },
      ...grantOverrides,
    },
  };
  const other = { nativeTab: {}, windowId: tabWindowId };
  const tabs = new Map([
    [41, { nativeTab, windowId: tabWindowId }],
    [42, other],
  ]);
  const extension = {
    tabManager: {
      get(tabId, fallback) {
        if (tabId === 99) throw new Error('Invalid tab ID: 99');
        return tabs.get(tabId) ?? fallback;
      },
    },
  };
  return { extension, nativeTab, acknowledged: () => acknowledged };
}

test('add-panel grant is consumed once and returns the recorded metadata', () => {
  const api = loadApi();
  const { extension, nativeTab, acknowledged } = grantFixture();
  assert.deepEqual(
    { ...api.consumeAddPanelGrant(extension, 41, GRANT_TOKEN) },
    {
      windowId: 7,
      source: 'end',
    },
  );
  assert.equal(nativeTab.bentoAddPanelGrant, undefined);
  assert.equal(acknowledged(), 1);
  assert.equal(api.consumeAddPanelGrant(extension, 41, GRANT_TOKEN), null);
});

test('add-panel grant rejects another tab, a wrong token, and unknown tabs without consuming', () => {
  const api = loadApi();
  const { extension, nativeTab } = grantFixture();
  assert.equal(api.consumeAddPanelGrant(extension, 42, GRANT_TOKEN), null);
  assert.equal(api.consumeAddPanelGrant(extension, 41, 'not-the-token'), null);
  assert.equal(api.consumeAddPanelGrant(extension, 41, 1), null);
  assert.equal(api.consumeAddPanelGrant(extension, 40, GRANT_TOKEN), null);
  assert.equal(api.consumeAddPanelGrant(extension, 99, GRANT_TOKEN), null);
  assert.ok(nativeTab.bentoAddPanelGrant, 'a mismatch must leave the live grant in place');
});

test('add-panel grant rejects expired grants and consumes them', () => {
  const api = loadApi();
  const { extension, nativeTab } = grantFixture({ grantOverrides: { expiresAt: Date.now() - 1 } });
  assert.equal(api.consumeAddPanelGrant(extension, 41, GRANT_TOKEN), null);
  assert.equal(nativeTab.bentoAddPanelGrant, undefined);
});

test('add-panel grant rejects a tab that moved to another window', () => {
  const api = loadApi();
  const { extension } = grantFixture({ windowId: 7, tabWindowId: 8 });
  assert.equal(api.consumeAddPanelGrant(extension, 41, GRANT_TOKEN), null);
});

test('add-panel grant without a recorded window id uses the tab window', () => {
  const api = loadApi();
  const { extension } = grantFixture({ windowId: null, tabWindowId: 9 });
  assert.deepEqual(
    { ...api.consumeAddPanelGrant(extension, 41, GRANT_TOKEN) },
    {
      windowId: 9,
      source: 'end',
    },
  );
});

test('add-panel grant rejects malformed recorded sources', () => {
  const api = loadApi();
  for (const source of ['sideways', -1, 1.5, null, undefined]) {
    const { extension } = grantFixture({ grantOverrides: { source } });
    assert.equal(api.consumeAddPanelGrant(extension, 41, GRANT_TOKEN), null);
  }
  for (const source of ['main', 0, 12]) {
    const { extension } = grantFixture({ grantOverrides: { source } });
    assert.equal(api.consumeAddPanelGrant(extension, 41, GRANT_TOKEN).source, source);
  }
});

test('add-panel grant survives a throwing acknowledgement', () => {
  const api = loadApi();
  const { extension } = grantFixture({
    grantOverrides: {
      acknowledge: () => {
        throw new Error('window closed');
      },
    },
  });
  assert.equal(api.consumeAddPanelGrant(extension, 41, GRANT_TOKEN).windowId, 7);
});

const MOUNT_SOURCE = '../src/browser/base/content/bento-shell-mount.js';

/** Source of a top-level (2-space indented) function in the mount script. */
function mountFunction(source, name) {
  const start = source.indexOf(`\n  function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing`);
  return source.slice(start, source.indexOf('\n  }\n', start) + 5);
}

/** Source of a single-line top-level `const` in the mount script. */
function mountConstant(source, name) {
  const match = new RegExp(`^  const ${name} = [^\\n]*;$`, 'm').exec(source);
  assert.ok(match, `${name} is missing`);
  return match[0];
}

/** Gecko pref types and getBoolPref's default-on-failure contract. */
function fakePrefs(type, value) {
  const types = { bool: 128, int: 64, string: 32, missing: 0 };
  return {
    PREF_INVALID: 0,
    PREF_STRING: 32,
    PREF_INT: 64,
    PREF_BOOL: 128,
    getPrefType: () => {
      if (type === 'throws') throw new Error('prefs unavailable');
      return types[type];
    },
    getBoolPref: (_name, fallback) => {
      if (type === 'bool') return value;
      if (fallback !== undefined) return fallback;
      throw new Error('NS_ERROR_UNEXPECTED');
    },
  };
}

const source = fs.readFileSync(path.resolve(import.meta.dirname, MOUNT_SOURCE), 'utf8');

test('clipboard suggestion trusts only a boolean pref', () => {
  const code = `${mountConstant(source, 'CLIPBOARD_SUGGEST_PREF')}
${mountFunction(source, 'isClipboardUrlSuggestionEnabled')}
isClipboardUrlSuggestionEnabled;`;
  const enabled = (type, value) =>
    vm.runInNewContext(code, { Services: { prefs: fakePrefs(type, value) } })();
  assert.equal(enabled('bool', true), true);
  assert.equal(enabled('bool', false), false);
  // A missing pref takes Firefox's own default (true).
  assert.equal(enabled('missing'), true);
  // Wrong-typed prefs and failed reads must not allow the clipboard read.
  assert.equal(enabled('int', 1), false);
  assert.equal(enabled('string', 'true'), false);
  assert.equal(enabled('throws'), false);
});

test('Save panel bounds its metadata to the validator caps', () => {
  const code = `${[
    'SAVED_PANEL_MAX_TITLE_LENGTH',
    'SAVED_PANEL_MAX_URL_LENGTH',
    'SAVED_PANEL_MAX_FAVICON_URL_LENGTH',
  ]
    .map((name) => mountConstant(source, name))
    .join('\n')}
${mountFunction(source, 'boundSavedPanelMetadata')}
({ bound: boundSavedPanelMetadata, titleMax: SAVED_PANEL_MAX_TITLE_LENGTH, urlMax: SAVED_PANEL_MAX_URL_LENGTH, faviconMax: SAVED_PANEL_MAX_FAVICON_URL_LENGTH });`;
  const { bound, titleMax, urlMax, faviconMax } = vm.runInNewContext(code);

  // The producer caps mirror the wire validator, which stays strict.
  const cap = (file, name) => {
    const text = fs.readFileSync(
      path.resolve(import.meta.dirname, '../extensions/_shared', file),
      'utf8',
    );
    const match = new RegExp(`${name} = ([\\d_]+);`).exec(text);
    assert.ok(match, `${name} is missing from ${file}`);
    return Number(match[1].replaceAll('_', ''));
  };
  assert.equal(titleMax, cap('export-schema.ts', 'MAX_TITLE_LENGTH'));
  assert.equal(urlMax, cap('export-schema.ts', 'MAX_URL_LENGTH'));
  assert.equal(faviconMax, cap('wire-action.ts', 'MAX_FAVICON_URL_LENGTH'));

  const url = 'https://example.com/';
  assert.deepEqual(
    { ...bound(url, 'Title', 'https://example.com/i.png') },
    {
      url,
      title: 'Title',
      favIconUrl: 'https://example.com/i.png',
    },
  );
  assert.equal(bound(url, 'a'.repeat(titleMax), '').title.length, titleMax);
  assert.equal(bound(url, 'a'.repeat(titleMax + 1), '').title.length, titleMax);
  // The cut never leaves half of a surrogate pair.
  const split = bound(url, `${'a'.repeat(titleMax - 1)}\u{1F600}`, '').title;
  assert.equal(split, 'a'.repeat(titleMax - 1));
  assert.equal(bound(url, 't', 'd'.repeat(faviconMax)).favIconUrl.length, faviconMax);
  assert.equal(bound(url, 't', 'd'.repeat(faviconMax + 1)).favIconUrl, '');
  // A URL at the cap is kept whole; one over it is skipped, never truncated
  // into a different address.
  const atCap = url.padEnd(urlMax, 'a');
  assert.equal(bound(atCap, 't', '').url, atCap);
  assert.equal(bound(`${atCap}a`, 't', ''), null);
});

test('the experiment allowlist covers every pref the privacy presets write', async () => {
  const { ALLOWED_PRIVACY_PREFS, SHUTDOWN_CLEAR_PREFS } =
    await import('../extensions/_shared/privacy-levels.ts');
  const list = /const ALLOWED_PREFS = new Set\(\[([\s\S]*?)\]\);/.exec(apiSource);
  assert.ok(list, 'ALLOWED_PREFS is missing from api.js');
  const allowed = new Set([...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
  for (const pref of [...ALLOWED_PRIVACY_PREFS, ...Object.keys(SHUTDOWN_CLEAR_PREFS)]) {
    assert.ok(allowed.has(pref), `${pref} is written by Bento but missing from api.js`);
  }
});

test('notifyUiColorMode fires the pref at every open browser window and refuses other values', async () => {
  const events = [];
  const browserWindow = (name, closed = false) => ({
    closed,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    dispatchEvent: (event) => events.push([name, event.type, event.detail]),
  });
  const api = loadApi({
    windows: [browserWindow('regular'), browserWindow('private'), browserWindow('gone', true)],
  });
  const { notifyUiColorMode } = new api.bentoPrivacy().getAPI({}).bentoPrivacy;

  const stamp = { run: 'run-a', seq: 3 };
  await notifyUiColorMode('system', stamp);
  // The mount script of a private window drops it; the experiment tells every live window,
  // with the order stamp the mount compares against its panels payloads.
  const detail = { mode: 'system', stamp };
  // The detail is made in the experiment's own realm; compare it as data.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(events), [
    ['regular', 'bento-ui-color-mode-set', detail],
    ['private', 'bento-ui-color-mode-set', detail],
  ]);

  // The time the change should show rides along; a caller without it (an older bento-tools) or
  // with a malformed one sends the stamp without it, which the mount applies at once.
  events.length = 0;
  await notifyUiColorMode('dark', { ...stamp, flipAt: 1_700_000_000_123 });
  assert.deepEqual(plain(events[0][2]), {
    mode: 'dark',
    stamp: { ...stamp, flipAt: 1_700_000_000_123 },
  });
  events.length = 0;
  await notifyUiColorMode('dark', { ...stamp, flipAt: 'soon' });
  assert.deepEqual(plain(events[0][2]), { mode: 'dark', stamp });

  events.length = 0;
  await notifyUiColorMode('dark', undefined);
  await notifyUiColorMode('dark', { run: 5, seq: 'x' });
  assert.deepEqual(
    plain(events.map((event) => event[2])),
    Array(4).fill({ mode: 'dark', stamp: null }), // two calls, two windows each
    'a missing or malformed stamp is no stamp, which the mount treats as unordered',
  );

  events.length = 0;
  await notifyUiColorMode('purple', stamp);
  await notifyUiColorMode(undefined, stamp);
  assert.deepEqual(events, []);
});
