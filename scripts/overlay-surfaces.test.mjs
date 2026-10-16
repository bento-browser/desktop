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
// timers and computed style, and fake frames whose message managers record what chrome sends an
// overlay (the toolbar scrim is a recording stub). A function that is renamed or
// removed fails extraction instead of silently leaving the test behind.

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
  'motionList',
  'motionTimeMs',
  'measureMotion',
  'cancelMotion',
  'afterMotion',
  'hideOverlayHostAfterFade',
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
  'dispatchShellAction',
  'dispatchAddrbarOpen',
  'dispatchMergePaletteLifecycle',
  'attachPaletteEscListener',
  'attachOutsideClickDismissListener',
];

const CONSTANTS = [
  'MOTION_SLACK_MS',
  'MOTION_UNAVAILABLE_CEILING_MS',
  'motionWaits',
  'ADDRBAR_POPUP_WIDTH_PX',
  'ADDRBAR_POPUP_HEIGHT_PX',
  'ADDRBAR_FRAME_GUTTER_TOP_PX',
  'ADDRBAR_FRAME_GUTTER_INLINE_PX',
  'ADDRBAR_FRAME_GUTTER_BOTTOM_PX',
  'ADDRBAR_OPEN_RETRY_MS',
  'ADDRBAR_OPEN_RETRY_LIMIT',
  'ADDRBAR_OPEN_FALLBACK_REVEAL_MS',
  'ADDRBAR_HOST_TRANSITION',
  'menuOnSelectByContext',
];

const EXPORTED = [
  'overlays',
  'menuOnSelectByContext',
  'MOTION_UNAVAILABLE_CEILING_MS',
  'showPalette',
  'hidePalette',
  'hideWorkspacePalette',
  'hideEditWorkspace',
  'hideWelcome',
  'togglePalette',
  'showWorkspacePalette',
  'showMergePalette',
  'hideMergePalette',
  'toggleMergePalette',
  'showAddrbar',
  'hideAddrbar',
  'revealPendingAddrbar',
  'showConfirm',
  'hideConfirm',
  'showEditWorkspace',
  'showWorkspaceSwitcher',
  'showWelcome',
  'showChromeMenu',
  'hideChromeMenu',
  'attachPaletteEscListener',
  'attachOutsideClickDismissListener',
];

// ─── World ───────────────────────────────────────────────────────────────────

/**
 * A <browser> whose message manager records what chrome sends and which frame scripts it loads.
 * It also answers what the motion helpers read: a connected flag, an owner document whose view
 * gives a computed style, and transitionend listeners.
 */
class FakeElement {
  constructor(registry, tag, sent) {
    this.registry = registry;
    this.ownerDocument = registry.ownerDocument;
    this.isConnected = true;
    this.listeners = new Map();
    this.tag = tag;
    this.id = '';
    this.style = {};
    this.attrs = new Map();
    this.focusCount = 0;
    if (tag === 'browser') {
      this.messageManager = {
        loadFrameScript: () => {},
        sendAsyncMessage: (name, data) => sent.push({ name, data: plain(data), frame: this.id }),
      };
    }
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

  addEventListener(type, handler) {
    this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(handler));
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }

  /** A browser event on this element, as the end of a CSS transition delivers it. */
  dispatch(type, init = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) {
      handler({ type, target: this, ...init });
    }
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

/**
 * `windowId` is what chrome's window tracker answers: a number, or null when the lookup fails.
 * `fadeMs` is the opacity transition the stylesheet gives every overlay host (the Mux modal
 * role); 0 stands for reduced motion. An inline `transition: none` wins, as in CSS.
 */
function makeWorld({ windowId = 7, fadeMs = 180 } = {}) {
  let clock = 1000;
  let nextTimer = 1;
  const timers = new Map();
  const idle = [];
  const registry = new Map();
  let currentFadeMs = fadeMs;
  registry.ownerDocument = {
    defaultView: {
      getComputedStyle(el) {
        const none = el.style.transition === 'none' || currentFadeMs === 0;
        return {
          transitionProperty: none ? 'none' : 'opacity',
          transitionDuration: none ? '0s' : `${currentFadeMs / 1000}s`,
          transitionDelay: '0s',
          animationName: 'none',
          animationDuration: '0s',
          animationDelay: '0s',
          animationIterationCount: '1',
        };
      },
    },
  };
  const sent = [];
  const events = {
    navigations: [],
    scrim: new Set(),
    scrimShown: [],
    errors: [],
  };
  const listeners = [];

  function host(id, props) {
    const el = new FakeElement(registry, 'vbox', sent);
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
      const frame = new FakeElement(registry, 'browser', sent);
      frame.id = `bento-${id}-frame`;
      el.appendChild(frame);
    }
  }
  for (const [id, props] of Object.entries(HOSTS)) host(id, props);
  const shellFrame = new FakeElement(registry, 'browser', sent);
  shellFrame.id = 'bento-shell-frame';
  registry.set(shellFrame.id, shellFrame);

