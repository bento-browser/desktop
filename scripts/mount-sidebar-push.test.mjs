// The sequencing of the sidebar push in bento-shell-mount.js (applyChromeSidebarCollapsed and
// applyChromeSidebarHidden, which the BENTO_PANELS payload runs in that order, startSidebarPush,
// settleSidebarPush): which toggles slide, what a slide commits, what ends it, and that an
// interrupted or repeated toggle leaves no margin, transform, class, attribute or custom
// property behind. The real functions run against fake elements and a
// fake motion helper that finishes on demand; the CSS that animates is not exercised here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../src/browser/base/content/bento-shell-mount.js',
  ),
  'utf8',
);

/** Source of a top-level (2-space indented) function in the mount script. */
function mountFunction(name) {
  const start = source.indexOf(`\n  function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing`);
  return source.slice(start, source.indexOf('\n  }\n', start) + 5);
}

/** Values built inside the vm have another realm's prototypes; compare them as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function mountConst(name) {
  const match = new RegExp(`^ {2}const ${name} = [^;]*;`, 'm').exec(source);
  assert.ok(match, `const ${name} is missing`);
  return match[0];
}

const CONSTANTS = [
  'SIDEBAR_PUSH_ATTR',
  'SIDEBAR_RAIL_ATTR',
  'SIDEBAR_PUSH_DELTA_PROP',
  'SIDEBAR_PUSH_PROPS',
  'SIDEBAR_PUSH_DIVIDER_EDGE',
  'SIDEBAR_PUSH_PAGE_CLASS',
  'SIDEBAR_PUSH_KEY',
  'SIDEBAR_PUSH_REDUCED_MOTION',
  'SIDEBAR_PUSH_SLIDE_ANIMATION',
];
const FUNCTIONS = [
  'isBentoSidebarPushing',
  'sidebarRailWidth',
  'sidebarExpandedWidth',
  'sidebarPushPageElements',
  'commitToolbarForSidebarPush',
  'startSidebarPush',
  'settleSidebarPush',
  'isSidebarCollapsedTarget',
  'isSidebarHiddenTarget',
  'syncGeometryAfterSidebarPush',
  'applyChromeSidebarCollapsed',
  'applyChromeSidebarHidden',
];

class FakeElement {
  constructor(id, { display = 'block', position = 'static', width = 0 } = {}) {
    this.id = id;
    this.display = display;
    this.position = position;
    this.width = width;
    this.nextElementSibling = null;
    this.classes = new Set();
    this.attributes = new Map();
    this.props = new Map();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => (force ? this.classes.add(name) : this.classes.delete(name)),
    };
    this.hidden = false;
    // The transition value in force each time layout was flushed through offsetWidth.
    this.flushes = [];
    this.style = {
      width: '',
      left: '',
      cssText: '',
      getPropertyValue: (name) => this.props.get(name) ?? '',
      setProperty: (name, value) => this.props.set(name, value),
      removeProperty: (name) => this.props.delete(name),
    };
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  toggleAttribute(name, force) {
    if (force) this.attributes.set(name, '');
    else this.attributes.delete(name);
  }

  get offsetWidth() {
    this.flushes.push(this.style.getPropertyValue('transition'));
    return this.width;
  }

  getBoundingClientRect() {
    return { width: this.width };
  }

  appendChild() {}

  remove() {}
}

/** A window of fake elements: host, a row of siblings after it, and a fake motion helper. */
function makeWorld({ expandedWidth = 300, railWidth = 64 } = {}) {
  const root = new FakeElement('root');
  const host = new FakeElement('bento-shell-host', { width: expandedWidth });
  host.style.width = expandedWidth + 'px';
  const splitter = new FakeElement('bento-shell-splitter');
  const overlay = new FakeElement('bento-palette-host', { position: 'absolute' });
  const script = new FakeElement('script', { display: 'none' });
  const nativeSidebar = new FakeElement('sidebar-box', { display: 'none' });
  const strip = new FakeElement('bento-strip-container');
  const affordance = new FakeElement('bento-shell-splitter-affordance', { position: 'absolute' });
  const bookmarks = new FakeElement('PersonalToolbar');
  const divider = new FakeElement('bento-sidebar-chrome-divider');
  const navBar = new FakeElement('nav-bar');
  const navTarget = new FakeElement('nav-bar-customization-target');
  const row = [host, splitter, overlay, script, nativeSidebar, strip];
  row.forEach((el, i) => (el.nextElementSibling = row[i + 1] ?? null));
  const byId = new Map(
    [...row, affordance, bookmarks, divider, navBar, navTarget].map((el) => [el.id, el]),
  );

  const world = {
    root,
    host,
    splitter,
    strip,
    affordance,
    bookmarks,
    divider,
    navBar,
    navTarget,
    overlay,
    nativeSidebar,
    byId,
    reducedMotion: false,
    rail: railWidth,
    waits: [],
    settledEvents: 0,
    syncs: 0,
    tokens: {
      '--bento-tab-strip-width-min-effective': 200,
      '--bento-tab-strip-width-min': 200,
      '--bento-tab-strip-width-max': 600,
    },
  };

  const sandbox = {
    HTML_NS: 'html',
    BENTO_EXPANDED_SIDEBAR_DEFAULT_WIDTH: 300,
    BENTO_RESIZE_SETTLED_EVENT: 'settled',
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    document: {
      documentElement: Object.assign(root, { appendChild() {} }),
      getElementById: (id) => byId.get(id) ?? null,
      createElementNS: () =>
        Object.assign(new FakeElement('probe'), {
          getBoundingClientRect: () => ({ width: world.rail }),
        }),
    },
    getComputedStyle: (el) => ({ display: el.display, position: el.position }),
    tokenPx: (name, fallback) => world.tokens[name] ?? fallback,
    window: {
      matchMedia: () => ({ matches: world.reducedMotion }),
      dispatchEvent: (event) => {
        if (event.type === 'settled') world.settledEvents += 1;
      },
      gBrowser: undefined,
    },
    // Motion helper stand-ins: a wait finishes when the test says so.
    afterMotion: (el, key, filter, done) => {
      const wait = { el, key, filter, done, cancelled: false };
      world.waits.push(wait);
      return () => (wait.cancelled = true);
    },
    cancelMotion: (el, key) => {
      for (const wait of world.waits) if (wait.el === el && wait.key === key) wait.cancelled = true;
    },
    // The layout refreshes the end of a push triggers.
    refreshFlatPanelLayoutFromLiveState: () => {
      world.syncs += 1;
      return true;
    },
    syncInterPanelSplitters() {},
    updateFlatLayoutOverlayPositions() {},
    updateStripScrollbar() {},
    console,
  };

  Object.assign(
    world,
    vm.runInNewContext(
      `"use strict";
      let currentSidebarHidden = false;
      let sidebarPush = null;
      let sidebarRailWidthPx = 0;
      let prepareSidebarChromeDividerForSidebarResize = null;
      let syncSidebarChromeDividerForSidebarWidth = null;
      let finishSidebarChromeDividerSidebarResize = null;
      let prepareToolbarNavigationForSidebarResize = null;
      let syncToolbarNavigationForSidebarWidth = null;
      let finishToolbarNavigationSidebarResize = null;
      let prepareBookmarksToolbarForSidebarResize = null;
      let syncBookmarksToolbarForSidebarWidth = null;
      let finishBookmarksToolbarSidebarResize = null;
      const sidebarGeometryFrameCancels = [];
      ${CONSTANTS.map(mountConst).join('\n')}
      ${FUNCTIONS.map(mountFunction).join('\n')}
      ({
        apply: applyChromeSidebarCollapsed,
        applyHidden: applyChromeSidebarHidden,
        settle: settleSidebarPush,
        isPushing: isBentoSidebarPushing,
        collapsedTarget: isSidebarCollapsedTarget,
        hiddenTarget: isSidebarHiddenTarget,
        setHidden: (value) => { currentSidebarHidden = value; },
        isHidden: () => currentSidebarHidden,
        running: () => sidebarPush,
        setToolbarHooks: (hooks) => {
          ({
            prepareSidebarChromeDividerForSidebarResize,
            syncSidebarChromeDividerForSidebarWidth,
            finishSidebarChromeDividerSidebarResize,
            prepareToolbarNavigationForSidebarResize,
            syncToolbarNavigationForSidebarWidth,
            finishToolbarNavigationSidebarResize,
            prepareBookmarksToolbarForSidebarResize,
            syncBookmarksToolbarForSidebarWidth,
            finishBookmarksToolbarSidebarResize,
          } = hooks);
        },
      });`,
      sandbox,
      { filename: 'bento-shell-mount.js#sidebar-push' },
    ),
  );

  /** Finishes the newest live wait, as the slide ending would. */
  world.endMotion = () => {
    const wait = [...world.waits].reverse().find((w) => !w.cancelled);
    assert.ok(wait, 'no motion is waiting');
    wait.cancelled = true;
    wait.done();
    return wait;
  };
  world.liveWaits = () => world.waits.filter((w) => !w.cancelled);
  /** What a slide must leave nothing of once it has ended. */
  world.assertNoResidue = () => {
    assert.equal(world.root.hasAttribute('bento-sidebar-push'), false);
    for (const name of world.root.props.keys()) {
      assert.equal(name.startsWith('--bento-sidebar-push-'), false, name);
    }
    for (const el of [world.splitter, world.strip, world.affordance, world.bookmarks]) {
      assert.equal(el.classes.has('bento-sidebar-push-page'), false, el.id);
    }
    assert.equal(world.running(), null);
    assert.equal(world.host.style.getPropertyValue('transition'), '');
  };
  /**
   * The toolbar hooks, over fake toolbar state. Sidebar width w puts the divider at w - 1 and
   * the navigation controls at max(200, w) - 100, like the real ones to within the details.
   * `calls` records what ran, in order, and what the push state looked like at the time.
   */
  world.installToolbarHooks = () => {
    const calls = [];
    const note = (name, extra = {}) =>
      calls.push({
        name,
        pushAttr: world.root.hasAttribute('bento-sidebar-push'),
        collapsedClass: world.host.classes.has('bento-sidebar-collapsed'),
        hidden: world.isHidden(),
        ...extra,
      });
    const px = (n) => n + 'px';
    world.setToolbarHooks({
      prepareSidebarChromeDividerForSidebarResize: () => note('prepare divider'),
      prepareToolbarNavigationForSidebarResize: () => note('prepare nav'),
      prepareBookmarksToolbarForSidebarResize: () => note('prepare bookmarks'),
      syncSidebarChromeDividerForSidebarWidth: (width) => {
        note('sync divider', { width });
        const hidden = world.isHidden() || width <= 0;
        world.divider.hidden = hidden;
        if (!hidden) world.divider.style.left = px(width - 1);
        world.navBar.props.set('--bento-toolbar-divider-x', px(hidden ? 0 : width - 1));
        world.root.props.set('--bento-toolbar-divider-x', px(hidden ? 0 : width - 1));
      },
      syncToolbarNavigationForSidebarWidth: (width) => {
        note('sync nav', { width });
        world.navTarget.props.set(
          '--bento-toolbar-nav-offset',
          px(world.isHidden() ? 0 : Math.max(200, width) - 100),
        );
      },
      syncBookmarksToolbarForSidebarWidth: (width) => note('sync bookmarks', { width }),
      finishSidebarChromeDividerSidebarResize: () => note('finish divider'),
      finishToolbarNavigationSidebarResize: () => note('finish nav'),
      finishBookmarksToolbarSidebarResize: () => note('finish bookmarks'),
    });
    return calls;
  };
  /** The toolbar as it is for a shown sidebar of width w. */
  world.setToolbarFor = (width) => {
    world.divider.hidden = false;
    world.divider.style.left = width - 1 + 'px';
    world.navBar.props.set('--bento-toolbar-divider-x', width - 1 + 'px');
    world.root.props.set('--bento-toolbar-divider-x', width - 1 + 'px');
    world.navTarget.props.set('--bento-toolbar-nav-offset', Math.max(200, width) - 100 + 'px');
  };
  // What the BENTO_PANELS payload runs for the two settings, in its order.
  world.payload = (collapsed, hidden) => {
    world.apply(collapsed, { hidden });
    world.applyHidden(hidden);
  };
  // First apply (boot) is instant; most tests start from a settled window after it.
  world.boot = (collapsed = false) => world.apply(collapsed);
  world.bootHidden = () => world.payload(true, true);
  return world;
}

