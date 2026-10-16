// The archived motion timing helpers: afterMotion and the workspace-switch fade in the
// archived mount script, and afterTransition in the archived shell (rollbackMotion.ts).
// They carry the same contract as the live helpers (see mount-motion.test.mjs): the LAST
// transition-property entry that names a property decides its timing, only requested
// properties end a wait, and a measured 0 runs the callback before the helper returns.
// The archived mount's workspace fade must also hold layout-transition suppression through
// the fade-in and the reveal layout transitions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archive = resolve(root, 'rollback/legacy-source');
const source = readFileSync(
  resolve(archive, 'src/browser/base/content/bento-shell-mount.js'),
  'utf8',
);

/** Source of a top-level (2-space indented) function in the archived mount script. */
function mountFunction(name) {
  const start = source.indexOf(`\n  function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing`);
  return source.slice(start, source.indexOf('\n  }\n', start) + 5);
}

function mountDeclaration(name) {
  const match = new RegExp(`^ {2}(?:const|let) ${name} = [^;]*;`, 'm').exec(source);
  assert.ok(match, `${name} is missing`);
  return match[0];
}

function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(callback, ms = 0) {
      timers.set(nextId, { callback, due: now + ms });
      return nextId++;
    },
    clearTimeout: (id) => timers.delete(id),
    pending: () => timers.size,
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.due <= target);
        if (due.length === 0) break;
        due.sort((a, b) => a[1].due - b[1].due || a[0] - b[0]);
        const [id, timer] = due[0];
        timers.delete(id);
        now = Math.max(now, timer.due);
        timer.callback();
      }
      now = target;
    },
  };
}

/** An element with the computed longhands the archived helpers read through getPropertyValue. */
class FakeElement {
  listeners = new Map();
  classes = new Set();

