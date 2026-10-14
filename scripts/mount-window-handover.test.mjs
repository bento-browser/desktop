// A window that closes while another Bento window stays open adopts its live tabs into that
// window first (handOverTabsBeforeClose in bento-shell-mount.js). These tests run the real
// handler against stubbed chrome windows and SessionStore.
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

/** The constants the handover block declares, up to the first function. */
function handoverConstants() {
  const start = source.indexOf(
    "\n  const TOOLS_SESSION_PREFIX = 'extension:bento-tools@bento.app:';",
  );
  assert.notEqual(start, -1, 'the handover constants are missing');
  return source.slice(start, source.indexOf('\n  function findHandoverSurvivor(', start));
}

const HANDOVER_KEY = 'extension:bento-tools@bento.app:bento.handover';
const CLOSING_KEY = 'extension:bento-tools@bento.app:bento.closingTab';
const WORKSPACE_WINDOW_KEY = 'extension:bento-tools@bento.app:bento.activeWorkspaceId';

/**
 * A closing chrome window (id 2) with `tabs`, and `others`: the windows a survivor is chosen
 * from. `adoptTab` records the call and returns a new tab, null (refused), or throws.
 */
function setup({
  tabs = [{ id: 11 }],
  selected = undefined,
  others = [{ id: 1 }],
  startup = {},
  windowOptions = {},
  adopt = () => ({}),
  extData = {},
} = {}) {
  const calls = [];
  const timers = [];
  const tabValues = new Map();
  const windowValues = new Map();

  const tabObjects = tabs.map((spec) => ({
    closing: false,
    isEmpty: false,
    pinned: false,
    attrs: new Set(spec.pending ? ['pending'] : []),
    hasAttribute(name) {
      return this.attrs.has(name);
    },
    ...spec,
  }));
  const win = {
    id: 2,
    closed: false,
    toolbar: { visible: true },
    gBrowser: { tabs: tabObjects, selectedTab: selected ?? tabObjects.at(-1) },
    setTimeout: (fn) => timers.push(fn),
    ...windowOptions,
  };

  const survivors = others.map((spec, index) => {
    const survivor = {
      id: 1,
      closed: false,
      __bentoShellMountInitialized: true,
      toolbar: { visible: true },
      gBrowser: {
        tabs: [{}, {}, {}],
        pinnedTabCount: 1,
        adoptTab(tab, options) {
          calls.push(['adopt', tab.id, options.tabIndex, options.selectTab]);
          return adopt(tab, options);
        },
      },
      ...spec,
    };
    if (spec.hello !== false) windowValues.set(survivor, '"ws-a"');
    // The survivor can be listed in any order after the closing window.
    survivor.listIndex = index;
    return survivor;
  });

  const tabKey = (tab, key) => `${tab.id}:${key}`;
  const sessionStore = {
    getCustomWindowValue: (target, key) => {
      // SessionStore throws for a window it does not track yet.
      if (target.untracked) throw new Error('Window is not tracked');
      return key === WORKSPACE_WINDOW_KEY ? (windowValues.get(target) ?? '') : '';
    },
    getCustomTabValue: (tab, key) => tabValues.get(tabKey(tab, key)) ?? '',
    setCustomTabValue(tab, key, value) {
      tabValues.set(tabKey(tab, key), value);
      calls.push(['set', tab.id ?? 'new', key, value]);
    },
    getTabState: (tab) => {
      calls.push(['state', tab.id]);
      return JSON.stringify({ entries: [], extData });
    },
  };

  const sandbox = {
    window: win,
    console: { warn: (...args) => calls.push(['warn', String(args[1] ?? args[0])]) },
    Services: {
      startup: { attemptingQuit: false, ...startup },
      wm: { getEnumerator: () => [win, ...survivors] },
    },
    BentoPrivateBrowsingUtils: { isWindowPrivate: (candidate) => candidate.private === true },
    getSessionStore: () => sessionStore,
    getChromeWindowId: (candidate = win) => candidate.id ?? null,
    reconcilePanelsSplitView: (panels) => calls.push(['teardown', panels.length]),
    Date: { now: () => 1234 },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      handoverConstants(),
      'let handingOverTabs = false;',
      mountFunction('findHandoverSurvivor'),
      mountFunction('notePageClose'),
      mountFunction('handOverTabsBeforeClose'),
    ].join('\n'),
    sandbox,
  );
  const handler = vm.runInContext('handOverTabsBeforeClose', sandbox);
  const notePageClose = vm.runInContext('notePageClose', sandbox);
  const closeEvent = (overrides = {}) => ({ target: win, defaultPrevented: false, ...overrides });
  return {
    win,
    tabs: tabObjects,
    survivors,
    calls,
    timers,
    sandbox,
    sessionStore,
    tabValues,
    close: (overrides) => handler(closeEvent(overrides)),
    // What the window's DOMWindowClose capture listeners do for an event, in registration order.
    dispatch: (event) => {
      notePageClose(event);
      handler(event);
    },
    handler,
    handingOver: () => vm.runInContext('handingOverTabs', sandbox),
  };
}

