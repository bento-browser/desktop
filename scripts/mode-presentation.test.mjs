import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModeClip, collectModeClip, createModePresenter, normalizeRadii, quadRect, roundedPath,
} from '../src/browser/actors/BentoModePresentation.sys.mjs';

const box = (left, top, right, bottom) => ({ left, top, right, bottom });
const quad = (left, top, right, bottom) => ({ p1: { x: left, y: top }, p2: { x: right, y: top }, p3: { x: right, y: bottom }, p4: { x: left, y: bottom } });
const shape = (rect, radius = 0) => ({ ...rect, radii: Array.from({ length: 4 }, () => [radius, radius]) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 12; ++i) await Promise.resolve(); };

test('fractional quads, CSS radius normalization and reversed rounded paths retain exact geometry', () => {
  assert.deepEqual(quadRect(quad(10.25, 20.5, 110.75, 90.125)), box(10.25, 20.5, 110.75, 90.125));
  assert.deepEqual(normalizeRadii(['10px', '0px', '0px', '0px'], 100, 80), [[10, 10], [0, 0], [0, 0], [0, 0]]);
  assert.deepEqual(normalizeRadii(['80% 40px', '80% 40px', '0', '0'], 100, 80), [[50, 25], [50, 25], [0, 0], [0, 0]]);
  assert.throws(() => quadRect({ ...quad(0, 0, 100, 100), p2: { x: 100, y: 1 } }), /Non-axis/);
  assert.match(roundedPath(shape(box(0, 0, 100, 80), 12), true), /A 12 12 0 0 0/);
});

test('mask deduplicates holes, rejects overlap and restores rounded corners plus only opaque focus rings', () => {
  const owner = {};
  const hole = { ...box(10, 10, 90, 90), clips: [{ owner, shape: shape(box(10, 10, 90, 90), 12) }] };
  const ring = { outer: shape(box(10, 10, 90, 90), 12), inner: shape(box(12, 12, 88, 88), 10) };
  const path = buildModeClip({ width: 100, height: 100 }, [hole, hole], [], [ring]);
  assert.equal(path.split('M 10 10 V 90 H 90 V 10 Z').length - 1, 1, 'duplicate negative winding is removed');
  assert.match(path, /H 22 A 12 12 0 0 0 10 22/, 'clipped native page corner is positive UI');
  assert.match(path, /M 22 12 A 10 10 0 0 0 12 22/, 'inner focus-ring contour has the opposite winding');
  assert.throws(() => buildModeClip({ width: 100, height: 100 }, [hole, box(30, 30, 95, 95)]), /Overlapping page holes/);
  assert.throws(() => buildModeClip({ width: 100, height: 100 }, [
    { ...box(20, 20, 40, 40), clips: [{ owner, shape: shape(box(10, 10, 90, 90), 40) }] }, box(10, 10, 19, 19),
  ]), /Corner restoration crosses/);
});

