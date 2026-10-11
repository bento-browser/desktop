import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Drives the real show, hide, toggle and Esc paths of bento-shell-mount.js
// against the real overlay manager and its real overlay table. The mount is one
// 20,000-line script that needs Firefox to run, so this extracts the functions
// by name from its source and evaluates them in a context with a fake DOM, fake
// timers, and recording stubs for what leaves the overlay surfaces (toolbar
// scrim, frame-script relays). A function that is renamed or removed fails
// extraction instead of silently leaving the test behind.

// Values built inside the vm context come from another realm.
const plain = (value) => JSON.parse(JSON.stringify(value));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOUNT = fs.readFileSync(
  path.join(ROOT, 'src/browser/base/content/bento-shell-mount.js'),
  'utf8',
);

// ─── Extraction ──────────────────────────────────────────────────────────────

/** Index just past the bracket that closes the one opened at `open`. */
function skipBalanced(source, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [pairs[source[open]]];
  let i = open + 1;
  while (i < source.length && stack.length > 0) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
    } else if (c === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i) + 1;
    } else if (c === "'" || c === '"') {
      i += 1;
      while (source[i] !== c) i += source[i] === '\\' ? 2 : 1;
    } else if (c === '`') {
      i += 1;
      while (source[i] !== '`') {
        if (source[i] === '\\') i += 2;
        else if (source[i] === '$' && source[i + 1] === '{') i = skipBalanced(source, i + 1) - 1;
        else i += 1;
      }
    } else if (pairs[c]) {
      stack.push(pairs[c]);
    } else if (c === stack.at(-1)) {
      stack.pop();
    }
    i += 1;
  }
  assert.equal(stack.length, 0, 'unbalanced source while extracting');
  return i;
}

function extractFunction(name) {
  const header = `\n  function ${name}(`;
  const start = MOUNT.indexOf(header);
  assert.ok(start !== -1, `bento-shell-mount.js has no function ${name}`);
  assert.equal(MOUNT.indexOf(header, start + 1), -1, `function ${name} is declared twice`);
  const open = start + header.length - 1;
  const bodyStart = MOUNT.indexOf('{', skipBalanced(MOUNT, open));
  return MOUNT.slice(start + 1, skipBalanced(MOUNT, bodyStart));
}

function extractConst(name) {
  const match = new RegExp(`^  const ${name} = [^;]*;`, 'm').exec(MOUNT);
  assert.ok(match, `bento-shell-mount.js has no const ${name}`);
  return match[0];
}

function extractOverlaysSection() {
  const begin = '// @bento-overlays:begin';
  const end = '// @bento-overlays:end';
  return MOUNT.slice(MOUNT.indexOf(begin) + begin.length, MOUNT.indexOf(end));
}

/** The `const overlays = createOverlayManager({ ... });` statement with its real table. */
function extractOverlaysTable() {
  const start = MOUNT.indexOf('  const overlays = createOverlayManager({');
  assert.ok(start !== -1, 'bento-shell-mount.js has no overlays table');
  const open = MOUNT.indexOf('(', start);
  return MOUNT.slice(start, skipBalanced(MOUNT, open) + 1);
}

const FUNCTIONS = [
  'overlayEntry',
  'createOverlayFrame',
  'openOverlay',
  'isOverlayOpen',
  'dismissPalette',
  'dismissMergePalette',
  'isPaletteVisible',
  'showPalette',
  'hidePalette',
  'togglePalette',
  'isWorkspacePaletteVisible',
  'showWorkspacePalette',
  'hideWorkspacePalette',
  'nextMergePaletteNonce',
  'isMergePaletteVisible',
  'showMergePalette',
  'hideMergePalette',
  'toggleMergePalette',
  'isAddrbarVisible',
  'nextAddrbarOpenId',
  'positionAddrbarHost',
  'clearPendingAddrbarReveal',
  'prepareAddrbarHostForOpen',
  'revealPendingAddrbar',
  'retryPendingAddrbarOpen',
  'getAddrbarFocusPreservingFrame',
  'showAddrbar',
  'hideAddrbar',
  'isConfirmVisible',
  'showConfirm',
  'hideConfirm',
  'isEditWorkspaceVisible',
  'showEditWorkspace',
  'hideEditWorkspace',
  'isWorkspaceSwitcherVisible',
  'showWorkspaceSwitcher',
  'hideWorkspaceSwitcher',
  'isWelcomeVisible',
  'showWelcome',
  'hideWelcome',
  'isEmbeddedImportVisible',
  'showChromeMenu',
  'hideChromeMenu',
  'attachPaletteEscListener',
  'attachAddrbarOutsideDismissListener',
];