  const document = {
    getElementById: (id) => registry.get(id) ?? null,
    createXULElement: (tag) => new FakeElement(registry, tag, sent),
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
    console: {
      warn: () => {},
      error: (...args) => events.errors.push(args.map(String).join(' ')),
    },
    Date,
    Math,
    Map,
    Set,
    Object,
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
    showOverlayToolbarScrim: (owner) => {
      events.scrim.add(owner);
      events.scrimShown.push(owner);
    },
    hideOverlayToolbarScrim: (owner) => events.scrim.delete(owner),
    getChromeWindowId: () => windowId,
    computeAddrbarAnchoredPlacement: () => null,
    resolveClipboardUrlSuggestion: () => '',
    // The frame scripts' URLs only name what loadFrameScript loads.
    SHELL_ACTION_FRAME_SCRIPT_URL: 'shell-action',
    ADDRBAR_OPEN_FRAME_SCRIPT_URL: 'addrbar-open',
    MERGE_PALETTE_LIFECYCLE_FRAME_SCRIPT_URL: 'merge-lifecycle',
  };

  const script = `"use strict";
    ${CONSTANTS.map(extractConst).join('\n')}
    let mergePaletteOpenSeq = 0;
    let addrbarOpenSeq = 0;
    let pendingAddrbarReveal = null;
    let pendingMenuContextId = null;
    let currentAddrbarMode = 'current';
    ${extractOverlaysSection()}
    ${FUNCTIONS.map(extractFunction).join('\n')}
    ${extractOverlaysTable()}
    ({ ${EXPORTED.join(', ')}, getPendingAddrbarReveal: () => pendingAddrbarReveal });`;
  const api = vm.runInNewContext(script, sandbox, { filename: 'bento-shell-mount.js#surfaces' });

  const messages = (name) => sent.filter((message) => message.name === name);
  const world = {
    ...api,
    events,
    sent,
    registry,
    /** The overlay's document announces it (the BENTO_OVERLAY_READY title). */
    ready: (id) => api.overlays.markFrameReady(`bento-${id}-frame`),
    host: (id) => registry.get(`bento-${id}-host`),
    /** The overlay fade the stylesheet gives the hosts from now on (0 = reduced motion). */
    setFadeMs: (ms) => {
      currentFadeMs = ms;
    },
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
      api.attachOutsideClickDismissListener();
      const { handler } = listeners.findLast((entry) => entry.type === 'pointerdown');
      handler({ composedPath: () => [] });
    },
    /** The messages chrome sent, as the frame scripts receive them. */
    addrbarOpens: () => messages('BentoAddrbarOpen').map((message) => message.data),
    mergeLifecycle: () => messages('BentoMergePaletteLifecycle').map((message) => message.data),
    mergeOpenNonces: () =>
      messages('BentoMergePaletteLifecycle')
        .map((message) => message.data)
        .filter((data) => data.type === 'open'),
    shellActions: () => messages('BentoShellAction').map((message) => message.data),
    menuOpens: () =>
      messages('BentoShellAction')
        .map((message) => message.data)
        .filter((data) => data.type === 'menu/open'),
  };
  return world;
}

// A window that has been running for a few seconds: the eager overlays and the
// idle-prewarmed ones are created and have announced themselves.
function warmWorld(options) {
  const world = makeWorld(options);
  world.overlays.startEager();
  for (const id of ['addrbar', 'palette', 'menu']) world.overlays.ensure(id, 'idle');
  for (const id of [
    'confirm',
    'edit-workspace',
    'workspace-switcher',
    'addrbar',
    'palette',
    'menu',
  ]) {
    world.ready(id);
  }
  return world;
}