test('the first apply at boot switches instantly', () => {
  const world = makeWorld();
  world.apply(true);
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), true);
  assert.equal(world.liveWaits().length, 0);
  world.assertNoResidue();
});

test('collapse keeps the host wide, commits the push and slides the page group', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.boot(false);
  world.apply(true);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'collapse');
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '236px');
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), false);
  // In-flow children right of the host move; the overlay host, the script and the
  // hidden native sidebar do not. The affordance is absolute but joins.
  for (const el of [world.splitter, world.strip, world.affordance]) {
    assert.equal(el.classes.has('bento-sidebar-push-page'), true, el.id);
  }
  for (const el of [world.overlay, world.nativeSidebar]) {
    assert.equal(el.classes.has('bento-sidebar-push-page'), false, el.id);
  }
  // The splitter slot is hidden for the slide; it keeps its layout space.
  assert.equal(world.splitter.classes.has('bento-sidebar-collapsed'), true);
  assert.equal(world.isPushing(), true);
  const [wait] = world.liveWaits();
  assert.deepEqual(plain(wait.filter), { animations: ['bento-sidebar-push-host-collapse'] });
});

test('the end of a collapse snaps the host to the rail in one change, with nothing left to wait for', () => {
  const world = makeWorld();
  world.boot(false);
  world.apply(true);
  world.endMotion();
  world.assertNoResidue();
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), true);
  assert.equal(world.settledEvents, 1);
  assert.equal(world.syncs, 1);
  assert.equal(world.liveWaits().length, 0);
});

