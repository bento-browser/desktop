// Firefox restores pinned tabs without loading them (restore_pinned_tabs_on_demand) but as
// pending tabs with a real browser, which the WebExtension API reports as loaded. The mount
// script unloads them when a window finishes its session restore. These tests run the real
// selection rule and the real SSWindowRestored handler from bento-shell-mount.js against stubs.
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

const FUNCTIONS = ['pinnedTabsToUnload', 'pinnedRestoreOnDemand', 'attachRestoredPinnedTabUnload']
  .map(mountFunction)
  .join('\n');

/** A tab stub: attributes are the names Firefox puts on the tab element. */
function tab(name, { pinned = true, selected = false, attrs = ['pending'], webExtId } = {}) {
  return { name, pinned, selected, webExtId, hasAttribute: (attr) => attrs.includes(attr) };
}

function setup({
  tabs,
  prefs = { 'browser.sessionstore.restore_pinned_tabs_on_demand': true },
  panelTabIds = [],
  discardBrowser,
} = {}) {
  const discarded = [];
  const discardArgCounts = [];
  const warnings = [];
  const listeners = new Map();
  const sandbox = {
    console: { warn: (...args) => warnings.push(args) },
    Services: {
      prefs: { getBoolPref: (name, fallback) => (name in prefs ? prefs[name] : fallback) },
    },
    currentPanelTabIds: new Set(panelTabIds),
    getBentoTabId: (t) => t.webExtId ?? null,
    window: {
      gBrowser: {
        tabs,
        discardBrowser:
          discardBrowser ??
          ((...args) => {
            discarded.push(args[0].name);
            discardArgCounts.push(args.length);
          }),
      },
      addEventListener: (type, fn) => listeners.set(type, fn),
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(FUNCTIONS, sandbox);
  return { sandbox, discarded, discardArgCounts, warnings, listeners };
}

test('only pinned, pending, unselected tabs that are quiet and not rendered panels are picked', () => {
  const { sandbox } = setup({ tabs: [] });
  const tabs = [
    tab('pending-pinned'),
    tab('unpinned', { pinned: false }),
    tab('loaded', { attrs: [] }),
    tab('selected', { selected: true }),
    tab('audible', { attrs: ['pending', 'soundplaying'] }),
    tab('sharing', { attrs: ['pending', 'sharing'] }),
    tab('panel'),
  ];
  const picked = sandbox.pinnedTabsToUnload(tabs, (t) => t.name === 'panel');
  assert.deepEqual(
    picked.map((t) => t.name),
    ['pending-pinned'],
  );
});

test('the handler listens for SSWindowRestored and discards the picked tabs without force', () => {
  const { sandbox, discarded, discardArgCounts, listeners } = setup({
    tabs: [tab('a'), tab('b', { attrs: [] }), tab('c')],
  });
  sandbox.attachRestoredPinnedTabUnload();
  assert.deepEqual([...listeners.keys()], ['SSWindowRestored']);
  listeners.get('SSWindowRestored')();
  assert.deepEqual(discarded, ['a', 'c']);
  assert.deepEqual(discardArgCounts, [1, 1]);
});

test('a pinned panel tab the window renders stays loaded', () => {
  const { sandbox, discarded, listeners } = setup({
    tabs: [tab('panel', { webExtId: 7 }), tab('other', { webExtId: 8 })],
    panelTabIds: [7],
  });
  sandbox.attachRestoredPinnedTabUnload();
  listeners.get('SSWindowRestored')();
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
    const { sandbox, discarded, listeners } = setup({ tabs: [tab('a')], prefs });
    sandbox.attachRestoredPinnedTabUnload();
    listeners.get('SSWindowRestored')();
    assert.deepEqual(discarded, expected, JSON.stringify(prefs));
  }
});

test('a failing discard is logged and never thrown', () => {
  const { sandbox, warnings, listeners } = setup({
    tabs: [tab('a')],
    discardBrowser: () => {
      throw new Error('gone');
    },
  });
  sandbox.attachRestoredPinnedTabUnload();
  assert.doesNotThrow(() => listeners.get('SSWindowRestored')());
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /^\[bento-shell-mount\]/);
});
