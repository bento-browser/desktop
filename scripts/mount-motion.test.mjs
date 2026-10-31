// The motion timing helpers of bento-shell-mount.js (measureMotion, afterMotion,
// cancelMotion, motionTokenMs). They read how long CSS motion runs from an element's
// computed style so no script mirrors a duration. These tests run the real functions
// against fake elements and fake timers; overlay-surfaces.test.mjs covers them through
// the overlay hides, and extensions/bento-shell/src/motion/afterMotion.test.ts covers the
// shell copy of the same contract. The last tests run the workspace-switch fade that waits
// on them (performWorkspaceSwitchFade) and check its timers and frames stay accounted for.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { splitTopLevelBlocks } from '../extensions/bento-shell/css-blocks.mjs';
import { splitTop, TARGETS } from './fade-twins.mjs';

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

// Native mode transactions are exercised end to end in mode-presentation.test.mjs.
const COLOR_FADE = 'data-bento-mode-fade';

test('mode page holes retain active pages and docked toolboxes but exclude the trailer', () => {
  const page = { id: 'page-browser' }, selected = { id: 'selected-browser' };
  const toolbox = { id: 'docked-toolbox' }, trailerFrame = { id: 'bento-panel-trailer-frame' };
  const slot = (id, browser, active = true) => ({
    id,
    classList: { contains: (name) => active && name === 'split-view-panel-active' },
    querySelector: (selector) => selector === ':scope > browser' ? browser : null,
  });
  const trailer = slot('bento-add-panel-trailer', trailerFrame);
  const inactive = slot('inactive-page', { id: 'inactive-browser' }, false);
  let deck = { children: [slot('page', page), trailer, slot('same-page', page), inactive, {}] };
  const sandbox = {
    document: {
      getElementById(id) { assert.equal(id, 'tabbrowser-tabpanels'); return deck; },
      querySelectorAll(selector) { assert.equal(selector, 'iframe.devtools-toolbox-iframe'); return [toolbox]; },
    },
    window: { gBrowser: { selectedBrowser: selected } },
  };
  const { modePageFrames, getPanelTargetBrowser } = vm.runInNewContext(
    `${mountFunction('getPanelTargetBrowser')}\n${mountFunction('modePageFrames')}\n({ modePageFrames, getPanelTargetBrowser })`,
    sandbox,
  );
  assert.equal(getPanelTargetBrowser(trailer), trailerFrame, 'general browser lookup still includes the trailer');
  assert.deepEqual(Array.from(modePageFrames()), [page, toolbox], 'only live page/toolbox holes, deduplicated');

  deck.children = [trailer, inactive, {}];
  assert.deepEqual(Array.from(modePageFrames()), [selected, toolbox], 'trailer alone does not suppress selected-browser fallback');
  deck = null;
  assert.deepEqual(Array.from(modePageFrames()), [selected, toolbox], 'fallback also works before the deck exists');
  sandbox.window.gBrowser = null;
  assert.deepEqual(Array.from(modePageFrames()), [toolbox], 'an unavailable selected browser leaves only the toolbox');
});

test('the native final writer settles carriers before publishing its granted mode', () => {
  const writes = [], attributes = new Map();
  const root = { style: { removeProperty() {} }, setAttribute(name, value) { attributes.set(name, value); writes.push(name); }, removeAttribute(name) { attributes.delete(name); writes.push('remove:' + name); } };
  const sandbox = {
    document: { documentElement: root, getElementById: () => ({}) },
    window: { getComputedStyle() { assert.equal(attributes.get(COLOR_FADE), 'settle'); writes.push('flush'); return {}; } },
    chromeColorModePref: null, chromeColorStamp: null,
    announceChromeColorMode: () => writes.push('publish'),
  };
  vm.runInNewContext(`${mountFunction('writeGrantedChromeMode')}\nwriteGrantedChromeMode({pref:'system', resolved:'dark',stamp:{run:'owner',seq:2}})`, sandbox);
  assert.ok(writes.indexOf(COLOR_FADE) < writes.indexOf('data-color-mode'));
  assert.ok(writes.lastIndexOf('flush') < writes.indexOf('remove:' + COLOR_FADE));
  assert.equal(writes.at(-1), 'publish');
  assert.equal(attributes.get('data-bento-color-mode-pref'), 'system');
});

// ─── The light/dark flip fade in CSS: the layer it lives in and what it leaves out ──────────────

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readRepo = (path) => readFileSync(resolve(REPO, path), 'utf8');