test('expand widens the host at once and the end drops the push', () => {
  const world = makeWorld({ expandedWidth: 360, railWidth: 64 });
  world.boot(true);
  world.apply(false);
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), false);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'expand');
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '296px');
  assert.deepEqual(plain(world.liveWaits()[0].filter), {
    animations: ['bento-sidebar-push-host-expand'],
  });
  world.endMotion();
  world.assertNoResidue();
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), false);
  assert.equal(world.liveWaits().length, 0);
});

test('an expand reads the width from the host width, clamped to the min and max the sheet pins', () => {
  const world = makeWorld({ railWidth: 64 });
  world.boot(true);
  world.host.style.width = '900px';
  world.apply(false);
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '536px');
  world.endMotion();
  world.apply(true);
  world.endMotion();
  world.host.style.width = '120px';
  world.apply(false);
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '136px');
});

test('an expand out of the hidden state is a show, pushing from no layout space at all', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.boot(true);
  world.host.classes.add('bento-sidebar-hidden');
  world.apply(false, { hidden: false });
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'show');
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '300px');
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), false);
  assert.deepEqual(plain(world.liveWaits()[0].filter), {
    animations: ['bento-sidebar-push-host-expand'],
  });
});

test('the rail colour attribute follows the push target from the frame the push starts', () => {
  const world = makeWorld();
  const rail = () => world.root.hasAttribute('bento-sidebar-rail');
  // Boot into the rail, and the instant path without a slide, set it with the class.
  world.boot(true);
  assert.equal(rail(), true);
  // An expand flips it as the host widens, in the push's first change, before the slide ends.
  world.apply(false);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'expand');
  assert.equal(rail(), false);
  world.endMotion();
  assert.equal(rail(), false);
  // A collapse flips it at the start too, while the host is still wide.
  world.apply(true);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'collapse');
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), false);
  assert.equal(rail(), true);
  world.endMotion();
  assert.equal(rail(), true);
  world.assertNoResidue();
});

