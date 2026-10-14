// A window that closes while another Bento window stays open adopts its live tabs into that
// window first (handOverTabsBeforeClose in bento-shell-mount.js). These tests run the real
// handler against stubbed chrome windows whose tabbrowser follows Firefox's adoptTab,
// swapBrowsersAndCloseOther and tab removal closely enough to show what the handover does to
// the tabs and to the closing window. Failures are injected inside the swap, as Firefox would.
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
  return source.slice(start, source.indexOf('\n  function ', start));
}

const HANDOVER_KEY = 'extension:bento-tools@bento.app:bento.handover';
const CLOSING_KEY = 'extension:bento-tools@bento.app:bento.closingTab';
const WORKSPACE_KEY = 'extension:bento-tools@bento.app:bento.workspaceId';
const WORKSPACE_WINDOW_KEY = 'extension:bento-tools@bento.app:bento.activeWorkspaceId';

class FakeTab {
  constructor(win, spec) {
    this.win = win;
    this.label = spec.label;
    this.closing = spec.closing ?? false;
    this.pinned = spec.pinned ?? false;
    this.pending = spec.pending ?? false;
    this.inUnload = spec.inUnload ?? false;
    this.values = { ...spec.values };
    // The docShell: what a swap moves from one tab to the other.
    this.page = spec.isEmpty
      ? { url: 'about:blank', blank: true }
      : { url: spec.url ?? `https://${spec.label}.example.test/`, blank: false, label: spec.label };
    // A pending (lazy) browser is not connected.
    this.linkedBrowser = {
      isConnected: !this.pending,
      getInPermitUnload: (callback) => callback(this.inUnload),
    };
  }
  get isEmpty() {
    return this.page.blank;
  }
  hasAttribute(name) {
    return name === 'pending' && this.pending;
  }
}

