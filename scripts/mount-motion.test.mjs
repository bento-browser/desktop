// The motion timing helpers of bento-shell-mount.js (measureMotion, afterMotion,
// cancelMotion, motionTokenMs). They read how long CSS motion runs from an element's
// computed style so no script mirrors a duration. These tests run the real functions
// against fake elements and fake timers; overlay-surfaces.test.mjs covers them through
// the overlay hides, and extensions/bento-shell/src/motion/afterMotion.test.ts covers the
// shell copy of the same contract. The last tests run the workspace-switch fade that waits
// on them (performWorkspaceSwitchFade) and check its timers and frames stay accounted for.
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

const CONSTANTS = ['MOTION_SLACK_MS', 'MOTION_UNAVAILABLE_CEILING_MS', 'motionWaits'];
const FUNCTIONS = [
  'motionList',
  'motionTimeMs',
  'measureMotion',
  'cancelMotion',
  'afterMotion',
  'motionTokenMs',
];

function makeWorld() {
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map();
  const tokens = {};
  const sandbox = {
    setTimeout: (callback, ms = 0) => {
      timers.set(nextTimer, { callback, due: clock + ms });
      return nextTimer++;
    },
    clearTimeout: (id) => timers.delete(id),
    window: {
      getComputedStyle: () => ({ getPropertyValue: (name) => ` ${tokens[name] ?? ''}` }),
    },
    document: { documentElement: {} },
  };
  const api = vm.runInNewContext(
    `"use strict";
    ${CONSTANTS.map(mountConst).join('\n')}
    ${FUNCTIONS.map(mountFunction).join('\n')}
    ({ ${[...CONSTANTS, ...FUNCTIONS].join(', ')} });`,
    sandbox,
    { filename: 'bento-shell-mount.js#motion' },
  );
  return {
    ...api,
    tokens,
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.due <= target);
        if (due.length === 0) break;
        due.sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
        const [id, timer] = due[0];
        timers.delete(id);
        clock = Math.max(clock, timer.due);
        timer.callback();
      }
      clock = target;
    },
  };
}

class FakeElement {
  listeners = new Map();

  constructor(computed, isConnected = true) {
    const style = {
      transitionProperty: 'all',
      transitionDuration: '0s',
      transitionDelay: '0s',
      animationName: 'none',
      animationDuration: '0s',
      animationDelay: '0s',
      animationIterationCount: '1',
      ...computed,
    };
    this.isConnected = isConnected;
    this.style = style;
    this.ownerDocument = { defaultView: { getComputedStyle: () => (computed ? style : null) } };
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
      toggle: (name, force) => (force ? this.classes.add(name) : this.classes.delete(name)),
    };
  }

  addEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(handler));
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }

  dispatch(type, init = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) {
      handler({ type, target: this, ...init });
    }
  }
}

const plain = (value) => JSON.parse(JSON.stringify(value));

test('measureMotion reads s and ms, adds delay, filters, and expands short lists', () => {
  const { measureMotion } = makeWorld();
  const el = new FakeElement({
    transitionProperty: 'opacity, transform, color',
    transitionDuration: '0.2s, 150ms, 1s',
    transitionDelay: '0s, 50ms, 0s',
  });
  assert.equal(measureMotion(el).ms, 1000);
  assert.equal(measureMotion(el, { properties: ['opacity', 'transform'] }).ms, 200);
  assert.equal(measureMotion(el, { properties: ['width'] }).ms, 0);

  const expanded = measureMotion(
    new FakeElement({
      transitionProperty: 'width, min-width, max-width',
      transitionDuration: '0.12s',
    }),
  );
  assert.equal(expanded.ms, 120);
  assert.deepEqual([...expanded.ending].sort(), ['t:max-width', 't:min-width', 't:width']);

  const all = new FakeElement({ transitionProperty: 'all', transitionDuration: '0.2s' });
  assert.equal(measureMotion(all, { properties: ['opacity'] }).ms, 200);
});

test('measureMotion takes the LAST transition-property entry that names a property, all included', () => {
  const { measureMotion } = makeWorld();
  const allThenOpacity = new FakeElement({
    transitionProperty: 'all, opacity',
    transitionDuration: '0.2s, 0s',
  });
  assert.equal(measureMotion(allThenOpacity, { properties: ['opacity'] }).ms, 0);
  assert.equal(measureMotion(allThenOpacity, { properties: ['color'] }).ms, 200);
  const both = measureMotion(allThenOpacity, { properties: ['opacity', 'color'] });
  assert.equal(both.ms, 200);
  assert.deepEqual([...both.ending], ['t:color']);

  const opacityThenAll = new FakeElement({
    transitionProperty: 'opacity, all',
    transitionDuration: '0s, 0.2s',
  });
  assert.equal(measureMotion(opacityThenAll, { properties: ['opacity'] }).ms, 200);

  // Without a filter an entry that a later entry overrides does not count.
  assert.equal(measureMotion(allThenOpacity).ms, 200);
  assert.equal(
    measureMotion(
      new FakeElement({ transitionProperty: 'opacity, all', transitionDuration: '1s, 0.2s' }),
    ).ms,
    200,
  );
});