const CONSTANTS = [
  'PALETTE_TRANSITION_MS',
  'WORKSPACE_PALETTE_TRANSITION_MS',
  'MERGE_PALETTE_TRANSITION_MS',
  'CONFIRM_TRANSITION_MS',
  'EDIT_WORKSPACE_TRANSITION_MS',
  'WELCOME_TRANSITION_MS',
  'ADDRBAR_POPUP_WIDTH_PX',
  'ADDRBAR_POPUP_HEIGHT_PX',
  'ADDRBAR_FRAME_GUTTER_TOP_PX',
  'ADDRBAR_FRAME_GUTTER_INLINE_PX',
  'ADDRBAR_FRAME_GUTTER_BOTTOM_PX',
  'ADDRBAR_OPEN_RETRY_MS',
  'ADDRBAR_OPEN_RETRY_LIMIT',
  'ADDRBAR_OPEN_FALLBACK_REVEAL_MS',
  'ADDRBAR_HOST_TRANSITION',
];

const EXPORTED = [
  'overlays',
  'showPalette',
  'hidePalette',
  'togglePalette',
  'showWorkspacePalette',
  'showMergePalette',
  'hideMergePalette',
  'toggleMergePalette',
  'showAddrbar',
  'hideAddrbar',
  'showConfirm',
  'hideConfirm',
  'showEditWorkspace',
  'showWorkspaceSwitcher',
  'showWelcome',
  'showChromeMenu',
  'hideChromeMenu',
  'attachPaletteEscListener',
  'attachAddrbarOutsideDismissListener',
  'getPendingAddrbarReveal',
];

// ─── World ───────────────────────────────────────────────────────────────────

class FakeElement {
  constructor(registry, tag) {
    this.registry = registry;
    this.tag = tag;
    this.id = '';
    this.style = {};
    this.attrs = new Map();
    this.focusCount = 0;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }

  removeAttribute(name) {
    this.attrs.delete(name);
  }

  hasAttribute(name) {
    return this.attrs.has(name);
  }

  appendChild(child) {
    if (child.id) this.registry.set(child.id, child);
    return child;
  }

  getBoundingClientRect() {
    return { left: 0, top: 0, width: 100, height: 100 };
  }

  focus() {
    this.focusCount += 1;
  }
}

const HOSTS = {
  palette: { static: true },
  'merge-palette': { static: true },
  confirm: { static: true },
  menu: { static: true },
  addrbar: {},
  'workspace-palette': {},
  'edit-workspace': {},
  welcome: {},
  'embedded-import': {},
  'workspace-switcher': {},
  'panel-navigator-tooltip': {},
};