function fixture() {
  const log = [];
  const attrs = new Map();
  const properties = new Map();
  const root = { getAttribute: (key) => attrs.get(key) ?? null, setAttribute: (key, value) => attrs.set(key, value), removeAttribute: (key) => attrs.delete(key), hasAttribute: (key) => attrs.has(key),
    style: { setProperty: (key, value) => properties.set(key, value), removeProperty: (key) => properties.delete(key) } };
  let owner = { ok: true, pref: 'light', stamp: { run: 'owner', seq: 1 } };
  let requestOwner = () => Promise.resolve(owner);
  let commitWait = null;
  let nextCapture;
  let animation;
  let pageFrames = [];
  const events = new Map();
  const frame = { isConnected: true, parentElement: null, closest: () => null, getBoxQuads: () => [quad(0, 0, 100, 100)], getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100 }), getAnimations: () => [] };
  let currentDocument = true;
  const participant = {
    id: 'document', frame, current: () => currentDocument,
    async query(command, data) {
      log.push(`child-${command}`);
      if (command === 'commit' && commitWait) await commitWait.promise;
      log.push(`ack-${command}`);
      return { documentId: 'document', generation: data.generation, hostGeneration: 1,
        documentNonce: 'nonce', applied: command === 'commit', styles: command === 'commit', submitted: command === 'commit' && data.submit !== false,
        geometry: { viewport: { width: 100, height: 100 }, surfaces: [] } };
    },
  };
  const doc = { documentElement: root, hidden: false, activeViewTransition: null, querySelectorAll: () => [], querySelector: () => null,
    createElementNS: () => ({ style: {} }), getAnimations: () => animation ? [animation] : [],
    startViewTransition(...args) {
      assert.equal(args.length, 0, 'native start has no update callback');
      log.push('capture');
      nextCapture = deferred();
      const finished = deferred();
      const aFinished = deferred();
      animation = {
        animationName: 'bento-mode-presentation-old', currentTime: 0, playbackRate: 1, playState: 'paused',
        effect: { setKeyframes: (frames) => { animation.frames = frames; }, updateTiming: (timing) => { animation.timing = timing; } },
        get finished() { return aFinished.promise; },
        pause() { this.playState = 'paused'; log.push('pause'); },
        play() {
          // Gecko Animation::Play auto-rewinds a negative-rate play at zero
          // to the effect end. A reversal must not invoke play at that endpoint.
          if (this.playbackRate < 0 && this.currentTime <= 0) this.currentTime = this.timing.duration;
          this.playState = 'running'; log.push('play');
        },
        cancel() { this.playState = 'idle'; log.push('cancel'); },
        finish() { this.playState = 'finished'; aFinished.resolve(); },
      };
      const transition = { ready: nextCapture.promise, finished: finished.promise, skipTransition() { log.push('skip'); if (doc.activeViewTransition === this) doc.activeViewTransition = null; finished.resolve(); } };
      doc.activeViewTransition = transition;
      return transition;
    },
  };
  class Observer { observe() {} disconnect() {} }
  const win = { document: doc, innerWidth: 100, innerHeight: 100, setTimeout, clearTimeout,
    CSS: { supports: () => true }, MutationObserver: Observer, ResizeObserver: Observer,
    matchMedia: (query) => ({ matches: query.includes('reduced') ? win.reduced : win.dark }),
    reduced: false, dark: false,
    addEventListener: (name, listener) => events.set(name, listener), removeEventListener: (name) => events.delete(name),
    windowUtils: { updateLayerTree: () => log.push('parent-submit'), syncFlushCompositor: () => log.push('parent-flush') },
    getComputedStyle: (node, pseudo) => pseudo ? { clipPath: properties.get('--bento-mode-presentation-clip'), pointerEvents: 'none', mixBlendMode: 'normal' }
      : { display: 'block', visibility: 'visible', opacity: '1', objectFit: 'fill', getPropertyValue: (name) => name.endsWith('duration') ? '250ms' : 'ease' },
  };
  const phases = [];
  const hub = { requestModeState: () => requestOwner(), modeDocuments: () => currentDocument ? [participant] : [] };
  const presenter = createModePresenter({ win, hub, getPageFrames: () => pageFrames, writeNative: (target) => { log.push(`native-${target.resolved}`); root.setAttribute('data-color-mode', target.resolved); }, onPhase: (state) => { phases.push(state); if (state.phase === 'ready') log.push('phase-ready'); } });
  return { presenter, doc, win, root, log, phases, participant,
    owner(pref, seq = 2) { owner = { ok: true, pref, stamp: { run: 'owner', seq } }; },
    read(fn) { requestOwner = fn; }, holdCommit(value) { commitWait = value; }, capture() { nextCapture.resolve(); }, get animation() { return animation; },
    pages(frames) { pageFrames = frames; },
    navigate() { currentDocument = false; presenter.documentClosed('document'); }, events,
  };
}