const MENU = { anchor: { left: 5, top: 6, width: 7, height: 8 }, items: [{ id: 'a' }] };
const STALL_MS = 5000;

// ─── Startup ─────────────────────────────────────────────────────────────────

test('nothing is created until startup, and startup creates only the eager overlays', () => {
  const world = makeWorld();
  for (const id of Object.keys(HOSTS)) {
    assert.equal(world.overlays.hasStarted(id), false, `${id} must not exist before startup`);
  }
  assert.deepEqual(world.events.navigations, []);

  world.overlays.startEager();

  assert.deepEqual(world.events.navigations, ['confirm', 'edit-workspace', 'workspace-switcher']);
  assert.ok(world.frame('edit-workspace'), 'the JS-created eager frames exist');
  assert.ok(world.frame('workspace-switcher'));
  assert.equal(world.frame('addrbar'), null, 'idle and on-demand frames do not exist yet');
});

// ─── Esc, toggle, and the other dismissal paths cancel a cold open ──────────

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
    assert.deepEqual(world.mergeOpenNonces(), [], 'the open nonce is never sent');
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

test('every hide function cancels a cold open', () => {
  const world = makeWorld();
  world.showConfirm();
  world.showMergePalette();
  world.showChromeMenu({ ...MENU });

  world.hideConfirm();
  world.hideMergePalette();
  world.hideChromeMenu();
  for (const id of ['confirm', 'merge-palette', 'menu']) {
    assert.equal(world.overlays.hasPendingOpen(id), false, id);
  }

  for (const id of ['confirm', 'merge-palette', 'menu']) world.ready(id);
  assert.equal(world.isShown('confirm'), false);
  assert.equal(world.isShown('merge-palette'), false);
  assert.equal(world.isShown('menu'), false);
  assert.deepEqual(world.menuOpens(), []);
  assert.deepEqual(world.mergeOpenNonces(), []);
});

// ─── Nothing is revealed or sent without the real announcement ──────────────

test('no overlay is revealed before its document announces, however long that takes', () => {
  const opens = {
    palette: (world) => world.showPalette(),
    'workspace-palette': (world) => world.showWorkspacePalette(),
    'merge-palette': (world) => world.showMergePalette(),
    confirm: (world) => world.showConfirm(),
    'edit-workspace': (world) => world.showEditWorkspace(),
    'workspace-switcher': (world) => world.showWorkspaceSwitcher(),
    welcome: (world) => world.showWelcome(),
    menu: (world) => world.showChromeMenu({ ...MENU }),
  };
  for (const [id, open] of Object.entries(opens)) {
    const world = makeWorld();
    open(world);
    world.advance(10 * 60_000);
    assert.equal(world.isShown(id), false, id);
    assert.equal(world.overlays.hasPendingOpen(id), true, `${id} stays pending`);
    assert.deepEqual(world.events.scrimShown, [], id);

    world.ready(id);
    assert.equal(world.isShown(id), true, `${id} opens on its announcement`);
    assert.equal(world.overlays.hasPendingOpen(id), false, id);
  }
});

test('a document that does not announce is reported once and its open stays cancellable', () => {
  const world = makeWorld();
  world.showPalette();

  world.advance(STALL_MS - 1);
  assert.deepEqual(world.events.errors, []);
  world.advance(1);
  assert.equal(world.events.errors.length, 1);
  assert.match(world.events.errors[0], /palette did not announce readiness/);

  assert.equal(world.isShown('palette'), false, 'it is not revealed');
  assert.equal(world.overlays.hasPendingOpen('palette'), true, 'the open is still pending');
  world.advance(60_000);
  assert.equal(world.events.errors.length, 1);

  // The user can still cancel it, and a late announcement then shows nothing.
  assert.equal(world.pressEscape(), true);
  world.ready('palette');
  assert.equal(world.isShown('palette'), false);
});

