// How the sidebar push and the toolbar geometry updaters of bento-shell-mount.js (the divider,
// the toolbar navigation alignment, the bookmarks toolbar alignment) work together. The real
// functions run against fake elements whose rects follow a small model of the layout the CSS
// produces: the host is as wide as its classes say, takes a negative right margin while a push
// runs or the sidebar is hidden, and carries the transform each of those starts from; the strip
// sits at the host's footprint and the page group carries the collapse's (and the hide's) start
// transform. Rects
// include transforms, as getBoundingClientRect does, which is the point of these cases.
// mount-sidebar-push.test.mjs covers the sequencing of the push itself.
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
  'SIDEBAR_PUSH_FLUID_ATTR',
  'SIDEBAR_PUSH_FLUID_ANIMATION',
  'SIDEBAR_PUSH_REDUCED_MOTION',
  'SIDEBAR_PUSH_SLIDE_ANIMATION',
];
const FUNCTIONS = [
  'isBentoWindowResizing',
  'isBentoSidebarResizing',
  'isBentoPanelResizing',
  'isBentoSidebarPushing',
  'isBentoChromeLiveResizing',
  'cssLengthToPx',
  'sidebarHostLayoutBox',
  'attachSidebarChromeDivider',
  'attachToolbarNavigationAlignment',
  'attachBookmarksToolbarAlignment',
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
  constructor(id, { display = 'block', position = 'static' } = {}) {
    this.id = id;
    this.display = display;
    this.position = position;
    this.nextElementSibling = null;
    this.firstChild = null;
    this.hidden = false;
    this.classes = new Set();
    this.attributes = new Map();
    this.props = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.rect = { left: 0, right: 0, top: 0, bottom: 40, width: 0, height: 40 };
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => (force ? this.classes.add(name) : this.classes.delete(name)),
    };
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

  addEventListener(type, handler) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
  }

  getBoundingClientRect() {
    return this.rect;
  }

  appendChild() {}

  insertBefore() {}

  remove() {}
}

const px = (n) => n + 'px';

/**
 * A window with the sidebar host, the strip, the toolbar and the real updaters attached. The
 * model: while a push runs, the host keeps its width with margin-right -delta and sits
 * at the transform its animation starts from (0 on a collapse or hide, -delta on an expand); the
 * strip sits at the host's footprint, translated by +delta on a collapse or hide. Hidden mode is the rail
 * width with margin-right -rail and translateX(-100%).
 */