function installPartialNativeFocusRing(f, transitioning) {
  const colors = Array(4).fill('rgba(40, 40, 40, 0.5)');
  const base = { display: 'block', visibility: 'visible', opacity: '1', objectFit: 'fill', clipPath: 'none', maskImage: 'none',
    borderTopLeftRadius: '12px', borderTopRightRadius: '12px', borderBottomRightRadius: '12px', borderBottomLeftRadius: '12px',
    borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px', overflowX: 'visible', overflowY: 'visible' };
  const deck = { id: 'tabbrowser-tabpanels', parentElement: f.root };
  const animations = [];
  const panel = { parentElement: deck, getBoxQuads: () => [quad(10, 10, 90, 90)],
    getBoundingClientRect: () => ({ x: 10, y: 10, width: 80, height: 80 }), classList: { contains: () => false },
    getAnimations: (options) => options?.pseudoElement === '::after' ? animations : [],
  };
  const frame = { isConnected: true, parentElement: panel,
    closest: (selector) => selector.includes('data-bento-main-panel') ? panel : null,
    getBoxQuads: () => [quad(10, 10, 90, 90)], getBoundingClientRect: panel.getBoundingClientRect, getAnimations: () => [],
  };
  const previousStyle = f.win.getComputedStyle;
  f.win.getComputedStyle = (element, pseudo) => {
    if (element === panel && pseudo === '::after') {
      f.log.push('ring-style');
      return { ...base, top: '0px', right: '0px', bottom: '0px', left: '0px',
        borderTopColor: colors[0], borderRightColor: colors[1], borderBottomColor: colors[2], borderLeftColor: colors[3],
        borderTopWidth: '2px', borderRightWidth: '2px', borderBottomWidth: '2px', borderLeftWidth: '2px' };
    }
    if ([frame, panel, deck].includes(element)) return { ...base, overflowX: element === panel ? 'clip' : 'visible' };
    return previousStyle(element, pseudo);
  };
  class Transition {
    playState = 'running';
    constructor(property, colorIndex) {
      this.transitionProperty = property;
      this.effect = { target: panel, pseudoElement: '::after' };
      this.colorIndex = colorIndex;
    }
    finish() {
      this.playState = 'finished';
      f.log.push(`finish-${this.transitionProperty}`);
      if (this.colorIndex !== undefined) colors[this.colorIndex] = 'rgba(0, 0, 0, 0)';
    }
  }
  f.win.CSSTransition = Transition;
  if (transitioning) for (const [index, edge] of ['top', 'right', 'bottom', 'left'].entries()) animations.push(new Transition(`border-${edge}-color`, index));
  for (const property of ['background-color', 'transform', 'opacity']) animations.push(new Transition(property));
  animations.push({ playState: 'running', effect: { target: panel, pseudoElement: '::after' }, finish() { f.log.push('finish-css-animation'); } });
  f.pages([frame]);
}

test('footer preparation settles only the in-flight owned pseudo focus-ring colours before capture and fade', async () => {
  const f = fixture(); await f.presenter.request();
  installPartialNativeFocusRing(f, true);
  f.owner('dark'); const dark = f.presenter.request({ pref: 'dark' });
  try {
    await tick();
    assert.notEqual(f.doc.activeViewTransition, null, 'partial ring reaches capture instead of instant fallback');
    assert.deepEqual(f.log.filter((entry) => entry.startsWith('finish-')), ['top', 'right', 'bottom', 'left'].map((edge) => `finish-border-${edge}-color`));
    assert.ok(f.log.lastIndexOf('ring-style') < f.log.indexOf('capture'));
    f.capture(); await dark;
    assert.equal(f.animation.playState, 'running');
    assert.ok(f.phases.some(({ phase }) => phase === 'fading'));
  } finally { f.presenter.dispose(); await dark.catch(() => {}); }
});

test('a steady unsupported semi-transparent focus ring still rejects capture and leaves unrelated animations alone', async () => {
  const f = fixture(); await f.presenter.request();
  installPartialNativeFocusRing(f, false);
  f.owner('dark'); await f.presenter.request({ pref: 'dark' });
  assert.equal(f.doc.activeViewTransition, null);
  assert.equal(f.log.includes('capture'), false);
  assert.equal(f.log.some((entry) => entry.startsWith('finish-')), false);
  assert.ok(f.phases.some(({ phase }) => phase === 'settling'));
  f.presenter.dispose();
});

test('opaque cover is fenced before colour commits; the final child/parent barrier precedes play', async (t) => {
  const f = fixture();
  await f.presenter.request();
  f.log.length = 0;
  f.owner('dark');
  const wait = deferred();
  f.holdCommit(wait);
  const flip = f.presenter.request({ pref: 'dark' });
  t.after(async () => { wait.resolve(); f.presenter.dispose(); await flip.catch(() => {}); });
  await tick();
  assert.equal(f.doc.activeViewTransition !== null, true);
  assert.equal(f.log.some((entry) => entry === 'native-dark'), false, 'no writes before ready');
  f.capture();
  await tick();
  assert.equal(f.animation.playState, 'paused');
  assert.equal(f.log.filter((entry) => entry === 'parent-flush').length, 1, 'opaque cover is fenced while child ACK is pending');
  assert.ok(f.log.indexOf('parent-submit') < f.log.indexOf('parent-flush'));
  assert.ok(f.log.indexOf('parent-flush') < f.log.indexOf('phase-ready'), 'ready means the opaque cover has been submitted and fenced');
  assert.ok(f.log.indexOf('phase-ready') < f.log.indexOf('child-commit'));
  assert.ok(f.log.indexOf('parent-flush') < f.log.indexOf('native-dark'));
  wait.resolve();
  await flip;
  assert.ok(f.log.indexOf('ack-commit') < f.log.lastIndexOf('parent-submit'));
  assert.ok(f.log.lastIndexOf('parent-submit') < f.log.lastIndexOf('parent-flush'));
  assert.ok(f.log.lastIndexOf('parent-flush') < f.log.indexOf('play'));
  assert.equal(f.log.filter((entry) => entry === 'parent-flush').length, 2);
  assert.equal(f.animation.playState, 'running');
  assert.equal(f.animation.timing.duration, 250);
  assert.ok(f.phases.some(({ phase }) => phase === 'fading'));
  f.animation.finish(); await tick();
  assert.equal(f.doc.activeViewTransition, null);
  assert.equal(f.root.hasAttribute('data-bento-mode-presentation'), false);
  f.presenter.dispose();
});

test('a failed cover fence retires the image without announcing ready or playing', async () => {
  const f = fixture(); await f.presenter.request();
  let flushes = 0;
  f.win.windowUtils.syncFlushCompositor = () => {
    if (++flushes === 1) throw new Error('fixture cover fence failed');
  };
  f.owner('dark'); const dark = f.presenter.request({ pref: 'dark' });
  await tick(); f.capture(); await dark;
  assert.equal(f.phases.some(({ phase }) => phase === 'ready'), false);
  assert.equal(f.phases.some(({ phase }) => phase === 'settling'), true);
  assert.equal(f.doc.activeViewTransition, null);
  assert.equal(f.root.hasAttribute('data-bento-mode-presentation-ready'), false);
  assert.equal(f.log.includes('play'), false);
  assert.equal(f.root.getAttribute('data-color-mode'), 'dark', 'existing instant fallback settles the owner target');
  f.presenter.dispose();
});

test('reversal reuses the image and pauses at opaque before committing old colours', async () => {
  const f = fixture(); await f.presenter.request();
  f.owner('dark'); const first = f.presenter.request({ pref: 'dark' }); await tick(); f.capture(); await first;
  const image = f.doc.activeViewTransition;
  f.animation.currentTime = 125;
  f.owner('light', 3); await f.presenter.request({ pref: 'light' });
  assert.equal(f.doc.activeViewTransition, image);
  assert.equal(f.animation.playbackRate, -1);
  assert.equal(f.animation.currentTime, 125);
  const wait = deferred(); f.holdCommit(wait);
  f.animation.finish(); await tick();
  assert.equal(f.animation.playState, 'paused');
  assert.equal(f.animation.currentTime, 0);
  assert.equal(f.doc.activeViewTransition, image, 'opaque hold survives actor wait');
  wait.resolve(); await tick();
  assert.equal(f.doc.activeViewTransition, null);
  assert.equal(f.root.getAttribute('data-color-mode'), 'light');
  assert.equal(f.log.filter((entry) => entry === 'capture').length, 1);
  f.presenter.dispose();
});

test('reduced motion keeps the capture/barrier but never plays; same-resolved metadata needs no new image', async () => {
  const f = fixture(); await f.presenter.request();
  f.win.reduced = true; f.owner('dark');
  const flip = f.presenter.request({ pref: 'dark' }); await tick(); f.capture(); await flip; await tick();
  assert.equal(f.doc.activeViewTransition, null);
  assert.equal(f.log.includes('play'), false);
  const captures = f.log.filter((entry) => entry === 'capture').length;
  f.win.dark = true; f.owner('system', 3); await f.presenter.request({ pref: 'system' });
  assert.equal(f.log.filter((entry) => entry === 'capture').length, captures);
  f.presenter.dispose();
});

test('ordinary activity during reversal settles the latest target before a reveal can continue', async () => {
  const f = fixture(); await f.presenter.request();
  f.owner('dark'); const dark = f.presenter.request({ pref: 'dark' }); await tick(); f.capture(); await dark;
  f.animation.currentTime = 125;
  f.owner('light', 3); await f.presenter.request({ pref: 'light' });
  const wait = deferred(); f.holdCommit(wait);
  f.presenter.activity();
  let settled = false;
  const reveal = f.presenter.settle().then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, 'reveal waits for the latest child submission');
  assert.equal(f.doc.activeViewTransition, null, 'activity removes the cover immediately');
  wait.resolve(); await reveal;
  assert.equal(f.root.getAttribute('data-color-mode'), 'light');
  f.presenter.dispose();
});

