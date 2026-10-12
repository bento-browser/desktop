// When a tab of another workspace is selected, the mount holds a curtain over the page until
// tools answers with the workspace switch. A slow switch can outlast the watchdog that lifts the
// curtain; at that point the panel payload the mount still holds belongs to the workspace being
// left. These tests run the real watchdog from bento-shell-mount.js and check it never draws that
// payload around the newly selected tab.
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

const WATCHDOG_MS = Number(/^ {2}const WORKSPACE_FADE_WATCHDOG_MS = (\d+);$/m.exec(source)?.[1]);
assert.ok(WATCHDOG_MS > 0, 'WORKSPACE_FADE_WATCHDOG_MS is missing from the mount script');

function run({ selectedAtFire }) {
  const timers = new Map();
  let nextTimer = 1;
  const calls = [];
  const deferredTab = { id: 'destination-first-tab' };
  const sandbox = {
    console: { warn() {} },
    window: { gBrowser: { selectedTab: deferredTab } },
    // The workspace being left still has two panels in the payload the mount holds.
    __lastPanelsPayload: [{ tabId: 11 }, { tabId: 12 }],
    WORKSPACE_FADE_WATCHDOG_MS: WATCHDOG_MS,
    clearWorkspaceFadeClasses: () => calls.push(['clear-curtain']),
    reconcilePanelsSplitView: (panels) => calls.push(['reconcile', panels.map((p) => p.tabId)]),
    setTimeout: (fn, ms) => {
      timers.set(nextTimer, { fn, ms });
      return nextTimer++;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `let __workspaceFadeWatchdog = null;\n${mountFunction('armDeferredWorkspaceSwitchWatchdog')}`,
    sandbox,
  );
  vm.runInContext('armDeferredWorkspaceSwitchWatchdog', sandbox)(deferredTab);
  assert.equal(timers.size, 1);
  const [{ fn, ms }] = timers.values();
  assert.equal(ms, WATCHDOG_MS);
  sandbox.window.gBrowser.selectedTab = selectedAtFire ?? deferredTab;
  fn();
  // Arrays built inside the vm realm have other prototypes; compare plain data.
  return JSON.parse(JSON.stringify(calls));
}

test('the watchdog lifts the curtain and renders the selected tab without the old panels', () => {
  assert.deepEqual(run({}), [['clear-curtain'], ['reconcile', []]]);
});

test('the watchdog does not render anything when the selection moved on', () => {
  assert.deepEqual(run({ selectedAtFire: { id: 'another-tab' } }), [['clear-curtain']]);
});

test('arming again replaces the earlier watchdog', () => {
  const timers = new Map();
  let nextTimer = 1;
  const sandbox = {
    console: { warn() {} },
    window: { gBrowser: {} },
    __lastPanelsPayload: [],
    WORKSPACE_FADE_WATCHDOG_MS: WATCHDOG_MS,
    clearWorkspaceFadeClasses() {},
    reconcilePanelsSplitView() {},
    setTimeout: (fn) => {
      timers.set(nextTimer, fn);
      return nextTimer++;
    },
    clearTimeout: (id) => timers.delete(id),
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `let __workspaceFadeWatchdog = null;\n${mountFunction('armDeferredWorkspaceSwitchWatchdog')}`,
    sandbox,
  );
  const arm = vm.runInContext('armDeferredWorkspaceSwitchWatchdog', sandbox);
  arm({});
  arm({});
  assert.equal(timers.size, 1);
});
