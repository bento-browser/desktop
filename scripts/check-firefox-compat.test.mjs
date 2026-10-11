import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DOCS_PATH,
  MOUNT_PATH,
  checkDocs,
  checkEngine,
  evaluateSection,
  extractSection,
  findUndeclaredPrivateMembers,
  loadRegistry,
  main,
  validateRegistry,
} from './check-firefox-compat.mjs';

const SCRIPT = fileURLToPath(new URL('./check-firefox-compat.mjs', import.meta.url));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bento-compat-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(root, relative, text) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text);
}

function capture() {
  const lines = { log: [], error: [] };
  return {
    log: (message) => lines.log.push(String(message)),
    error: (message) => lines.error.push(String(message)),
    lines,
  };
}

// A window where every property exists, and one where nothing does.
function universal() {
  const proxy = new Proxy(function () {}, {
    // linkedPanel is the one member the probe requires to be a string.
    get: (_target, key) => {
      if (typeof key === 'symbol') return undefined;
      return key === 'linkedPanel' ? 'panel-1' : universal();
    },
    apply: () => universal(),
    has: () => true,
    getOwnPropertyDescriptor: () => ({
      value: universal(),
      writable: true,
      enumerable: true,
      configurable: true,
    }),
  });
  return proxy;
}

function runtimeGlobals(logs, { modulesLoaded }) {
  return {
    console: {
      error: (message) => logs.error.push(String(message)),
      info: (message) => logs.info.push(String(message)),
    },
    Services: { appinfo: { version: '154.0' } },
    ChromeUtils: {
      importESModule: () => {
        if (!modulesLoaded) throw new Error('module not found');
        return universal();
      },
    },
    Cu: { isESModuleLoaded: () => modulesLoaded },
  };
}

test('the real registry, its call sites, and the docs table agree', () => {
  const registry = loadRegistry();
  assert.ok(registry.members.length > 100, 'registry should list the audited members');
  assert.deepEqual(validateRegistry(registry), []);
  assert.deepEqual(findUndeclaredPrivateMembers(registry.source, registry), []);
  assert.deepEqual(checkDocs(registry), []);
});

test('the runtime probe stays quiet on a window that has every member', () => {
  const logs = { error: [], info: [] };
  const registry = loadRegistry(undefined, runtimeGlobals(logs, { modulesLoaded: true }));
  const result = registry.run(universal());
  // Arrays from the evaluated section belong to another realm; copy to compare.
  assert.deepEqual([...result.missing], []);
  assert.deepEqual([...result.deferred], []);
  assert.deepEqual(logs.error, []);
  assert.match(
    logs.info[0],
    /^\[bento-compat\] probed \d+ members on Firefox 154\.0: 0 missing, 0 deferred$/,
  );
});

test('the runtime probe logs one error per missing member and defers lazy ones', () => {
  const logs = { error: [], info: [] };
  const registry = loadRegistry(undefined, runtimeGlobals(logs, { modulesLoaded: false }));
  const emptyWindow = { document: { getElementById: () => null } };
  const result = registry.run(emptyWindow);

  const members = [...registry.members];
  const lazyIds = members.filter((entry) => entry.lazy).map((entry) => entry.id);
  const probed = members.filter((entry) => entry.kind !== 'source' && !entry.lazy);
  assert.deepEqual(new Set(result.deferred), new Set(lazyIds));
  assert.deepEqual(
    [...result.missing],
    probed.map((entry) => entry.id),
  );
  assert.equal(logs.error.length, probed.length);
  assert.match(
    logs.error.find((line) => line.includes('gBrowser._beginRemoveTab')),
    /^\[bento-compat\] missing gBrowser\._beginRemoveTab: .+ \(expected near browser\/components\/tabbrowser\/content\/tabbrowser\.js:\d+ in Firefox 154\.0\)$/,
  );
});