test('an interrupted collapse settles the rail colour at the end it was heading to', () => {
  const world = makeWorld();
  world.boot(false);
  world.apply(true);
  world.settle();
  assert.equal(world.root.hasAttribute('bento-sidebar-rail'), true);
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), true);
});

test('a hide takes the rail colour when it ends, not while the sidebar is sliding out', () => {
  const world = makeWorld();
  world.boot(false);
  world.payload(true, true);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'hide');
  assert.equal(world.root.hasAttribute('bento-sidebar-rail'), false);
  world.endMotion();
  assert.equal(world.root.hasAttribute('bento-sidebar-rail'), true);
  // Showing it again leaves the rail look for the expanded sidebar at the start.
  world.payload(false, false);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'show');
  assert.equal(world.root.hasAttribute('bento-sidebar-rail'), false);
});

test('toggles that leave the sidebar hidden, and the boot into it, switch instantly', () => {
  const world = makeWorld();
  world.bootHidden();
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), true);
  assert.equal(world.host.classes.has('bento-sidebar-hidden'), true);
  assert.equal(world.liveWaits().length, 0);
  world.assertNoResidue();
  // The setting changing underneath a hidden sidebar does not slide anything.
  world.payload(false, true);
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), false);
  assert.equal(world.liveWaits().length, 0);
  world.assertNoResidue();
});

test('hide slides the host out like a collapse to a narrow end of 0', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.boot(false);
  world.payload(true, true);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'hide');
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '300px');
  // The host keeps its width, and neither of its end classes lands until the slide ends.
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), false);
  assert.equal(world.host.classes.has('bento-sidebar-hidden'), false);
  assert.equal(world.hiddenTarget(world.host), true);
  assert.equal(world.collapsedTarget(world.host), true);
  assert.equal(world.isHidden(), true);
  for (const el of [world.splitter, world.strip, world.affordance, world.bookmarks]) {
    assert.equal(el.classes.has('bento-sidebar-push-page'), true, el.id);
  }
  // The page lays out at its final geometry from the start: no splitter slot, no affordance.
  assert.equal(world.splitter.classes.has('bento-sidebar-hidden'), true);
  assert.equal(world.splitter.classes.has('bento-sidebar-collapsed'), true);
  assert.equal(world.affordance.classes.has('bento-sidebar-hidden'), true);
  assert.equal(world.root.hasAttribute('bento-sidebar-hidden'), true);
  const [wait] = world.liveWaits();
  assert.deepEqual(plain(wait.filter), { animations: ['bento-sidebar-push-host-collapse'] });
});

test('hide from the rail slides the rail out, with the setting already collapsed', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.boot(true);
  world.host.width = 64;
  world.payload(true, true);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'hide');
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '64px');
  world.endMotion();
  assert.equal(world.host.classes.has('bento-sidebar-hidden'), true);
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), true);
  world.assertNoResidue();
});

test('the end of a hide puts the hidden state on in one change', () => {
  const world = makeWorld();
  world.boot(false);
  world.payload(true, true);
  world.endMotion();
  world.assertNoResidue();
  assert.equal(world.host.classes.has('bento-sidebar-hidden'), true);
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), true);
  assert.equal(world.liveWaits().length, 0);
  assert.equal(world.settledEvents >= 1, true);
  assert.equal(world.syncs, 1);
  // The hidden rule's transform transition was held off for the frame the class landed
  // in and restored after it, so the host does not slide back in from the end of the slide.
  assert.deepEqual([...world.host.flushes], ['none']);
  assert.equal(world.host.style.getPropertyValue('transition'), '');
  // The same hidden state a boot into it ends in.
  const booted = makeWorld();
  booted.bootHidden();
  assert.deepEqual([...world.host.classes].sort(), [...booted.host.classes].sort());
  assert.deepEqual([...world.splitter.classes].sort(), [...booted.splitter.classes].sort());
  assert.deepEqual([...world.affordance.classes].sort(), [...booted.affordance.classes].sort());
});