test('a late announcement shows the stalled open once, with its message', () => {
  const world = makeWorld();
  world.showMergePalette();
  world.advance(STALL_MS + 2000);
  assert.equal(world.isShown('merge-palette'), false);
  assert.deepEqual(world.mergeOpenNonces(), []);

  world.ready('merge-palette');
  assert.equal(world.isShown('merge-palette'), true);
  assert.equal(world.mergeOpenNonces().length, 1);
  world.ready('merge-palette');
  assert.equal(world.mergeOpenNonces().length, 1, 'a second announcement sends nothing again');
});

// ─── Menu ───────────────────────────────────────────────────────────────────

test('a menu opened before its document is ready is shown and sent once, on the announcement', () => {
  const world = makeWorld();
  world.showChromeMenu({ ...MENU });
  assert.deepEqual(world.menuOpens(), []);
  assert.equal(world.isShown('menu'), false);

  // No reveal at 5 s: the message has nowhere to go yet.
  world.advance(STALL_MS);
  assert.equal(world.isShown('menu'), false);
  assert.deepEqual(world.menuOpens(), []);

  // The listener mounts at 7 s.
  world.advance(2000);
  world.ready('menu');
  assert.equal(world.isShown('menu'), true);
  assert.equal(world.menuOpens().length, 1);
  assert.deepEqual(world.menuOpens()[0].anchor, { left: 5, top: 6, width: 7, height: 8 });

  world.ready('menu');
  assert.equal(world.menuOpens().length, 1, 'a second announcement does not send it again');
});

test('Esc and an outside click cancel a menu open that still waits for its document', () => {
  for (const dismiss of [(world) => world.pressEscape(), (world) => world.pointerDownOutside()]) {
    const world = makeWorld();
    world.showChromeMenu({ ...MENU });
    assert.equal(world.overlays.hasPendingOpen('menu'), true);

    dismiss(world);
    assert.equal(world.overlays.hasPendingOpen('menu'), false);
    world.advance(10_000);
    world.ready('menu');
    assert.deepEqual(world.menuOpens(), []);
    assert.equal(world.isShown('menu'), false);
  }
});

test('Esc is not consumed for a menu that was delivered: the menu page handles its own', () => {
  const world = warmWorld();
  world.showChromeMenu({ ...MENU });
  assert.equal(world.isShown('menu'), true);
  assert.equal(world.overlays.hasPendingOpen('menu'), false);
  assert.equal(world.pressEscape(), false);
  assert.equal(world.isShown('menu'), true);
});

test('the newest menu request is the one delivered, and a dropped request leaves no handler', () => {
  const world = makeWorld();
  world.showChromeMenu({ ...MENU, items: [{ id: 'first' }], onSelect: () => {} });
  world.showChromeMenu({ ...MENU, items: [{ id: 'second' }], onSelect: () => {} });
  assert.equal(world.menuOnSelectByContext.size, 1, 'the older handler can never be called');
  world.ready('menu');
  assert.equal(world.menuOpens().length, 1);
  assert.deepEqual(plain(world.menuOpens()[0].items), [{ id: 'second' }]);
  assert.equal(world.menuOnSelectByContext.size, 1, 'a delivered menu keeps its handler');

  const other = makeWorld();
  other.showChromeMenu({ ...MENU, onSelect: () => {} });
  other.pressEscape();
  assert.equal(other.menuOnSelectByContext.size, 0, 'a cancelled open drops its handler');
});

test('a ready menu opens synchronously, as before', () => {
  const world = warmWorld();
  world.showChromeMenu({ ...MENU });
  assert.equal(world.isShown('menu'), true);
  assert.equal(world.menuOpens().length, 1);
});

// ─── Address bar ────────────────────────────────────────────────────────────

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
    assert.deepEqual(world.addrbarOpens(), []);
    assert.equal(world.host('addrbar').style.opacity, '0');
  }
});

test('a cold address bar open is sent once the document announces, and not before', () => {
  const world = makeWorld();
  world.showAddrbar('newTab', 'query');
  world.advance(3000);
  assert.deepEqual(world.addrbarOpens(), [], 'nothing listens before the announcement');

  world.ready('addrbar');
  const [first] = world.addrbarOpens();
  assert.equal(first.mode, 'newTab');
  assert.equal(first.initialQuery, 'query');
});

