// The BentoKey content-key bridge: the registration in bento-shell-mount.js and the
// BentoKeyParent message checks, run against a stub JSWindowActorParent. The child runs in
// untrusted web content processes, so the parent must drop malformed messages. Key routing
// itself is proven in a built browser (docs/technical/panel-traversal-focus.md).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const source = (file) =>
  readFileSync(resolve(ROOT, 'src/browser/actors', file), 'utf8').replaceAll(/^export /gm, '');

/**
 * A window with a main tab browser, a panel browser, a Bento chrome frame and a frame
 * that is neither, plus a BentoKeyParent factory for a sender in one of them.
 */
function world() {
  const events = [];
  const warnings = [];
  class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  const win = { CustomEvent, dispatchEvent: (e) => events.push([e.type, JSON.parse(JSON.stringify(e.detail))]) };
  const doc = { defaultView: win };
  const otherWin = { CustomEvent, dispatchEvent: () => events.push(['other window']) };
  const browser = (owner = doc) => ({ ownerDocument: owner });
  const browsers = { main: browser(), panel: browser(), shellFrame: browser(), otherFrame: browser(), otherWindow: browser({ defaultView: otherWin }) };
  const tabs = new Set([browsers.main, browsers.panel]);
  win.gBrowser = { getTabForBrowser: (b) => (tabs.has(b) ? {} : null) };
  let nextId = 1;
  // A top-level browsing context in `embedder` and optional child frames.
  const top = (embedder, addonId = '', topWin = win) => {
    const bc = { id: nextId++, topChromeWindow: topWin, embedderElement: embedder };
    bc.top = bc;
    bc.currentWindowGlobal = { documentPrincipal: { addonId } };
    bc.child = () => ({ id: nextId++, topChromeWindow: topWin, top: bc });
    return bc;
  };
  const focus = { focusedContentBrowsingContext: null };
  const context = vm.createContext({
    JSWindowActorParent: class {},
    Services: { focus },
    console: { warn: (...args) => warnings.push(args) },
  });
  vm.runInContext(source('BentoKeyParent.sys.mjs') + '\nthis.BentoKeyParent = BentoKeyParent;', context);
  const actorFor = (bc, { current = true } = {}) =>
    Object.assign(new context.BentoKeyParent(), { browsingContext: bc, manager: { isCurrentGlobal: current } });
  return { events, warnings, focus, browsers, top, actorFor, otherWin };
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

/** A trusted-looking Cmd+Shift+ArrowRight keydown on `target`. */
function cycleKey(target) {
  return {
    type: 'keydown',
    key: 'ArrowRight',
    code: 'ArrowRight',
    metaKey: true,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    defaultPrevented: false,
    target,
    getModifierState: (name) => name === 'Accel',
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
  };
}

test('BentoKey is registered for untrusted web and file processes', () => {
  const mount = readFileSync(resolve(ROOT, 'src/browser/base/content/bento-shell-mount.js'), 'utf8');
  const block = /registerWindowActor\('BentoKey', \{[\s\S]*?\n {6}\}\);/.exec(mount)?.[0];
  assert.ok(block, 'registerContentKeyActor registers BentoKey');
  assert.match(block, /^\s*safeForUntrustedWebProcess: true,$/m);
  assert.match(block, /'\*:\/\/\*\/\*', 'file:\/\/\/\*'/);
});

test('BentoKeyParent forwards only a direction of 1 or -1 and a normalised address mode', () => {
  const w = world();
  const bc = w.top(w.browsers.main);
  w.focus.focusedContentBrowsingContext = bc;
  const actor = w.actorFor(bc);
  actor.receiveMessage({ name: 'BentoKey:Cycle', data: { direction: 1 } });
  actor.receiveMessage({ name: 'BentoKey:PanelHistory', data: { direction: -1 } });
  actor.receiveMessage({ name: 'BentoKey:AddrbarOpen', data: { mode: 'newTab' } });
  actor.receiveMessage({ name: 'BentoKey:AddrbarOpen', data: { mode: 'other' } });
  actor.receiveMessage({ name: 'BentoKey:AddrbarOpen' });
  for (const data of [undefined, null, {}, { direction: 2 }, { direction: '1' }, { direction: 0 }, { direction: NaN }]) {
    actor.receiveMessage({ name: 'BentoKey:Cycle', data });
    actor.receiveMessage({ name: 'BentoKey:PanelHistory', data });
  }
  actor.receiveMessage({ name: 'BentoKey:Other', data: { direction: 1 } });
  assert.deepEqual(w.events, [
    ['BentoKey:Cycle', { direction: 1 }],
    ['BentoKey:PanelHistory', { direction: -1 }],
    ['BentoKey:AddrbarOpen', { mode: 'newTab' }],
    ['BentoKey:AddrbarOpen', { mode: 'current' }],
    ['BentoKey:AddrbarOpen', { mode: 'current' }],
  ]);
  assert.deepEqual(w.warnings, []);
});

test('BentoKeyParent acts only for the focused, current document of a tab or Bento frame', () => {
  const w = world();
  const send = (bc, focused, options) => {
    w.focus.focusedContentBrowsingContext = focused;
    const before = w.events.length;
    w.actorFor(bc, options).receiveMessage({ name: 'BentoKey:PanelHistory', data: { direction: -1 } });
    return w.events.length > before;
  };
  const main = w.top(w.browsers.main);
  const panel = w.top(w.browsers.panel);
  const frame = main.child();
  const shell = w.top(w.browsers.shellFrame, 'bento-shell@bento.app');
  assert.equal(send(main, main), true, 'focused main slot');
  assert.equal(send(panel, panel), true, 'focused panel');
  assert.equal(send(frame, frame), true, 'focused iframe');
  assert.equal(send(shell, shell), true, 'focused Bento sidebar frame');
  assert.equal(send(panel, main), false, 'unfocused panel or background tab');
  assert.equal(send(frame, main), false, 'unfocused iframe of the focused tab');
  assert.equal(send(main, frame), false, 'top document while its iframe has focus');
  assert.equal(send(main, null), false, 'nothing focused');
  assert.equal(send(main, main, { current: false }), false, 'not the current global');
  const other = w.top(w.browsers.otherFrame, 'someone@example.com');
  assert.equal(send(other, other), false, 'a frame that is neither a tab nor bento-shell');
  const foreign = w.top(w.browsers.otherWindow, '', w.otherWin);
  assert.equal(send(foreign, foreign), false, 'embedder outside the target window');
  assert.equal(w.events.filter(([type]) => type === 'other window').length, 0);
});

test('BentoKeyChild keeps panel keys in editable targets, whatever the tagName case', () => {
  const { child, sent } = loadChild();
  const el = (localName, extra = {}) => ({ localName, tagName: localName, isContentEditable: false, getAttribute: () => null, ...extra });
  for (const target of [el('input'), el('textarea'), el('select'), el('div', { isContentEditable: true }), el('div', { getAttribute: () => 'textbox' })]) {
    const event = cycleKey(target);
    child.handleEvent(event);
    assert.equal(event.defaultPrevented, false, target.localName);
  }
  child.handleEvent(cycleKey(el('INPUT', { localName: 'input' })));
  assert.deepEqual(sent, []);
  const event = cycleKey(el('button'));
  child.handleEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(sent, [['BentoKey:Cycle', { direction: 1 }]]);
});