test('measureMotion multiplies animations by a finite iteration count and skips infinite ones', () => {
  const { measureMotion } = makeWorld();
  const el = new FakeElement({
    animationName: 'fade, spin, pulse',
    animationDuration: '0.5s, 1s, 1.2s',
    animationDelay: '0.1s',
    animationIterationCount: '2, 1, infinite',
  });
  assert.equal(measureMotion(el, { animations: ['fade'] }).ms, 1100);
  assert.equal(measureMotion(el, { animations: ['spin'] }).ms, 1100);
  assert.equal(measureMotion(el, { animations: ['pulse'] }).ms, 0);
});

test('measureMotion: zero is an answer, a disconnected element has none', () => {
  const { measureMotion } = makeWorld();
  assert.equal(measureMotion(new FakeElement({ transitionProperty: 'none' })).ms, 0);
  assert.equal(measureMotion(new FakeElement({})).ms, 0);
  assert.equal(measureMotion(new FakeElement({ transitionDuration: '1s' }, false)), null);
  assert.equal(measureMotion(new FakeElement(null)), null);
});

test('afterMotion runs now at 0 ms, otherwise on the last end event or the timer', () => {
  const world = makeWorld();
  const calls = [];

  world.afterMotion(new FakeElement({}), 'k', { properties: ['opacity'] }, () => calls.push('now'));
  assert.deepEqual(calls, ['now']);

  const el = new FakeElement({
    transitionProperty: 'opacity, transform',
    transitionDuration: '0.1s, 0.2s',
  });
  world.afterMotion(el, 'k', { properties: ['opacity', 'transform'] }, () => calls.push('events'));
  el.dispatch('transitionend', { propertyName: 'opacity' });
  assert.deepEqual(calls, ['now'], 'the earlier transition ending is not the end');
  el.dispatch('transitionend', { propertyName: 'transform' });
  assert.deepEqual(calls, ['now', 'events']);
  assert.equal(el.listenerCount(), 0);

  const timed = new FakeElement({ transitionProperty: 'opacity', transitionDuration: '0.12s' });
  world.afterMotion(timed, 'k', { properties: ['opacity'] }, () => calls.push('timer'));
  world.advance(120 + world.MOTION_SLACK_MS - 1);
  assert.equal(calls.includes('timer'), false);
  world.advance(1);
  assert.equal(calls.at(-1), 'timer');
  assert.equal(timed.listenerCount(), 0);
});

test('afterMotion runs now when the last entry for the property is 0, and ignores unrelated ends', () => {
  const world = makeWorld();
  const calls = [];
  const zero = new FakeElement({
    transitionProperty: 'all, opacity',
    transitionDuration: '0.2s, 0s',
  });
  world.afterMotion(zero, 'k', { properties: ['opacity'] }, () => calls.push('zero'));
  assert.deepEqual(calls, ['zero'], 'runs before afterMotion returns');
  assert.equal(zero.listenerCount(), 0);

  // 'all' ends last, so an event for another property must not finish an opacity wait.
  const el = new FakeElement({ transitionProperty: 'all', transitionDuration: '0.2s' });
  world.afterMotion(el, 'k', { properties: ['opacity'] }, () => calls.push('opacity'));
  el.dispatch('transitionend', { propertyName: 'background-color' });
  assert.deepEqual(calls, ['zero']);
  el.dispatch('transitionend', { propertyName: 'opacity' });
  assert.deepEqual(calls, ['zero', 'opacity']);
  assert.equal(el.listenerCount(), 0);

  // A filtered wait ends on the requested property that ends last, not an unrelated one.
  const two = new FakeElement({
    transitionProperty: 'opacity, transform, color',
    transitionDuration: '0.1s, 0.3s, 0.5s',
  });
  world.afterMotion(two, 'k', { properties: ['opacity', 'transform'] }, () => calls.push('two'));
  two.dispatch('transitionend', { propertyName: 'color' });
  two.dispatch('transitionend', { propertyName: 'opacity' });
  assert.deepEqual(calls, ['zero', 'opacity']);
  two.dispatch('transitionend', { propertyName: 'transform' });
  assert.deepEqual(calls, ['zero', 'opacity', 'two']);

  // Without a filter a transition on 'all' still ends on any property.
  const unfiltered = new FakeElement({ transitionProperty: 'all', transitionDuration: '0.2s' });
  world.afterMotion(unfiltered, 'k', {}, () => calls.push('any'));
  unfiltered.dispatch('transitionend', { propertyName: 'width' });
  assert.equal(calls.at(-1), 'any');
});