/** The tabbrowser calls the handover makes, in the order Firefox 158 runs them. */
class FakeTabbrowser {
  constructor(win, world, specs) {
    this.win = win;
    this.world = world;
    this.tabs = specs.map((spec) => new FakeTab(win, spec));
    this.selectedTab = this.tabs.at(-1);
    this.opened = 0;
  }
  get pinnedTabCount() {
    return this.tabs.filter((tab) => tab.pinned).length;
  }
  get browsers() {
    return this.tabs.map((tab) => tab.linkedBrowser);
  }
  getTabForBrowser(browser) {
    return this.tabs.find((tab) => tab.linkedBrowser === browser) ?? null;
  }
  #insert(tab, index) {
    // Pinned tabs live in the first region, the rest after it.
    const pinned = this.pinnedTabCount;
    const at = tab.pinned ? Math.min(index, pinned) : Math.max(index, pinned);
    this.tabs.splice(at, 0, tab);
  }
  addTrustedTab(url, { inBackground = true, pinned = false, tabIndex = this.tabs.length } = {}) {
    if (this.world.hooks.addTabThrows) throw new Error('no tab');
    const tab = new FakeTab(this.win, { label: `new${(this.opened += 1)}`, isEmpty: true, pinned });
    this.#insert(tab, tabIndex);
    this.world.calls.push(['addTab', tab.label, url, inBackground]);
    if (!inBackground) this.select(tab);
    return tab;
  }
  select(tab) {
    this.selectedTab = tab;
    this.world.calls.push(['select', tab.label]);
  }
  removeTab(tab) {
    this.world.calls.push(['removeTab', tab.label]);
    tab.closing = true;
    this.tabs.splice(this.tabs.indexOf(tab), 1);
  }
  /** Firefox's adoptTab: an empty twin first (TabOpen moves the id and the tab values), then the swap. */
  adoptTab(source, { tabIndex, selectTab = false }) {
    const { calls, sessionStore } = this.world;
    calls.push(['adopt', source.label, tabIndex]);
    const index = tabIndex;
    const twin = new FakeTab(this.win, {
      label: `${source.label}'`,
      isEmpty: true,
      pinned: index < this.pinnedTabCount || (source.pinned && index === this.pinnedTabCount),
      pending: source.pending,
    });
    this.#insert(twin, index);
    sessionStore.moveValues(source, twin);
    if (!this.swapBrowsersAndCloseOther(twin, source)) {
      this.removeTab(twin);
      return null;
    }
    if (selectTab) this.select(twin);
    return twin;
  }
  swapBrowsersAndCloseOther(ourTab, otherTab) {
    const { hooks, sessionStore } = this.world;
    if (hooks.refuse?.(otherTab)) return false;
    const other = otherTab.win.gBrowser;
    if (!other.beginRemoveTab(otherTab, { adoptedByTab: ourTab, closeWindowWithLastTab: true })) {
      return false;
    }
    const [closeWindow] = otherTab.endRemoveArgs;
    if (otherTab.pending) {
      // SessionStore.setTabState(ourTab, getTabState(otherTab)): the values do not come along.
      sessionStore.dropValues(ourTab);
      ourTab.pending = true;
      ourTab.linkedBrowser.isConnected = false;
    } else {
      hooks.swapDocShells?.(otherTab, ourTab);
      [ourTab.page, otherTab.page] = [otherTab.page, ourTab.page];
    }
    if (closeWindow) otherTab.win.close();
    else other.tabs.splice(other.tabs.indexOf(otherTab), 1);
    return true;
  }
  /** The first half of Tabbrowser's #beginRemoveTab, for a tab that an adoption takes away. */
  beginRemoveTab(tab, { adoptedByTab, closeWindowWithLastTab }) {
    if (tab.closing) return false;
    const isLast = !this.tabs.some((other) => other !== tab && !other.closing);
    const closeWindow = isLast ? (closeWindowWithLastTab ?? !this.win.toolbar.visible) : false;
    tab.endRemoveArgs = [closeWindow, isLast];
    // The last tab of a window returns here, before the tab is blurred and before TabClose.
    if (closeWindow && adoptedByTab) return true;
    if (tab === this.selectedTab) {
      this.select(this.tabs.find((other) => other !== tab && !other.closing));
    }
    tab.closing = true;
    this.world.calls.push(['TabClose', tab.label, adoptedByTab?.label]);
    return true;
  }
}

/** SessionStore as the handover sees it: custom values per tab, moved to an adopting twin. */
function makeSessionStore(world) {
  return {
    getCustomWindowValue: (target, key) => {
      // SessionStore throws for a window it does not track yet.
      if (target.untracked) throw new Error('Window is not tracked');
      return key === WORKSPACE_WINDOW_KEY && !target.noWorkspace ? '"ws-a"' : '';
    },
    getCustomTabValue: (tab, key) => tab.values[key] ?? '',
    setCustomTabValue(tab, key, value) {
      tab.values[key] = value;
      world.calls.push(['set', tab.label, key, value]);
    },
    moveValues(from, to) {
      to.values = { ...from.values };
      from.values = {};
    },
    dropValues(tab) {
      tab.values = {};
    },
    getTabState(tab) {
      world.calls.push(['state', tab.label]);
      return JSON.stringify({ entries: [{ url: tab.page.url }], extData: tab.values });
    },
    setTabState(tab, state) {
      const parsed = JSON.parse(state);
      world.calls.push(['setState', tab.label]);
      tab.values = { ...parsed.extData };
      tab.page = { url: parsed.entries.at(-1).url, blank: false, label: `${tab.label}:restored` };
    },
  };
}

/**
 * A closing chrome window (id 2) with `tabs`, and `others`: the windows a survivor is chosen
 * from, each with its own tabs. `hooks` injects failures into the swap.
 */
