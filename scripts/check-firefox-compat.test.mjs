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
  evaluateProbeSection,
  extractSection,
  findUndeclaredPrivateMembers,
  main,
  readMount,
  validateProbeList,
  validateRegistry,
} from './check-firefox-compat.mjs';
import { registry } from './firefox-compat-registry.mjs';

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

// A window where every property exists.
function universal() {
  return new Proxy(function () {}, {
    // linkedPanel is the one member the probe requires to be a string.
    get: (_target, key) => {
      if (typeof key === 'symbol') return undefined;
      return key === 'linkedPanel' ? 'panel-1' : universal();
    },
    apply: () => universal(),
    has: () => true,
    getPrototypeOf: () => universal(),
    getOwnPropertyDescriptor: () => ({
      value: universal(),
      writable: true,
      enumerable: true,
      configurable: true,
    }),
  });
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

function loadProbes(globals) {
  return evaluateProbeSection(extractSection(readMount()), globals);
}

const runtimeEntries = registry.members.filter((entry) => entry.probe !== 'E');

test('the real registry, its call sites, the probe list, and the docs table agree', () => {
  assert.ok(registry.members.length > 100, 'registry should list the audited members');
  assert.deepEqual(validateRegistry(registry), []);
  assert.deepEqual(validateProbeList(readMount(), registry), []);
  assert.deepEqual(findUndeclaredPrivateMembers(readMount(), registry), []);
  assert.deepEqual(checkDocs(registry), []);
});

test('the mount probe ids equal the registry entries marked R or R-lazy', () => {
  // The section runs in another realm; copy its entries before comparing.
  const mounted = Array.from(loadProbes().entries);
  const ids = (entries) => entries.map((entry) => entry.id).sort();
  assert.deepEqual(ids(mounted), ids(runtimeEntries));
  assert.deepEqual(
    ids(mounted.filter((entry) => entry.lazy)),
    ids(registry.members.filter((entry) => entry.probe === 'R-lazy')),
  );
});

test('the shipped probe section stays compact', () => {
  assert.ok(
    extractSection(readMount()).length < 10000,
    'keep use and locator text in the registry',
  );
});

test('probe list drift against the registry is reported', () => {
  const source = readMount();
  const first = registry.members.find((entry) => entry.id === 'gBrowser._beginRemoveTab');
  const mutate = (members) => ({ ...registry, members });
  const others = registry.members.filter((entry) => entry !== first);

  assert.match(
    validateProbeList(
      source,
      mutate([...registry.members, { ...first, id: 'gBrowser._newHook' }]),
    )[0],
    /gBrowser\._newHook: registry probe R but .* does not probe it/,
  );
  assert.match(
    validateProbeList(source, mutate([...others, { ...first, probe: 'E', kind: 'source' }]))[0],
    new RegExp(`${first.id.replaceAll('.', '\\.')}: probed in .* no R or R-lazy entry`),
  );
  assert.match(
    validateProbeList(source, mutate([...others, { ...first, probe: 'R-lazy' }]))[0],
    /lazy is false .* registry probe is R-lazy/,
  );
  assert.match(
    validateProbeList(source, mutate([...others, { ...first, kind: 'element' }]))[0],
    /probed as (method|member) but registry kind is element/,
  );
  const module = runtimeEntries.find((entry) => entry.kind === 'module');
  assert.match(
    validateProbeList(
      source,
      mutate(
        registry.members.map((entry) =>
          entry === module ? { ...module, exports: ['Other'] } : entry,
        ),
      ),
    )[0],
    /probed export .* is not in the registry exports/,
  );
  assert.match(validateProbeList('no markers', registry)[0], /cannot read the probe list/);

  // A patch site that stops recording the native member, a stray recording,
  // and a proto list that no longer matches are all drift.
  const call = "bentoCompatNoteNative('PopupNotifications._isActiveBrowser'";
  assert.ok(source.includes(call));
  assert.match(
    validateProbeList(
      source.replace(call, "bentoCompatNoteNative('PopupNotifications.other'"),
      registry,
    ).join('\n'),
    /PopupNotifications\._isActiveBrowser: registry says native: note but .* never calls[\s\S]*PopupNotifications\.other: .* does not say native: note/,
  );
  const proto = "proto: ['MozTabbrowserTab.splitview', 'gBrowser.tabpanels.splitViewPanels']";
  assert.ok(source.includes(proto));
  assert.match(
    validateProbeList(source.replace(proto, "proto: ['MozTabbrowserTab.splitview']"), registry)[0],
    /gBrowser\.tabpanels\.splitViewPanels: registry says native: proto but .* proto list lacks it/,
  );
});

test('the runtime probe stays quiet on a window that has every member', () => {
  const logs = { error: [], info: [] };
  const result = loadProbes(runtimeGlobals(logs, { modulesLoaded: true })).run(universal());
  // Arrays from the evaluated section belong to another realm; copy to compare.
  assert.deepEqual([...result.missing], []);
  assert.deepEqual([...result.deferred], []);
  assert.equal(result.probed, runtimeEntries.length);
  assert.deepEqual(logs.error, []);
  assert.match(
    logs.info[0],
    /^\[bento-compat\] probed \d+ members on Firefox 154\.0: 0 missing, 0 deferred$/,
  );
});

test('the runtime probe logs one id per missing member and defers unloaded lazy modules', () => {
  const logs = { error: [], info: [] };
  const probes = loadProbes(runtimeGlobals(logs, { modulesLoaded: false }));
  const result = probes.run({ document: { getElementById: () => null } });

  const lazyModules = runtimeEntries
    .filter((entry) => entry.probe === 'R-lazy' && entry.kind === 'module')
    .map((entry) => entry.id);
  const absent = runtimeEntries
    .map((entry) => entry.id)
    .filter((id) => !lazyModules.includes(id))
    .sort();
  assert.deepEqual([...result.deferred].sort(), lazyModules.sort());
  // A window with no DownloadsPanel at all is missing it, not waiting for it.
  assert.deepEqual([...result.missing].sort(), absent);
  assert.equal(logs.error.length, absent.length);
  assert.ok(logs.error.includes('[bento-compat] missing gBrowser._beginRemoveTab'));
  assert.ok(logs.error.includes('[bento-compat] missing DownloadsPanel.initialize'));
});

test('probes resolve roots, never run getters, and leave lazy globals unloaded', () => {
  const logs = { error: [], info: [] };
  const probes = loadProbes(runtimeGlobals(logs, { modulesLoaded: true }));
  const probe = (win, id) =>
    probes.probe(
      win,
      probes.entries.find((entry) => entry.id === id),
    );
  const never = () => {
    throw new Error('a probe invoked a getter');
  };

  const win = {
    OpenBrowserWindow() {},
    gBrowser: {
      _beginRemoveTab() {},
      tabpanels: Object.create({
        splitViewPanels: [],
      }),
      selectedTab: Object.create({
        linkedPanel: 'panel-1',
        get isEmpty() {
          return never();
        },
      }),
      selectedBrowser: { mIconURL: null },
    },
    gURLBar: { view: { close() {} } },
    customElements: { get: () => ({ prototype: { removeProgressListener() {} } }) },
    document: { getElementById: (id) => (id === 'nav-bar' ? {} : null) },
  };
  Object.defineProperty(win.gBrowser.tabpanels, 'removeTabsFromSplitview', {
    value() {},
  });
  Object.defineProperty(win.gBrowser.tabpanels, 'handleEvent', { value() {} });
  Object.defineProperty(win.gBrowser.selectedTab, 'linkedPanel', { value: 'panel-1' });
  Object.defineProperty(win, 'DownloadsPanel', { get: never, configurable: true });

  assert.equal(probe(win, 'gBrowser._beginRemoveTab'), 'ok');
  assert.equal(probe(win, 'gBrowser._findTabToBlurTo'), 'missing');
  assert.equal(probe(win, 'gBrowser.tabpanels.removeTabsFromSplitview'), 'ok');
  assert.equal(probe(win, 'gBrowser.tabpanels.splitViewPanels'), 'ok');
  assert.equal(probe(win, 'gURLBar.view.close'), 'ok');
  assert.equal(probe(win, 'MozTabbrowserTab.isEmpty'), 'ok');
  assert.equal(probe(win, 'MozTabbrowserTab.linkedPanel'), 'ok');
  assert.equal(probe(win, 'MozBrowser.prototype.removeProgressListener'), 'ok');
  assert.equal(probe(win, 'MozBrowser.prototype.preserveLayers'), 'missing');
  assert.equal(probe(win, 'MozBrowser.mIconURL'), 'ok');
  assert.equal(probe(win, 'nav-bar'), 'ok');
  assert.equal(probe(win, 'urlbar'), 'missing');
  assert.equal(probe(win, 'DownloadsPanel.initialize'), 'deferred');
  assert.equal(probe(win, 'OpenBrowserWindow'), 'ok');
  assert.equal(probe({}, 'OpenBrowserWindow'), 'missing');

  Object.defineProperty(win, 'DownloadsPanel', { value: { initialize() {} }, configurable: true });
  assert.equal(probe(win, 'DownloadsPanel.initialize'), 'ok');
});

test('a lazy global is missing when absent, deferred behind its getter, and probed once loaded', () => {
  const probes = loadProbes(runtimeGlobals({ error: [], info: [] }, { modulesLoaded: true }));
  const probe = (win, id) =>
    probes.probe(
      win,
      probes.entries.find((entry) => entry.id === id),
    );
  const never = () => {
    throw new Error('a probe invoked a getter');
  };
  const lazyGlobal = (win, name) =>
    Object.defineProperty(win, name, { get: never, set() {}, configurable: true });

  // No property at all: a deleted DownloadsPanel must not wait forever.
  assert.equal(probe({}, 'DownloadsPanel.initialize'), 'missing');
  assert.equal(probe({}, 'DownloadsButton.getAnchor'), 'missing');
  assert.equal(probe({}, 'PlacesUIUtils.lastContextMenuTriggerNode'), 'missing');

  const win = {};
  lazyGlobal(win, 'DownloadsPanel');
  lazyGlobal(win, 'DownloadsButton');
  lazyGlobal(win, 'PlacesUIUtils');
  assert.equal(probe(win, 'DownloadsPanel.initialize'), 'deferred');
  assert.equal(probe(win, 'DownloadsButton.getAnchor'), 'deferred');
  assert.equal(probe(win, 'PlacesUIUtils.lastContextMenuTriggerNode'), 'deferred');
  // PrivateDownloadsSubview is a plain var in the downloads script, so it
  // waits on DownloadsPanel's getter instead of counting as absent.
  assert.equal(probe(win, 'PrivateDownloadsSubview.openWhenReady'), 'deferred');

  Object.defineProperty(win, 'DownloadsPanel', { value: { initialize() {} }, configurable: true });
  assert.equal(probe(win, 'DownloadsPanel.initialize'), 'ok');
  assert.equal(probe(win, 'PrivateDownloadsSubview.openWhenReady'), 'missing');
  win.PrivateDownloadsSubview = { openWhenReady() {} };
  assert.equal(probe(win, 'PrivateDownloadsSubview.openWhenReady'), 'ok');
  Object.defineProperty(win, 'PlacesUIUtils', { value: {}, configurable: true });
  assert.equal(probe(win, 'PlacesUIUtils.lastContextMenuTriggerNode'), 'missing');
});

test('elements that live inside a template until their owner expands them are not probed', () => {
  const identity = registry.members.find((entry) => entry.id === 'identity-popup');
  assert.equal(identity.probe, 'E');
  assert.match(identity.use, /template-identity-popup/);
  assert.ok(!Array.from(loadProbes().entries).some((entry) => entry.id === 'identity-popup'));

  // A fresh window keeps the panel in <html:template id="template-identity-popup">.
  const probes = loadProbes(runtimeGlobals({ error: [], info: [] }, { modulesLoaded: true }));
  const { missing } = probes.run({
    document: { getElementById: (id) => (id === 'identity-popup' ? null : {}) },
  });
  assert.ok(!missing.includes('identity-popup'));
  assert.ok(!missing.includes('nav-bar'));
});

const nativeNotes = runtimeEntries.filter((entry) => entry.native === 'note');

test('a wrapped member is judged by the original Firefox recorded before Bento replaced it', () => {
  assert.deepEqual(nativeNotes.map((entry) => entry.id).sort(), [
    'DownloadsButton.getAnchor',
    'DownloadsButton.releaseAnchor',
    'MozBrowser.prototype.removeProgressListener',
    'MozTabbrowserTab.isEmpty',
    'PopupNotifications._isActiveBrowser',
    'gBrowser._beginRemoveTab',
    'gBrowser._findTabToBlurTo',
    'gBrowser.on_visibilitychange',
  ]);
  const probes = loadProbes(runtimeGlobals({ error: [], info: [] }, { modulesLoaded: true }));
  const probe = (win, id) =>
    probes.probe(
      win,
      probes.entries.find((entry) => entry.id === id),
    );
  for (const { id } of nativeNotes) {
    // Bento's wrapper is in place (the universal window has every member), but
    // Firefox's original was missing when the patch site ran.
    probes.note(id, undefined);
    assert.equal(probe(universal(), id), 'missing', `${id} with no native original`);
    // Firefox's original existed (the window itself has nothing).
    probes.note(id, function original() {});
    assert.equal(probe({}, id), 'ok', `${id} with a native original`);
  }
});

test('Bento writes to a member never satisfy a probe on that member', () => {
  const probes = loadProbes(runtimeGlobals({ error: [], info: [] }, { modulesLoaded: true }));
  const probe = (win, id) =>
    probes.probe(
      win,
      probes.entries.find((entry) => entry.id === id),
    );
  assert.deepEqual(
    runtimeEntries
      .filter((entry) => entry.native === 'proto')
      .map((entry) => entry.id)
      .sort(),
    ['MozTabbrowserTab.splitview', 'gBrowser.tabpanels.splitViewPanels'],
  );

  // Bento assigned splitViewPanels and shadowed splitview on the instances;
  // Firefox's prototypes no longer define either.
  const tabpanels = Object.create({});
  tabpanels.splitViewPanels = [];
  const selectedTab = Object.create({});
  Object.defineProperty(selectedTab, 'splitview', { value: {}, configurable: true });
  const win = { gBrowser: { tabpanels, selectedTab } };
  assert.equal(probe(win, 'gBrowser.tabpanels.splitViewPanels'), 'missing');
  assert.equal(probe(win, 'MozTabbrowserTab.splitview'), 'missing');

  win.gBrowser.tabpanels = Object.create({ splitViewPanels: [] });
  win.gBrowser.selectedTab = Object.create({ splitview: null });
  assert.equal(probe(win, 'gBrowser.tabpanels.splitViewPanels'), 'ok');
  assert.equal(probe(win, 'MozTabbrowserTab.splitview'), 'ok');
});

test('a probe that throws counts as missing instead of breaking the run', () => {
  const logs = { error: [], info: [] };
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error('boom');
      },
    },
  );
  const result = loadProbes(runtimeGlobals(logs, { modulesLoaded: true })).run(hostile);
  assert.ok(result.missing.length > 0);
  assert.equal(logs.error.length, result.missing.length);
});