test('a repeated hide payload during the slide does not restart it', () => {
  const world = makeWorld();
  world.boot(false);
  world.payload(true, true);
  const waits = world.waits.length;
  world.payload(true, true);
  world.payload(true, true);
  assert.equal(world.waits.length, waits);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'hide');
  world.endMotion();
  world.payload(true, true);
  assert.equal(world.waits.length, waits);
  assert.equal(world.host.classes.has('bento-sidebar-hidden'), true);
});

test('hide mode keeps the two settings in step through a hide, a show and a hide', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.boot(false);
  world.payload(true, true);
  world.endMotion();
  world.payload(false, false);
  // The show is the expand out of the hidden state: no layout space at the narrow end.
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'show');
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '300px');
  assert.equal(world.host.classes.has('bento-sidebar-hidden'), false);
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), false);
  world.endMotion();
  world.assertNoResidue();
  world.payload(true, true);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'hide');
  world.endMotion();
  world.assertNoResidue();
  assert.equal(world.host.classes.has('bento-sidebar-hidden'), true);
});

test('showing during a hide settles the hide first, then slides in from the hidden state', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.boot(false);
  world.payload(true, true);
  world.payload(false, false);
  // The hide ended in place (hidden and collapsed classes landed), the show then widened
  // the host and took the hidden class off: one live push, the show.
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'show');
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '300px');
  assert.equal(world.isHidden(), false);
  assert.equal(world.host.classes.has('bento-sidebar-hidden'), false);
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), false);
  assert.equal(world.splitter.classes.has('bento-sidebar-hidden'), false);
  assert.equal(world.liveWaits().length, 1);
  assert.deepEqual(plain(world.liveWaits()[0].filter), {
    animations: ['bento-sidebar-push-host-expand'],
  });
  assert.equal(world.host.style.getPropertyValue('transition'), '');
  world.endMotion();
  world.assertNoResidue();
});

test('hiding during a show or a collapse settles that first', () => {
  for (const interrupt of ['show', 'collapse']) {
    const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
    if (interrupt === 'show') {
      world.bootHidden();
      world.payload(false, false);
    } else {
      world.boot(false);
      world.payload(true, false);
    }
    assert.equal(world.root.getAttribute('bento-sidebar-push'), interrupt);
    world.payload(true, true);
    assert.equal(world.root.getAttribute('bento-sidebar-push'), 'hide', interrupt);
    assert.equal(world.liveWaits().length, 1, interrupt);
    while (world.liveWaits().length > 0) world.endMotion();
    world.assertNoResidue();
    assert.equal(world.host.classes.has('bento-sidebar-hidden'), true, interrupt);
    assert.equal(world.host.classes.has('bento-sidebar-collapsed'), true, interrupt);
  }
});

test('rapid hide and show ends in the state of the last one with nothing left behind', () => {
  for (const finalHidden of [true, false]) {
    for (const finishFirst of [false, true]) {
      const world = makeWorld();
      world.boot(false);
      let hidden = false;
      for (let i = 0; i < 7; i += 1) {
        hidden = !hidden;
        world.payload(hidden, hidden);
        if (finishFirst && i % 2 === 0) world.endMotion();
      }
      if (hidden !== finalHidden) world.payload((hidden = finalHidden), hidden);
      while (world.liveWaits().length > 0) world.endMotion();
      world.assertNoResidue();
      assert.equal(world.host.classes.has('bento-sidebar-hidden'), finalHidden);
      assert.equal(world.host.classes.has('bento-sidebar-collapsed'), finalHidden);
      assert.equal(world.splitter.classes.has('bento-sidebar-hidden'), finalHidden);
      assert.equal(world.root.hasAttribute('bento-sidebar-hidden'), finalHidden);
      assert.equal(world.isHidden(), finalHidden);
    }
  }
});

test('hide switches instantly with reduced motion, an unmeasurable rail or no distance', () => {
  const reduced = makeWorld();
  reduced.boot(false);
  reduced.reducedMotion = true;
  reduced.payload(true, true);
  assert.equal(reduced.host.classes.has('bento-sidebar-collapsed'), true);
  assert.equal(reduced.host.classes.has('bento-sidebar-hidden'), true);
  assert.equal(reduced.liveWaits().length, 0);
  reduced.assertNoResidue();

  const unmeasured = makeWorld({ railWidth: 0 });
  unmeasured.boot(false);
  unmeasured.payload(true, true);
  assert.equal(unmeasured.host.classes.has('bento-sidebar-hidden'), true);
  unmeasured.assertNoResidue();

  const flat = makeWorld({ expandedWidth: 0 });
  flat.boot(false);
  flat.payload(true, true);
  assert.equal(flat.host.classes.has('bento-sidebar-hidden'), true);
  flat.assertNoResidue();
});