function setup({
  tabs = [{ label: 'a' }],
  selected,
  others = [{}],
  startup = {},
  windowOptions = {},
  hooks = {},
  closeId = 2,
} = {}) {
  const world = { calls: [], hooks };
  world.sessionStore = makeSessionStore(world);
  const timers = [];

  const makeWindow = (id, specs, extra) => {
    const win = {
      id,
      closed: false,
      closeCalls: 0,
      toolbar: { visible: true },
      gDialogBox: { isOpen: false },
      setTimeout: (fn) => timers.push(fn),
      close() {
        this.closeCalls += 1;
        world.calls.push(['windowClose', id]);
        // window.close() reaches the window's own DOMWindowClose listeners.
        this.onClose?.();
      },
      ...extra,
    };
    win.gBrowser = new FakeTabbrowser(win, world, specs);
    return win;
  };

  const win = makeWindow(closeId, tabs, windowOptions);
  if (selected) win.gBrowser.selectedTab = win.gBrowser.tabs.find((tab) => tab.label === selected);
  const survivors = others.map((spec, index) => {
    const { tabs: survivorTabs, ...rest } = spec;
    return makeWindow(
      spec.id ?? 1 + index,
      survivorTabs ?? [{ label: 's0', pinned: true }, { label: 's1' }, { label: 's2' }],
      { __bentoShellMountInitialized: true, ...rest },
    );
  });

  const sandbox = {
    window: win,
    console: { warn: (...args) => world.calls.push(['warn', String(args[0])]) },
    Services: {
      startup: { attemptingQuit: false, ...startup },
      wm: { getEnumerator: () => [win, ...survivors] },
    },
    BentoPrivateBrowsingUtils: { isWindowPrivate: (candidate) => candidate.private === true },
    getSessionStore: () => world.sessionStore,
    getChromeWindowId: (candidate = win) => candidate.id ?? null,
    reconcilePanelsSplitView: (panels) => world.calls.push(['teardown', panels.length]),
    Date: { now: () => 1234 },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    [
      handoverConstants(),
      'let handingOverTabs = false;',
      mountFunction('isCheckingUnload'),
      mountFunction('findHandoverSurvivor'),
      mountFunction('notePageClose'),
      mountFunction('parseHandoverHops'),
      mountFunction('adoptTabInto'),
      mountFunction('recreateTabIn'),
      mountFunction('handOverTabsBeforeClose'),
    ].join('\n'),
    sandbox,
  );
  const handler = vm.runInContext('handOverTabsBeforeClose', sandbox);
  const notePageClose = vm.runInContext('notePageClose', sandbox);
  const closeEvent = (overrides = {}) => ({ target: win, defaultPrevented: false, ...overrides });
  // adopting a window's last tab, or a tab's script, closes the window: its listeners run again.
  win.onClose = () => handler(closeEvent());
  const tabByLabel = (label) => win.gBrowser.tabs.find((tab) => tab.label === label);
  return {
    win,
    survivors,
    calls: world.calls,
    timers,
    sandbox,
    tabByLabel,
    close: (overrides) => handler(closeEvent(overrides)),
    // What the window's DOMWindowClose capture listeners do for an event, in registration order.
    dispatch: (event) => {
      notePageClose(event);
      handler(event);
    },
    handler,
    handingOver: () => vm.runInContext('handingOverTabs', sandbox),
    /** Labels of a window's tabs that are still open, in strip order. */
    order: (target) => target.gBrowser.tabs.filter((tab) => !tab.closing).map((tab) => tab.label),
    /** The same with an adopted tab named for the tab it was (the twin's label has a prime). */
    names: (target) =>
      target.gBrowser.tabs.filter((tab) => !tab.closing).map((tab) => tab.label.replace("'", '')),
    of: (kind) => world.calls.filter(([name]) => name === kind),
  };
}

const marks = (calls) => calls.filter(([kind, , key]) => kind === 'set' && key === HANDOVER_KEY);