test('settle during reversal drains the latest target through the submission barrier before removing its image', async () => {
  const f = fixture(); await f.presenter.request();
  f.owner('dark'); const dark = f.presenter.request({ pref: 'dark' }); await tick(); f.capture(); await dark;
  f.animation.currentTime = 125;
  f.owner('light', 3); await f.presenter.request({ pref: 'light' });
  const image = f.doc.activeViewTransition;
  const wait = deferred(); f.holdCommit(wait);
  let settled = false;
  const settling = f.presenter.settle().then(() => { settled = true; });
  try {
    await tick();
    assert.equal(settled, false, 'initial ready must not bypass the Light commit');
    assert.equal(f.animation.playState, 'paused');
    assert.equal(f.doc.activeViewTransition, image, 'hold survives until child submission ACK');
    wait.resolve(); await settling;
    assert.equal(f.root.getAttribute('data-color-mode'), 'light');
    assert.ok(f.log.lastIndexOf('parent-flush') < f.log.lastIndexOf('skip'), 'latest submission fence precedes image removal');
    assert.equal(f.doc.activeViewTransition, null);
  } finally { wait.resolve(); f.presenter.dispose(); await settling; }
});

test('reversal at the already-opaque endpoint never auto-rewinds to the transparent effect end', async () => {
  const f = fixture(); await f.presenter.request();
  f.owner('dark'); const dark = f.presenter.request({ pref: 'dark' }); await tick(); f.capture(); await dark;
  const image = f.doc.activeViewTransition;
  const plays = f.log.filter((entry) => entry === 'play').length;
  const wait = deferred(); f.holdCommit(wait);
  f.owner('light', 3);
  const light = f.presenter.request({ pref: 'light' });
  try {
    await tick();
    assert.equal(f.animation.currentTime, 0, 'negative play at zero would rewind to 250ms');
    assert.equal(f.animation.playState, 'paused');
    assert.equal(f.log.filter((entry) => entry === 'play').length, plays);
    assert.equal(f.doc.activeViewTransition, image, 'opaque image stays while Light commits');
    wait.resolve(); await light;
    assert.equal(f.root.getAttribute('data-color-mode'), 'light');
    assert.equal(f.doc.activeViewTransition, null);
  } finally { wait.resolve(); f.presenter.dispose(); await light; }
});

