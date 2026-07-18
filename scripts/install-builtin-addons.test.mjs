import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { installBuiltinAddons } from './install-builtin-addons.mjs';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-addons-test-'));
  fs.mkdirSync(path.join(root, 'extensions'), { recursive: true });
  fs.mkdirSync(path.join(root, 'engine', 'browser', 'extensions'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'engine', 'browser', 'extensions', 'moz.build'),
    '# upstream\nDIRS += ["webcompat"]\n',
  );
  return root;
}

function addExtension(root, name, manifest = { applications: { gecko: { id: `${name}@test` } } }) {
  const extension = path.join(root, 'extensions', name);
  writeJson(path.join(extension, 'manifest.json'), manifest);
  fs.mkdirSync(path.join(extension, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(extension, 'dist', 'z.js'), 'z');
  fs.writeFileSync(path.join(extension, 'dist', 'a.js'), 'a');
  fs.mkdirSync(path.join(extension, 'src'), { recursive: true });
  fs.writeFileSync(path.join(extension, 'src', 'not-shipped.ts'), 'source');
  return extension;
}

test('copies only runtime files and writes deterministic build manifests', () => {
  const root = fixture();
  try {
    addExtension(root, 'bento-shell');
    const [addon] = installBuiltinAddons({ repoRoot: root });
    assert.equal(addon.name, 'bento-shell');
    assert.equal(fs.existsSync(path.join(addon.destination, 'src')), false);
    const jar = fs.readFileSync(path.join(addon.destination, 'jar.mn'), 'utf8');
    assert.match(jar, /builtin-addons\/bento-shell\/dist\/a\.js/);
    assert.ok(jar.indexOf('dist/a.js') < jar.indexOf('dist/z.js'));
    assert.doesNotMatch(jar, /\\/);
    assert.match(
      fs.readFileSync(path.join(addon.destination, 'moz.build'), 'utf8'),
      /JAR_MANIFESTS/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('custom runtime entries replace defaults but always include manifest', () => {
  const root = fixture();
  try {
    const extension = addExtension(root, 'large-addon');
    fs.mkdirSync(path.join(extension, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(extension, 'assets', 'data'), 'data');
    writeJson(path.join(extension, '.bento-runtime-entries.json'), ['assets']);
    const [addon] = installBuiltinAddons({ repoRoot: root });
    assert.equal(fs.existsSync(path.join(addon.destination, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(addon.destination, 'assets', 'data')), true);
    assert.equal(fs.existsSync(path.join(addon.destination, 'dist')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('packages both privileged preference bridge experiments and version metadata', () => {
  const root = fixture();
  try {
    const shell = addExtension(root, 'bento-shell', {
      version: '0.0.3',
      browser_specific_settings: { gecko: { id: 'bento-shell@bento.app' } },
      experiment_apis: {
        bentoChrome: {
          schema: 'experiments/chrome-bridge/schema.json',
          parent: { script: 'experiments/chrome-bridge/api.js' },
        },
      },
    });
    const tools = addExtension(root, 'bento-tools', {
      version: '0.1.11',
      browser_specific_settings: { gecko: { id: 'bento-tools@bento.app' } },
      experiment_apis: {
        bentoNativePreferences: {
          schema: 'experiments/bento-native-preferences/schema.json',
          parent: { script: 'experiments/bento-native-preferences/api.js' },
        },
      },
    });
    for (const [extension, directory] of [
      [shell, 'chrome-bridge'],
      [tools, 'bento-native-preferences'],
    ]) {
      const experiment = path.join(extension, 'experiments', directory);
      fs.mkdirSync(experiment, { recursive: true });
      fs.writeFileSync(path.join(experiment, 'api.js'), 'api');
      writeJson(path.join(experiment, 'schema.json'), []);
    }

    const addons = installBuiltinAddons({ repoRoot: root });
    for (const addon of addons) {
      const jar = fs.readFileSync(path.join(addon.destination, 'jar.mn'), 'utf8');
      assert.match(jar, /experiments\/.+\/api\.js/);
      assert.match(jar, /experiments\/.+\/schema\.json/);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(addon.destination, 'manifest.json'), 'utf8'),
      );
      assert.ok(manifest.experiment_apis);
      assert.match(manifest.version, /^0\.(?:0\.3|1\.11)$/);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects missing IDs and unsafe runtime entries', () => {
  const root = fixture();
  try {
    const extension = addExtension(root, 'broken', {});
    assert.throws(() => installBuiltinAddons({ repoRoot: root }), /no Gecko add-on ID/);
    writeJson(path.join(extension, 'manifest.json'), {
      browser_specific_settings: { gecko: { id: 'broken@test' } },
    });
    writeJson(path.join(extension, '.bento-runtime-entries.json'), ['../escape']);
    assert.throws(() => installBuiltinAddons({ repoRoot: root }), /unsafe top-level runtime entry/);
    writeJson(path.join(extension, '.bento-runtime-entries.json'), ['C:escape']);
    assert.throws(() => installBuiltinAddons({ repoRoot: root }), /unsafe top-level runtime entry/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('removes stale output and replaces one marker block idempotently', () => {
  const root = fixture();
  try {
    addExtension(root, 'bento-tools');
    installBuiltinAddons({ repoRoot: root });
    const destination = path.join(root, 'engine', 'browser', 'extensions', 'bento-tools');
    fs.writeFileSync(path.join(destination, 'stale'), 'stale');
    installBuiltinAddons({ repoRoot: root });
    assert.equal(fs.existsSync(path.join(destination, 'stale')), false);
    const mozBuild = fs.readFileSync(
      path.join(root, 'engine', 'browser', 'extensions', 'moz.build'),
      'utf8',
    );
    assert.equal(mozBuild.split('# BEGIN BENTO BUILTIN ADDONS').length - 1, 1);
    assert.match(mozBuild, /DIRS \+= \["webcompat"\]/);
    assert.match(mozBuild, /DIRS \+= \["bento-tools"\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects malformed marker blocks', () => {
  const root = fixture();
  try {
    addExtension(root, 'bento-tools');
    fs.appendFileSync(
      path.join(root, 'engine', 'browser', 'extensions', 'moz.build'),
      '# BEGIN BENTO BUILTIN ADDONS\n',
    );
    assert.throws(() => installBuiltinAddons({ repoRoot: root }), /malformed Bento marker block/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