/** The top-level blocks of a stylesheet whose text mentions the fade attribute. */
function fadeBlocks(path) {
  return splitTopLevelBlocks(readRepo(path)).filter(
    ({ prelude, body }) => prelude.includes(COLOR_FADE) || body.includes(COLOR_FADE),
  );
}

/** Custom properties that the catch-all rule in `body` transitions (not the generated twins after it). */
function transitionedCustomProperties(body) {
  return [...body.split('/* fade-twins:begin')[0].matchAll(/(--[\w-]+) var\(--muxui-semantic-motion-state-transition\)/g)].map(
    (match) => match[1],
  );
}

function registeredColorProperties(paths) {
  const registered = new Set();
  for (const path of paths) {
    for (const match of readRepo(path).matchAll(/@property\s+(--[\w-]+)\s*\{([^}]*)\}/g)) {
      if (/syntax:\s*'<color>'/.test(match[2])) registered.add(match[1]);
    }
  }
  return registered;
}

const CHROME_THEME = 'src/browser/base/content/bento-chrome-theme.css';
const FADE_LAYER = '@layer bento.chrome-theme.fade';
const EXCLUSION_LAYER = '@layer bento.chrome-theme.fade-exclusion';

/** Resolve these generated CSS lists against a nominal Mux state pair, then let the
 * real motion helper apply CSS's last-matching-property timing rules. */
function generatedMotion(target, settle, selector, ownTransition) {
  const css = readRepo(target.sheet).replace(/\/\*[\s\S]*?\*\//g, '');
  const layer = splitTopLevelBlocks(css).find(({ prelude }) => prelude.split(';').pop().trim() === target.layer);
  const blocks = splitTopLevelBlocks(layer.body);
  const rootSelector = settle ? ":root[data-bento-mode-fade='settle']" : ':root[data-bento-mode-fade]';
  const root = blocks.find(({ prelude }) => prelude.trim() === rootSelector);
  const variables = {
    '--muxui-semantic-motion-state-transition': '250ms linear',
    '--muxui-semantic-motion-state-transition-duration': '250ms',
    '--muxui-semantic-motion-state-transition-easing': 'linear',
    '--muxui-semantic-motion-reveal-transition-spring-duration': '400ms',
    '--muxui-semantic-motion-reveal-transition-spring-easing': 'linear',
    '--muxui-semantic-motion-modal-transition': '300ms linear',
    '--bento-mode-fade-delay': '180ms',
  };
  for (const [, name, value] of root.body.matchAll(/(--bento-mode-fade-colours(?:-inherited)?):\s*([^;]+);/g)) variables[name] = value;
  const rule = selector && blocks.find(({ prelude }) => prelude.replace(/\s+/g, ' ').includes(selector));
  let transition = ownTransition ?? /transition:\s*([^;]+);/.exec(rule.body)[1];
  while (transition.includes('var(')) {
    transition = transition.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_match, name) => {
      assert.ok(name in variables, `missing fixture value for ${name}`);
      return variables[name];
    });
  }
  transition = transition.replace(/calc\(\s*([\d.]+)(ms|s)\s*([*/])\s*([\d.]+)\s*\)/g,
    (_match, value, unit, operator, factor) => `${operator === '*' ? Number(value) * Number(factor) : Number(value) / Number(factor)}${unit}`);
  assert.ok(!transition.includes('calc('), 'the fixture resolves every generated time');
  const entries = splitTop(transition.replace(/!important/g, ''), /,/).map((entry) => splitTop(entry, /\s/));
  const times = entries.map((entry) => entry.filter((token) => /^[\d.]+(?:ms|s)$/.test(token)));
  return new FakeElement({
    transitionProperty: entries.map(([property]) => property).join(', '),
    transitionDuration: times.map(([duration]) => duration).join(', '),
    transitionDelay: times.map(([, delay]) => delay ?? '0ms').join(', '),
  });
}

test('settle keeps RowHighlight geometry at 125ms and opacity at 250ms while its colours end immediately', () => {
  const { measureMotion } = makeWorld();
  for (const settle of [false, true]) {
    const row = generatedMotion(TARGETS[1], settle, '[data-bento-mode-fade] .bento-row-highlight[data-highlight-motion]::before');
    for (const property of ['transform', 'block-size', 'inline-size']) {
      assert.equal(measureMotion(row, { properties: [property] }).ms, 125);
    }
    assert.equal(measureMotion(row, { properties: ['opacity'] }).ms, 250);
    assert.equal(measureMotion(row, { properties: ['background-color'] }).ms, settle ? 0 : 430);
  }
});