test('stale owner replies cannot overwrite a newer grant; navigation and ordinary activity retire the image', async () => {
  const f = fixture(); await f.presenter.request();
  const old = deferred(); f.read(() => old.promise);
  const stale = f.presenter.request({ pref: 'dark' });
  f.owner('light', 4); f.read(() => Promise.resolve({ ok: true, pref: 'light', stamp: { run: 'new-owner', seq: 1 } }));
  await f.presenter.request({ pref: 'light' });
  old.resolve({ ok: true, pref: 'dark', stamp: { run: 'owner', seq: 2 } }); await stale;
  assert.equal(f.root.getAttribute('data-color-mode'), 'light');
  f.read(() => Promise.resolve({ ok: true, pref: 'dark', stamp: { run: 'new-owner', seq: 2 } }));
  const flip = f.presenter.request({ pref: 'dark' }); await tick(); f.capture(); await flip;
  f.presenter.activity({ generation: -1 });
  assert.notEqual(f.doc.activeViewTransition, null, 'stale activity cannot cancel a new transaction');
  f.navigate(); await tick();
  assert.equal(f.doc.activeViewTransition, null);
  assert.equal(f.events.size, 0, 'transaction listeners are bounded');
  f.presenter.dispose();
});

test('surface geometry maps only public opaque surfaces through fractional host content quads', () => {
  const styles = { display: 'block', visibility: 'visible', opacity: '1', objectFit: 'fill' };
  const root = {};
  const frame = { isConnected: true, parentElement: root, closest: () => null, getBoxQuads: () => [quad(10.5, 20.25, 210.5, 220.25)] };
  const win = { innerWidth: 500, innerHeight: 500, document: { documentElement: root }, getComputedStyle: () => styles };
  const path = collectModeClip(win, [], [{ participant: { frame }, response: {
    geometry: { viewport: { width: 100, height: 100 }, surfaces: [{ quad: quad(10, 10, 60, 40), layout: quad(10, 10, 60, 40), radii: ['5px', '5px', '5px', '5px'] }] },
  } }]);
  assert.match(path, /M 40.5 40.25 H 120.5 A 10 10/, 'local radii and quads scale into the native host');
});