test('a later wait with the same key, or cancelMotion, drops the earlier one', () => {
  const world = makeWorld();
  const el = new FakeElement({ transitionProperty: 'opacity', transitionDuration: '0.2s' });
  const calls = [];
  world.afterMotion(el, 'k', { properties: ['opacity'] }, () => calls.push('first'));
  world.afterMotion(el, 'k', { properties: ['opacity'] }, () => calls.push('second'));
  assert.equal(el.listenerCount(), 2, 'one wait is left');
  world.advance(1000);
  assert.deepEqual(calls, ['second']);

  world.afterMotion(el, 'k', { properties: ['opacity'] }, () => calls.push('third'));
  world.cancelMotion(el, 'k');
  world.advance(1000);
  assert.deepEqual(calls, ['second']);
  assert.equal(el.listenerCount(), 0);
});

test('an element with no computed style waits for the ceiling and listens to nothing', () => {
  const world = makeWorld();
  const el = new FakeElement({ transitionDuration: '1s' }, false);
  const calls = [];
  world.afterMotion(el, 'k', {}, () => calls.push('done'));
  assert.equal(el.listenerCount(), 0);
  world.advance(world.MOTION_UNAVAILABLE_CEILING_MS - 1);
  assert.deepEqual(calls, []);
  world.advance(1);
  assert.deepEqual(calls, ['done']);
});

test('motionTokenMs reads a custom property as a time', () => {
  const world = makeWorld();
  world.tokens['--muxui-semantic-motion-reveal-transition-duration'] = '200ms';
  world.tokens['--seconds'] = '0.5s';
  assert.equal(world.motionTokenMs('--muxui-semantic-motion-reveal-transition-duration'), 200);
  assert.equal(world.motionTokenMs('--seconds'), 500);
  assert.equal(plain(world.motionTokenMs('--missing')), 0);
});

// ─── Workspace-switch fade ───────────────────────────────────────────────────

function mountDeclaration(name) {
  const match = new RegExp(`^ {2}(?:const|let) ${name} = [^;]*;`, 'm').exec(source);
  assert.ok(match, `${name} is missing`);
  return match[0];
}

const FADE_DECLARATIONS = [
  '__workspaceSwitchTimer',
  '__workspaceFadeWatchdog',
  '__workspaceFadeCleanupTimer',
  '__workspaceFadeCleanupFrame',
  'WORKSPACE_FADE_WATCHDOG_MS',
  '__workspaceSwitchSwapping',
  '__mainWidthTransitionForNextReconcile',
  '__pendingStripScrollRestore',
];
const FADE_FUNCTIONS = [
  'workspaceFadeTarget',
  'workspaceStabilizeMs',
  'cancelWorkspaceFadeCleanup',
  'clearWorkspaceFadeClasses',
  'cancelWorkspaceFadeForMainOnly',
  'setWorkspaceFadeClasses',
  'cancelStripScrollMotion',
  'armWorkspaceSwitchFade',
  'performWorkspaceSwitchFade',
];

/** The real fade helpers over fake timers and animation frames; the fade is `fadeComputed`. */
function makeFade(fadeComputed) {
  let clock = 0;
  let nextId = 1;
  const timers = new Map();
  const frames = new Map();
  const tokens = { '--muxui-semantic-motion-reveal-transition-duration': '200ms' };
  const fade = new FakeElement(fadeComputed);
  const sandbox = {
    setTimeout: (callback, ms = 0) => {
      timers.set(nextId, { callback, due: clock + ms });
      return nextId++;
    },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => {
      frames.set(nextId, callback);
      return nextId++;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
    console: { warn() {} },
    window: {
      gBrowser: { tabpanels: fade },
      getComputedStyle: () => ({ getPropertyValue: (name) => ` ${tokens[name] ?? ''}` }),
    },
    document: { documentElement: {}, getElementById: () => null },
    reconcilePanels() {},
    getStripScrollTarget: () => null,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `"use strict";
    ${CONSTANTS.map(mountConst).join('\n')}
    ${FADE_DECLARATIONS.map(mountDeclaration).join('\n')}
    ${[...FUNCTIONS, ...FADE_FUNCTIONS].map(mountFunction).join('\n')}`,
    sandbox,
    { filename: 'bento-shell-mount.js#workspace-fade' },
  );
  return {
    fade,
    get: (expression) => vm.runInContext(expression, sandbox),
    pendingTimers: () => timers.size,
    pendingFrames: () => frames.size,
    flushFrames() {
      const queued = [...frames.values()];
      frames.clear();
      for (const frame of queued) frame();
    },
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.due <= target);
        if (due.length === 0) break;
        due.sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
        const [id, timer] = due[0];
        timers.delete(id);
        clock = Math.max(clock, timer.due);
        timer.callback();
      }
      clock = target;
    },
  };
}

const STABILIZING = 'bento-workspace-stabilizing';
const SWITCHING = 'bento-workspace-switching';

test('overlapping zero-fade switches leave one stabilize timer, and cancelling leaves none', () => {
  const { get, fade, pendingTimers, flushFrames } = makeFade({ transitionProperty: 'opacity' });
  const perform = get('performWorkspaceSwitchFade');
  perform([], {});
  perform([], {});
  flushFrames();
  assert.equal(pendingTimers(), 1, 'only the newer switch keeps a stabilize timer');
  get('cancelWorkspaceFadeForMainOnly')();
  assert.equal(pendingTimers(), 0, 'no timer survives the cancel');
  assert.equal(get('__workspaceFadeCleanupTimer'), null);
  assert.equal(get('__workspaceFadeCleanupFrame'), null);
  assert.equal(fade.classes.size, 0);
});