function makeWorld({
  expandedWidth = 300,
  railWidth = 64,
  hidden = false,
  collapsed = false,
  splitterGap = 0,
} = {}) {
  const root = new FakeElement('root');
  const host = new FakeElement('bento-shell-host');
  host.style.width = expandedWidth + 'px';
  const splitter = new FakeElement('bento-shell-splitter');
  const strip = new FakeElement('bento-strip-container');
  const browser = new FakeElement('browser');
  const toolbox = new FakeElement('navigator-toolbox');
  const tabsToolbar = new FakeElement('TabsToolbar');
  const navBar = new FakeElement('nav-bar');
  const target = new FakeElement('nav-bar-customization-target');
  const back = new FakeElement('back-button');
  const forward = new FakeElement('forward-button');
  const stopReload = new FakeElement('stop-reload-button');
  const bookmarks = new FakeElement('PersonalToolbar');
  const body = new FakeElement('body');
  const row = [host, splitter, strip];
  row.forEach((el, i) => (el.nextElementSibling = row[i + 1] ?? null));
  const byId = new Map(
    [host, splitter, strip, browser, toolbox, tabsToolbar, navBar, target, back, forward, stopReload, bookmarks].map(
      (el) => [el.id, el],
    ),
  );
  if (hidden) host.classes.add('bento-sidebar-hidden');
  if (collapsed || hidden) host.classes.add('bento-sidebar-collapsed');

  const world = {
    root,
    host,
    strip,
    bookmarks,
    navBar,
    target,
    byId,
    rail: railWidth,
    waits: [],
    frames: new Map(),
    nextFrame: 1,
    mutationCallbacks: [],
    windowListeners: new Map(),
    tokens: { '--bento-tab-strip-width-min': 200, '--bento-tab-strip-width-max': 600 },
  };

  const pushDirection = () => root.getAttribute('bento-sidebar-push');
  const delta = () => Number.parseFloat(root.props.get('--bento-sidebar-push-delta')) || 0;
  const isHidden = () => host.classes.has('bento-sidebar-hidden');
  const hostWidth = () =>
    isHidden() || host.classes.has('bento-sidebar-collapsed') ? railWidth : expandedWidth;
  const hostMargin = () => (pushDirection() ? -delta() : isHidden() ? -railWidth : 0);
  const hostShift = () => {
    if (pushDirection() === 'expand') return -delta();
    if (pushDirection() === 'collapse' || pushDirection() === 'hide') return 0;
    return isHidden() ? -railWidth : 0;
  };
  // The splitter's slot between the host and the strip; the hidden state drops it.
  const splitterSlot = () => (splitter.classes.has('bento-sidebar-hidden') ? 0 : splitterGap);
  const stripFootprint = () => hostWidth() + hostMargin() + splitterSlot();
  const stripShift = () =>
    pushDirection() === 'collapse' || pushDirection() === 'hide' ? delta() : 0;

  host.getBoundingClientRect = () => ({
    left: hostShift(),
    right: hostShift() + hostWidth(),
    top: 0,
    bottom: 600,
    width: hostWidth(),
    height: 600,
  });
  host.computedStyle = () => ({
    display: 'block',
    position: 'relative',
    transform: hostShift() ? `matrix(1, 0, 0, 1, ${hostShift()}, 0)` : 'none',
    marginRight: px(hostMargin()),
  });
  strip.getBoundingClientRect = () => ({
    left: stripFootprint() + stripShift(),
    right: 1000,
    top: 0,
    bottom: 600,
    width: 1000 - stripFootprint(),
    height: 600,
  });
  strip.computedStyle = () => ({ display: 'block', position: 'relative' });
  splitter.computedStyle = () => ({
    display: splitter.classes.has('bento-sidebar-hidden') ? 'none' : 'block',
    position: 'relative',
  });
  bookmarks.computedStyle = () => ({ display: 'block', position: 'relative', height: '28px', minHeight: '28px' });
  bookmarks.getBoundingClientRect = () => ({ left: 0, right: 1000, top: 40, bottom: 68, width: 1000, height: 28 });
  for (const el of [toolbox, tabsToolbar, navBar]) {
    el.rect = { left: 0, right: 1000, top: 0, bottom: 40, width: 1000, height: 40 };
  }
  browser.rect = { left: 0, right: 1000, top: 40, bottom: 640, width: 1000, height: 600 };
  target.rect = { left: 100, right: 800, top: 0, bottom: 40, width: 700, height: 40 };
  back.rect = { left: 100, right: 132, top: 0, bottom: 40, width: 32, height: 40 };
  forward.rect = { left: 132, right: 164, top: 0, bottom: 40, width: 32, height: 40 };
  stopReload.rect = { left: 164, right: 196, top: 0, bottom: 40, width: 32, height: 40 };

  const sandbox = {
    HTML_NS: 'html',
    BENTO_EXPANDED_SIDEBAR_DEFAULT_WIDTH: 300,
    BENTO_RESIZE_SETTLED_EVENT: 'settled',
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    DOMMatrix: class {
      constructor(value) {
        const match = /^matrix\(([^)]*)\)$/.exec(value);
        this.m41 = match ? Number(match[1].split(',')[4]) : 0;
      }
    },
    document: {
      documentElement: root,
      body,
      readyState: 'complete',
      getElementById: (id) => byId.get(id) ?? null,
      createElementNS: () => {
        const el = new FakeElement('');
        el.getBoundingClientRect = () =>
          el.style.cssText.includes('--bento-tab-strip-width-collapsed')
            ? { left: 0, right: railWidth, top: 0, bottom: 0, width: railWidth, height: 0 }
            : el.rect;
        return el;
      },
    },
    getComputedStyle: (el) =>
      el.computedStyle?.() ?? {
        display: 'block',
        position: 'static',
        height: '0px',
        minHeight: '0px',
        fontSize: '16px',
        transform: 'none',
        marginRight: '0px',
      },
    tokenPx: (name, fallback) => {
      const live = Number.parseFloat(root.props.get(name));
      return Number.isFinite(live) ? live : (world.tokens[name] ?? fallback);
    },
    requestAnimationFrame: (callback) => {
      world.frames.set(world.nextFrame, callback);
      return world.nextFrame++;
    },
    cancelAnimationFrame: (id) => world.frames.delete(id),
    window: {
      innerWidth: 1000,
      ResizeObserver: true,
      MutationObserver: true,
      matchMedia: () => ({ matches: false }),
      addEventListener: (type, handler) =>
        world.windowListeners.set(type, [...(world.windowListeners.get(type) ?? []), handler]),
      dispatchEvent: (event) => {
        for (const handler of world.windowListeners.get(event.type) ?? []) handler(event);
      },
      gBrowser: undefined,
    },
    // The updaters test window.<Observer> and construct the global one.
    ResizeObserver: class {
      observe() {}
    },
    MutationObserver: class {
      constructor(callback) {
        world.mutationCallbacks.push(callback);
      }

      observe() {}
    },
    afterMotion: (el, key, filter, done) => {
      const wait = { el, key, filter, done, cancelled: false };
      world.waits.push(wait);
      return () => (wait.cancelled = true);
    },
    cancelMotion: (el, key) => {
      for (const wait of world.waits) if (wait.el === el && wait.key === key) wait.cancelled = true;
    },
    refreshFlatPanelLayoutFromLiveState: () => true,
    syncInterPanelSplitters() {},
    updateFlatLayoutOverlayPositions() {},
    updateStripScrollbar() {},
    console,
  };
  // The divider element the real attach function creates joins the lookup like a real one.
  body.appendChild = (el) => {
    if (el.id) byId.set(el.id, el);
  };

  Object.assign(
    world,
    vm.runInNewContext(
      `"use strict";
      let currentSidebarHidden = ${hidden};
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
        attach: () => {
          attachSidebarChromeDivider();
          attachToolbarNavigationAlignment();
          attachBookmarksToolbarAlignment();
        },
        apply: applyChromeSidebarCollapsed,
        applyHidden: applyChromeSidebarHidden,
        setHidden: (value) => { currentSidebarHidden = value; },
      });`,
      sandbox,
      { filename: 'bento-shell-mount.js#sidebar-push-geometry' },
    ),
  );

  /** What the BENTO_PANELS payload runs for the two settings, in its order. */
  world.payload = (collapsed, hidden) => {
    world.apply(collapsed, { hidden });
    world.applyHidden(hidden);
  };
  /** Runs every queued animation frame once, like the next frame. */
  world.runFrames = () => {
    const queued = [...world.frames];
    world.frames.clear();
    for (const [, callback] of queued) callback();
  };
  /** Finishes the newest live motion wait, as the slide ending would. */
  world.endMotion = () => {
    const wait = [...world.waits].reverse().find((w) => !w.cancelled);
    assert.ok(wait, 'no motion is waiting');
    wait.cancelled = true;
    wait.done();
  };
  /** The toolbar values the updaters wrote, as the CSS reads them. */
  world.toolbarState = () => ({
    nav: target.props.get('--bento-toolbar-nav-offset'),
    minWidth: root.props.get('--bento-tab-strip-width-min-effective'),
    divider: byId.get('bento-sidebar-chrome-divider')?.style.left,
    bookmarks: bookmarks.props.get('--bento-bookmarks-toolbar-offset'),
    rootSplit: root.props.get('--bento-toolbar-divider-x'),
  });
  // Attached the way boot does, then let the first frames settle the toolbar for the start state.
  world.attach();
  world.runFrames();
  world.runFrames();
  // The first apply at boot switches instantly; the cases below are later toggles.
  world.apply(collapsed || hidden, { hidden });
  return world;
}