test('reduced motion and an unmeasurable rail switch instantly', () => {
  const reduced = makeWorld();
  reduced.boot(false);
  reduced.reducedMotion = true;
  reduced.apply(true);
  assert.equal(reduced.host.classes.has('bento-sidebar-collapsed'), true);
  assert.equal(reduced.liveWaits().length, 0);
  reduced.assertNoResidue();

  const unmeasured = makeWorld({ railWidth: 0 });
  unmeasured.boot(false);
  unmeasured.apply(true);
  assert.equal(unmeasured.host.classes.has('bento-sidebar-collapsed'), true);
  unmeasured.assertNoResidue();
});

test('the same setting arriving again does not restart the slide', () => {
  const world = makeWorld();
  world.boot(false);
  world.apply(true);
  const waits = world.waits.length;
  world.apply(true);
  world.apply(true);
  assert.equal(world.waits.length, waits);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'collapse');
  world.endMotion();
  world.apply(true);
  assert.equal(world.waits.length, waits);
  assert.equal(world.isPushing(), false);
});

test('a toggle during a slide settles it, then pushes the other way from the final state', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.boot(false);
  world.apply(true);
  world.apply(false);
  // The collapse was finished in place (collapsed class applied), then the expand began
  // from the collapsed state: class dropped again, one running push.
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'expand');
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), false);
  assert.equal(world.liveWaits().length, 1);
  assert.deepEqual(plain(world.liveWaits()[0].filter), {
    animations: ['bento-sidebar-push-host-expand'],
  });
  world.endMotion();
  world.assertNoResidue();
});

test('rapid toggling always ends in the state of the last one with nothing left behind', () => {
  for (const finalCollapsed of [true, false]) {
    const world = makeWorld();
    world.boot(false);
    let target = false;
    for (let i = 0; i < 7; i += 1) {
      target = !target;
      world.apply(target);
    }
    if (target !== finalCollapsed) world.apply((target = finalCollapsed));
    while (world.liveWaits().length > 0) world.endMotion();
    world.assertNoResidue();
    assert.equal(world.host.classes.has('bento-sidebar-collapsed'), finalCollapsed);
    assert.equal(world.splitter.classes.has('bento-sidebar-collapsed'), finalCollapsed);
  }
});

test('hiding the sidebar mid-slide settles the slide first', () => {
  const world = makeWorld();
  world.boot(false);
  world.apply(true);
  assert.equal(world.isPushing(), true);
  world.settle();
  world.assertNoResidue();
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), true);
});

test('the page group takes the bookmarks toolbar along', () => {
  const world = makeWorld();
  world.boot(false);
  world.apply(true);
  assert.equal(world.bookmarks.classes.has('bento-sidebar-push-page'), true);
});

test('the toolbar band is committed for the final width before anything else, and slides from where it was', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.boot(false);
  world.setToolbarFor(300);
  const calls = world.installToolbarHooks();
  world.apply(true);
  // Prepare each hook, then sync each for the rail width, all while the host and page are
  // still as they were: no push attribute yet, no collapsed class.
  assert.deepEqual(
    calls.map((call) => call.name),
    [
      'prepare divider',
      'prepare nav',
      'prepare bookmarks',
      'sync divider',
      'sync nav',
      'sync bookmarks',
    ],
  );
  for (const call of calls) {
    assert.equal(call.pushAttr, false, call.name);
    assert.equal(call.collapsedClass, false, call.name);
  }
  assert.deepEqual(
    calls.filter((call) => call.name.startsWith('sync')).map((call) => call.width),
    [64, 64, 64],
  );
  // What the CSS slides from: divider and toolbar split by the distance they moved, the
  // navigation controls from their old offset (the new one is the live offset var).
  assert.equal(world.root.props.get('--bento-sidebar-push-divider-shift'), '236px');
  assert.equal(world.root.props.get('--bento-sidebar-push-split-from'), '299px');
  assert.equal(world.root.props.get('--bento-sidebar-push-split-shift'), '236px');
  assert.equal(world.root.props.get('--bento-sidebar-push-nav-from'), '200px');
  assert.equal(world.navTarget.props.get('--bento-toolbar-nav-offset'), '100px');
  // The backgrounds behind the host keep the wider split for the slide...
  assert.equal(world.root.props.get('--bento-toolbar-divider-x'), '299px');
  // ...and take the final one when it ends, with the hooks' caches released.
  calls.length = 0;
  world.endMotion();
  assert.equal(world.root.props.get('--bento-toolbar-divider-x'), '63px');
  assert.deepEqual(
    calls.map((call) => call.name),
    ['finish divider', 'finish nav', 'finish bookmarks'],
  );
  world.assertNoResidue();
});