test('cancelling before the frame runs drops the frame and its timer', () => {
  const { get, fade, pendingTimers, pendingFrames, flushFrames } = makeFade({
    transitionProperty: 'opacity',
  });
  get('performWorkspaceSwitchFade')([], {});
  assert.equal(pendingFrames(), 1);
  get('cancelWorkspaceFadeForMainOnly')();
  assert.equal(pendingFrames(), 0);
  flushFrames();
  assert.equal(pendingTimers(), 0);
  assert.equal(fade.classes.size, 0);
});

test('a stale stabilize timer cannot end the stabilize window of a newer switch early', () => {
  const { get, fade, advance, flushFrames } = makeFade({ transitionProperty: 'opacity' });
  const perform = get('performWorkspaceSwitchFade');
  // Two switches queue their frames before either runs; the window is 200 + slack ms.
  const stabilizeMs = 200 + get('MOTION_SLACK_MS');
  perform([], {});
  perform([], {});
  flushFrames();
  get('cancelWorkspaceFadeForMainOnly')();
  advance(100);
  perform([], {});
  flushFrames();
  advance(stabilizeMs - 100 - 1);
  assert.equal(fade.classes.has(STABILIZING), true, 'the first switch timer would have fired here');
  advance(100);
  assert.equal(fade.classes.has(STABILIZING), true, 'still inside the newer 250 ms window');
  advance(stabilizeMs - 100);
  assert.equal(fade.classes.has(STABILIZING), false);
  assert.equal(get('__workspaceFadeCleanupTimer'), null);
});

test('a frame queued by a replaced switch does not lift the curtain of the newer switch', () => {
  const { get, fade, advance, flushFrames, pendingFrames } = makeFade({
    transitionProperty: 'opacity',
  });
  const perform = get('performWorkspaceSwitchFade');
  perform([], {});
  assert.equal(pendingFrames(), 1);
  Object.assign(fade.style, { transitionDuration: '0.12s' });
  perform([], {});
  assert.equal(pendingFrames(), 0, 'the replaced switch dropped its frame');
  flushFrames();
  assert.equal(fade.classes.has(SWITCHING), true, 'the curtain stays up for the fade-out');
  advance(120 + get('MOTION_SLACK_MS'));
  flushFrames();
  assert.equal(fade.classes.has(SWITCHING), false);
  assert.equal(fade.classes.has(STABILIZING), true);
});

// ─── The light/dark flip fade (applyChromeColorMode and the direct signal) ──────────────────────

const COLOR_FADE = 'data-bento-mode-fade';

function mountLet(name) {
  const match = new RegExp(`^ {2}let ${name} = [^;]*;`, 'm').exec(source);
  assert.ok(match, `let ${name} is missing`);
  return match[0];
}

const EPOCH = 1_700_000_000_000;