test('frames queued by an interrupted slide do not read the next slide as layout', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.apply(true);
  world.apply(false);
  // The settle of the collapse queued the updaters, and the expand is running.
  const committed = world.toolbarState();
  assert.ok(committed.nav, 'the expand committed a navigation offset');
  world.runFrames();
  world.runFrames();
  assert.deepEqual(world.toolbarState(), committed);
});

test('a frame that slips past the cancel still holds off while a slide runs', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  // Queue the updaters with no push running, then let a slide begin behind their back.
  world.windowListeners.get('settled').forEach((handler) => handler({ type: 'settled' }));
  assert.ok(world.frames.size > 0, 'the settled event queued frames');
  const before = world.toolbarState();
  world.root.setAttribute('bento-sidebar-push', 'expand');
  world.root.props.set('--bento-sidebar-push-delta', '236px');
  world.host.classes.add('bento-sidebar-collapsed');
  world.host.classes.delete('bento-sidebar-collapsed');
  world.runFrames();
  assert.deepEqual(world.toolbarState(), before);
});

test('the bookmarks toolbar mutation observer does not read the translated strip into its offset (collapse)', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.apply(true);
  // A collapse commits the final offset: the rail's footprint, where the strip will sit.
  assert.equal(world.bookmarks.props.get('--bento-bookmarks-toolbar-offset'), '64px');
  assert.equal(world.bookmarks.classes.has('bento-sidebar-push-page'), true);
  // Adding the class fires the observer; the strip it reads is translated by +delta.
  for (const callback of world.mutationCallbacks) callback();
  assert.equal(world.bookmarks.props.get('--bento-bookmarks-toolbar-offset'), '64px');
  world.runFrames();
  assert.equal(world.bookmarks.props.get('--bento-bookmarks-toolbar-offset'), '64px');
  world.endMotion();
  world.runFrames();
  assert.equal(world.bookmarks.props.get('--bento-bookmarks-toolbar-offset'), '64px');
});