test('actual native clip owners intersect the shared scrollport and restore an opaque inner focus ring', () => {
  const root = {};
  const base = { display: 'block', visibility: 'visible', opacity: '1', objectFit: 'fill', clipPath: 'none', maskImage: 'none',
    borderTopLeftRadius: '12px', borderTopRightRadius: '12px', borderBottomRightRadius: '12px', borderBottomLeftRadius: '12px',
    borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px', overflowX: 'visible', overflowY: 'visible' };
  const deck = { id: 'tabbrowser-tabpanels', parentElement: root, getBoxQuads: () => [quad(0, 0, 100, 100)] };
  const panel = { parentElement: deck, getBoxQuads: () => [quad(10, 10, 110, 90)] };
  const frame = { isConnected: true, parentElement: panel, closest: (selector) => selector.includes('data-bento-main-panel') ? panel : null,
    getBoxQuads: () => [quad(10, 10, 110, 90)] };
  let ring = 'rgb(40, 40, 40)';
  const win = { document: { documentElement: root }, innerWidth: 120, innerHeight: 100,
    getComputedStyle: (element, pseudo) => pseudo ? { ...base, top: '0px', right: '0px', bottom: '0px', left: '0px',
      borderTopColor: ring, borderRightColor: ring, borderBottomColor: ring, borderLeftColor: ring,
      borderTopWidth: '2px', borderRightWidth: '2px', borderBottomWidth: '2px', borderLeftWidth: '2px' }
      : element === deck ? { ...base, overflowX: 'auto', borderTopLeftRadius: '0px', borderTopRightRadius: '0px', borderBottomLeftRadius: '0px', borderBottomRightRadius: '0px' }
        : element === panel ? { ...base, overflowX: 'clip' } : base,
  };
  const path = collectModeClip(win, [frame, frame], []);
  assert.match(path, /M 10 10 V 90 H 100 V 10 Z/, 'the shared scrollport clips the rendered page hole');
  assert.match(path, /M 22 12 A 10 10 0 0 0 12 22/, 'focus-ring inner contour restores only its UI footprint');
  ring = 'rgba(0, 0, 0, 0)';
  assert.doesNotMatch(collectModeClip(win, [frame], []), /M 22 12 A 10 10/);
  ring = 'rgba(0, 0, 0, 0.5)';
  assert.throws(() => collectModeClip(win, [frame], []), /Unsupported native focus ring/);
});

test('invalid mask support settles colours without capturing any stale full-window image', async () => {
  const f = fixture(); await f.presenter.request();
  f.win.CSS.supports = () => false;
  f.owner('dark'); await f.presenter.request({ pref: 'dark' });
  assert.equal(f.log.includes('capture'), false);
  assert.equal(f.root.getAttribute('data-color-mode'), 'dark');
  assert.ok(f.phases.some(({ phase }) => phase === 'settling'));
  f.presenter.dispose();
});
