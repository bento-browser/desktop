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

function loadApi(overrides = {}) {
  const context = {
    AbortController,
    ExtensionAPI: class {},
    Response,
    Services: {
      io: {
        newURI(value) {
          return { scheme: String(value).split(':', 1)[0].toLowerCase() };
        },
      },
    },
    TextDecoder,
    Uint8Array,
    atob,
    btoa,
    clearTimeout,
    console,
    fetch: async () => {
      throw new Error('Unexpected fetch');
    },
    setTimeout,
    ...overrides,
  };
  context.ChromeUtils = {
    importESModule(specifier) {
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
    `${apiSource}\n;globalThis.__securityTest = { iconUrlToDataUrl, mapWithConcurrency, consumeAddPanelGrant };`,
    context,
    { filename: apiPath },
  );
  return context.__securityTest;
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
});

test('search icons reject declared and streamed bodies over 512 KiB', async () => {
  const declaredApi = loadApi({
    fetch: async () => new Response(new Uint8Array(1), { headers: { 'content-length': '524289' } }),
  });
  assert.equal(await declaredApi.iconUrlToDataUrl('https://example.invalid/large.png'), undefined);

  const streamedApi = loadApi({
    fetch: async () => new Response(new Uint8Array(524289)),
  });
  assert.equal(await streamedApi.iconUrlToDataUrl('https://example.invalid/large.png'), undefined);
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

const MOUNT_SOURCES = {
  current: '../src/browser/base/content/bento-shell-mount.js',
  rollback: '../rollback/legacy-source/src/browser/base/content/bento-shell-mount.js',
};

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

for (const [label, relativePath] of Object.entries(MOUNT_SOURCES)) {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, relativePath), 'utf8');

  test(`clipboard suggestion trusts only a boolean pref (${label} mount)`, () => {
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
}

test('Save panel bounds its metadata to the validator caps', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, MOUNT_SOURCES.current), 'utf8');
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
