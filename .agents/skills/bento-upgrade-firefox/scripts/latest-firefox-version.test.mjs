import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { latestFirefoxVersion } from './latest-firefox-version.mjs';

function fixture(config = { firefox: { product: 'firefox' } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-latest-firefox-'));
  fs.writeFileSync(path.join(root, 'bento.json'), `${JSON.stringify(config)}\n`);
  return root;
}

function response(body, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

test('reads the canonical Bento product and resolves its Mozilla channel', async () => {
  const root = fixture();
  try {
    let requestedUrl;
    const version = await latestFirefoxVersion(root, async (url) => {
      requestedUrl = url;
      return response({ LATEST_FIREFOX_VERSION: '154.0' });
    });
    assert.equal(version, '154.0');
    assert.equal(requestedUrl, 'https://product-details.mozilla.org/1.0/firefox_versions.json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects missing and unsupported configured products', async () => {
  const missing = fixture({ firefox: {} });
  const unsupported = fixture({ firefox: { product: 'waterfox' } });
  try {
    await assert.rejects(
      () => latestFirefoxVersion(missing, async () => response({})),
      /must define firefox\.product/,
    );
    await assert.rejects(
      () => latestFirefoxVersion(unsupported, async () => response({})),
      /unsupported Firefox product/,
    );
  } finally {
    fs.rmSync(missing, { recursive: true, force: true });
    fs.rmSync(unsupported, { recursive: true, force: true });
  }
});

test('reports failed or incomplete Mozilla responses', async () => {
  const root = fixture();
  try {
    await assert.rejects(
      () => latestFirefoxVersion(root, async () => response({}, false, 503)),
      /HTTP 503/,
    );
    await assert.rejects(
      () => latestFirefoxVersion(root, async () => response({ FIREFOX_ESR: '115.0' })),
      /did not include LATEST_FIREFOX_VERSION/,
    );
    await assert.rejects(
      () =>
        latestFirefoxVersion(root, async () => {
          throw new Error('offline');
        }),
      /lookup failed: offline/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