test('keeps the order of the tabs, whichever one is selected, as the destination grows', () => {
  const labels = ['p1', 'p2', 'a', 'b', 'c'];
  for (const selected of labels) {
    const w = setup({
      tabs: [
        { label: 'p1', pinned: true },
        { label: 'p2', pinned: true },
        { label: 'a' },
        { label: 'b' },
        { label: 'c' },
      ],
      selected,
    });

    w.close();

    // Pinned tabs join the destination's pinned region (s0), the rest follow its tabs.
    assert.deepEqual(
      w.names(w.survivors[0]),
      ['s0', 'p1', 'p2', 's1', 's2', 'a', 'b', 'c'],
      `selected ${selected}`,
    );
  }
});

test('no adoption is the closing window last tab: it is not closed from inside adoptTab', () => {
  const w = setup({ tabs: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], selected: 'c' });

  w.close();

  assert.equal(w.win.closeCalls, 0);
  // Every adopted tab left through the ordinary TabClose, which carries a DevTools toolbox.
  assert.deepEqual(
    w.of('TabClose').map(([, label, adoptedBy]) => [label, adoptedBy]),
    [
      ['a', "a'"],
      ['b', "b'"],
      ['c', "c'"],
    ],
  );
  // A blank selected tab is all that is left, to close with the window; nothing is re-selected.
  assert.deepEqual(w.of('addTab'), [['addTab', 'new1', 'about:blank', false]]);
  assert.deepEqual(w.of('select'), [['select', 'new1']]);
  assert.deepEqual(w.order(w.win), ['new1']);
  assert.equal(w.win.gBrowser.selectedTab.label, 'new1');
});

test('tears the split view down before the first tab is adopted, and the reconciler stays down', () => {
  const w = setup({ tabs: [{ label: 'a' }, { label: 'b' }] });

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
  const w = setup({ tabs: [{ label: 'a' }, { label: 'b' }] });

  w.close();

  assert.equal(marks(w.calls).length, 2);
  for (const [, , , value] of marks(w.calls)) {
    assert.deepEqual(JSON.parse(value), [{ from: 2, to: 1, at: 1234 }]);
  }
  // Writing before adoptTab is unsafe: SessionStore moves the values to the twin during it.
  const first = w.calls.findIndex(([kind, label]) => kind === 'adopt' && label === 'a');
  assert.ok(first < w.calls.findIndex(([kind]) => kind === 'set'));
});

test('a tab handed on again keeps the hop it arrived by, so tools sees both moves', () => {
  // Window 2 closed into window 1 moments ago; now window 1 closes into window 3.
  const earlier = JSON.stringify([{ from: 2, to: 1, at: 1000 }]);
  const w = setup({
    closeId: 1,
    tabs: [{ label: 'a', values: { [HANDOVER_KEY]: earlier } }, { label: 'b' }],
    others: [{ id: 3 }],
  });

  w.close();

  const [first, second] = marks(w.calls).map(([, label, , value]) => [label, JSON.parse(value)]);
  assert.deepEqual(first, [
    "a'",
    [
      { from: 2, to: 1, at: 1000 },
      { from: 1, to: 3, at: 1234 },
    ],
  ]);
  assert.deepEqual(second, ["b'", [{ from: 1, to: 3, at: 1234 }]]);
});

test('leaves out empty, closing and tools-closing tabs', () => {
  const w = setup({
    tabs: [
      { label: 'a' },
      { label: 'e', isEmpty: true },
      { label: 'x', closing: true },
      { label: 'd', values: { [CLOSING_KEY]: '"1"' } },
      { label: 'c' },
    ],
    selected: 'a',
  });

  w.close();

  assert.deepEqual(
    w.of('adopt').map(([, label]) => label),
    ['a', 'c'],
  );
});

test('a window with only tabs that are not worth keeping closes as it is', () => {
  const w = setup({
    tabs: [
      { label: 'e', isEmpty: true },
      { label: 'x', closing: true },
    ],
  });

  w.close();

  assert.deepEqual(w.calls, []);
  assert.equal(w.handingOver(), false);
});