test('settle preserves rail and overlay motion and overrides a retained all only for colours', () => {
  const { measureMotion } = makeWorld();
  for (const settle of [false, true]) {
    const footer = generatedMotion(TARGETS[1], settle, 'html[data-bento-mode-fade][data-bento-rail-transition] .bento-shell-app__footer');
    assert.equal(measureMotion(footer, { properties: ['--bento-footer-fill'] }).ms, settle ? 0 : 400);
    const grow = generatedMotion(TARGETS[1], settle, '[data-bento-mode-fade] .bento-address-bar__shadow[data-bento-grow=');
    assert.equal(measureMotion(grow, { properties: ['transform'] }).ms, 400);
    assert.equal(measureMotion(grow, { properties: ['opacity'] }).ms, 400);
    const chromeRail = generatedMotion(TARGETS[0], settle, '#bento-shell-host.bento-sidebar-hidden');
    assert.equal(measureMotion(chromeRail, { properties: ['transform'] }).ms, 400);
    const overlay = generatedMotion(TARGETS[0], settle, '[data-bento-mode-fade] #bento-palette-host');
    assert.equal(measureMotion(overlay, { properties: ['opacity'] }).ms, 300);
    for (const target of TARGETS) {
      const all = generatedMotion(target, settle, null, 'all 125ms linear 75ms, var(--bento-mode-fade-colours)');
      assert.equal(measureMotion(all, { properties: ['transform'] }).ms, 200);
      assert.equal(measureMotion(all, { properties: ['opacity'] }).ms, 200);
      assert.equal(measureMotion(all, { properties: ['background-color'] }).ms, settle ? 0 : 430);
    }
  }
});

test('the chrome fade rule is layered, so no unlayered transition: none !important beats it', () => {
  // Among important declarations an unlayered one is the weakest: bento-shell-mount.css
  // switches transitions off for the bookmarks toolbar, the import handoff, live resize and a
  // workspace switch, and Firefox's own ID selectors do the same. Outside a layer the fade
  // would lose to all of them and those surfaces would step to the new colours.
  const blocks = fadeBlocks(CHROME_THEME);
  assert.deepEqual(
    blocks.map(({ prelude }) => prelude),
    [FADE_LAYER, EXCLUSION_LAYER],
    'the catch-all and the exclusion, each in its own sublayer',
  );
  const mountCss = readRepo('src/browser/base/content/bento-shell-mount.css');
  assert.ok(!mountCss.includes(COLOR_FADE), 'the fade is one rule, in bento-chrome-theme.css');
});

test('the chrome fade sublayers rank before the layer\'s own rules, the exclusion first', () => {
  // Among important declarations the earlier layer wins, and a nested layer ranks before the
  // rules of the layer that contains it. So the exclusion beats the catch-all, which beats every
  // `transition ... !important` that bento.chrome-theme declares itself whatever its specificity
  // (the Customize Toolbar buttons, an ID selector, out-rank a (0,2,0) catch-all in one layer).
  const css = readRepo(CHROME_THEME);
  const order = /^@layer bento\.chrome-theme\.fade-exclusion,\s*bento\.chrome-theme\.fade;$/m.exec(css);
  assert.ok(order, 'the order statement names the exclusion first, then the catch-all');
  const firstLayer = css.indexOf('@layer bento.chrome-theme {');
  assert.ok(firstLayer > order.index, 'the sublayers are ordered before the layer\'s own block');
  assert.ok(
    !css.slice(0, order.index).includes('@layer bento.chrome-theme.'),
    'nothing names a sublayer before the order statement',
  );
});

