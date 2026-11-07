import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { marFileName, validateDescriptor } from './descriptor.mjs';
import { handleRequest, selectResponse } from './worker.mjs';

const release = {
  version: '0.0.3',
  buildId: '20261102120000',
  marUrl: `https://dl.bentobrowser.app/${marFileName('0.0.3', '20261102120000')}`,
  size: 123456789,
  sha512: 'ab'.repeat(64),
  platformVersion: '158.0',
  detailsUrl: 'https://bentobrowser.app/release-notes/0.0.3/',
};
const serving = {
  serving: true,
  product: 'Bento',
  target: 'Darwin_aarch64-gcc3',
  channel: 'bento',
  release,
};
const withRelease = (changes) => ({ ...serving, release: { ...release, ...changes } });

// A stock-shaped update URL; the client fields default to an arm64 macOS client.
function updateUrl(overrides = {}) {
  const fields = {
    product: 'Bento',
    version: '0.0.2',
    buildId: '20261001000000',
    target: 'Darwin_aarch64-gcc3',
    locale: 'en-US',
    channel: 'bento',
    osVersion: 'Darwin%2520Kernel%252027.0.0',
    systemCapabilities: 'ISET%3ANEON%2CMEM%3A16384',
    distribution: 'default',
    distributionVersion: 'default',
    ...overrides,
  };
  return `https://updates.bentobrowser.app/update/6/${Object.values(fields).join('/')}/update.xml`;
}

async function check(url, descriptor = serving) {
  const response = selectResponse(url, descriptor);
  return { response, body: await response.text() };
}

const NO_UPDATE = '<?xml version="1.0"?>\n<updates/>\n';

test('offers one complete update to an older client', async () => {
  const { response, body } = await check(updateUrl());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/xml; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(
    body,
    /<update type="minor" displayVersion="0\.0\.3" appVersion="0\.0\.3" platformVersion="158\.0" buildID="20261102120000" detailsURL="https:\/\/bentobrowser\.app\/release-notes\/0\.0\.3\/">/,
  );
  assert.match(
    body,
    new RegExp(
      `<patch type="complete" URL="${release.marUrl.replaceAll('.', '\\.')}" size="123456789" hashFunction="sha512" hashValue="${release.sha512}"/>`,
    ),
  );
  assert.equal(body.match(/<update /g).length, 1);
  assert.equal(body.match(/<patch /g).length, 1);
});

test('type is major only when the major version rises', async () => {
  const major = withRelease({
    version: '1.0.0',
    marUrl: `https://dl.bentobrowser.app/${marFileName('1.0.0', release.buildId)}`,
  });
  assert.match((await check(updateUrl({ version: '0.9.9' }), major)).body, /type="major"/);
  assert.match(
    (
      await check(
        updateUrl({ version: '1.0.0' }),
        withRelease({ version: '1.0.1', marUrl: release.marUrl.replace('0.0.3', '1.0.1') }),
      )
    ).body,
    /type="minor"/,
  );
});

test('offers only a strictly higher version, compared numerically', async () => {
  assert.equal((await check(updateUrl({ version: '0.0.3' }))).body, NO_UPDATE);
  assert.equal((await check(updateUrl({ version: '0.0.4' }))).body, NO_UPDATE);
  assert.equal((await check(updateUrl({ version: '0.1.0' }))).body, NO_UPDATE);
  assert.equal((await check(updateUrl({ version: '0.0.10' }))).body, NO_UPDATE);
  assert.match(
    (
      await check(
        updateUrl({ version: '0.0.9' }),
        withRelease({ version: '0.0.10', marUrl: release.marUrl.replace('0.0.3', '0.0.10') }),
      )
    ).body,
    /appVersion="0\.0\.10"/,
  );
});

test('a client on the same version never gets an offer, whatever its BuildID', async () => {
  for (const buildId of ['20261001000000', release.buildId, '20270101000000']) {
    assert.equal((await check(updateUrl({ version: '0.0.3', buildId }))).body, NO_UPDATE);
  }
});

test('an unrecognized product, target, channel or version gets no update', async () => {
  for (const overrides of [
    { product: 'Firefox' },
    { product: 'bento' },
    { target: 'Darwin_x86_64-gcc3' },
    { target: 'WINNT_x86_64-msvc' },
    { channel: 'release' },
    { channel: 'Bento' },
    { version: '0.0' },
    { version: 'abc' },
    { version: '0.0.1b2' },
  ]) {
    const { response, body } = await check(updateUrl(overrides));
    assert.equal(response.status, 200, JSON.stringify(overrides));
    assert.equal(body, NO_UPDATE, JSON.stringify(overrides));
  }
});