/** The mount's colour mode functions, run against a root that records its attribute writes. */
function makeColorWorld({ isPrivate = false } = {}) {
  let clock = 0;
  let nextTimer = 1;
  const timers = new Map();
  const frames = new Map();
  let nextFrame = 1;
  const attributes = new Map([['data-color-mode', 'light']]);
  const writes = [];
  const notifications = [];
  // clockStep: how far the system clock (Date.now) has been stepped from the monotonic one.
  const env = { hidden: false, reducedMotion: false, osDark: false, clockStep: 0 };
  const documentListeners = new Map();
  const root = new FakeElement({
    transitionProperty: 'background-color, color',
    transitionDuration: '0.12s',
  });
  Object.assign(root, {
    getAttribute: (name) => attributes.get(name) ?? null,
    hasAttribute: (name) => attributes.has(name),
    setAttribute(name, value) {
      writes.push([name, value, attributes.get(COLOR_FADE) ?? null]);
      attributes.set(name, value);
    },
    removeAttribute(name) {
      writes.push([name, null, null]);
      attributes.delete(name);
    },
  });
  const windowListeners = new Map();
  const sandbox = {
    setTimeout: (callback, ms = 0) => {
      timers.set(nextTimer, { callback, due: clock + ms });
      return nextTimer++;
    },
    clearTimeout: (id) => timers.delete(id),
    // The system clock tools' epoch time is read from: one fixed epoch plus the fake timers'
    // time, plus any step. The window's own monotonic clock (performance.now, which frame times
    // use) has no step. Frame callbacks run every 4 ms of it (a 240 Hz display), and not while
    // the window is hidden.
    Date: { now: () => EPOCH + clock + env.clockStep },
    document: {
      documentElement: root,
      get hidden() {
        return env.hidden;
      },
      addEventListener: (type, handler) =>
        documentListeners.set(type, new Set([...(documentListeners.get(type) ?? []), handler])),
      removeEventListener: (type, handler) => documentListeners.get(type)?.delete(handler),
    },
    window: {
      matchMedia: (query) => ({
        matches: query.includes('reduced-motion') ? env.reducedMotion : env.osDark,
      }),
      addEventListener: (type, handler) => windowListeners.set(type, handler),
      performance: { now: () => clock },
      requestAnimationFrame: (callback) => {
        frames.set(nextFrame, callback);
        return nextFrame++;
      },
      cancelAnimationFrame: (id) => frames.delete(id),
    },
    Services: { obs: { notifyObservers: (...args) => notifications.push(args) } },
    BentoPrivateBrowsingUtils: { isWindowPrivate: () => isPrivate },
  };
  const names = [
    'resolveChromeColorMode',
    'writeChromeColorMode',
    'acceptChromeColorStamp',
    'commitChromeColorMode',
    'runAtChromeFlip',
    'setChromeColorMode',
    'applyChromeColorMode',
    'handleChromeDarkQueryChange',
    'handleUiColorModeSet',
  ];
  const api = vm.runInNewContext(
    `"use strict";
    ${['CHROME_DARK_QUERY', 'BENTO_UI_COLOR_MODE_TOPIC', 'BENTO_MODE_FADE_ATTR', 'BENTO_UI_COLOR_MODE_SET_EVENT', 'BENTO_FLIP_FRAME_WATCH_MS', ...CONSTANTS].map(mountConst).join('\n')}
    ${mountLet('chromeColorModePref')}
    ${mountLet('chromeColorModeApplied')}
    ${mountLet('chromeColorStamp')}
    ${mountLet('cancelChromeColorFlip')}
    ${[...FUNCTIONS, ...names].map(mountFunction).join('\n')}
    ({ ${names.join(', ')}, BENTO_UI_COLOR_MODE_SET_EVENT });`,
    sandbox,
    { filename: 'bento-shell-mount.js#colormode' },
  );
  return {
    ...api,
    attributes,
    writes,
    notifications,
    env,
    /** The epoch time `ms` from now, as a stamp's flipAt. */
    at: (ms) => EPOCH + clock + env.clockStep + ms,
    timerCount: () => timers.size,
    visibilityListeners: () => documentListeners.get('visibilitychange')?.size ?? 0,
    /** The window hides: frames stop and the listeners hear it. */
    hide() {
      env.hidden = true;
      for (const handler of [...(documentListeners.get('visibilitychange') ?? [])]) handler({});
    },
    // The window event bento-tools fires; the world registers the mount's handler for it.
    signal: (mode, stamp) => api.handleUiColorModeSet({ detail: { mode, stamp } }),
    fadeWrites: () => writes.filter(([name, value]) => name === COLOR_FADE && value === ''),
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        // The next thing due: a timer, or the next frame tick (every 4 ms).
        const nextTick = (Math.floor(clock / 4) + 1) * 4;
        const due = [...timers].filter(([, timer]) => timer.due <= target);
        due.sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
        const timerDue = due.length > 0 ? due[0][1].due : Infinity;
        if (Math.min(timerDue, nextTick) > target) break;
        if (timerDue <= nextTick) {
          const [id, timer] = due[0];
          timers.delete(id);
          clock = Math.max(clock, timer.due);
          timer.callback();
        } else {
          clock = nextTick;
          if (env.hidden) continue;
          const queued = [...frames.values()];
          frames.clear();
          for (const callback of queued) callback(clock);
        }
      }
      clock = target;
    },
  };
}

test('the first colour mode application never fades; a later flip fades and clears after the motion', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('dark');
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  assert.equal(world.fadeWrites().length, 0, 'the startup application writes without a fade');

  world.applyChromeColorMode('light');
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  // The attribute went on before the mode did, in the same task.
  const order = world.writes.map(([name]) => name);
  assert.ok(order.lastIndexOf(COLOR_FADE) < order.lastIndexOf('data-color-mode'));
  assert.equal(world.attributes.has(COLOR_FADE), true);
  world.advance(100);
  assert.equal(world.attributes.has(COLOR_FADE), true, 'it stays until the fade has ended');
  world.advance(100);
  assert.equal(world.attributes.has(COLOR_FADE), false);
});

test('hidden windows and reduced motion switch the mode without a fade', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light');
  world.env.hidden = true;
  world.applyChromeColorMode('dark');
  world.env.hidden = false;
  world.env.reducedMotion = true;
  world.applyChromeColorMode('light');
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  assert.equal(world.fadeWrites().length, 0);
});

test('the direct signal applies the pref, resolving Auto in chrome, and ignores a bad value', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light');
  world.signal('system');
  assert.equal(world.attributes.get('data-color-mode'), 'light', 'Auto resolves against the OS');
  assert.equal(world.attributes.get('data-bento-color-mode-pref'), 'system');
  world.env.osDark = true;
  world.signal('system');
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  world.signal('purple');
  world.signal(undefined);
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
});