function makeWorld() {
  let clock = 1000;
  let nextTimer = 1;
  const timers = new Map();
  const idle = [];
  const registry = new Map();
  const events = {
    navigations: [],
    scrim: new Set(),
    scrimShown: [],
    mergeLifecycle: [],
    shellActions: [],
    addrbarOpens: [],
    cancelRelays: [],
    warnings: [],
  };
  const listeners = [];

  function host(id, props) {
    const el = new FakeElement(registry, 'vbox');
    el.id = `bento-${id}-host`;
    el.setAttribute('hidden', 'true');
    // The hosts start as ensureOverlayHost and the init pre-warm leave them.
    el.style.display = 'none';
    el.style.opacity = '0';
    if (id === 'workspace-switcher') {
      el.style.display = 'flex';
      el.style.pointerEvents = 'none';
    }
    if (id === 'menu') el.style.opacity = '';
    registry.set(el.id, el);
    if (props.static) {
      // The browser-box patch declares these frames inside their hosts.
      const frame = new FakeElement(registry, 'browser');
      frame.id = `bento-${id}-frame`;
      el.appendChild(frame);
    }
  }
  for (const [id, props] of Object.entries(HOSTS)) host(id, props);

  const document = {
    getElementById: (id) => registry.get(id) ?? null,
    createXULElement: (tag) => new FakeElement(registry, tag),
  };

  function setTimeout(callback, ms = 0) {
    const id = nextTimer++;
    timers.set(id, { callback, due: clock + ms });
    return id;
  }
  const clearTimeout = (id) => timers.delete(id);

  const window = {
    performance: { now: () => clock },
    requestIdleCallback: (callback, options) => idle.push({ callback, options }),
    setTimeout,
    clearTimeout,
    addEventListener: (type, handler) => listeners.push({ type, handler }),
  };

  const navigate = (name) => () => events.navigations.push(name);
  const sandbox = {
    document,
    window,
    setTimeout,
    clearTimeout,
    console: { warn: (...args) => events.warnings.push(args.map(String).join(' ')) },
    Date,
    Math,
    // What the overlay surfaces call that is not under test here.
    setBentoPaletteSrc: navigate('palette'),
    setBentoWorkspacePaletteSrc: navigate('workspace-palette'),
    setBentoMergePaletteSrc: navigate('merge-palette'),
    setBentoAddrbarSrc: navigate('addrbar'),
    setBentoConfirmSrc: navigate('confirm'),
    setBentoEditWorkspaceSrc: navigate('edit-workspace'),
    setBentoWelcomeSrc: navigate('welcome'),
    setBentoWorkspaceSwitcherSrc: navigate('workspace-switcher'),
    setBentoMenuSrc: navigate('menu'),
    setBentoPanelNavigatorTooltipSrc: navigate('panel-navigator-tooltip'),
    replayPanelNavigatorTooltipPayload: () => {},
    broadcastOverlayCancel: (id) => events.cancelRelays.push(id),
    showOverlayToolbarScrim: (owner) => {
      events.scrim.add(owner);
      events.scrimShown.push(owner);
    },
    hideOverlayToolbarScrim: (owner) => events.scrim.delete(owner),
    dispatchMergePaletteLifecycle: (type, nonce) => events.mergeLifecycle.push({ type, nonce }),
    dispatchShellAction: (action) => {
      events.shellActions.push(action);
      return true;
    },
    dispatchAddrbarOpen: (mode, initialQuery, options) => {
      events.addrbarOpens.push({ mode, initialQuery, ...options });
      return true;
    },
    computeAddrbarAnchoredPlacement: () => null,
    resolveClipboardUrlSuggestion: () => '',
    menuOnSelectByContext: new Map(),
  };

  const script = `"use strict";
    ${CONSTANTS.map(extractConst).join('\n')}
    let mergePaletteOpenSeq = 0;
    let addrbarOpenSeq = 0;
    let pendingAddrbarReveal = null;
    let currentAddrbarMode = 'current';
    ${extractOverlaysSection()}
    ${FUNCTIONS.map(extractFunction).join('\n')}
    ${extractOverlaysTable()}
    ({ ${EXPORTED.filter((name) => name !== 'getPendingAddrbarReveal').join(', ')},
       getPendingAddrbarReveal: () => pendingAddrbarReveal });`;
  const api = vm.runInNewContext(script, sandbox, { filename: 'bento-shell-mount.js#surfaces' });

  const world = {
    ...api,
    events,
    registry,
    document,
    /** The overlay's document announces it (the BENTO_OVERLAY_READY title). */
    ready: (id) => api.overlays.markFrameReady(`bento-${id}-frame`),
    host: (id) => registry.get(`bento-${id}-host`),
    frame: (id) => registry.get(`bento-${id}-frame`) ?? null,
    isShown: (id) => {
      const host = registry.get(`bento-${id}-host`);
      return host.style.display !== 'none' && !host.hasAttribute('hidden');
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
    /** Esc as the chrome window sees it; returns whether Esc was consumed. */
    pressEscape() {
      api.attachPaletteEscListener();
      const { handler } = listeners.findLast((entry) => entry.type === 'keydown');
      const event = {
        key: 'Escape',
        consumed: false,
        preventDefault() {
          this.consumed = true;
        },
        stopPropagation() {},
        stopImmediatePropagation() {},
      };
      handler(event);
      return event.consumed;
    },
    pointerDownOutside() {
      api.attachAddrbarOutsideDismissListener();
      const { handler } = listeners.findLast((entry) => entry.type === 'pointerdown');
      handler({ composedPath: () => [] });
    },
    mergeOpenNonces: () => events.mergeLifecycle.filter((entry) => entry.type === 'open'),
    menuOpens: () => events.shellActions.filter((action) => action.type === 'menu/open'),
  };
  return world;
}

// A window with every prewarmed overlay already announced, like one that has
// been running for a few seconds.
function warmWorld() {
  const world = makeWorld();
  for (const id of ['palette', 'menu', 'addrbar', 'workspace-switcher']) {
    world.overlays.ensure(id, 'idle');
    world.ready(id);
  }
  return world;
}

const MENU = { anchor: { left: 5, top: 6, width: 7, height: 8 }, items: [{ id: 'a' }] };

// ─── Esc, toggle, and the other dismissal paths cancel a cold open ──────────

test('the extracted surfaces evaluate and the table has every overlay', () => {
  const world = makeWorld();
  for (const id of Object.keys(HOSTS)) {
    assert.equal(world.overlays.hasStarted(id), false, `${id} must not start at window startup`);
  }
  assert.deepEqual(world.events.navigations, []);
});

test('a cold palette open followed by Esc never appears', () => {
  const world = makeWorld();
  world.showPalette();
  assert.equal(world.overlays.hasPendingOpen('palette'), true);
  assert.equal(world.isShown('palette'), false, 'the host stays hidden while the document loads');

  assert.equal(world.pressEscape(), true, 'Esc is consumed by the pending open');
  assert.equal(world.overlays.hasPendingOpen('palette'), false);

  world.ready('palette');
  world.advance(10_000);
  assert.equal(world.isShown('palette'), false);
  assert.deepEqual(world.events.scrimShown, []);
  assert.deepEqual(world.events.cancelRelays, ['palette']);
});

test('a cold palette open followed by the toggle cancels it instead of queueing another', () => {
  const world = makeWorld();
  world.togglePalette();
  assert.equal(world.overlays.hasPendingOpen('palette'), true);

  world.togglePalette();
  assert.equal(world.overlays.hasPendingOpen('palette'), false);

  world.ready('palette');
  world.advance(10_000);
  assert.equal(world.isShown('palette'), false);
  assert.deepEqual(world.events.scrimShown, []);

  // Once the document is ready the toggle opens and closes it as before.
  world.togglePalette();
  assert.equal(world.isShown('palette'), true);
  world.togglePalette();
  world.advance(1000);
  assert.equal(world.isShown('palette'), false);
});

test('a cold merge palette open followed by the toggle or Esc never appears', () => {
  for (const dismiss of [(world) => world.toggleMergePalette(), (world) => world.pressEscape()]) {
    const world = makeWorld();
    world.toggleMergePalette();
    assert.equal(world.overlays.hasPendingOpen('merge-palette'), true);
    dismiss(world);
    world.ready('merge-palette');
    world.advance(10_000);
    assert.equal(world.isShown('merge-palette'), false);
    assert.deepEqual(world.mergeOpenNonces(), [], 'the open nonce is never delivered');
  }
});

test('Esc cancels each cold open in turn, top of the stack first', () => {
  const world = makeWorld();
  world.showPalette();
  world.showConfirm();
  world.showEditWorkspace();

  assert.equal(world.pressEscape(), true);
  assert.equal(world.overlays.hasPendingOpen('edit-workspace'), true, 'confirm is above edit');
  assert.equal(world.overlays.hasPendingOpen('confirm'), false);

  world.pressEscape();
  assert.equal(world.overlays.hasPendingOpen('edit-workspace'), false);
  assert.equal(world.overlays.hasPendingOpen('palette'), true);

  world.pressEscape();
  assert.equal(world.overlays.hasPendingOpen('palette'), false);
  assert.equal(world.pressEscape(), false, 'nothing is open any more');

  for (const id of ['palette', 'confirm', 'edit-workspace']) world.ready(id);
  assert.deepEqual(world.events.scrimShown, []);
});

test('Esc is consumed but does not cancel the mandatory welcome overlay', () => {
  const world = makeWorld();
  world.showWelcome();
  assert.equal(world.pressEscape(), true);
  assert.equal(world.overlays.hasPendingOpen('welcome'), true);

  world.ready('welcome');
  assert.equal(world.isShown('welcome'), true);
  assert.equal(world.pressEscape(), true);
  assert.equal(world.isShown('welcome'), true);
});

test('every hide function cancels a cold open, and tells the payload senders', () => {
  const world = makeWorld();
  world.showConfirm();
  world.showEditWorkspace();
  world.showWorkspacePalette();
  world.showWorkspaceSwitcher();
  world.showWelcome();
  world.showMergePalette();
  world.showChromeMenu({ ...MENU });
  // hide* is what the CLOSE titles and the Esc handler call.
  const { hideConfirm } = world;
  hideConfirm();
  assert.equal(world.overlays.hasPendingOpen('confirm'), false);
  assert.ok(world.events.cancelRelays.includes('confirm'));

  world.hideMergePalette();
  world.hideChromeMenu();
  assert.equal(world.overlays.hasPendingOpen('merge-palette'), false);
  assert.equal(world.overlays.hasPendingOpen('menu'), false);

  for (const id of ['confirm', 'merge-palette', 'menu']) world.ready(id);
  assert.equal(world.isShown('confirm'), false);
  assert.equal(world.isShown('merge-palette'), false);
  assert.equal(world.isShown('menu'), false);
  assert.deepEqual(world.menuOpens(), []);
});

test('a cold address bar open followed by Esc or an outside click sends nothing', () => {
  for (const dismiss of [(world) => world.pressEscape(), (world) => world.pointerDownOutside()]) {
    const world = makeWorld();
    world.showAddrbar('current');
    assert.equal(world.overlays.hasPendingOpen('addrbar'), true);
    assert.notEqual(world.getPendingAddrbarReveal(), null);

    dismiss(world);
    assert.equal(world.overlays.hasPendingOpen('addrbar'), false);
    assert.equal(world.getPendingAddrbarReveal(), null);

    world.ready('addrbar');
    world.advance(10_000);
    assert.deepEqual(world.events.addrbarOpens, []);
    assert.equal(world.host('addrbar').style.opacity, '0');
  }
});

test('a cold address bar open sends its message once, after the announcement', () => {
  const world = makeWorld();
  world.showAddrbar('newTab', 'query');
  world.advance(3000);
  assert.deepEqual(world.events.addrbarOpens, [], 'nothing listens before the announcement');

  world.ready('addrbar');
  assert.equal(world.events.addrbarOpens.length, 1);
  assert.equal(world.events.addrbarOpens[0].mode, 'newTab');
  assert.equal(world.events.addrbarOpens[0].initialQuery, 'query');
});

test('the address bar does not take the focus from an overlay still waiting to open', () => {
  const world = warmWorld();
  world.showWorkspacePalette();
  world.showAddrbar('current');

  assert.equal(world.events.addrbarOpens.length, 1);
  assert.equal(world.events.addrbarOpens[0].suppressFocus, true);
});

// ─── The newest open wins, whichever document loads first ───────────────────

test('palette then merge palette: the merge palette wins in both readiness orders', () => {
  for (const order of [
    ['palette', 'merge-palette'],
    ['merge-palette', 'palette'],
  ]) {
    const world = makeWorld();
    world.showPalette();
    world.showMergePalette();
    assert.equal(world.overlays.hasPendingOpen('palette'), false, 'the older open is superseded');
    assert.equal(world.overlays.hasPendingOpen('merge-palette'), true);

    for (const id of order) world.ready(id);

    assert.equal(world.isShown('merge-palette'), true);
    assert.equal(world.isShown('palette'), false);
    assert.deepEqual([...world.events.scrim], ['merge-palette']);
    assert.equal(world.mergeOpenNonces().length, 1);
  }
});

test('merge palette then palette: the palette wins in both readiness orders', () => {
  for (const order of [
    ['palette', 'merge-palette'],
    ['merge-palette', 'palette'],
  ]) {
    const world = makeWorld();
    world.showMergePalette();
    world.showPalette();
    assert.equal(world.overlays.hasPendingOpen('merge-palette'), false);
    assert.equal(world.overlays.hasPendingOpen('palette'), true);

    for (const id of order) world.ready(id);

    assert.equal(world.isShown('palette'), true);
    assert.equal(world.isShown('merge-palette'), false);
    assert.deepEqual([...world.events.scrim], ['palette']);
    assert.deepEqual(world.mergeOpenNonces(), [], 'the superseded nonce is never delivered');
  }
});

test('the workspace palette and the address bar also take over from a cold palette', () => {
  for (const open of [
    (world) => world.showWorkspacePalette(),
    (world) => world.showAddrbar('current'),
  ]) {
    const world = makeWorld();
    world.showPalette();
    open(world);
    assert.equal(world.overlays.hasPendingOpen('palette'), false);
    world.ready('palette');
    world.ready('workspace-palette');
    world.ready('addrbar');
    assert.equal(world.isShown('palette'), false);
  }
});

test('a shown palette closes when a cold merge palette is requested, not when it loads', () => {
  const world = warmWorld();
  world.showPalette();
  assert.equal(world.isShown('palette'), true);

  world.showMergePalette();
  world.advance(1000);
  assert.equal(world.isShown('palette'), false, 'closed at the request');
  assert.equal(world.isShown('merge-palette'), false, 'not shown until its document is ready');

  world.ready('merge-palette');
  assert.equal(world.isShown('merge-palette'), true);
});

// ─── A queued message survives the readiness fallback ───────────────────────

test('a menu opened before its document is ready is delivered once, after the announcement', () => {
  const world = makeWorld();
  world.showChromeMenu({ ...MENU });
  assert.deepEqual(world.menuOpens(), []);
  assert.equal(world.isShown('menu'), false);

  // The 5 s fallback reveals the host, but the message has nowhere to go yet.
  world.advance(5000);
  assert.equal(world.isShown('menu'), true);
  assert.deepEqual(world.menuOpens(), []);

  // The listener mounts at 7 s.
  world.advance(2000);
  world.ready('menu');
  assert.equal(world.menuOpens().length, 1);
  assert.deepEqual(plain(world.menuOpens()[0].anchor), { left: 5, top: 6, width: 7, height: 8 });

  world.ready('menu');
  assert.equal(world.menuOpens().length, 1, 'a second announcement does not send it again');
});

test('a menu opened and dismissed before its document is ready is never sent', () => {
  const world = makeWorld();
  world.showChromeMenu({ ...MENU });
  assert.equal(world.pressEscape(), true);
  world.advance(10_000);
  world.ready('menu');
  assert.deepEqual(world.menuOpens(), []);
  assert.equal(world.isShown('menu'), false);
});

test('the newest menu request is the one delivered', () => {
  const world = makeWorld();
  world.showChromeMenu({ ...MENU, items: [{ id: 'first' }] });
  world.showChromeMenu({ ...MENU, items: [{ id: 'second' }] });
  world.ready('menu');
  assert.equal(world.menuOpens().length, 1);
  assert.deepEqual(plain(world.menuOpens()[0].items), [{ id: 'second' }]);
});

test('a ready menu opens synchronously, as before', () => {
  const world = warmWorld();
  world.showChromeMenu({ ...MENU });
  assert.equal(world.isShown('menu'), true);
  assert.equal(world.menuOpens().length, 1);
});

test('a ready palette opens synchronously and a second request does not wait', () => {
  const world = warmWorld();
  world.showPalette();
  assert.equal(world.isShown('palette'), true);
  assert.deepEqual([...world.events.scrim], ['palette']);
});