test('no update while not serving or without a release', async () => {
  assert.equal((await check(updateUrl(), { ...serving, serving: false })).body, NO_UPDATE);
  assert.equal(
    (await check(updateUrl(), { ...serving, serving: false, release: null })).body,
    NO_UPDATE,
  );
  assert.equal((await check(updateUrl(), { ...serving, release: null })).body, NO_UPDATE);
});

test('the query string does not change the answer', async () => {
  const plain = await check(updateUrl());
  for (const query of ['?force=1', '?force=1&pin=x', '?']) {
    assert.equal((await check(updateUrl() + query)).body, plain.body, query);
  }
  assert.equal((await check(updateUrl({ version: '0.0.3' }) + '?force=1')).body, NO_UPDATE);
});

test('decodes fields leniently, including double-encoded and malformed ones', async () => {
  const lenient = updateUrl({
    product: '%42ento',
    osVersion: '%E0%A4%A',
    systemCapabilities: '%25zz',
    locale: 'x%',
  });
  assert.match((await check(lenient)).body, /appVersion="0\.0\.3"/);
});

test('a path that is not an update check is a plain-text 400, never XML', async () => {
  const stock = updateUrl();
  const [, prefix] = /^(https:\/\/[^/]+\/update\/6)/.exec(stock);
  for (const url of [
    'https://updates.bentobrowser.app/',
    'https://updates.bentobrowser.app/update/6/Bento/0.0.2/update.xml',
    stock.replace('/update/6/', '/update/5/'),
    stock.replace('/update.xml', '/update.json'),
    stock.replace('/update.xml', '/update.xml/'),
    stock.replace('/update.xml', '/extra/update.xml'),
    stock.replace('/Bento/0.0.2/', '/Bento//'),
    `${prefix}/Bento/0.0.2/b/t/l/c/o/s/d/dv/update.xml/more`,
    stock.replace('/update/6/', '/updates/6/'),
  ]) {
    const { response, body } = await check(url);
    assert.equal(response.status, 400, url);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8', url);
    assert.equal(response.headers.get('cache-control'), 'no-store', url);
    assert.ok(!body.trimStart().startsWith('<'), url);
  }
});

test('escapes every interpolated value', async () => {
  const hostile = withRelease({
    platformVersion: '15"8',
    buildId: '<1&2>',
    detailsUrl: 'https://example.test/?a=1&b="2"&c=<3>\'',
    marUrl: 'https://example.test/m.mar?x=1&y=2',
    sha512: '&',
  });
  const { body } = await check(updateUrl(), hostile);
  assert.ok(body.includes('platformVersion="15&quot;8"'));
  assert.ok(body.includes('buildID="&lt;1&amp;2&gt;"'));
  assert.ok(
    body.includes(
      'detailsURL="https://example.test/?a=1&amp;b=&quot;2&quot;&amp;c=&lt;3&gt;&apos;"',
    ),
  );
  assert.ok(body.includes('URL="https://example.test/m.mar?x=1&amp;y=2"'));
  assert.ok(body.includes('hashValue="&amp;"'));
  assert.ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(body));
});

test('fetch handler: GET and HEAD answer, other methods are 405', async () => {
  const request = (method) => new Request(updateUrl(), { method });
  const get = handleRequest(request('GET'), serving);
  assert.equal(get.status, 200);
  assert.match(await get.text(), /<update /);

  const head = handleRequest(request('HEAD'), serving);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('cache-control'), 'no-store');
  assert.equal(head.headers.get('content-type'), 'text/xml; charset=utf-8');
  assert.equal(await head.text(), '');

  const post = handleRequest(request('POST'), serving);
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  assert.equal(post.headers.get('cache-control'), 'no-store');
  assert.ok(!(await post.text()).startsWith('<'));
});

test('the committed descriptors are valid', () => {
  for (const env of ['test', 'production']) {
    const file = path.join(import.meta.dirname, 'releases', `${env}.json`);
    validateDescriptor(JSON.parse(fs.readFileSync(file, 'utf8')));
  }
});

test('descriptor validation accepts a complete descriptor and a withdrawn one', () => {
  assert.equal(validateDescriptor(serving), serving);
  const withdrawn = { ...serving, serving: false };
  assert.equal(validateDescriptor(withdrawn), withdrawn);
});