test('a private window ignores the direct signal', () => {
  const world = makeColorWorld({ isPrivate: true });
  world.applyChromeColorMode('light');
  world.signal('dark');
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  assert.equal(world.fadeWrites().length, 0);
});

test('the late BENTO_PANELS payload after the direct signal neither restarts nor doubles the fade', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light');
  world.signal('dark');
  assert.equal(world.fadeWrites().length, 1);
  assert.equal(world.notifications.length, 1, 'about:preferences is told once');
  world.advance(60);

  // The payload carries the same pref and takes the unchanged-mode path.
  world.applyChromeColorMode('dark');
  assert.equal(world.fadeWrites().length, 1, 'the attribute is not set again');
  assert.equal(world.notifications.length, 1);
  world.advance(120);
  assert.equal(world.attributes.has(COLOR_FADE), false, 'the first wait still ends the fade');
});

test('a second flip during the fade keeps the attribute and waits again', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light');
  world.signal('dark');
  world.advance(100);
  world.signal('light');
  assert.equal(world.attributes.has(COLOR_FADE), true);
  assert.equal(
    world.writes.filter(([name, value]) => name === COLOR_FADE && value === null).length,
    0,
    'no removal between the flips',
  );
  world.advance(100);
  assert.equal(world.attributes.has(COLOR_FADE), true, 'the first flip’s wait no longer ends it');
  world.advance(100);
  assert.equal(world.attributes.has(COLOR_FADE), false);
});

test('the mount listens for the event name the bentoPrivacy experiment dispatches', () => {
  const world = makeColorWorld();
  const api = readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../extensions/bento-tools/experiments/bento-privacy/api.js',
    ),
    'utf8',
  );
  assert.ok(api.includes(`UI_COLOR_MODE_EVENT = '${world.BENTO_UI_COLOR_MODE_SET_EVENT}'`));
  assert.ok(
    source.includes(
      'window.addEventListener(BENTO_UI_COLOR_MODE_SET_EVENT, handleUiColorModeSet);',
    ),
    'the mount registers its handler',
  );
});

test('a change that does not fade ends a running fade, and an unchanged value leaves it alone', () => {
  for (const noFade of ['hidden', 'reducedMotion']) {
    const world = makeColorWorld();
    world.applyChromeColorMode('light');
    world.signal('dark');
    assert.equal(world.attributes.has(COLOR_FADE), true);

    // The same mode arriving again (the payload backstop) must not touch the running fade.
    world.env[noFade] = true;
    world.applyChromeColorMode('dark');
    assert.equal(world.attributes.has(COLOR_FADE), true, noFade + ': unchanged value');

    // A real change with no fade drops the attribute now and the wait with it.
    world.applyChromeColorMode('light');
    assert.equal(world.attributes.get('data-color-mode'), 'light');
    assert.equal(world.attributes.has(COLOR_FADE), false, noFade + ': changed value');
    const removals = () =>
      world.writes.filter(([name, value]) => name === COLOR_FADE && value === null).length;
    const before = removals();
    world.advance(500);
    assert.equal(removals(), before, 'the cancelled wait does not fire');
  }
});

// A stamp of tools run 'a' (or another run), as SettingsStore.colorStamp() makes them.
const stamp = (seq, run = 'a') => ({ run, seq });

test('a stale payload after the direct signal is dropped, with one fade and no reversal', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light', stamp(1));
  world.signal('dark', stamp(2));
  // A payload serialised before the flip: the old mode, the old stamp.
  world.applyChromeColorMode('light', stamp(1));
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  assert.equal(world.attributes.get('data-bento-color-mode-pref'), 'dark');
  assert.equal(world.fadeWrites().length, 1);
  assert.equal(world.notifications.length, 1);

  // The current payload agrees and neither restarts nor cancels the fade.
  world.applyChromeColorMode('dark', stamp(2));
  assert.equal(world.fadeWrites().length, 1);
  assert.equal(world.attributes.has(COLOR_FADE), true);
  world.advance(200);
  assert.equal(world.attributes.has(COLOR_FADE), false);
});

test('the same holds the other way round: the payload first, then an older direct signal', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light', stamp(1));
  world.applyChromeColorMode('dark', stamp(2));
  world.signal('light', stamp(1));
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  assert.equal(world.fadeWrites().length, 1);
});

test('the first flip of a run: an initial payload queued before it cannot undo the direct signal', () => {
  // Tools stamps the state it starts with (seq 1), so the initial payload is ordered too. It was
  // serialised with the old mode, and is delivered after the direct event for the first flip.
  for (const initial of [stamp(1), undefined]) {
    const world = makeColorWorld();
    world.applyChromeColorMode('light', stamp(1));
    world.signal('dark', stamp(2));
    world.applyChromeColorMode('light', initial);
    assert.equal(world.attributes.get('data-color-mode'), 'dark', String(initial));
    // The payload built after the flip is the backstop and changes nothing.
    world.applyChromeColorMode('dark', stamp(2));
    assert.equal(world.fadeWrites().length, 1, 'one fade, not dark, light, dark');
    assert.equal(world.notifications.length, 1);
  }
});