test('the bookmarks toolbar keeps its initial offset through an expand and takes the final one when it ends', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64, collapsed: true });
  assert.equal(world.bookmarks.props.get('--bento-bookmarks-toolbar-offset'), '64px');
  world.apply(false);
  // The strip's layout stays at the rail's footprint until the slide ends, and the page
  // group's transform moves it: an offset already at the final value would be added to it.
  assert.equal(world.bookmarks.props.get('--bento-bookmarks-toolbar-offset'), '64px');
  for (const callback of world.mutationCallbacks) callback();
  world.runFrames();
  assert.equal(world.bookmarks.props.get('--bento-bookmarks-toolbar-offset'), '64px');
  world.endMotion();
  // In the frame the page lays out to its final geometry, not one frame later.
  assert.equal(world.bookmarks.props.get('--bento-bookmarks-toolbar-offset'), '300px');
});

test('an expand out of the hidden state prepares the toolbar from the host layout origin', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64, hidden: true });
  // Hidden: no divider, no navigation offset, the bookmarks toolbar at the window edge.
  assert.equal(world.toolbarState().nav, '0px');
  assert.equal(world.toolbarState().bookmarks, '0px');
  world.apply(false, { hidden: false });
  // The hidden class (translateX(-100%), margin-right -rail) is still on the host while the
  // hooks measure it; applyChromeSidebarHidden removes it right after.
  const state = world.toolbarState();
  // A shown 300 px sidebar puts the divider at its right edge, not 64 px short of it.
  assert.equal(state.divider, '299px');
  // The navigation controls align to that edge (the same offset an expanded window computes).
  const expandedWorld = makeWorld({ expandedWidth: 300, railWidth: 64 });
  assert.equal(state.nav, expandedWorld.toolbarState().nav);
  assert.equal(state.minWidth, expandedWorld.toolbarState().minWidth);
  // The divider was absent, so it comes in with the strip's left edge: the whole delta.
  assert.equal(world.root.props.get('--bento-sidebar-push-divider-shift'), '-300px');
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '300px');
  world.applyHidden(false);
  assert.equal(world.host.classes.has('bento-sidebar-hidden'), false);
  world.endMotion();
  // The bookmarks toolbar starts where the strip will: the expanded width, no inset.
  assert.equal(world.toolbarState().bookmarks, '300px');
});

