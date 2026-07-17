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
    `${apiSource}\n;globalThis.__securityTest = { iconUrlToDataUrl, mapWithConcurrency };`,
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