test('every important transition of the chrome sheets is where the fade out-ranks it', () => {
  // A census of the `transition ... !important` declarations in the two chrome sheets: each is
  // unlayered or in bento.chrome-theme itself (its direct rules rank after the fade sublayers),
  // or it is the fade's own. A declaration in any other layer could rank before the fade.
  const OWN = new Set(['@layer bento.chrome-theme', FADE_LAYER, EXCLUSION_LAYER]);
  const important = /transition(?:-property|-duration|-delay)?\s*:[^;{}]*!important/;
  let found = 0;
  for (const path of [CHROME_THEME, 'src/browser/base/content/bento-shell-mount.css']) {
    for (const block of splitTopLevelBlocks(readRepo(path))) {
      // A statement before the block (an order statement) is part of the prelude text.
      const prelude = block.prelude.split(';').pop().trim();
      if (!prelude.startsWith('@layer')) continue;
      if (important.test(block.body)) {
        found += 1;
        assert.ok(OWN.has(prelude), `${path}: an important transition in ${prelude}`);
      }
    }
  }
  assert.ok(found >= 2, 'the census found the chrome theme layers');
  // The Customize Toolbar buttons are the same-layer case the sublayers exist for.
  const chrome = splitTopLevelBlocks(readRepo(CHROME_THEME)).filter(
    ({ prelude }) => prelude.split(';').pop().trim() === '@layer bento.chrome-theme',
  );
  assert.ok(chrome.some(({ body }) => /#customization-done-button[\s\S]*?transition[^;]*!important/.test(body)));
});

test('the chrome fade skips the hidden tab strip and background tab panels', () => {
  // Their cost grows with the tab count and nothing in them paints: 200 tabs started about
  // 3000 transitions, 2900 of them invisible, and each fade frame took 25 to 60 ms.
  const layer = fadeBlocks(CHROME_THEME).find(({ prelude }) => prelude === EXCLUSION_LAYER);
  assert.ok(layer, 'the exclusion sublayer is missing');
  const body = layer.body;
  const skipped = splitTopLevelBlocks(body).filter(
    ({ prelude, body: rule }) =>
      prelude.includes('#tabbrowser-tabs') && /transition:\s*none\s*!important/.test(rule),
  );
  assert.equal(skipped.length, 1, 'one rule lists the skipped subtrees');
  const selectors = skipped[0].prelude.split(/,\s*:root/);
  assert.equal(selectors.length, 6, 'the subtrees, their pseudo-elements and descendants');
  // split-view-panel-active is the class forceSubPanelBrowserPaint adds to a panel it makes visible
  // without Firefox's own classes: such a panel keeps the fade too.
  assert.match(
    skipped[0].prelude,
    /\.browserSidebarContainer:not\(\.split-view-panel,\s*\.split-view-panel-active,\s*\.deck-selected\)/,
  );
  // The tab strip is only skipped while Bento hides it; a profile that shows it keeps the fade.
  assert.match(skipped[0].prelude, /#navigator-toolbox\[tabs-hidden\] #tabbrowser-tabs/);
  // The selected tab's panel and the split view's panels keep their transitions.
  assert.ok(!skipped[0].prelude.includes('#tabbrowser-tabpanels,'));
});

test('the shell fade rule is in the first bento layer', () => {
  // The rail choreography has layered `transition: none !important` rows and a switcher. The
  // earliest layer wins among important declarations, so the fade is declared in the first of
  // the bento sub-layers in muxui.css's order statement.
  const order = readRepo('extensions/bento-shell/src/theme/muxui.css').match(
    /^@layer (bento\.[^;]*);$/m,
  );
  assert.ok(order, 'the layer order statement is missing');
  assert.equal(order[1].split(',')[0].trim(), 'bento.mode-fade');
  const blocks = fadeBlocks('extensions/bento-shell/src/theme/document-base.css');
  assert.ok(blocks.length > 0 && blocks.every(({ prelude }) => prelude === '@layer bento.mode-fade'));
});

test('every custom property the fade transitions is a registered <color>', () => {
  // A gradient stop over an unregistered custom property cannot interpolate, so a custom
  // property in the fade list that is not registered would silently do nothing.
  const cases = [
    {
      sheet: 'src/browser/base/content/bento-chrome-theme.css',
      registrations: ['src/browser/base/content/bento-shell-mount.css'],
      expected: [
        '--bento-toolbar-left-bg',
        '--bento-toolbar-right-bg',
        '--bento-splitter-accent',
        '--bento-placeholder-fg',
        '--bento-arrow-fill',
      ],
    },
    {
      sheet: 'extensions/bento-shell/src/theme/document-base.css',
      registrations: [
        'extensions/bento-shell/src/app.css',
        'extensions/bento-shell/src/components/TabList/TabList.css',
        'extensions/bento-shell/src/components/SettingsPalette/SettingsPalette.css',
        'extensions/bento-shell/src/components/WorkspaceThemePicker/WorkspaceThemePicker.css',
        'extensions/bento-shell/src/theme/document-base.css',
      ],
      expected: [
        '--bento-corner-fill',
        '--bento-private-band-fill',
        '--bento-search-result-actions-bg',
        '--bento-switch-hover-tint',
        '--bento-placeholder-fg',
        '--bento-card-tint',
      ],
    },
  ];
  for (const { sheet, registrations, expected } of cases) {
    const listed = fadeBlocks(sheet).flatMap(({ body }) => transitionedCustomProperties(body));
    assert.deepEqual(listed, expected, `${sheet} fades these custom properties`);
    const registered = registeredColorProperties(registrations);
    for (const name of listed) assert.ok(registered.has(name), `${name} is not a registered <color>`);
  }
});

test('a gradient stop over a custom property is a registered <color> or a known length', () => {
  // A gradient stop over an unregistered custom property takes the new mode at once, while the
  // surface it sits on fades (the search result actions backing and Mux's hovered switch tint were
  // found this way). A new colour stop must be registered and listed in the fade; a length is fine.
  const LENGTHS = new Set([
    '--bento-sidebar-corner-radius',
    '--bento-tab-row-actions-width',
    '--bento-tab-row-actions-fade',
    '--bento-toolbar-divider-x',
    '--bento-splitter-indicator-radius',
    '--space-xs',
  ]);
  const files = [];
  const walk = (dir, filter) => {
    for (const entry of readdirSync(resolve(REPO, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path, filter);
      else if (path.endsWith('.css') && filter(path)) files.push(path);
    }
  };
  walk('extensions/bento-shell/src', (path) => !path.includes('/theme/presets/'));
  // The embedded import host never changes mode while it is open (theming.md).
  walk('src/browser/base/content', (path) => /bento-shell-mount\.css|bento-chrome-theme\.css/.test(path));
  const registered = registeredColorProperties(files);
  const offenders = [];
  for (const file of files) {
    const css = readRepo(file);
    for (const match of css.matchAll(/(?:linear|radial|conic)-gradient\(/g)) {
      let depth = 1;
      let end = match.index + match[0].length;
      while (depth > 0 && end < css.length) {
        if (css[end] === '(') depth += 1;
        else if (css[end] === ')') depth -= 1;
        end += 1;
      }
      for (const read of css.slice(match.index, end).matchAll(/var\((--[\w-]+)/g)) {
        if (!registered.has(read[1]) && !LENGTHS.has(read[1])) offenders.push(`${file}: ${read[1]}`);
      }
    }
  }
  assert.deepEqual([...new Set(offenders)], []);
  // The two stops added with the fade read their carriers, not the custom property they copy.
  assert.match(readRepo('extensions/bento-shell/src/components/TabList/TabList.css'), /var\(--bento-search-result-actions-bg\) var\(--space-xs\)/);
  assert.match(readRepo('extensions/bento-shell/src/components/SettingsPalette/SettingsPalette.css'), /linear-gradient\(var\(--bento-switch-hover-tint\), var\(--bento-switch-hover-tint\)\)/);
});

test('every entry of the fade rule reads the registered delay that holds a prepared flip', () => {
  // The prepared flip (modeFade.ts, prepareChromeColorFlip) shows its fade at flipAt through
  // --bento-mode-fade-delay on <html>. An entry without it would start at once; an unregistered
  // property would leave the whole transition invalid when the property is not set.
  const sheets = [
    'src/browser/base/content/bento-chrome-theme.css',
    'extensions/bento-shell/src/theme/document-base.css',
  ];
  for (const sheet of sheets) {
    const css = readRepo(sheet);
    assert.match(
      css,
      /@property\s+--bento-mode-fade-delay\s*\{[^}]*syntax:\s*'<time>'[^}]*initial-value:\s*0s/,
      `${sheet} registers the delay as a <time> that starts at 0s`,
    );
    const block = fadeBlocks(sheet).find(({ body }) => body.includes('transition:'));
    const entries = block.body
      .split('transition:')[1]
      .split('!important')[0]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    assert.ok(entries.length > 8, `${sheet} lists the colour properties`);
    for (const entry of entries) {
      assert.match(
        entry,
        /^[\w-]+ var\(--muxui-semantic-motion-state-transition\) var\(--bento-mode-fade-delay\)$/,
        `${sheet}: ${entry}`,
      );
    }
  }
});

// ─── The favicon navigator keeps its buttons, and so their running colour fades ─────────────────

/** A strip of named fake nodes that records which of them insertBefore moved. */
function fakeNavStrip(names) {
  const nodes = names.map((name) => ({ name }));
  const strip = {
    nodes,
    moves: [],
    get children() {
      return [...nodes];
    },
    insertBefore(node, reference) {
      const from = nodes.indexOf(node);
      if (from !== -1) nodes.splice(from, 1);
      nodes.splice(reference ? nodes.indexOf(reference) : nodes.length, 0, node);
      strip.moves.push(node.name);
    },
  };
  for (const node of nodes) {
    Object.defineProperty(node, 'nextElementSibling', {
      get: () => nodes[nodes.indexOf(node) + 1] ?? null,
    });
  }
  return strip;
}

test('a navigator reconcile moves only the buttons that are out of place', () => {
  // Removing and inserting a node again cancels its running transitions, which cut a mode flip's
  // fade short on every icon (the BENTO_PANELS payload reconciles inside the flip's lead).
  const placeInOrder = vm.runInNewContext(`(${mountFunction('placeInOrder').trim()})`);
  const by = (strip, ...names) =>
    names.map((name) => strip.nodes.find((node) => node.name === name));

  const same = fakeNavStrip(['main', 'a', 'b']);
  placeInOrder(same, by(same, 'main', 'a', 'b'));
  assert.deepEqual(same.moves, [], 'a strip already in order is left alone');

  const added = fakeNavStrip(['main', 'a']);
  const fresh = { name: 'b', nextElementSibling: null };
  placeInOrder(added, [...by(added, 'main', 'a'), fresh]);
  assert.deepEqual(added.moves, ['b']);
  assert.deepEqual(
    added.nodes.map((node) => node.name),
    ['main', 'a', 'b'],
  );

  const swapped = fakeNavStrip(['main', 'a', 'b', 'c']);
  placeInOrder(swapped, by(swapped, 'main', 'c', 'a', 'b'));
  assert.deepEqual(
    swapped.nodes.map((node) => node.name),
    ['main', 'c', 'a', 'b'],
  );
  assert.deepEqual(swapped.moves, ['c'], 'only the button that jumped moves');

  // The drop indicator is not a button: it stays where it is and the buttons keep their order.
  const dragging = fakeNavStrip(['main', 'a', 'indicator']);
  placeInOrder(dragging, by(dragging, 'a', 'main'));
  assert.deepEqual(
    dragging.nodes.filter((node) => node.name !== 'indicator').map((node) => node.name),
    ['a', 'main'],
  );
});

// ─── The mount's reconcilers keep the nodes that are still wanted ────────────────────────────────
//
// A node that is removed and inserted (or built) again has no style to transition from, so a
// reconcile that rebuilds on every BENTO_PANELS payload makes its colours jump to the target of a
// mode flip that is only being prepared. These run the real reconcilers on a small fake DOM and
// check node identity and the DOM operations performed.

/** A DOM node with a child list, a log of the insertions and removals it saw, and a style bag. */
class FakeNode {
  constructor(localName = 'div') {
    this.localName = localName;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.attrs = new Map();
    this.classes = new Set();
    this.listeners = [];
    this.style = {
      setProperty(name, value) {
        this[name] = value;
      },
      removeProperty(name) {
        delete this[name];
      },
    };
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name),
    };
    this.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this.classes].join(' ');
  }

  get nextElementSibling() {
    const siblings = this.parentNode?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  getAttribute(name) {
    return this.attrs.get(name) ?? null;
  }

  addEventListener() {}

  getBoundingClientRect() {
    return this.rect;
  }

  appendChild(node) {
    return this.insertBefore(node, null);
  }

  insertBefore(node, reference) {
    node.#detach(false);
    const index = reference ? this.children.indexOf(reference) : this.children.length;
    this.children.splice(index, 0, node);
    node.parentNode = this;
    this.#log('insert', node);
    return node;
  }

  remove() {
    this.#detach(true);
  }

  #detach(logIt) {
    const parent = this.parentNode;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    this.parentNode = null;
    if (logIt) parent.#log('remove', this);
  }

  /** The operations on this node's child list, in order, as [kind, node]. */
  ops = [];

  #log(kind, node) {
    this.ops.push([kind, node]);
  }

  /** `:scope > .a, :scope > .b` over the children, which is all the mount asks of a list. */
  querySelectorAll(selector) {
    const names = [...selector.matchAll(/:scope > \.([\w-]+)/g)].map((match) => match[1]);
    return this.children.filter((child) => names.some((name) => child.classes.has(name)));
  }
}

test('an unchanged payload keeps every layout splitter and chooser, and what they carry', () => {
  const host = new FakeNode();
  const sidebar = new FakeNode();
  sidebar.rect = { left: -500, top: 0, right: -400, bottom: 10, width: 100, height: 10 };
  const tabpanels = new FakeNode();
  const saved = [{ title: 'Docs', url: 'https://example.test/docs', favIconUrl: '' }];
  const sandbox = {
    document: {
      getElementById: (id) => ({ 'bento-side-panel-host': host, 'bento-shell-host': sidebar })[id] ?? null,
      createXULElement: (name) => new FakeNode(name),
      createElementNS: (_ns, name) => new FakeNode(name),
    },
    HTML_NS: 'html',
    ICONS: { x: 'x' },
    makeIcon: () => new FakeNode('svg'),
    dispatchShellAction: () => {},
    focusPanelCycleTarget: () => {},
  };
  const names = [
    'placeInOrder',
    'layoutChooserSignature',
    'syncFlatLayoutOverlays',
    'viewportRectForLayoutRect',
    'rectOverlapsBentoSidebar',
    'setSidebarOccludedOverlayState',
    'createLayoutSplitter',
    'createSubdivisionChooser',
    'createSavedPanelPlaceholder',
  ];
  const api = vm.runInNewContext(
    `"use strict";
    let currentSavedPanelItems = [];
    ${names.map(mountFunction).join('\n')}
    ({ ${names.join(', ')}, setSaved: (items) => { currentSavedPanelItems = items; } });`,
    sandbox,
    { filename: 'bento-shell-mount.js#overlays' },
  );
  api.setSaved(saved);
  const rect = (left, top, width, height) => ({ left, top, width, height });
  const geometry = (overrides = {}) => ({
    splitters: [
      { axis: 'vertical', groupId: 'g1', rect: rect(10, 100, 300, 6), groupRect: rect(10, 0, 300, 400) },
      { axis: 'horizontal', groupId: 'g2', rect: rect(400, 0, 6, 300), groupRect: rect(400, 0, 300, 300) },
      { axis: 'vertical', groupId: 'g3', rect: rect(400, 320, 300, 6), groupRect: rect(400, 300, 300, 200) },
    ],
    choosers: [{ id: 'c1', ownerTabId: 7, groupId: 'g1', rect: rect(10, 110, 300, 290) }],
    ...overrides,
  });
  const sync = (g) => api.syncFlatLayoutOverlays(tabpanels, g);
  const overlays = () => [...host.children];

  sync(geometry());
  const [vsplit, hsplit, vsplit3, chooser] = overlays();
  assert.equal(new Set(overlays()).size, 4, 'two splitters of one axis are two nodes');
  assert.deepEqual(
    overlays().map((node) => node.classes.has('bento-layout-chooser')),
    [false, false, false, true],
    'splitters first, then choosers',
  );
  vsplit.hover = 'running transition';
  chooser.hover = 'running transition';
  const opsBefore = host.ops.length;

  // The same payload again, as every BENTO_PANELS payload, scroll and layout refresh sends it.
  sync(geometry());
  sync(geometry());
  assert.deepEqual(overlays(), [vsplit, hsplit, vsplit3, chooser], 'the same nodes');
  assert.equal(host.ops.length, opsBefore, 'nothing was removed, built or inserted');
  assert.equal(vsplit.hover, 'running transition');
  assert.equal(chooser.hover, 'running transition');

  // New geometry updates the same nodes in place.
  sync(geometry({ splitters: [{ axis: 'vertical', groupId: 'g1', rect: rect(10, 150, 300, 6), groupRect: rect(10, 0, 300, 400) }, ...geometry().splitters.slice(1)] }));
  assert.deepEqual(overlays(), [vsplit, hsplit, vsplit3, chooser]);
  assert.equal(vsplit.style.top, '150px');
  assert.equal(host.ops.length, opsBefore);

  // A saved panel appears: the chooser shows it, so that one node is replaced, nothing else.
  api.setSaved([...saved, { title: 'Mail', url: 'https://example.test/mail', favIconUrl: '' }]);
  sync(geometry());
  const [vsplit2, hsplit2, vsplit3b, chooser2] = overlays();
  assert.equal(vsplit3b, vsplit3);
  assert.equal(vsplit2, vsplit);
  assert.equal(hsplit2, hsplit);
  assert.notEqual(chooser2, chooser, 'the chooser has new content');
  assert.equal(chooser.parentNode, null);

  // A splitter goes and a chooser comes: only those change, the survivors are not moved.
  const opsMid = host.ops.length;
  sync(
    geometry({
      splitters: [geometry().splitters[0], geometry().splitters[2]],
      choosers: [
        { id: 'c1', ownerTabId: 7, groupId: 'g1', rect: rect(10, 110, 300, 290) },
        { id: 'c2', ownerTabId: 8, groupId: null, rect: rect(400, 0, 300, 300) },
      ],
    }),
  );
  assert.equal(hsplit.parentNode, null);
  assert.deepEqual(overlays().slice(0, 3), [vsplit, vsplit3, chooser2], 'survivors keep their place');
  assert.equal(overlays()[3].getAttribute('data-bento-chooser-id'), 'c2');
  assert.deepEqual(
    host.ops.slice(opsMid).map(([kind]) => kind),
    ['remove', 'insert'],
    'one removal, one insertion',
  );

  // Something else in the host between payloads does not make the overlays move.
  const foreign = new FakeNode('div');
  host.insertBefore(foreign, host.children[1]);
  const opsForeign = host.ops.length;
  sync(
    geometry({
      splitters: [geometry().splitters[0], geometry().splitters[2]],
      choosers: [
        { id: 'c1', ownerTabId: 7, groupId: 'g1', rect: rect(10, 110, 300, 290) },
        { id: 'c2', ownerTabId: 8, groupId: null, rect: rect(400, 0, 300, 300) },
      ],
    }),
  );
  assert.equal(host.ops.length, opsForeign, 'no overlay moved around the foreign node');
});

test('the inline toolbar gradient reads the registered left and right stops', () => {
  // The writer is nested in attachSidebarChromeDivider, so its source is read: the gradient it
  // builds must use the registered <color> stops that a mode flip fades through.
  const start = source.indexOf("'linear-gradient(to right, '");
  assert.notEqual(start, -1, 'the writer builds the gradient');
  const gradient = source.slice(start, source.indexOf(';', source.indexOf("100%)'", start)));
  assert.deepEqual(
    [...gradient.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1]),
    ['--bento-toolbar-left-bg', '--bento-toolbar-left-bg', '--bento-toolbar-right-bg', '--bento-toolbar-right-bg'],
  );
  assert.equal(source.match(/linear-gradient\(/g)?.length, 1, 'one place builds the gradient');
  const css = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../src/browser/base/content/bento-shell-mount.css'),
    'utf8',
  );
  for (const stop of ['--bento-toolbar-left-bg', '--bento-toolbar-right-bg']) {
    assert.match(css, new RegExp(`@property ${stop} \\{[^}]*syntax: '<color>'`), stop);
  }
});

