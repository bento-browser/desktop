// The BentoKey content-key bridge: the registration and the key press tokens in
// bento-shell-mount.js, and both actors, run against stubs of the Firefox globals they use.
// The child runs in untrusted web content processes, so a message must never cycle panels
// on its own: chrome cycles only by consuming a trusted keydown it saw for that <browser>.
// Key routing itself is proven in a built browser (docs/technical/panel-traversal-focus.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MOUNT = readFileSync(resolve(ROOT, 'src/browser/base/content/bento-shell-mount.js'), 'utf8');

const source = (file) =>
  readFileSync(resolve(ROOT, 'src/browser/actors', file), 'utf8').replaceAll(/^export /gm, '');

/** A window with a main tab browser, a panel browser, a Bento chrome frame and a frame that is neither. */
function world() {
  const events = [];
  const warnings = [];
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  const win = { CustomEvent, dispatchEvent: (e) => events.push([e.type, e.detail]) };
  const doc = { defaultView: win };
  const otherWin = { CustomEvent, dispatchEvent: () => events.push(['other window']) };
  const browser = (owner = doc) => ({ ownerDocument: owner });
  const browsers = { main: browser(), panel: browser(), shellFrame: browser(), otherFrame: browser(), otherWindow: browser({ defaultView: otherWin }) };
  const tabs = new Set([browsers.main, browsers.panel]);
  win.gBrowser = { getTabForBrowser: (b) => (tabs.has(b) ? {} : null) };
  const top = (embedder, addonId = '', topWin = win) => {
    const bc = { topChromeWindow: topWin, embedderElement: embedder };
    bc.top = bc;
    bc.currentWindowGlobal = { documentPrincipal: { addonId } };
    bc.child = () => ({ topChromeWindow: topWin, top: bc });
    return bc;
  };
  const context = vm.createContext({ JSWindowActorParent: class {}, console: { warn: (...args) => warnings.push(args) } });
  vm.runInContext(source('BentoKeyParent.sys.mjs') + '\nthis.BentoKeyParent = BentoKeyParent;', context);
  const actorFor = (bc, { current = true } = {}) =>
    Object.assign(new context.BentoKeyParent(), { browsingContext: bc, manager: { isCurrentGlobal: current } });
  return { events, warnings, browsers, top, actorFor };
}

function loadChild() {
  const sent = [];
  const context = vm.createContext({
    JSWindowActorChild: class {
      sendAsyncMessage(name, data) {
        sent.push([name, JSON.parse(JSON.stringify(data))]);
      }
    },
  });
  vm.runInContext(source('BentoKeyChild.sys.mjs') + '\nthis.BentoKeyChild = BentoKeyChild;', context);
  return { child: new context.BentoKeyChild(), sent };
}

/** A Cmd+Shift+Arrow keydown (or another chord through `over`) on `target`. */
function key(target, over = {}) {
  return {
    type: 'keydown',
    key: 'ArrowRight',
    code: 'ArrowRight',
    metaKey: true,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    isTrusted: true,
    defaultPrevented: false,
    target,
    getModifierState(name) {
      return name === 'Accel' && (this.metaKey || this.ctrlKey);
    },
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    ...over,
  };
}