test('an underscore or on_ member reached on a Firefox global needs an entry', () => {
  const source = `${readMount()}
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

// A small registry, repo and engine to drive the CLI end to end. The fixture
// mount reuses the real probe runner with a two-member probe list.
const FIXTURE_REGISTRY = {
  baseline: '154.0',
  members: [
    {
      id: 'gBrowser._hook',
      kind: 'method',
      how: 'calls',
      probe: 'R',
      sites: ['useTheHook'],
      use: 'Wraps the hook.',
      at: ['browser/hook.js', '^\\s+_hook\\(', 3],
    },
    {
      id: 'resource:///modules/Thing.sys.mjs',
      kind: 'module',
      how: 'imports',
      probe: 'R',
      sites: ['useTheHook'],
      use: 'Imports the module.',
      exports: ['Thing'],
      at: ['browser/Thing.sys.mjs', '^export const Thing', 1],
      reg: ['browser/moz.build', '"Thing\\.sys\\.mjs"'],
    },
  ],
};

const FIXTURE_PROBES = {
  members: { gBrowser: ['_hook()'] },
  proto: [],
  elements: [],
  modules: { 'resource:///modules/Thing.sys.mjs': 'Thing' },
  custom: {},
  lazy: [],
  gate: {},
};

function fixtureMount(probes = FIXTURE_PROBES) {
  const literal = /const BENTO_COMPAT_PROBES = \{[\s\S]*?\n {2}\};\n/;
  const section = extractSection(readMount());
  assert.match(section, literal);
  return `(function () {
  function useTheHook() {
    return gBrowser._hook();
  }
  // @bento-firefox-compat:begin${section.replace(literal, `const BENTO_COMPAT_PROBES = ${JSON.stringify(probes)};\n`)}// @bento-firefox-compat:end
})();
`;
}

const FIXTURE_DOCS = `# Touchpoints

<!-- firefox-compat:begin -->
<!-- firefox-compat:end -->
`;

function fixtureRepo(t) {
  const repo = tempDir(t);
  write(repo, MOUNT_PATH, fixtureMount());
  write(repo, DOCS_PATH, FIXTURE_DOCS);
  return repo;
}

function fixtureEngine(root, { hook = true, registered = true } = {}) {
  write(root, 'browser/hook.js', hook ? 'class A {\n\n  _hook() {}\n}\n' : 'class A {}\n');
  write(root, 'browser/Thing.sys.mjs', 'export const Thing = {};\n');
  write(root, 'browser/moz.build', registered ? 'MODULES = ["Thing.sys.mjs"]\n' : 'MODULES = []\n');
}

test('--engine lists missing members and exits non-zero', (t) => {
  const repo = fixtureRepo(t);
  const engine = tempDir(t);
  const run = (...args) => {
    const out = capture();
    return { code: main(['--repo', repo, ...args], out, FIXTURE_REGISTRY), out: out.lines };
  };

  const written = run('--write-docs');
  assert.equal(written.code, 0, written.out.error.join('\n'));
  assert.match(fs.readFileSync(path.join(repo, DOCS_PATH), 'utf8'), /`gBrowser\._hook`/);

  fixtureEngine(engine);
  const ok = run('--engine', engine);
  assert.equal(ok.code, 0, ok.out.error.join('\n'));
  assert.match(ok.out.log.join('\n'), /2 of 2 members found/);

  fixtureEngine(engine, { hook: false });
  const missingHook = run('--engine', engine);
  assert.equal(missingHook.code, 1);
  assert.match(
    missingHook.out.error.join('\n'),
    /MISSING gBrowser\._hook\n.*not found in browser\/hook\.js/,
  );

  fixtureEngine(engine, { registered: false });
  const unregistered = run('--engine', engine);
  assert.equal(unregistered.code, 1);
  assert.match(
    unregistered.out.error.join('\n'),
    /MISSING resource:\/\/\/modules\/Thing\.sys\.mjs\n.*no longer registered/,
  );
});

test('checkEngine reports the line where a moved member now lives', (t) => {
  const engine = tempDir(t);
  fixtureEngine(engine);
  const [hook] = checkEngine(FIXTURE_REGISTRY, engine);
  assert.deepEqual(hook, { id: 'gBrowser._hook', status: 'ok', line: 3, expected: 3 });

  write(engine, 'browser/hook.js', '\n\n\n\nclass A {\n  _hook() {}\n}\n');
  assert.equal(checkEngine(FIXTURE_REGISTRY, engine)[0].line, 6);
});

// Vanilla Firefox 154 text for entries added after the first audit pass, and
// the rename that must make the engine check fail.
const RENAMES = [
  [
    'FirefoxProfileMigrator._getFileObject',
    '  _getFileObject(dir, fileName) {\n  }\n',
    '_getFileObject',
    '_getFile',
  ],
  [
    'AsyncSetting.emitChange',
    '  emitChange = () => {\n    this.emit("change");\n  };\n',
    'emitChange',
    'notifyChange',
  ],
  [
    'TabSelect',
    '        let event = new CustomEvent("TabSelect", {\n',
    '"TabSelect"',
    '"TabSelected"',
  ],
  ['TabOpen', '      let evt = new CustomEvent("TabOpen", {\n', '"TabOpen"', '"TabOpened"'],
  [
    'TabAttrModified',
    '      let event = new CustomEvent("TabAttrModified", {\n',
    '"TabAttrModified"',
    '"TabAttrChanged"',
  ],
  [
    'SSTabRestored',
    '    event.initCustomEvent("SSTabRestored", true, false, {\n',
    '"SSTabRestored"',
    '"SSTabReady"',
  ],
  ['gBrowser._endRemoveTab', '    _endRemoveTab(aTab) {\n', '_endRemoveTab', '_finishRemoveTab'],
  [
    'tab._endRemoveArgs',
    '      aTab._endRemoveArgs = [closeWindow, newTab];\n',
    '_endRemoveArgs',
    '_removeArgs',
  ],
  [
    'MigrationWizard:Close',
    '        new CustomEvent("MigrationWizard:Close", { bubbles: true })\n',
    '"MigrationWizard:Close"',
    '"MigrationWizard:Done"',
  ],
  [
    'about:devtools-toolbox id parameter',
    '  const id = params.get("id");\n',
    'get("id")',
    'get("targetId")',
  ],
  [
    'about:devtools-toolbox type parameter',
    '  const type = params.get("type");\n',
    'get("type")',
    'get("kind")',
  ],
  [
    'about:devtools-toolbox type=tab branch',
    '  if (type === "tab") {\n    commands = await CommandsFactory.forRemoteTab(id, { client });\n  }\n',
    'forRemoteTab(id',
    'forTab(id',
  ],
  [
    'identity-popup',
    '<html:template id="template-identity-popup">\n<panel id="identity-popup"\n',
    'id="identity-popup"',
    'id="identity-panel"',
  ],
];

for (const [id, vanilla, from, to] of RENAMES) {
  test(`the engine check fails when Firefox renames ${id}`, (t) => {
    const entry = registry.members.find((member) => member.id === id);
    assert.ok(entry, `${id} must be in the registry`);
    assert.ok(vanilla.includes(from));
    const engine = tempDir(t);
    const check = () => checkEngine({ ...registry, members: [entry] }, engine)[0];

    write(engine, entry.at[0], vanilla);
    assert.equal(check().status, 'ok');
    write(engine, entry.at[0], vanilla.replace(from, to));
    assert.equal(check().status, 'missing');
  });
}

test('a stale docs table, a removed call site, a bad entry, and probe drift are reported', (t) => {
  const repo = fixtureRepo(t);
  const run = (members = FIXTURE_REGISTRY.members) => {
    const out = capture();
    const code = main(['--repo', repo], out, { ...FIXTURE_REGISTRY, members });
    return { code, errors: out.lines.error.join('\n') };
  };

  const stale = run();
  assert.equal(stale.code, 1);
  assert.match(stale.errors, /table is stale/);

  main(['--repo', repo, '--write-docs'], capture(), FIXTURE_REGISTRY);
  assert.equal(run().code, 0);

  const [hook, thing] = FIXTURE_REGISTRY.members;
  const bad = run([{ ...hook, kind: 'nonsense' }, thing]);
  assert.equal(bad.code, 1);
  assert.match(bad.errors, /gBrowser\._hook: kind must be one of/);

  const engineOnlyMismatch = run([{ ...hook, probe: 'E' }, thing]);
  assert.equal(engineOnlyMismatch.code, 1);
  assert.match(engineOnlyMismatch.errors, /probe E and kind source go together/);

  const drifted = run([...FIXTURE_REGISTRY.members, { ...hook, id: 'gBrowser._other' }]);
  assert.equal(drifted.code, 1);
  assert.match(drifted.errors, /gBrowser\._other: registry probe R but .* does not probe it/);

  write(repo, MOUNT_PATH, fixtureMount().replace('function useTheHook', 'function renamedHook'));
  const renamed = run();
  assert.equal(renamed.code, 1);
  assert.match(renamed.errors, /site token "useTheHook" not found/);
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