test('probes resolve roots, never run getters, and leave lazy globals unloaded', () => {
  const logs = { error: [], info: [] };
  const registry = loadRegistry(undefined, runtimeGlobals(logs, { modulesLoaded: true }));
  const probe = (win, id) =>
    registry.probe(
      win,
      [...registry.members].find((entry) => entry.id === id),
    );
  const never = () => {
    throw new Error('a probe invoked a getter');
  };

  const win = {
    gBrowser: {
      _beginRemoveTab() {},
      tabpanels: {
        removeTabsFromSplitview() {},
        get splitViewPanels() {
          return never();
        },
      },
      selectedTab: {
        linkedPanel: 'panel-1',
        get isEmpty() {
          return never();
        },
      },
      selectedBrowser: { mIconURL: null },
    },
    customElements: { get: () => ({ prototype: { removeProgressListener() {} } }) },
    document: { getElementById: (id) => (id === 'nav-bar' ? {} : null) },
  };
  Object.defineProperty(win, 'DownloadsPanel', { get: never, configurable: true });

  assert.equal(probe(win, 'gBrowser._beginRemoveTab'), 'ok');
  assert.equal(probe(win, 'gBrowser._findTabToBlurTo'), 'missing');
  assert.equal(probe(win, 'gBrowser.tabpanels.removeTabsFromSplitview'), 'ok');
  assert.equal(probe(win, 'gBrowser.tabpanels.splitViewPanels'), 'ok');
  assert.equal(probe(win, 'MozTabbrowserTab.isEmpty'), 'ok');
  assert.equal(probe(win, 'MozTabbrowserTab.linkedPanel'), 'ok');
  assert.equal(probe(win, 'MozBrowser.prototype.removeProgressListener'), 'ok');
  assert.equal(probe(win, 'MozBrowser.prototype.preserveLayers'), 'missing');
  assert.equal(probe(win, 'MozBrowser.mIconURL'), 'ok');
  assert.equal(probe(win, 'nav-bar'), 'ok');
  assert.equal(probe(win, 'urlbar'), 'missing');
  assert.equal(probe(win, 'DownloadsPanel.initialize'), 'deferred');
  assert.equal(probe(win, 'pagetitlechanged'), 'source');

  Object.defineProperty(win, 'DownloadsPanel', { value: { initialize() {} }, configurable: true });
  assert.equal(probe(win, 'DownloadsPanel.initialize'), 'ok');
});

test('a probe that throws counts as missing instead of breaking the run', () => {
  const logs = { error: [], info: [] };
  const registry = loadRegistry(undefined, runtimeGlobals(logs, { modulesLoaded: true }));
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('boom');
      },
    },
  );
  const result = registry.run(hostile);
  assert.ok(result.missing.length > 0);
  assert.equal(logs.error.length, result.missing.length);
});

test('an underscore or on_ member reached on a Firefox global needs an entry', () => {
  const registry = loadRegistry();
  const source = `${registry.source}
window.gBrowser._newHook();
PanelUI.on_newEvent;
// gBrowser._mentionedInAComment
window.gBrowser.__bentoOwnFlag = true;
`;
  assert.deepEqual(
    findUndeclaredPrivateMembers(source, registry).map((problem) =>
      problem.replace(/:\d+ /, ':N '),
    ),
    [
      `${MOUNT_PATH}:N reaches gBrowser._newHook but the registry has no entry`,
      `${MOUNT_PATH}:N reaches PanelUI.on_newEvent but the registry has no entry`,
    ],
  );
});

test('the marker comments must delimit exactly one section', () => {
  assert.throws(() => extractSection('no markers'), /must contain one/);
  const begin = '// @bento-firefox-compat:begin';
  const end = '// @bento-firefox-compat:end';
  assert.throws(() => extractSection(`${begin}\n${end}\n${begin}\n${end}`), /more than one/);
});

// A small repo and engine to drive the CLI end to end.
const FIXTURE_MOUNT = `(function () {
  function useTheHook() {
    return gBrowser._hook();
  }
  // @bento-firefox-compat:begin
  const BENTO_COMPAT_BASELINE = '154.0';
  const BENTO_FIREFOX_COMPAT = [
    {
      id: 'gBrowser._hook',
      kind: 'method',
      how: 'wraps',
      sites: ['useTheHook'],
      use: 'Wraps the hook.',
      at: ['browser/hook.js', '^\\\\s+_hook\\\\(', 3],
    },
    {
      id: 'resource:///modules/Thing.sys.mjs',
      kind: 'module',
      how: 'imports',
      sites: ['useTheHook'],
      use: 'Imports the module.',
      exports: ['Thing'],
      at: ['browser/Thing.sys.mjs', '^export const Thing', 1],
      reg: ['browser/moz.build', '"Thing\\\\.sys\\\\.mjs"'],
    },
  ];
  function probeBentoCompatEntry() { return 'source'; }
  function runBentoFirefoxCompat() { return {}; }
  // @bento-firefox-compat:end
})();
`;