test('an expand slides the toolbar band the other way', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.boot(true);
  world.setToolbarFor(64);
  const calls = world.installToolbarHooks();
  world.apply(false);
  // The bookmarks toolbar rides the page group, whose layout stays the initial one until the
  // slide ends: its offset is committed when the push settles, not at the start.
  assert.deepEqual(
    calls.filter((call) => call.name.startsWith('sync')).map((call) => call.name),
    ['sync divider', 'sync nav'],
  );
  assert.equal(world.root.props.get('--bento-sidebar-push-divider-shift'), '-236px');
  assert.equal(world.root.props.get('--bento-sidebar-push-split-from'), '63px');
  assert.equal(world.root.props.get('--bento-sidebar-push-split-shift'), '-236px');
  assert.equal(world.root.props.get('--bento-sidebar-push-nav-from'), '100px');
  assert.equal(world.root.props.get('--bento-toolbar-divider-x'), '299px');
  calls.length = 0;
  world.endMotion();
  assert.equal(world.root.props.get('--bento-toolbar-divider-x'), '299px');
  const ending = calls.filter((call) => call.name === 'sync bookmarks');
  assert.deepEqual(ending.map((call) => call.width), [300]);
  assert.equal(ending[0].pushAttr, false, 'in the frame the page takes its final layout');
  world.assertNoResidue();
});

test('an expand out of the hidden state commits the toolbar of a shown sidebar', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.boot(true);
  // Hidden: the split is 0, the controls are not offset and the divider is hidden.
  world.root.props.set('--bento-toolbar-divider-x', '0px');
  world.navBar.props.set('--bento-toolbar-divider-x', '0px');
  world.navTarget.props.set('--bento-toolbar-nav-offset', '0px');
  world.divider.hidden = true;
  world.divider.style.left = '63px';
  world.host.classes.add('bento-sidebar-hidden');
  world.setHidden(true);
  const calls = world.installToolbarHooks();
  world.apply(false, { hidden: false });
  assert.equal(
    calls.filter((call) => call.name.startsWith('sync')).every((call) => call.hidden === false),
    true,
  );
  assert.equal(world.isHidden(), true, 'the hidden flag is restored for the caller');
  // The divider was not shown: it comes in with the strip's left edge, from the edge of
  // a strip at 0, so it travels the whole delta. The split and the navigation controls
  // start from their hidden values.
  assert.equal(world.root.props.get('--bento-sidebar-push-divider-shift'), '-300px');
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '300px');
  assert.equal(world.divider.style.left, '299px');
  assert.equal(world.divider.hidden, false);
  assert.equal(world.root.props.get('--bento-sidebar-push-split-from'), '0px');
  assert.equal(world.root.props.get('--bento-sidebar-push-split-shift'), '-299px');
  assert.equal(world.root.props.get('--bento-sidebar-push-nav-from'), '0px');
});

test('a hide commits the hidden toolbar at the start and sends the divider out with the strip', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.boot(false);
  world.setToolbarFor(300);
  const calls = world.installToolbarHooks();
  world.payload(true, true);
  // Every hook syncs for the hidden end (no width), with the page still as it was.
  assert.deepEqual(
    calls.filter((call) => call.name.startsWith('sync')).map((call) => [call.name, call.width]),
    [
      ['sync divider', 0],
      ['sync nav', 0],
      ['sync bookmarks', 0],
    ],
  );
  for (const call of calls.filter((call) => call.name.startsWith('sync'))) {
    assert.equal(call.hidden, true, call.name);
    assert.equal(call.pushAttr, false, call.name);
  }
  assert.equal(world.isHidden(), true, 'the hidden flag stays what the payload set');
  // The navigation controls slide from their offset to none, the toolbar's sidebar segment
  // out by the whole split.
  assert.equal(world.root.props.get('--bento-sidebar-push-nav-from'), '200px');
  assert.equal(world.navTarget.props.get('--bento-toolbar-nav-offset'), '0px');
  assert.equal(world.root.props.get('--bento-sidebar-push-split-from'), '299px');
  assert.equal(world.root.props.get('--bento-sidebar-push-split-shift'), '299px');
  // The divider is not hidden for the slide: it stays at the strip's edge, just left of
  // it, and starts the whole delta to the right, where the sidebar's edge was.
  assert.equal(world.divider.hidden, false);
  assert.equal(world.divider.style.left, '-1px');
  assert.equal(world.root.props.get('--bento-sidebar-push-divider-shift'), '300px');
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '300px');
  // The backgrounds behind the host keep the wider split, then take the hidden one.
  assert.equal(world.root.props.get('--bento-toolbar-divider-x'), '299px');
  calls.length = 0;
  world.endMotion();
  assert.equal(world.divider.hidden, true);
  assert.equal(world.root.props.get('--bento-toolbar-divider-x'), '0px');
  assert.deepEqual(
    calls.map((call) => call.name),
    ['finish divider', 'finish nav', 'finish bookmarks'],
  );
  world.assertNoResidue();
});

