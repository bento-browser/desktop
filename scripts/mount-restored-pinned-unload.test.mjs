// Firefox restores pinned tabs without loading them (restore_pinned_tabs_on_demand) but as
// pending tabs with a real browser, which the WebExtension API reports as loaded. The mount
// script unloads each one once its own history restore is done (SSTabRestoring plus one task):
// a browser discarded earlier is re-inserted by SessionStore. These tests run the real selection
// rule and the real SSTabRestoring handler from bento-shell-mount.js against stubs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const MOUNT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/browser/base/content/bento-shell-mount.js',
);
const source = readFileSync(MOUNT, 'utf8');

/** Source of a top-level (2-space indented) function in the mount script. */
function mountFunction(name) {
  const start = source.indexOf(`\n  function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing`);
  return source.slice(start, source.indexOf('\n  }\n', start) + 5);
}

const FUNCTIONS = [
  'shouldUnloadRestoredPinnedTab',
  'pinnedRestoreOnDemand',
  'attachRestoredPinnedTabUnload',
]
  .map(mountFunction)
  .join('\n');

/** A tab stub: attrs are the attribute names Firefox puts on the tab element. */
function tab(name, { pinned = true, selected = false, attrs = ['pending'], webExtId } = {}) {
  const stub = { name, pinned, selected, webExtId, attrs };
  stub.hasAttribute = (attr) => stub.attrs.includes(attr);
  return stub;
}

function setup({
  prefs = { 'browser.sessionstore.restore_pinned_tabs_on_demand': true },
  panelTabIds = [],
  discardBrowser,
} = {}) {
  const discarded = [];
  const discardArgCounts = [];
  const warnings = [];
  const listeners = new Map();
  const tasks = [];
  const sandbox = {
    console: { warn: (...args) => warnings.push(args) },
    Services: {
      prefs: { getBoolPref: (name, fallback) => (name in prefs ? prefs[name] : fallback) },
    },
    currentPanelTabIds: new Set(panelTabIds),
    getBentoTabId: (t) => t.webExtId ?? null,
    window: {
      gBrowser: {
        discardBrowser:
          discardBrowser ??
          ((...args) => {
            discarded.push(args[0].name);
            discardArgCounts.push(args.length);
          }),
      },
      addEventListener: (type, fn) => listeners.set(type, fn),
      setTimeout: (fn, delay) => tasks.push({ fn, delay }),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(FUNCTIONS, sandbox);
  sandbox.attachRestoredPinnedTabUnload();
  const flush = () => {
    while (tasks.length) tasks.shift().fn();
  };
  /** Dispatches SSTabRestoring on the tab and, unless told not to, runs the deferred task. */
  const restoring = (t, { run = true } = {}) => {
    listeners.get('SSTabRestoring')({ target: t });
    if (run) flush();
  };
  return { sandbox, discarded, discardArgCounts, warnings, listeners, tasks, flush, restoring };
}

test('only pinned, pending, unselected tabs that are quiet and not rendered panels qualify', () => {
  const { sandbox } = setup();
  const picked = [
    tab('pending-pinned'),
    tab('unpinned', { pinned: false }),
    tab('loaded', { attrs: [] }),
    tab('selected', { selected: true }),
    tab('audible', { attrs: ['pending', 'soundplaying'] }),
    tab('sharing', { attrs: ['pending', 'sharing'] }),
    tab('panel'),
  ].filter((t) => sandbox.shouldUnloadRestoredPinnedTab(t, (p) => p.name === 'panel'));
  assert.deepEqual(
    picked.map((t) => t.name),
    ['pending-pinned'],
  );
});

test('a pinned tab is discarded without force one task after its SSTabRestoring', () => {
  const { discarded, discardArgCounts, listeners, tasks, restoring } = setup();
  assert.deepEqual([...listeners.keys()], ['SSTabRestoring']);
  restoring(tab('a'), { run: false });
  assert.deepEqual(discarded, [], 'nothing is discarded inside the dispatch');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].delay, 0);
  tasks.shift().fn();
  assert.deepEqual(discarded, ['a']);
  assert.deepEqual(discardArgCounts, [1]);
});

test('an unpinned tab schedules nothing', () => {
  const { discarded, tasks, restoring } = setup();
  restoring(tab('a', { pinned: false }), { run: false });
  assert.equal(tasks.length, 0);
  assert.deepEqual(discarded, []);
});

test('the conditions are checked again when the task runs', () => {
  const { discarded, flush, restoring } = setup();
  const loading = tab('loading');
  const selecting = tab('selecting');
  restoring(loading, { run: false });
  restoring(selecting, { run: false });
  loading.attrs = []; // its content restore started, so the pending attribute is gone
  selecting.selected = true;
  flush();
  assert.deepEqual(discarded, []);
});

test('a pinned panel tab the window renders stays loaded', () => {
  const { discarded, restoring } = setup({ panelTabIds: [7] });
  restoring(tab('panel', { webExtId: 7 }));
  restoring(tab('other', { webExtId: 8 }));
  assert.deepEqual(discarded, ['other']);
});

test('tabs are unloaded only while both restore-on-demand prefs are true', () => {
  const PINNED = 'browser.sessionstore.restore_pinned_tabs_on_demand';
  const ALL = 'browser.sessionstore.restore_on_demand';
  // restore_on_demand defaults to true and the pinned pref to false in Firefox.
  const cases = [
    [{}, []],
    [{ [PINNED]: false }, []],
    [{ [PINNED]: true, [ALL]: false }, []],
    [{ [PINNED]: true }, ['a']],
    [{ [PINNED]: true, [ALL]: true }, ['a']],
  ];
  for (const [prefs, expected] of cases) {
    const { discarded, restoring } = setup({ prefs });
    restoring(tab('a'));
    assert.deepEqual(discarded, expected, JSON.stringify(prefs));
  }
});

test('a failing discard is logged and never thrown', () => {
  const { warnings, restoring } = setup({
    discardBrowser: () => {
      throw new Error('gone');
    },
  });
  assert.doesNotThrow(() => restoring(tab('a')));
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /^\[bento-shell-mount\]/);
});