test('with nothing recorded yet any message applies; after a stamp an unstamped one is dropped', () => {
  const world = makeColorWorld();
  // First boot, an older payload source, the legacy title: no stamp anywhere yet.
  world.applyChromeColorMode('dark');
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  world.applyChromeColorMode('light', undefined);
  assert.equal(world.attributes.get('data-color-mode'), 'light');

  world.applyChromeColorMode('dark', stamp(3));
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  // A sidebar's pre-hydration boot hint, or the legacy title, after a stamped mode.
  world.applyChromeColorMode('light');
  world.applyChromeColorMode('light', { run: 7, seq: 'x' });
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  // The same run: lower is stale, equal and higher apply.
  world.applyChromeColorMode('light', stamp(2));
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  world.applyChromeColorMode('light', stamp(3));
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  world.applyChromeColorMode('dark', stamp(4));
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
});

test('a restart never leaves chrome rejecting: a new run applies whatever its sequence or clock', () => {
  const world = makeColorWorld();
  // The old run got far, with chrome applying its stamps.
  world.applyChromeColorMode('light', stamp(1, 'old'));
  world.signal('dark', stamp(40, 'old'));
  assert.equal(world.attributes.get('data-color-mode'), 'dark');

  // Tools restarted (the clock may have stepped back too): a new run id, sequence from 1.
  // The saved mode is light, and the new run's first stamped message says so.
  world.applyChromeColorMode('light', stamp(1, 'new'));
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  world.signal('dark', stamp(2, 'new'));
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  // Inside the new run the order holds again.
  world.applyChromeColorMode('light', stamp(1, 'new'));
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  world.signal('light', stamp(3, 'new'));
  assert.equal(world.attributes.get('data-color-mode'), 'light');
});

test('a mode that follows the OS under Auto still follows it after a stamped message', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('system', stamp(5));
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  world.env.osDark = true;
  world.handleChromeDarkQueryChange();
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  // With another pref the OS appearance changes nothing.
  world.applyChromeColorMode('light', stamp(6));
  world.handleChromeDarkQueryChange();
  assert.equal(world.attributes.get('data-color-mode'), 'light');
});

test('a malformed direct event is ignored, and a bad stamp is no stamp', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light');
  world.handleUiColorModeSet({});
  world.handleUiColorModeSet({ detail: 'dark' });
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  // A valid mode with a junk stamp applies like an unstamped one: nothing is recorded yet.
  world.handleUiColorModeSet({ detail: { mode: 'dark', stamp: 'x' } });
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
});

// ─── The scheduled flip (ColorStamp.flipAt) ─────────────────────────────────────────────────────

test('a scheduled flip waits for flipAt, then fades once; the late payload agrees', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light', stamp(1));
  world.signal('dark', { ...stamp(2), flipAt: world.at(120) });
  world.advance(119);
  assert.equal(world.attributes.get('data-color-mode'), 'light', 'nothing before flipAt');
  assert.equal(world.attributes.get('data-bento-color-mode-pref'), 'light');
  assert.equal(world.attributes.has(COLOR_FADE), false);

  // The BENTO_PANELS backstop, still before flipAt, carries the same change and the same time.
  world.applyChromeColorMode('dark', { ...stamp(2), flipAt: world.at(1) });
  world.advance(1);
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  assert.equal(world.fadeWrites().length, 1, 'one fade, not two');
  assert.equal(world.notifications.length, 1, 'about:preferences is told once');
  // The fade attribute went on before the mode, in the same task.
  const order = world.writes.map(([name]) => name);
  assert.ok(order.lastIndexOf(COLOR_FADE) < order.lastIndexOf('data-color-mode'));
  world.advance(200);
  assert.equal(world.attributes.has(COLOR_FADE), false);
});

test('a flipAt that has passed, or is absent, applies at once', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light', stamp(1));
  world.signal('dark', { ...stamp(2), flipAt: world.at(0) });
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  world.signal('light', { ...stamp(3), flipAt: world.at(-40) });
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  world.signal('dark', { ...stamp(4), flipAt: 'soon' });
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
});

test('a newer change replaces one that is waiting, and a stale stamp schedules nothing', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light', stamp(1));
  world.signal('dark', { ...stamp(2), flipAt: world.at(120) });
  world.advance(50);

  // Back to light before the first flip showed: it never does.
  world.signal('light', { ...stamp(3), flipAt: world.at(120) });
  world.advance(300);
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  assert.equal(world.fadeWrites().length, 0);

  // Another change replaces a waiting one with its own time.
  world.signal('dark', { ...stamp(4), flipAt: world.at(100) });
  world.signal('dark', { ...stamp(5), flipAt: world.at(150) });
  world.advance(100);
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  world.advance(50);
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  assert.equal(world.fadeWrites().length, 1);

  // A lower seq is dropped before it can schedule or cancel anything.
  world.signal('light', { ...stamp(2), flipAt: world.at(100) });
  world.advance(300);
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
});