const FIXTURE_DOCS = `# Touchpoints

<!-- firefox-compat:begin -->
<!-- firefox-compat:end -->
`;

function fixtureEngine(root, { hook = true, registered = true } = {}) {
  write(root, 'browser/hook.js', hook ? 'class A {\n\n  _hook() {}\n}\n' : 'class A {}\n');
  write(root, 'browser/Thing.sys.mjs', 'export const Thing = {};\n');
  write(root, 'browser/moz.build', registered ? 'MODULES = ["Thing.sys.mjs"]\n' : 'MODULES = []\n');
}

test('--engine lists missing members and exits non-zero', (t) => {
  const repo = tempDir(t);
  const engine = tempDir(t);
  write(repo, MOUNT_PATH, FIXTURE_MOUNT);
  write(repo, DOCS_PATH, FIXTURE_DOCS);

  const written = capture();
  assert.equal(main(['--repo', repo, '--write-docs'], written), 0, written.lines.error.join('\n'));
  assert.match(fs.readFileSync(path.join(repo, DOCS_PATH), 'utf8'), /`gBrowser\._hook`/);

  fixtureEngine(engine);
  const ok = capture();
  assert.equal(main(['--repo', repo, '--engine', engine], ok), 0, ok.lines.error.join('\n'));
  assert.match(ok.lines.log.join('\n'), /2 of 2 members found/);

  fixtureEngine(engine, { hook: false });
  const missingHook = capture();
  assert.equal(main(['--repo', repo, '--engine', engine], missingHook), 1);
  assert.match(
    missingHook.lines.error.join('\n'),
    /MISSING gBrowser\._hook\n.*not found in browser\/hook\.js/,
  );

  fixtureEngine(engine, { registered: false });
  const unregistered = capture();
  assert.equal(main(['--repo', repo, '--engine', engine], unregistered), 1);
  assert.match(
    unregistered.lines.error.join('\n'),
    /MISSING resource:\/\/\/modules\/Thing\.sys\.mjs\n.*no longer registered/,
  );
});

test('checkEngine reports the line where a moved member now lives', (t) => {
  const engine = tempDir(t);
  fixtureEngine(engine);
  const registry = evaluateSection(extractSection(FIXTURE_MOUNT));
  const [hook] = checkEngine(registry, engine);
  assert.deepEqual(hook, { id: 'gBrowser._hook', status: 'ok', line: 3, expected: 3 });

  write(engine, 'browser/hook.js', '\n\n\n\nclass A {\n  _hook() {}\n}\n');
  assert.equal(checkEngine(registry, engine)[0].line, 6);
});

test('a stale docs table, a removed call site, and a bad entry are all reported', (t) => {
  const repo = tempDir(t);
  write(repo, MOUNT_PATH, FIXTURE_MOUNT);
  write(repo, DOCS_PATH, FIXTURE_DOCS);

  const stale = capture();
  assert.equal(main(['--repo', repo], stale), 1);
  assert.match(stale.lines.error.join('\n'), /table is stale/);

  main(['--repo', repo, '--write-docs'], capture());
  write(repo, MOUNT_PATH, FIXTURE_MOUNT.replace('function useTheHook', 'function renamedHook'));
  const renamed = capture();
  assert.equal(main(['--repo', repo], renamed), 1);
  assert.match(renamed.lines.error.join('\n'), /site token "useTheHook" not found/);

  write(repo, MOUNT_PATH, FIXTURE_MOUNT.replace("kind: 'method'", "kind: 'nonsense'"));
  const bad = capture();
  assert.equal(main(['--repo', repo], bad), 1);
  assert.match(bad.lines.error.join('\n'), /gBrowser\._hook: kind must be one of/);
});

test('the CLI exits 2 on bad usage and when --engine is not a Firefox tree', (t) => {
  const empty = tempDir(t);
  const unknown = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument: --nope/);

  const notFirefox = spawnSync(process.execPath, [SCRIPT, '--engine', empty], { encoding: 'utf8' });
  assert.equal(notFirefox.status, 2);
  assert.match(notFirefox.stderr, /not a Firefox source tree/);
});