test('a hide whose divider is not shown leaves it hidden and shifts it by nothing', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.boot(false);
  world.setToolbarFor(300);
  world.divider.hidden = true;
  world.installToolbarHooks();
  world.payload(true, true);
  assert.equal(world.divider.hidden, true);
  assert.equal(world.root.props.get('--bento-sidebar-push-divider-shift'), '0px');
});

test('a window without the toolbar hooks still slides the host and the page', () => {
  const world = makeWorld();
  world.boot(false);
  world.apply(true);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'collapse');
  assert.equal(world.root.props.has('--bento-sidebar-push-nav-from'), false);
  world.endMotion();
  world.assertNoResidue();
});

test('a toggle reads the push target, not the class that only lands when the slide ends', () => {
  const world = makeWorld();
  world.boot(false);
  assert.equal(world.collapsedTarget(world.host), false);
  world.apply(true);
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), false);
  assert.equal(world.collapsedTarget(world.host), true);
  world.endMotion();
  assert.equal(world.collapsedTarget(world.host), true);
  world.apply(false);
  assert.equal(world.host.classes.has('bento-sidebar-collapsed'), false);
  assert.equal(world.collapsedTarget(world.host), false);
});

// The stylesheet side of the audit: a rule keyed to an expand also names the show (the expand
// out of the hidden state), unless it belongs to the shell document's own counter-translation
// (the host's clip, the frame, the edge line) or to the rail colour fade (the toolbar segment,
// the host's background, the chrome divider), which a collapse and an expand alone have: a
// show or hide switches the colour at once.
test('the stylesheet gives show every expand rule but the shell-document ones, and has no fade', () => {
  const css = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../src/browser/base/content/bento-shell-mount.css',
    ),
    'utf8',
  );
  const selectors = [...css.matchAll(/^(:root[^{]*bento-sidebar-push=[^{]*)\{/gm)].map((m) =>
    m[1].replace(/\s+/g, ' ').trim(),
  );
  const expandOnly = selectors.filter((s) => s.includes("'expand'") && !s.includes("'show'"));
  assert.equal(expandOnly.length, 7, expandOnly.join('\n'));
  for (const selector of expandOnly) {
    assert.match(
      selector,
      /#bento-shell-(host(::after)?|frame)$|#nav-bar\)$|#bento-sidebar-chrome-divider$/,
      selector,
    );
  }
  assert.doesNotMatch(css, /bento-sidebar-push-fade/);
});

// The colour transition replaces the transition list of the toolbar surfaces for the push;
// Firefox's fullscreen reveal on the toolbox (`transition: 0.8s margin-top` under
// [fullscreenShouldAnimate]) must not be cut short by it.
test('the push colour transition skips a toolbox whose fullscreen reveal is animating', () => {
  const css = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../src/browser/base/content/bento-shell-mount.css',
    ),
    'utf8',
  );
  const rule = /^(:root:is\([^{]*\)\s+:is\([^{]*#TabsToolbar[^{]*)\{([^}]*)\}/m.exec(css);
  assert.ok(rule, 'the toolbar colour transition rule is missing');
  assert.match(rule[1], /#navigator-toolbox:not\(\[fullscreenShouldAnimate\]\)/);
  assert.match(rule[2], /transition:\s*--bento-toolbar-left-bg/);
  const toolbox = [...css.matchAll(/^[^\n{]*#navigator-toolbox[^{]*\{([^}]*)\}/gm)].filter(
    (m) => /transition\s*:/.test(m[1]) && !m[0].includes('fullscreenShouldAnimate'),
  );
  assert.deepEqual(
    toolbox.map((m) => m[0].slice(0, 60)),
    [],
    'no other rule may set a transition on the plain toolbox',
  );
});

// The host is stacked over the page for the slide, and the card's drop shadow spills left into
// the host's area from inside #bento-strip-container (issue #85): the strip has to be stacked
// above the host for the push, or the shadow is cut to the gutter until the push ends.
test('the strip container stays stacked above the host for the push so the card shadow is not covered', () => {
  const css = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../src/browser/base/content/bento-shell-mount.css',
    ),
    'utf8',
  );
  const zIndex = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rule = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    assert.ok(rule, `${selector} rule is missing`);
    const value = /z-index:\s*(\d+);/.exec(rule[1]);
    assert.ok(value, `${selector} has no z-index`);
    return Number(value[1]);
  };
  const host = zIndex(':root[bento-sidebar-push] #bento-shell-host');
  const strip = zIndex(':root[bento-sidebar-push] #bento-strip-container');
  assert.ok(strip > host, `strip z-index ${strip} must be above the host's ${host}`);
});
