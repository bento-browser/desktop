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