test('readiness at 7 s still gives a filled address bar: the reveal timer starts at delivery', () => {
  const world = makeWorld();
  world.showAddrbar('current', 'typed');

  // 5 s stall report, then more than the 1.4 s reveal fallback: nothing may have
  // been revealed, and the open must still be waiting to be sent.
  world.advance(STALL_MS + 2000);
  assert.deepEqual(world.addrbarOpens(), []);
  assert.notEqual(world.getPendingAddrbarReveal(), null, 'the pending open is not dropped');
  assert.equal(world.host('addrbar').style.opacity, '0', 'the empty address bar is not revealed');
  assert.equal(world.host('addrbar').style.pointerEvents, 'none');

  world.ready('addrbar');
  const sentAt7s = world.addrbarOpens();
  assert.equal(sentAt7s.length, 1);
  assert.equal(sentAt7s[0].initialQuery, 'typed');
  assert.equal(world.host('addrbar').style.opacity, '0', 'it is not revealed by the delivery');

  // The reveal fallback counts from the delivery.
  world.advance(1399);
  assert.equal(world.host('addrbar').style.opacity, '0');
  world.advance(1);
  assert.equal(world.host('addrbar').style.opacity, '1');
  assert.equal(world.getPendingAddrbarReveal(), null);
});

test('the address bar document revealing itself ends the open, as it always did', () => {
  const world = warmWorld();
  world.showAddrbar('current');
  const [{ openId }] = world.addrbarOpens();
  world.revealPendingAddrbar(openId);
  assert.equal(world.host('addrbar').style.opacity, '1');
  world.advance(10_000);
  assert.equal(world.addrbarOpens().length >= 1, true);
  assert.equal(world.getPendingAddrbarReveal(), null);
});