test('descriptor validation rejects unknown, missing and malformed fields', () => {
  const dropped = (key) =>
    Object.fromEntries(Object.entries(serving).filter(([name]) => name !== key));
  const droppedFromRelease = (key) => ({
    ...serving,
    release: Object.fromEntries(Object.entries(release).filter(([name]) => name !== key)),
  });
  const bad = {
    'unknown top-level field': { ...serving, note: 'x' },
    'unknown release field': withRelease({ partialUrl: 'https://example.test/p.mar' }),
    'missing serving': dropped('serving'),
    'missing release': dropped('release'),
    'missing release.sha512': droppedFromRelease('sha512'),
    'serving not boolean': { ...serving, serving: 'true' },
    'wrong product': { ...serving, product: 'Firefox' },
    'wrong target': { ...serving, target: 'Darwin_x86_64-gcc3' },
    'wrong channel': { ...serving, channel: 'release' },
    'serving without a release': { ...serving, release: null },
    'release not an object': { ...serving, release: 'x' },
    'version with a suffix': withRelease({ version: '0.0.3b1' }),
    'short buildId': withRelease({ buildId: '2026' }),
    'http marUrl': withRelease({ marUrl: release.marUrl.replace('https:', 'http:') }),
    'marUrl with credentials': withRelease({
      marUrl: release.marUrl.replace('https://', 'https://u:p@'),
    }),
    'marUrl for another version': withRelease({ marUrl: release.marUrl.replace('0.0.3', '0.0.4') }),
    'zero size': withRelease({ size: 0 }),
    'fractional size': withRelease({ size: 1.5 }),
    'string size': withRelease({ size: '123' }),
    'uppercase sha512': withRelease({ sha512: 'AB'.repeat(64) }),
    'short sha512': withRelease({ sha512: 'ab'.repeat(32) }),
    'bad platformVersion': withRelease({ platformVersion: 'latest' }),
    'bad detailsUrl': withRelease({ detailsUrl: 'not a url' }),
  };
  for (const [name, descriptor] of Object.entries(bad)) {
    assert.throws(() => validateDescriptor(descriptor), /invalid release descriptor/, name);
  }
  assert.throws(() => validateDescriptor(null), /not an object/);
  assert.throws(() => validateDescriptor([]), /not an object/);
});

test('descriptor validation rejects characters XML 1.0 cannot carry, in every string', () => {
  for (const character of ['\u0000', '\u0001', '\u000B', '\u001F', '\uFFFE', '\uFFFF', '\uD800']) {
    const name = `U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
    // `new URL()` accepts all of these, so only the XML check can stop them.
    assert.throws(
      () => validateDescriptor(withRelease({ detailsUrl: `https://example.test/${character}` })),
      /release\.detailsUrl contains a character that XML 1\.0 cannot carry/,
      name,
    );
    assert.throws(
      () => validateDescriptor(withRelease({ marUrl: `${release.marUrl}?x=${character}` })),
      /release\.marUrl contains a character that XML 1\.0 cannot carry/,
      name,
    );
    assert.throws(
      () => validateDescriptor({ ...serving, product: `Bento${character}` }),
      /descriptor\.product contains a character that XML 1\.0 cannot carry/,
      name,
    );
  }
  // Tab, LF and CR are legal in XML, and so are non-ASCII and astral characters.
  validateDescriptor(withRelease({ detailsUrl: 'https://example.test/\u00e9\u{1F600}' }));
});

test("each environment's wrangler entry serves its own descriptor on its own domain", async (t) => {
  // A copy of the service whose environments offer different releases, so the answer
  // shows which descriptor the entry named by `main` bundled.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(import.meta.dirname, dir, {
    recursive: true,
    filter: (source) => !source.endsWith('.test.mjs'),
  });
  const versions = { test: '0.0.3', production: '0.0.5' };
  for (const [env, version] of Object.entries(versions)) {
    const marUrl = `https://dl.bentobrowser.app/${marFileName(version, release.buildId)}`;
    fs.writeFileSync(
      path.join(dir, 'releases', `${env}.json`),
      JSON.stringify({ ...serving, release: { ...release, version, marUrl } }),
    );
  }

  const toml = fs.readFileSync(path.join(import.meta.dirname, 'wrangler.toml'), 'utf8');
  const [, testSection, productionSection] = toml.split(/^\[env\.(?:test|production)\]$/m);
  for (const [env, section, host] of [
    ['test', testSection, 'updates-test.bentobrowser.app'],
    ['production', productionSection, 'updates.bentobrowser.app'],
  ]) {
    assert.ok(
      section.includes(`pattern = "${host}", custom_domain = true`),
      `${env} custom domain`,
    );
    const [, main] = /^main = "(.+)"$/m.exec(section);
    const worker = (await import(pathToFileURL(path.join(dir, main)).href)).default;
    const response = await worker.fetch(new Request(updateUrl({ version: '0.0.1' })));
    assert.match(await response.text(), new RegExp(`appVersion="${versions[env]}"`), env);
  }
  assert.ok(
    !/^\s*(?:account_id|api_token)\s*=/im.test(toml),
    'no account id or token in the config',
  );
});