test('a hide commits the hidden toolbar at the start and the updaters keep it after the slide', () => {
  // The splitter slot between the host and the strip goes with the hidden state, so the
  // bookmarks offset cannot be derived from the shown sidebar's width and inset.
  const world = makeWorld({ expandedWidth: 300, railWidth: 64, splitterGap: 6 });
  const shown = world.toolbarState();
  assert.equal(shown.divider, '299px');
  assert.notEqual(shown.nav, '0px');
  assert.equal(shown.bookmarks, '306px');
  world.payload(true, true);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'hide');
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '300px');
  const started = world.toolbarState();
  // Hidden values from the first frame: no navigation offset, the bookmarks toolbar at the
  // window edge (it rides the page group from delta back to 0), the split held wide.
  assert.equal(started.nav, '0px');
  assert.equal(started.bookmarks, '0px');
  assert.equal(started.rootSplit, '299px');
  // The divider line is laid out at the strip's final edge and slides from the sidebar's.
  const divider = world.byId.get('bento-sidebar-chrome-divider');
  assert.equal(divider.hidden, false);
  assert.equal(divider.style.left, '-1px');
  assert.equal(world.root.props.get('--bento-sidebar-push-divider-shift'), '300px');
  // Nothing the hooks queued reads the translated geometry while the slide runs, and a
  // mutation of the bookmarks toolbar does not read the strip's translation into its offset.
  world.runFrames();
  for (const callback of world.mutationCallbacks) callback();
  world.runFrames();
  assert.deepEqual(world.toolbarState(), started);
  assert.equal(world.bookmarks.classes.has('bento-sidebar-push-page'), true);
  world.endMotion();
  world.runFrames();
  world.runFrames();
  const ended = world.toolbarState();
  assert.equal(divider.hidden, true);
  assert.equal(ended.nav, '0px');
  assert.equal(ended.bookmarks, '0px');
  assert.equal(ended.rootSplit, '0px');
  assert.equal(world.host.classes.has('bento-sidebar-hidden'), true);
  assert.equal(world.root.hasAttribute('bento-sidebar-push'), false);
  // The same toolbar a boot into the hidden state has.
  const booted = makeWorld({ expandedWidth: 300, railWidth: 64, hidden: true, splitterGap: 6 });
  assert.equal(ended.nav, booted.toolbarState().nav);
  assert.equal(ended.bookmarks, booted.toolbarState().bookmarks);
  assert.equal(ended.rootSplit, booted.toolbarState().rootSplit);
});

test('a hide from the rail slides the rail footprint out and ends hidden', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64, collapsed: true, splitterGap: 6 });
  assert.equal(world.toolbarState().bookmarks, '70px');
  world.payload(true, true);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'hide');
  assert.equal(world.root.props.get('--bento-sidebar-push-delta'), '64px');
  assert.equal(world.root.props.get('--bento-sidebar-push-divider-shift'), '64px');
  assert.equal(world.toolbarState().bookmarks, '0px');
  world.endMotion();
  world.runFrames();
  world.runFrames();
  assert.equal(world.byId.get('bento-sidebar-chrome-divider').hidden, true);
  assert.equal(world.toolbarState().bookmarks, '0px');
  assert.equal(world.host.classes.has('bento-sidebar-hidden'), true);
});

test('showing right after a hide starts the divider and the toolbar from the hidden state', () => {
  const world = makeWorld({ expandedWidth: 300, railWidth: 64 });
  world.payload(true, true);
  // Interrupted before the hide ended: it settles first, then the show begins.
  world.payload(false, false);
  assert.equal(world.root.getAttribute('bento-sidebar-push'), 'show');
  assert.equal(world.root.props.get('--bento-sidebar-push-divider-shift'), '-300px');
  assert.equal(world.root.props.get('--bento-sidebar-push-nav-from'), '0px');
  assert.equal(world.host.classes.has('bento-sidebar-hidden'), false);
  const divider = world.byId.get('bento-sidebar-chrome-divider');
  assert.equal(divider.hidden, false);
  assert.equal(divider.style.left, '299px');
  world.endMotion();
  world.runFrames();
  world.runFrames();
  assert.equal(world.toolbarState().bookmarks, '300px');
  assert.equal(world.root.hasAttribute('bento-sidebar-push'), false);
});