test('refreshPanelNav keeps the navigator buttons of repeated payloads, and moves only what changed', () => {
  const list = new FakeNode();
  list.classes.add('bento-panel-nav__list');
  let menuCloses = 0;
  const frames = [];
  const sandbox = {
    document: { querySelector: (selector) => (selector === '.bento-panel-nav__list' ? list : null) },
    requestAnimationFrame: (callback) => frames.push(callback),
    hidePanelNavContextMenu: () => {
      menuCloses += 1;
    },
    uniqueRootPanels: (panels) => panels,
    getPanelPayloadByTabIdForNav: () => new Map(),
    stopPanelNavAudioEmitter: () => {},
    getMainPanelTooltipLabel: () => 'Main',
    getMainTabFavicon: () => '',
    syncPanelNavAudioParticles: () => {},
    isMainTabAudioPlaying: () => false,
    getPanelNavSignature: (panel) => `sig:${panel.tabId}`,
    getPanelNavInfo: (panel) => ({ isGrouped: false, tabId: panel.tabId, title: `Tab ${panel.tabId}` }),
    updatePanelNavButton: () => true,
    buildNavIcon: () => new FakeNode('button'),
    buildGroupedNavIcon: () => new FakeNode('button'),
    syncPanelNavDiscardedClass: () => {},
    syncPanelNavAudioClass: () => {},
    getPanelCycleTargets: () => [],
    applyActiveMarker: () => {},
  };
  const { refreshPanelNav, placeInOrder } = vm.runInNewContext(
    `"use strict";
    let currentActiveIdx = 0;
    ${['placeInOrder', 'refreshPanelNav'].map(mountFunction).join('\n')}
    ({ refreshPanelNav, placeInOrder });`,
    sandbox,
    { filename: 'bento-shell-mount.js#nav' },
  );
  assert.equal(typeof placeInOrder, 'function');
  const panel = (tabId) => ({ tabId, rootNodeId: `panel:${tabId}` });
  const buttons = () => [...list.children];

  refreshPanelNav([panel(1), panel(2), panel(3)]);
  const [main, one, two, three] = buttons();
  assert.deepEqual(
    buttons().map((node) => node.dataset.bentoNavKey),
    ['main', 'panel:1', 'panel:2', 'panel:3'],
  );
  const opsBuilt = list.ops.length;

  // The BENTO_PANELS payload that follows a mode flip's direct event carries the same panels.
  refreshPanelNav([panel(1), panel(2), panel(3)]);
  refreshPanelNav([panel(1), panel(2), panel(3)]);
  assert.deepEqual(buttons(), [main, one, two, three], 'the same buttons');
  assert.equal(list.ops.length, opsBuilt, 'no button was removed or inserted again');
  assert.equal(menuCloses, 3);

  // A panel moves: only that button is inserted again.
  refreshPanelNav([panel(3), panel(1), panel(2)]);
  assert.deepEqual(buttons(), [main, three, one, two]);
  assert.equal(list.ops.length, opsBuilt + 1);

  // A panel goes: that button is removed, the others stay where they are.
  refreshPanelNav([panel(3), panel(2)]);
  assert.deepEqual(buttons(), [main, three, two]);
  assert.equal(list.ops.length, opsBuilt + 2);
  assert.equal(one.parentNode, null);
});