test('the address bar does not take the focus from an overlay still waiting to open', () => {
  const world = warmWorld();
  world.showWorkspacePalette();
  world.showAddrbar('current');

  assert.equal(world.addrbarOpens().length, 1);
  assert.equal(world.addrbarOpens()[0].suppressFocus, true);
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
    assert.deepEqual(world.mergeOpenNonces(), [], 'the superseded nonce is never sent');
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

test('a ready palette opens synchronously', () => {
  const world = warmWorld();
  world.showPalette();
  assert.equal(world.isShown('palette'), true);
  assert.deepEqual([...world.events.scrim], ['palette']);
});

// ─── Chrome stamps the window on what it sends ──────────────────────────────

test('the address bar open names the window it is for', () => {
  const world = warmWorld({ windowId: 7 });
  world.showAddrbar('current');
  assert.equal(world.addrbarOpens()[0].windowId, 7);
});

test('the merge palette open and close name the window they are for', () => {
  const world = warmWorld({ windowId: 7 });
  world.showMergePalette();
  world.ready('merge-palette');
  world.hideMergePalette();
  assert.deepEqual(
    world.mergeLifecycle().map((message) => [message.type, message.windowId]),
    [
      ['open', 7],
      ['close', 7],
    ],
  );
});

test('menu/open names the window it is for, in the envelope bento-tools routes by', () => {
  const world = warmWorld({ windowId: 7 });
  world.showChromeMenu({ ...MENU });
  assert.equal(world.menuOpens()[0].__windowId, 7);
});

test('a failed window lookup leaves the id out, so receivers accept the message', () => {
  const world = warmWorld({ windowId: null });
  world.showAddrbar('current');
  world.showChromeMenu({ ...MENU });
  assert.equal(world.addrbarOpens()[0].windowId, null);
  assert.equal('__windowId' in world.menuOpens()[0], false);
});

// ─── The hide waits for the fade the stylesheet configures ──────────────────

const isHidden = (world, id) => !world.isShown(id);

test('the address bar host fades on the modal role, with no raw duration', () => {
  assert.match(
    MOUNT,
    /^ {2}const ADDRBAR_HOST_TRANSITION = 'opacity var\(--muxui-semantic-motion-modal-transition\)';$/m,
  );
  const world = warmWorld();
  world.showAddrbar('current');
  assert.equal(
    world.host('addrbar').style.transition,
    'opacity var(--muxui-semantic-motion-modal-transition)',
  );
});

test('a hide takes its time from the computed fade, not from a constant', () => {
  for (const fadeMs of [120, 180, 400]) {
    const world = warmWorld({ fadeMs });
    world.showPalette();
    world.hidePalette();
    assert.equal(world.isShown('palette'), true, 'still fading');
    world.advance(fadeMs + 49);
    assert.equal(world.isShown('palette'), true, `${fadeMs} ms: not hidden before the fade ends`);
    world.advance(1);
    assert.equal(isHidden(world, 'palette'), true, `${fadeMs} ms: hidden after the fade`);
    assert.equal(world.host('palette').listenerCount(), 0);
  }
});

test('the end of the opacity transition hides at once, ahead of the timer', () => {
  const world = warmWorld();
  world.showPalette();
  world.hidePalette();
  const host = world.host('palette');

  host.dispatch('transitionend', { propertyName: 'transform' });
  assert.equal(world.isShown('palette'), true, 'another property ending is ignored');
  host.dispatch('transitionend', { propertyName: 'opacity', target: {} });
  assert.equal(world.isShown('palette'), true, 'an event from a descendant is ignored');

  host.dispatch('transitionend', { propertyName: 'opacity' });
  assert.equal(isHidden(world, 'palette'), true);
  assert.equal(host.listenerCount(), 0);
  world.advance(10_000);
});

test('with no fade (reduced motion) every hide completes at once', () => {
  const world = warmWorld({ fadeMs: 0 });
  for (const [id, show, hide] of [
    ['palette', () => world.showPalette(), () => world.hidePalette()],
    ['workspace-palette', () => world.showWorkspacePalette(), () => world.hideWorkspacePalette()],
    ['merge-palette', () => world.showMergePalette(), () => world.hideMergePalette()],
    ['confirm', () => world.showConfirm(), () => world.hideConfirm()],
    ['edit-workspace', () => world.showEditWorkspace(), () => world.hideEditWorkspace()],
    ['welcome', () => world.showWelcome(), () => world.hideWelcome()],
  ]) {
    world.ready(id);
    show();
    assert.equal(world.isShown(id), true, `${id} shows`);
    hide();
    assert.equal(isHidden(world, id), true, `${id} hides without waiting`);
  }
  const addrbar = world.host('addrbar');
  world.showAddrbar('current');
  world.hideAddrbar();
  assert.equal(addrbar.style.display, 'none');
});

test('a host with no computed style falls back to the ceiling instead of hanging', () => {
  const world = warmWorld();
  world.showPalette();
  const host = world.host('palette');
  host.isConnected = false;
  world.hidePalette();
  world.advance(world.MOTION_UNAVAILABLE_CEILING_MS - 1);
  assert.equal(world.isShown('palette'), true);
  world.advance(1);
  assert.equal(isHidden(world, 'palette'), true);
});

test('showing again during the fade cancels the pending hide, and the next hide times itself', () => {
  const world = warmWorld();
  world.showPalette();
  const host = world.host('palette');

  world.hidePalette();
  world.advance(100);
  world.showPalette();
  assert.equal(host.listenerCount(), 0, 'the re-show dropped the first hide wait');

  world.advance(1000);
  assert.equal(world.isShown('palette'), true, 'the first hide never fires');

  // The second hide starts its own full fade rather than inheriting the first one's.
  world.hidePalette();
  world.advance(100);
  world.hidePalette();
  world.advance(179);
  assert.equal(world.isShown('palette'), true);
  world.advance(51);
  assert.equal(isHidden(world, 'palette'), true);
});

test('hiding twice replaces the pending hide instead of stacking waits', () => {
  const world = warmWorld();
  world.showConfirm();
  const host = world.host('confirm');
  world.hideConfirm();
  world.hideConfirm();
  assert.equal(host.listenerCount(), 2, 'one wait: its transitionend and animationend listeners');
  world.advance(10_000);
  assert.equal(isHidden(world, 'confirm'), true);
  assert.equal(host.listenerCount(), 0);
});

test('the address bar re-open during its fade keeps it shown', () => {
  const world = warmWorld();
  world.showAddrbar('current');
  const host = world.host('addrbar');
  world.hideAddrbar();
  world.advance(100);
  world.showAddrbar('current');
  world.advance(10_000);
  assert.equal(host.style.display, 'flex');
  assert.equal(host.hasAttribute('hidden'), false);
});