const adopted = (calls) => calls.filter(([kind]) => kind === 'adopt');

test('a close hands the live tabs to a surviving window, pinned first and the selected tab last', () => {
  const w = setup({
    tabs: [
      { id: 11 },
      { id: 12, pinned: true },
      { id: 13 },
      { id: 14, pinned: true },
      { id: 15, isEmpty: true },
    ],
    selected: undefined,
  });
  w.win.gBrowser.selectedTab = w.tabs[0];

  w.close();

  assert.deepEqual(adopted(w.calls), [
    // Pinned tabs go to the end of the pinned region (pinnedTabCount 1), the rest to the end.
    ['adopt', 12, 1, false],
    ['adopt', 14, 1, false],
    ['adopt', 13, 3, false],
    ['adopt', 11, 3, false],
  ]);
});

test('tears the split view down before the first tab is adopted, and the reconciler stays down', () => {
  const w = setup({ tabs: [{ id: 11 }, { id: 12 }] });

  w.close();

  const teardown = w.calls.findIndex(([kind]) => kind === 'teardown');
  const firstAdopt = w.calls.findIndex(([kind]) => kind === 'adopt');
  assert.ok(teardown !== -1 && teardown < firstAdopt);
  assert.equal(w.handingOver(), true);
  // reconcilePanelsSplitView checks the flag first; without it a TabSelect or panels/sync
  // during the move would mark the leaving tabs again.
  const reconcile = mountFunction('reconcilePanelsSplitView');
  assert.match(reconcile, /\{\n {4}if \(handingOverTabs\) return;\n/);
});

test('marks every adopted tab with the windows it moved between, written after adoptTab', () => {
  const w = setup({ tabs: [{ id: 11 }, { id: 12 }] });

  w.close();

  const marks = w.calls.filter(([kind, , key]) => kind === 'set' && key === HANDOVER_KEY);
  assert.equal(marks.length, 2);
  for (const [, , , value] of marks) {
    assert.deepEqual(JSON.parse(value), { from: 2, to: 1, at: 1234 });
  }
  // Writing before adoptTab is unsafe: a pending tab loses its values in the swap.
  assert.ok(
    w.calls.findIndex(([kind]) => kind === 'adopt') < w.calls.findIndex(([kind]) => kind === 'set'),
  );
});

test('leaves out empty, closing and tools-closing tabs', () => {
  const w = setup({
    tabs: [
      { id: 11 },
      { id: 12, isEmpty: true },
      { id: 13, closing: true },
      { id: 14 },
      { id: 15 },
    ],
  });
  // Tools marked tab 14 closing (a workspace delete) before it closed the window.
  w.tabValues.set(`14:${CLOSING_KEY}`, '"1"');
  w.win.gBrowser.selectedTab = w.tabs[0];

  w.close();

  assert.deepEqual(
    adopted(w.calls).map(([, id]) => id),
    [15, 11],
  );
});

test('a window with only tabs that are not worth keeping closes as it is', () => {
  const w = setup({
    tabs: [
      { id: 11, isEmpty: true },
      { id: 12, closing: true },
    ],
  });

  w.close();

  assert.deepEqual(w.calls, []);
  assert.equal(w.handingOver(), false);
});

test('only a regular, mounted, open window that has a workspace is a survivor', () => {
  const w = setup({
    others: [
      { id: 3, toolbar: { visible: false } },
      { id: 4, private: true },
      { id: 5, __bentoShellMountInitialized: false },
      { id: 6, closed: true },
      { id: 7, hello: false },
      { id: 9, untracked: true },
      { id: 8, hello: true },
    ],
  });

  w.close();

  assert.deepEqual(
    adopted(w.calls).map(([, id]) => id),
    [11],
  );
  const marks = w.calls.filter(([kind, , key]) => kind === 'set' && key === HANDOVER_KEY);
  assert.equal(JSON.parse(marks[0][3]).to, 8);
});

test('with no survivor the close goes through untouched', () => {
  const w = setup({
    others: [
      { id: 3, toolbar: { visible: false } },
      { id: 4, private: true },
    ],
  });

  w.close();

  assert.deepEqual(w.calls, []);
  assert.equal(w.handingOver(), false);
});

test('a private window and a popup never hand tabs over', () => {
  for (const windowOptions of [{ private: true }, { toolbar: { visible: false } }]) {
    const w = setup({ windowOptions });

    w.close();

    assert.deepEqual(w.calls, []);
  }
});

test('nothing happens once a quit was granted: the windows are collected as they are', () => {
  const w = setup({ startup: { attemptingQuit: true } });

  w.close();

  assert.deepEqual(w.calls, []);
  assert.equal(w.handingOver(), false);
});

test('a close that Firefox already cancelled (a beforeunload prompt answered Stay) is left alone', () => {
  const w = setup();

  w.close({ defaultPrevented: true });

  assert.deepEqual(w.calls, []);
});

test('a tab closing itself does not hand itself over, even when it is the only tab', () => {
  // BrowserElementParent bubbles DOMWindowClose from the browser element; the tabbrowser then
  // calls window.close() from inside that event, which reaches this window as its own close.
  const w = setup({ tabs: [{ id: 11 }] });

  const fromTab = { target: { browserElement: true }, defaultPrevented: false };
  w.dispatch(fromTab);
  // The tabbrowser's listener runs next and closes the window from inside the event.
  w.dispatch({ target: w.win, defaultPrevented: false });

  assert.deepEqual(w.calls, []);
  assert.equal(w.timers.length, 1);

  // The flag lasts for that event only: a close of the window itself afterwards is handled.
  w.timers[0]();
  w.dispatch({ target: w.win, defaultPrevented: false });

  assert.equal(adopted(w.calls).length, 1);
});

test('a close event from something inside the window is not a close of the window', () => {
  const w = setup();

  w.close({ target: { dialog: true } });

  assert.deepEqual(w.calls, []);
  assert.equal(w.timers.length, 0);
});

test('adopting the last tab closes the window by itself, which must not hand over twice', () => {
  let reentered = false;
  const w = setup({
    tabs: [{ id: 11 }, { id: 12 }],
    adopt: () => {
      // swapBrowsersAndCloseOther: window.close() -> DOMWindowClose on this window again.
      if (!reentered) {
        reentered = true;
        w.close();
      }
      return {};
    },
  });

  w.close();

  assert.equal(adopted(w.calls).length, 2);
  assert.equal(w.calls.filter(([kind]) => kind === 'teardown').length, 1);
});

test('a tab Firefox refuses or fails to adopt is skipped and the rest still move', () => {
  let attempt = 0;
  const w = setup({
    tabs: [{ id: 11 }, { id: 12 }, { id: 13 }],
    adopt: () => {
      attempt += 1;
      if (attempt === 1) return null;
      if (attempt === 2) throw new Error('swapDocShells failed');
      return {};
    },
  });

  w.close();

  assert.equal(adopted(w.calls).length, 3);
  // Only the third was adopted, so only it is marked.
  assert.equal(w.calls.filter(([kind, , key]) => kind === 'set' && key === HANDOVER_KEY).length, 1);
  assert.ok(w.calls.some(([kind]) => kind === 'warn'));
});

test('a pending tab gets its custom values back, a live one is not asked for its state', () => {
  const values = { 'extension:bento-tools@bento.app:bento.workspaceId': '"ws-b"' };
  const w = setup({
    tabs: [{ id: 11, pending: true }, { id: 12 }],
    extData: values,
  });
  w.win.gBrowser.selectedTab = w.tabs[1];

  w.close();

  assert.deepEqual(
    w.calls.filter(([kind]) => kind === 'state'),
    [['state', 11]],
  );
  const restored = w.calls.filter(([kind, , key]) => kind === 'set' && key in values);
  assert.deepEqual(restored, [
    ['set', 'new', 'extension:bento-tools@bento.app:bento.workspaceId', '"ws-b"'],
  ]);
  // The state was read before the swap, which empties it.
  assert.ok(
    w.calls.findIndex(([kind]) => kind === 'state') <
      w.calls.findIndex(([kind]) => kind === 'adopt'),
  );
});