test('the first application, a hidden window and an unchanged mode do not wait', () => {
  const world = makeColorWorld();
  // First application in the window: the startup veil is up, so it shows now.
  world.signal('dark', { ...stamp(1), flipAt: world.at(120) });
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  assert.equal(world.timerCount(), 0);

  world.signal('dark', { ...stamp(2), flipAt: world.at(120) });
  assert.equal(world.timerCount(), 0, 'an unchanged mode has nothing to schedule');

  world.env.hidden = true;
  world.signal('light', { ...stamp(3), flipAt: world.at(120) });
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  assert.equal(world.attributes.has(COLOR_FADE), false);
  assert.equal(world.timerCount(), 0);
});

test('reduced motion still waits, then switches without a fade', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light', stamp(1));
  world.env.reducedMotion = true;
  world.signal('dark', { ...stamp(2), flipAt: world.at(120) });
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  world.advance(120);
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  assert.equal(world.fadeWrites().length, 0);
});

test('an OS appearance change under Auto applies at once and replaces a waiting flip', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('system', stamp(1));
  world.signal('dark', { ...stamp(2), flipAt: world.at(120) });
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  // Auto is the pref again (as a later change would set it); the OS flips before flipAt.
  world.signal('system', { ...stamp(3), flipAt: world.at(100) });
  world.env.osDark = true;
  world.handleChromeDarkQueryChange();
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  world.advance(300);
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  assert.equal(world.attributes.has(COLOR_FADE), false);
});

// flipAt is wall-clock time and frame times are monotonic: a step of the system clock after the
// window opened must neither delay nor advance the flip (the deadline is fixed on receipt).
for (const [when, step] of [
  ['before', 60_000],
  ['before', -60_000],
  ['after', 60_000],
  ['after', -60_000],
]) {
  test(`the system clock stepping ${step} ms ${when} the change arrives does not move the flip`, () => {
    const world = makeColorWorld();
    world.applyChromeColorMode('light', stamp(1));
    if (when === 'before') world.env.clockStep += step;
    world.signal('dark', { ...stamp(2), flipAt: world.at(120) });
    world.advance(20);
    if (when === 'after') world.env.clockStep += step;

    world.advance(99);
    assert.equal(world.attributes.get('data-color-mode'), 'light', 'not before 120 ms');
    world.advance(5);
    assert.equal(world.attributes.get('data-color-mode'), 'dark', 'in the first frame after it');
    assert.equal(world.fadeWrites().length, 1);
  });
}

test('a window that hides while it waits applies at once without a fade, and drops its listener', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light', stamp(1));
  world.signal('dark', { ...stamp(2), flipAt: world.at(120) });
  assert.equal(world.visibilityListeners(), 1);
  world.advance(20);
  assert.equal(world.attributes.get('data-color-mode'), 'light');

  // A hidden window gets no frames, so the flip would otherwise wait for the next show.
  world.hide();
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  assert.equal(world.fadeWrites().length, 0);
  assert.equal(world.attributes.has(COLOR_FADE), false);
  assert.equal(world.visibilityListeners(), 0);
  assert.equal(world.timerCount(), 0, 'no timer left to run it again');
  world.advance(300);
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  assert.equal(world.notifications.length, 1, 'about:preferences is told once');
});

test('the visibility listener goes when the flip applies and when a newer call replaces it', () => {
  const world = makeColorWorld();
  world.applyChromeColorMode('light', stamp(1));
  world.signal('dark', { ...stamp(2), flipAt: world.at(120) });
  assert.equal(world.visibilityListeners(), 1);
  world.advance(120);
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
  assert.equal(world.visibilityListeners(), 0);

  world.signal('light', { ...stamp(3), flipAt: world.at(120) });
  assert.equal(world.visibilityListeners(), 1);
  world.signal('dark', { ...stamp(4), flipAt: world.at(120) });
  assert.equal(world.visibilityListeners(), 0, 'dark is already showing: nothing waits');
  world.advance(300);
  assert.equal(world.attributes.get('data-color-mode'), 'dark');
});

test('Auto waiting for its flip follows an OS change that arrives first, and ends on the live value', () => {
  const world = makeColorWorld();
  // Explicit light, the OS dark; the user picks Auto, which resolves to dark and waits.
  world.env.osDark = true;
  world.applyChromeColorMode('light', stamp(1));
  world.signal('system', { ...stamp(2), flipAt: world.at(120) });
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  assert.equal(world.visibilityListeners(), 1);

  // The OS turns light during the wait. The listener registered at load replaces the waiting
  // flip; Auto now resolves to light, which is already showing, so nothing fades.
  world.advance(12);
  world.env.osDark = false;
  world.handleChromeDarkQueryChange();
  assert.equal(world.visibilityListeners(), 0, 'the waiting flip is gone');
  world.advance(300);
  assert.equal(world.attributes.get('data-color-mode'), 'light');
  assert.equal(world.attributes.get('data-bento-color-mode-pref'), 'system');
  assert.equal(world.fadeWrites().length, 0);
  assert.equal(world.notifications.length, 0);
});