/** The mount script's press-token block in a chrome window stub with a controllable clock. */
function mountBridge() {
  const block = MOUNT.slice(
    MOUNT.indexOf('  // Real key presses that BentoKeyParent may turn into a panel cycle.'),
    MOUNT.indexOf('  // Click-into-panel needs to update currentActiveIdx'),
  );
  const listeners = new Map();
  const cycles = [];
  const clock = { now: 1000 };
  const window = {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  const api = vm.runInNewContext(`${block}\n;({ attachContentKeyBridgeListener, CONTENT_KEY_PRESS_MAX_AGE_MS })`, {
    window,
    performance: { now: () => clock.now },
    navigatePanels: (dir) => cycles.push(dir),
  });
  api.attachContentKeyBridgeListener();
  const fire = (type, event) => {
    for (const listener of listeners.get(type) ?? []) listener({ type, ...event });
  };
  const browser = (localName = 'browser') => ({ localName });
  return {
    cycles,
    clock,
    maxAge: api.CONTENT_KEY_PRESS_MAX_AGE_MS,
    browser,
    press: (target, over) => fire('keydown', key(target, over)),
    message: (target, direction) => fire('BentoKey:Cycle', { detail: { direction, browser: target } }),
  };
}

test('BentoKey is registered for untrusted web and file processes', () => {
  const block = /registerWindowActor\('BentoKey', \{[\s\S]*?\n {6}\}\);/.exec(MOUNT)?.[0];
  assert.ok(block, 'registerContentKeyActor registers BentoKey');
  assert.match(block, /^\s*safeForUntrustedWebProcess: true,$/m);
  assert.match(block, /'\*:\/\/\*\/\*', 'file:\/\/\/\*'/);
});

test('a Cycle message cycles only by consuming a real press for its <browser>', () => {
  const m = mountBridge();
  const main = m.browser();
  const panel = m.browser();
  m.message(main, 1);
  assert.deepEqual(m.cycles, [], 'no press');
  m.press(main);
  m.message(panel, 1);
  assert.deepEqual(m.cycles, [], 'press went to another browser');
  m.message(main, -1);
  assert.deepEqual(m.cycles, [], 'press of the other direction');
  m.message(main, 1);
  assert.deepEqual(m.cycles, [1], 'matching press');
  m.message(main, 1);
  assert.deepEqual(m.cycles, [1], 'a press is consumed once');
  m.press(main, { key: 'ArrowLeft' });
  m.clock.now += m.maxAge + 1;
  m.message(main, -1);
  assert.deepEqual(m.cycles, [1], 'stale press');
  m.press(main, { isTrusted: false });
  m.press(main, { isReplyEventFromRemoteContent: true });
  m.press(main, { shiftKey: false });
  m.press(main, { altKey: true });
  m.press(main, { metaKey: true, ctrlKey: true });
  m.press(main, { metaKey: false });
  m.press(main, { key: 'ArrowUp' });
  m.press(m.browser('vbox'));
  m.message(main, 1);
  assert.deepEqual(m.cycles, [1], 'untrusted, content replies, other chords and non-browser targets leave no press');
  m.press(main);
  m.press(main);
  m.message(main, 1);
  m.message(main, 1);
  m.message(main, 1);
  assert.deepEqual(m.cycles, [1, 1, 1], 'two presses (or key repeats), two cycles');
  m.message(null, 1);
  m.message(main, 2);
  assert.deepEqual(m.cycles, [1, 1, 1]);
});

test('BentoKeyParent passes on only a Cycle of 1 or -1, with the sender browser', () => {
  const w = world();
  const actor = w.actorFor(w.top(w.browsers.main));
  actor.receiveMessage({ name: 'BentoKey:Cycle', data: { direction: 1 } });
  actor.receiveMessage({ name: 'BentoKey:Cycle', data: { direction: -1 } });
  for (const data of [undefined, null, {}, { direction: 2 }, { direction: '1' }, { direction: 0 }, { direction: NaN }]) {
    actor.receiveMessage({ name: 'BentoKey:Cycle', data });
  }
  for (const name of ['BentoKey:PanelHistory', 'BentoKey:AddrbarOpen', 'BentoKey:Other']) {
    actor.receiveMessage({ name, data: { direction: 1, mode: 'newTab' } });
  }
  // The detail is made in the actor's realm: compare its fields.
  assert.deepEqual(
    w.events.map(([type, detail]) => [type, detail.direction, detail.browser === w.browsers.main]),
    [
      ['BentoKey:Cycle', 1, true],
      ['BentoKey:Cycle', -1, true],
    ],
  );
  assert.deepEqual(w.warnings, []);
});

test('BentoKeyParent passes on only a current document of a tab or Bento frame of its window', () => {
  const w = world();
  const send = (bc, options) => {
    const before = w.events.length;
    w.actorFor(bc, options).receiveMessage({ name: 'BentoKey:Cycle', data: { direction: 1 } });
    return w.events.length > before ? w.events.at(-1)[1].browser : null;
  };
  const main = w.top(w.browsers.main);
  assert.equal(send(main), w.browsers.main, 'main slot');
  assert.equal(send(w.top(w.browsers.panel)), w.browsers.panel, 'panel');
  assert.equal(send(main.child()), w.browsers.main, 'an iframe names its top-level browser');
  assert.equal(send(w.top(w.browsers.shellFrame, 'bento-shell@bento.app')), w.browsers.shellFrame, 'Bento sidebar frame');
  assert.equal(send(main, { current: false }), null, 'not the current global');
  assert.equal(send(w.top(w.browsers.otherFrame, 'someone@example.com')), null, 'neither a tab nor bento-shell');
  assert.equal(send(w.top(w.browsers.otherWindow, '', w.otherWin)), null, 'embedder outside the target window');
});

test('BentoKeyChild forwards Cmd+Shift+Arrow from non-editable targets only', () => {
  const { child, sent } = loadChild();
  const el = (localName, extra = {}) => ({ localName, tagName: localName, isContentEditable: false, getAttribute: () => null, ...extra });
  for (const target of [el('input'), el('textarea'), el('select'), el('INPUT', { localName: 'input' }), el('div', { isContentEditable: true }), el('div', { getAttribute: () => 'textbox' })]) {
    const event = key(target);
    child.handleEvent(event);
    assert.equal(event.defaultPrevented, false, target.tagName);
  }
  for (const over of [{ shiftKey: false }, { key: 'l', code: 'KeyL', shiftKey: false }, { altKey: true }, { ctrlKey: true }, { defaultPrevented: true }]) {
    child.handleEvent(key(el('button'), over));
  }
  assert.deepEqual(sent, []);
  const event = key(el('button'), { key: 'ArrowLeft' });
  child.handleEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(sent, [['BentoKey:Cycle', { direction: -1 }]]);
});