  constructor(computed, isConnected = true) {
    const values = {
      'transition-property': 'all',
      'transition-duration': '0s',
      'transition-delay': '0s',
      'animation-name': 'none',
      'animation-duration': '0s',
      'animation-delay': '0s',
      'animation-iteration-count': '1',
      ...computed,
    };
    const style = { getPropertyValue: (name) => values[name] ?? '' };
    this.isConnected = isConnected;
    this.ownerDocument = { defaultView: { getComputedStyle: () => (computed ? style : null) } };
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

// ─── Archived mount script ───────────────────────────────────────────────────

const MOTION_DECLARATIONS = ['MOTION_CEILING_MS', 'MOTION_SLACK_MS', 'pendingMotion'];
const MOTION_FUNCTIONS = [
  'cssTimeMs',
  'motionList',
  'measureMotion',
  'cancelMotion',
  'afterMotion',
  'motionTokenMs',
];

function makeMount(extra = '', globals = {}) {
  const clock = makeClock();
  const tokens = {};
  const frames = [];
  const sandbox = {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    requestAnimationFrame: (callback) => frames.push(callback),
    window: {
      getComputedStyle: () => ({ getPropertyValue: (name) => ` ${tokens[name] ?? ''}` }),
    },
    document: { documentElement: {} },
    console: { warn() {} },
    ...globals,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${MOTION_DECLARATIONS.map(mountDeclaration).join('\n')}
    ${MOTION_FUNCTIONS.map(mountFunction).join('\n')}
    ${extra}`,
    sandbox,
    { filename: 'archived-bento-shell-mount.js#motion' },
  );
  return {
    sandbox,
    clock,
    tokens,
    frames,
    get: (expression) => vm.runInContext(expression, sandbox),
    flushFrames() {
      for (const frame of frames.splice(0)) frame();
    },
  };
}

test('archived measureMotion takes the LAST transition-property entry that names a property', () => {
  const { get } = makeMount();
  const measure = get('measureMotion');
  const allThenOpacity = new FakeElement({
    'transition-property': 'all, opacity',
    'transition-duration': '0.2s, 0s',
  });
  assert.equal(measure(allThenOpacity, { transition: ['opacity'] }).ms, 0);
  const both = measure(allThenOpacity, { transition: ['opacity', 'color'] });
  assert.equal(both.ms, 200);
  assert.deepEqual([...both.ends], ['color']);

  const opacityThenAll = new FakeElement({
    'transition-property': 'opacity, all',
    'transition-duration': '0s, 0.2s',
  });
  assert.equal(measure(opacityThenAll, { transition: ['opacity'] }).ms, 200);
});

test('archived afterMotion runs now at 0 ms, including when the last entry for the property is 0', () => {
  const { get } = makeMount();
  const afterMotion = get('afterMotion');
  const calls = [];
  const zero = new FakeElement({
    'transition-property': 'all, opacity',
    'transition-duration': '0.2s, 0s',
  });
  const cancel = afterMotion(zero, { transition: ['opacity'], key: 'k' }, () => calls.push('zero'));
  assert.deepEqual(calls, ['zero'], 'done ran before afterMotion returned');
  assert.equal(zero.listenerCount(), 0);
  cancel();

  const idle = new FakeElement({});
  afterMotion(idle, { transition: ['opacity'], key: 'k' }, () => calls.push('idle'));
  assert.deepEqual(calls, ['zero', 'idle']);
});

test('an unrelated transitionend does not finish an archived opacity wait', () => {
  const { get, clock } = makeMount();
  const afterMotion = get('afterMotion');
  const calls = [];
  // 'all' ends last, but only the requested property's end may finish the wait.
  const el = new FakeElement({ 'transition-property': 'all', 'transition-duration': '0.2s' });
  afterMotion(el, { transition: ['opacity'], key: 'k' }, () => calls.push('opacity'));
  el.dispatch('transitionend', { propertyName: 'background-color' });
  assert.deepEqual(calls, []);
  el.dispatch('transitionend', { propertyName: 'opacity' });
  assert.deepEqual(calls, ['opacity']);
  assert.equal(el.listenerCount(), 0);
  assert.equal(clock.pending(), 0);

  const timed = new FakeElement({
    'transition-property': 'opacity',
    'transition-duration': '0.12s',
  });
  afterMotion(timed, { transition: ['opacity'], key: 'k' }, () => calls.push('timer'));
  clock.advance(120 + get('MOTION_SLACK_MS') - 1);
  assert.equal(calls.includes('timer'), false);
  clock.advance(1);
  assert.equal(calls.at(-1), 'timer');
});

test('archived afterMotion measures after spec.frames and a later key replaces an earlier wait', () => {
  const { get, flushFrames, clock } = makeMount();
  const afterMotion = get('afterMotion');
  const calls = [];
  const el = new FakeElement({ 'transition-property': 'opacity', 'transition-duration': '0.2s' });
  afterMotion(el, { transition: ['opacity'], key: 'k', frames: 1 }, () => calls.push('first'));
  assert.equal(el.listenerCount(), 0, 'nothing is measured before the frame');
  afterMotion(el, { transition: ['opacity'], key: 'k', frames: 1 }, () => calls.push('second'));
  flushFrames();
  clock.advance(1000);
  assert.deepEqual(calls, ['second']);
});

// ─── Archived workspace-switch fade ──────────────────────────────────────────

const FADE_FUNCTIONS = [
  'getWorkspaceFadeElement',
  'workspaceStabilizeMs',
  'clearWorkspaceFadeClasses',
  'cancelWorkspaceFadeForMainOnly',
  'setWorkspaceFadeClasses',
  'cancelStripScrollMotion',
  'armWorkspaceSwitchFade',
  'performWorkspaceSwitchFade',
];
const FADE_DECLARATIONS = [
  '__workspaceSwitchCancel',
  '__workspaceFadeWatchdog',
  '__workspaceFadeCleanupTimer',
  'WORKSPACE_FADE_WATCHDOG_MS',
  '__workspaceSwitchSwapping',
  '__mainWidthTransitionForNextReconcile',
  '__pendingStripScrollRestore',
];

function makeFade(fadeComputed) {
  const fade = new FakeElement(fadeComputed);
  const reconciles = [];
  const mount = makeMount(
    `${FADE_DECLARATIONS.map(mountDeclaration).join('\n')}
    ${FADE_FUNCTIONS.map(mountFunction).join('\n')}`,
    {
      document: { documentElement: {}, getElementById: () => null },
      reconcilePanels: (panels) => reconciles.push(panels),
      getStripScrollTarget: () => null,
    },
  );
  mount.sandbox.window.gBrowser = { tabpanels: fade };
  mount.tokens['--muxui-semantic-motion-reveal-transition-duration'] = '200ms';
  return { ...mount, fade, reconciles };
}

test('archived workspace stabilization lasts through the reveal layout transitions', () => {
  const { get, clock, fade, flushFrames, reconciles } = makeFade({
    'transition-property': 'opacity',
    'transition-duration': '0.12s',
  });
  get('performWorkspaceSwitchFade')(['panels'], {});
  assert.deepEqual(
    [...fade.classes].sort(),
    ['bento-workspace-stabilizing', 'bento-workspace-switching'],
    'the curtain is up for the fade-out',
  );
  clock.advance(120 + get('MOTION_SLACK_MS'));
  assert.equal(reconciles.length, 1, 'the swap ran behind the fade-out');
  flushFrames();
  assert.deepEqual([...fade.classes], ['bento-workspace-stabilizing']);

  // The 120 ms fade-in ends first; the 200 ms reveal token decides.
  clock.advance(200);
  assert.equal(fade.classes.has('bento-workspace-stabilizing'), true, 'still suppressed at 200 ms');
  clock.advance(get('MOTION_SLACK_MS') - 1);
  assert.equal(fade.classes.has('bento-workspace-stabilizing'), true);
  clock.advance(1);
  assert.equal(fade.classes.has('bento-workspace-stabilizing'), false);
});

test('archived workspace stabilization outlasts a fade longer than the reveal token', () => {
  const { get, clock, fade, flushFrames } = makeFade({
    'transition-property': 'opacity',
    'transition-duration': '0.4s',
  });
  get('performWorkspaceSwitchFade')([], {});
  clock.advance(400 + get('MOTION_SLACK_MS'));
  flushFrames();
  clock.advance(400);
  assert.equal(fade.classes.has('bento-workspace-stabilizing'), true);
  clock.advance(get('MOTION_SLACK_MS'));
  assert.equal(fade.classes.has('bento-workspace-stabilizing'), false);
});

test('cancelling the archived workspace fade clears the stabilize timer and the classes', () => {
  const { get, clock, fade, flushFrames } = makeFade({
    'transition-property': 'opacity',
    'transition-duration': '0.12s',
  });
  get('performWorkspaceSwitchFade')([], {});
  clock.advance(120 + get('MOTION_SLACK_MS'));
  flushFrames();
  get('cancelWorkspaceFadeForMainOnly')();
  assert.equal(fade.classes.size, 0);
  assert.equal(get('__workspaceFadeCleanupTimer'), null);
  assert.equal(clock.pending(), 0, 'no timer is left');
});

test('a zero-length archived fade swaps at once and keeps no stale cancel handle', () => {
  const { get, fade, reconciles } = makeFade({
    'transition-property': 'opacity',
    'transition-duration': '0s',
  });
  get('performWorkspaceSwitchFade')(['panels'], {});
  assert.equal(reconciles.length, 1, 'the swap ran before performWorkspaceSwitchFade returned');
  assert.equal(get('__workspaceSwitchCancel'), null);
  assert.equal(fade.listenerCount(), 0);
});

// ─── Archived shell (rollbackMotion.ts) ──────────────────────────────────────

// The archived shell helper is TypeScript; strip its types and load it as a module.
const { code } = transformSync(
  readFileSync(resolve(archive, 'extensions/bento-shell/src/rollbackMotion.ts'), 'utf8'),
  { loader: 'ts', format: 'esm' },
);
const { afterTransition } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
);

function shellClock() {
  const clock = makeClock();
  globalThis.window = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  return clock;
}

test('afterTransition takes the LAST entry for the property and runs a measured 0 at once', () => {
  shellClock();
  const calls = [];
  const zero = new FakeElement({
    'transition-property': 'all, opacity',
    'transition-duration': '0.2s, 0s',
  });
  const cancel = afterTransition(zero, ['opacity'], () => calls.push('zero'));
  assert.deepEqual(calls, ['zero'], 'done ran before afterTransition returned');
  assert.equal(zero.listenerCount(), 0);
  assert.doesNotThrow(cancel);

  const color = new FakeElement({
    'transition-property': 'all, opacity',
    'transition-duration': '0.2s, 0s',
  });
  afterTransition(color, ['color'], () => calls.push('color'));
  assert.equal(color.listenerCount(), 1, 'color still follows the all entry');
});

test('an unrelated transitionend does not finish an afterTransition wait', () => {
  const clock = shellClock();
  const calls = [];
  const el = new FakeElement({ 'transition-property': 'all', 'transition-duration': '0.2s' });
  afterTransition(el, ['opacity'], () => calls.push('opacity'));
  el.dispatch('transitionend', { propertyName: 'background-color' });
  assert.deepEqual(calls, []);
  el.dispatch('transitionend', { propertyName: 'opacity' });
  assert.deepEqual(calls, ['opacity']);
  assert.equal(el.listenerCount(), 0);
  assert.equal(clock.pending(), 0);
});

test('afterTransition falls back to a timer, replaces a pending wait and can be cancelled', () => {
  const clock = shellClock();
  const calls = [];
  const el = new FakeElement({ 'transition-property': 'opacity', 'transition-duration': '0.12s' });
  afterTransition(el, ['opacity'], () => calls.push('first'));
  afterTransition(el, ['opacity'], () => calls.push('second'));
  assert.equal(el.listenerCount(), 1);
  clock.advance(1000);
  assert.deepEqual(calls, ['second']);

  const cancel = afterTransition(el, ['opacity'], () => calls.push('third'));
  cancel();
  clock.advance(1000);
  assert.deepEqual(calls, ['second']);
  assert.equal(el.listenerCount(), 0);

  const detached = new FakeElement({ 'transition-duration': '1s' }, false);
  afterTransition(detached, ['opacity'], () => calls.push('detached'));
  clock.advance(1199);
  assert.equal(calls.includes('detached'), false);
  clock.advance(1);
  assert.equal(calls.at(-1), 'detached');
});