test('only a regular, mounted, open, undisturbed window that has a workspace is a survivor', () => {
  const w = setup({
    others: [
      { id: 3, toolbar: { visible: false } },
      { id: 4, private: true },
      { id: 5, __bentoShellMountInitialized: false },
      { id: 6, closed: true },
      { id: 7, noWorkspace: true },
      { id: 9, untracked: true },
      // Its own closing-tabs warning is up, or a tab of it is answering a beforeunload prompt.
      { id: 10, gDialogBox: { isOpen: true } },
      { id: 11, tabs: [{ label: 's0', inUnload: true }] },
      { id: 8 },
    ],
  });

  w.close();

  assert.deepEqual(JSON.parse(marks(w.calls)[0][3]), [{ from: 2, to: 8, at: 1234 }]);
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

test('a close event from something inside the window is not a close of the window', () => {
  const w = setup();

  w.close({ target: { dialog: true } });

  assert.deepEqual(w.calls, []);
});

test('a second close request does not hand the tabs over twice', () => {
  // The refused tab is still in the window afterwards, as the second request would find it.
  const w = setup({
    tabs: [{ label: 'a' }, { label: 'b' }],
    hooks: { refuse: (tab) => tab.label === 'a' },
  });

  w.close();
  const calls = w.calls.length;
  w.close();

  assert.equal(w.calls.length, calls);
});

test('a tab closing itself does not hand itself over, even when it is the only tab', () => {
  // BrowserElementParent bubbles DOMWindowClose from the browser element; the tabbrowser then
  // calls window.close() from inside that event, which reaches this window as its own close.
  const w = setup({ tabs: [{ label: 'a' }] });

  w.dispatch({ target: w.tabByLabel('a').linkedBrowser, defaultPrevented: false });
  // The tabbrowser's listener runs next and closes the window from inside the event.
  w.dispatch({ target: w.win, defaultPrevented: false });

  assert.deepEqual(w.calls, []);
  assert.equal(w.timers.length, 1);
});

test('a page closing one tab does not stop the window handing its other tabs over', () => {
  const w = setup({ tabs: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] });

  // Tab b's page called window.close(); chrome then closes the window in the same task.
  w.dispatch({ target: w.tabByLabel('b').linkedBrowser, defaultPrevented: false });
  w.dispatch({ target: w.win, defaultPrevented: false });

  assert.deepEqual(
    w.of('adopt').map(([, label]) => label),
    ['a', 'c'],
  );

  // The record of the page's tab does not outlive the event.
  w.timers[0]();
  const later = setup({ tabs: [{ label: 'a' }] });
  later.dispatch({ target: later.tabByLabel('a').linkedBrowser, defaultPrevented: false });
  later.timers[0]();
  later.dispatch({ target: later.win, defaultPrevented: false });
  assert.equal(later.of('adopt').length, 1);
});

test('a DOMWindowClose from a browser that is not a tab excludes nothing', () => {
  const w = setup({ tabs: [{ label: 'a' }, { label: 'b' }] });

  w.dispatch({ target: { sidebarBrowser: true }, defaultPrevented: false });
  w.dispatch({ target: w.win, defaultPrevented: false });

  assert.equal(w.of('adopt').length, 2);
});

test('a close repeated while a beforeunload prompt is up hands nothing over', () => {
  // permitUnload throws for a tab that is already being asked, so that close goes on regardless.
  const w = setup({ tabs: [{ label: 'a', inUnload: true }, { label: 'b' }] });

  w.close();

  assert.deepEqual(w.calls, []);
  assert.equal(w.handingOver(), false);
});

test('a lazy tab is not asked about unloading', () => {
  const w = setup({ tabs: [{ label: 'a', pending: true, inUnload: true }, { label: 'b' }] });

  w.close();

  assert.equal(w.of('adopt').length, 2);
});

test('a refused adoption recreates the tab in the survivor from its state', () => {
  // Firefox removes the empty twin, and with it the id tools knew the tab by.
  const w = setup({
    tabs: [{ label: 'a', values: { [WORKSPACE_KEY]: '"ws-b"' } }, { label: 'b' }],
    hooks: { refuse: (tab) => tab.label === 'a' },
  });

  w.close();

  assert.deepEqual(w.order(w.survivors[0]), ['s0', 's1', 's2', 'new1', "b'"]);
  const recreated = w.survivors[0].gBrowser.tabs.find((tab) => tab.label === 'new1');
  assert.equal(recreated.page.url, 'https://a.example.test/');
  assert.equal(recreated.values[WORKSPACE_KEY], '"ws-b"');
  // The recreated tab is a new tab, not a handover: it carries no marker.
  assert.deepEqual(
    marks(w.calls).map(([, label]) => label),
    ["b'"],
  );
});

test('a failure inside the docShell swap leaves no blank twin and keeps the page', () => {
  const w = setup({
    tabs: [{ label: 'a', pinned: true }, { label: 'b' }, { label: 'c' }],
    hooks: {
      swapDocShells: (source) => {
        if (source.label === 'b') throw new Error('swapDocShells failed');
      },
    },
  });

  w.close();

  // The empty twin b' is gone; b came back as a new tab with its own state, after a and c.
  const survivor = w.order(w.survivors[0]);
  assert.ok(!survivor.includes("b'"));
  assert.deepEqual(survivor, ['s0', "a'", 's1', 's2', 'new1', "c'"]);
  assert.ok(w.of('removeTab').some(([, label]) => label === "b'"));
  assert.ok(w.of('warn').length > 0);
  // The other tabs are marked, the recreated one is not.
  assert.deepEqual(
    marks(w.calls).map(([, label]) => label),
    ["a'", "c'"],
  );
});

test('a failed tab that is also the only one in the closing window is still recreated', () => {
  const w = setup({
    tabs: [{ label: 'a' }],
    hooks: {
      swapDocShells: () => {
        throw new Error('swapDocShells failed');
      },
    },
  });

  w.close();

  assert.equal(w.of('setState').length, 1);
  assert.ok(w.order(w.survivors[0]).includes('new1'));
});

test('the tab is not lost when even recreating it fails', () => {
  const w = setup({
    tabs: [{ label: 'a' }, { label: 'b' }],
    hooks: { refuse: (tab) => tab.label === 'a' },
  });
  w.survivors[0].gBrowser.addTrustedTab = () => {
    throw new Error('no room');
  };

  w.close();

  // b still moves; the failure is reported, not thrown into the close.
  assert.deepEqual(
    w.of('adopt').map(([, label]) => label),
    ['a', 'b'],
  );
  assert.ok(w.of('warn').length > 0);
});

test('with no way to hold the window open nothing is handed over', () => {
  const w = setup({ tabs: [{ label: 'a' }, { label: 'b' }], hooks: { addTabThrows: true } });

  w.close();

  assert.equal(w.of('adopt').length, 0);
  assert.ok(w.of('warn').length > 0);
});

test('a pending tab gets its custom values back, a live one keeps the ones SessionStore moves', () => {
  const values = { [WORKSPACE_KEY]: '"ws-b"' };
  const w = setup({
    tabs: [
      { label: 'p', pending: true, values },
      { label: 'b', values },
    ],
    selected: 'b',
  });

  w.close();

  for (const label of ["p'", "b'"]) {
    const adopted = w.survivors[0].gBrowser.tabs.find((tab) => tab.label === label);
    assert.equal(adopted.values[WORKSPACE_KEY], '"ws-b"', label);
    assert.equal(JSON.parse(adopted.values[HANDOVER_KEY]).length, 1, label);
  }
  // Only the pending tab needed its values written back.
  assert.deepEqual(
    w
      .of('set')
      .filter(([, , key]) => key === WORKSPACE_KEY)
      .map(([, label]) => label),
    ["p'"],
  );
  // The state is read before the swap, which empties it.
  assert.ok(
    w.calls.findIndex(([kind]) => kind === 'state') <
      w.calls.findIndex(([kind]) => kind === 'adopt'),
  );
});
