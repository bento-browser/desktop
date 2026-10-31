/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// One native-root image presents a window's UI. Remote pages are holes, never
// named groups or a fallback full-window crossfade.
const EPSILON = 0.00001;
const ATTRIBUTE = 'data-bento-mode-presentation';
const CLIP = '--bento-mode-presentation-clip';
const HOLD = 'bento-mode-presentation-old';
const GEOMETRY_PROPERTIES = new Set(['opacity', 'transform', 'translate', 'scale', 'rotate', 'filter', 'clipPath', 'width', 'height', 'left', 'top', 'right', 'bottom', 'marginLeft', 'marginRight']);
const FOCUS_RING_COLORS = new Set(['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color']);

export function quadRect(quad) {
  if (!quad || !['p1', 'p2', 'p3', 'p4'].every((key) => Number.isFinite(quad[key]?.x) && Number.isFinite(quad[key]?.y))) throw new Error('Missing content quad');
  const { p1, p2, p3, p4 } = quad;
  if (Math.abs(p1.y - p2.y) > EPSILON || Math.abs(p2.x - p3.x) > EPSILON || Math.abs(p3.y - p4.y) > EPSILON || Math.abs(p4.x - p1.x) > EPSILON || p2.x <= p1.x || p4.y <= p1.y) throw new Error('Non-axis-aligned content quad');
  return { left: p1.x, top: p1.y, right: p2.x, bottom: p4.y };
}

const width = (box) => box.right - box.left;
const height = (box) => box.bottom - box.top;
const intersects = (a, b) => a.left < b.right - EPSILON && b.left < a.right - EPSILON && a.top < b.bottom - EPSILON && b.top < a.bottom - EPSILON;
const contains = (a, b) => b.left >= a.left - EPSILON && b.top >= a.top - EPSILON && b.right <= a.right + EPSILON && b.bottom <= a.bottom + EPSILON;
const intersection = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
const positive = (box) => width(box) > EPSILON && height(box) > EPSILON;

export function normalizeRadii(values, boxWidth, boxHeight) {
  const length = (value, extent) => {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0 || !/^(?:\d*\.)?\d+(?:px|%)?$/.test(value)) throw new Error('Unsupported corner radius');
    return value.endsWith('%') ? parsed * extent / 100 : parsed;
  };
  const radii = values.map((value) => {
    const pair = String(value).trim().split(/\s+/);
    return [length(pair[0], boxWidth), length(pair[1] || pair[0], boxHeight)];
  });
  const fit = (extent, sum) => sum ? extent / sum : 1;
  const factor = Math.min(1,
    fit(boxWidth, radii[0][0] + radii[1][0]), fit(boxWidth, radii[3][0] + radii[2][0]),
    fit(boxHeight, radii[0][1] + radii[3][1]), fit(boxHeight, radii[1][1] + radii[2][1]));
  return radii.map(([x, y]) => [x * factor, y * factor]);
}

function scaledShape(quad, layout, values) {
  const box = quadRect(quad);
  const local = quadRect(layout);
  const radii = normalizeRadii(values, width(local), height(local));
  return { ...box, radii: radii.map(([x, y]) => [x * width(box) / width(local), y * height(box) / height(local)]) };
}

function shapeOf(win, element, box = 'border', pseudo = null) {
  const quads = element.getBoxQuads({ box });
  const layout = element.getBoxQuads({ box, ignoreTransforms: true });
  if (quads.length !== 1 || layout.length !== 1) throw new Error('Fragmented native geometry');
  const style = win.getComputedStyle(element, pseudo);
  const values = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
  const result = scaledShape(quads[0], layout[0], values);
  if (box === 'padding') {
    const borders = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map((value) => Number.parseFloat(value) || 0);
    const borderLayout = quadRect(element.getBoxQuads({ box: 'border', ignoreTransforms: true })[0]);
    const outer = normalizeRadii(values, width(borderLayout), height(borderLayout));
    const corners = [[borders[3], borders[0]], [borders[1], borders[0]], [borders[1], borders[2]], [borders[3], borders[2]]];
    const local = quadRect(layout[0]);
    result.radii = outer.map(([x, y], i) => [Math.max(0, x - corners[i][0]) * width(result) / width(local), Math.max(0, y - corners[i][1]) * height(result) / height(local)]);
  }
  return result;
}

export function roundedPath(box, reverse = false) {
  const { left: l, top: t, right: r, bottom: b, radii: [tl, tr, br, bl] } = box;
  const arc = ([x, y], endX, endY, sweep) => x && y ? `A ${x} ${y} 0 0 ${sweep} ${endX} ${endY}` : `L ${endX} ${endY}`;
  return reverse
    ? `M ${l + tl[0]} ${t} ${arc(tl, l, t + tl[1], 0)} V ${b - bl[1]} ${arc(bl, l + bl[0], b, 0)} H ${r - br[0]} ${arc(br, r, b - br[1], 0)} V ${t + tr[1]} ${arc(tr, r - tr[0], t, 0)} Z`
    : `M ${l + tl[0]} ${t} H ${r - tr[0]} ${arc(tr, r, t + tr[1], 1)} V ${b - br[1]} ${arc(br, r - br[0], b, 1)} H ${l + bl[0]} ${arc(bl, l, b - bl[1], 1)} V ${t + tl[1]} ${arc(tl, l + tl[0], t, 1)} Z`;
}

function cornerCuts(shape) {
  const { left: l, top: t, right: r, bottom: b, radii: [tl, tr, br, bl] } = shape;
  return [
    { left: l, top: t, right: l + tl[0], bottom: t + tl[1], path: `M ${l} ${t} H ${l + tl[0]} A ${tl[0]} ${tl[1]} 0 0 0 ${l} ${t + tl[1]} Z` },
    { left: r - tr[0], top: t, right: r, bottom: t + tr[1], path: `M ${r} ${t} V ${t + tr[1]} A ${tr[0]} ${tr[1]} 0 0 0 ${r - tr[0]} ${t} Z` },
    { left: r - br[0], top: b - br[1], right: r, bottom: b, path: `M ${r} ${b} H ${r - br[0]} A ${br[0]} ${br[1]} 0 0 0 ${r} ${b - br[1]} Z` },
    { left: l, top: b - bl[1], right: l + bl[0], bottom: b, path: `M ${l} ${b} V ${b - bl[1]} A ${bl[0]} ${bl[1]} 0 0 0 ${l + bl[0]} ${b} Z` },
  ].filter(positive);
}

/** Nonzero winding: disjoint negative page rectangles, positive UI restorations. */
export function buildModeClip(viewport, holes, surfaces = [], rings = []) {
  const unique = [];
  for (const hole of holes) {
    const duplicate = unique.find((other) => ['left', 'top', 'right', 'bottom'].every((key) => Math.abs(hole[key] - other[key]) < EPSILON));
    if (duplicate) continue;
    if (unique.some((other) => intersects(other, hole))) throw new Error('Overlapping page holes');
    unique.push(hole);
  }
  const commands = [`M 0 0 H ${viewport.width} V ${viewport.height} H 0 Z`];
  for (const hole of unique) {
    commands.push(`M ${hole.left} ${hole.top} V ${hole.bottom} H ${hole.right} V ${hole.top} Z`);
    for (const clip of hole.clips || []) {
      for (const cut of cornerCuts(clip.shape)) {
        if (unique.some((other) => other !== hole && intersects(cut, other) && !other.clips?.some((candidate) => candidate.owner === clip.owner))) throw new Error('Corner restoration crosses another page');
        commands.push(cut.path);
      }
    }
  }
  for (const surface of surfaces) commands.push(roundedPath(surface));
  for (const ring of rings) {
    if (!contains(ring.outer, ring.inner)) throw new Error('Invalid native focus ring');
    commands.push(roundedPath(ring.outer), roundedPath(ring.inner, true));
  }
  return `path(nonzero, "${commands.join(' ')}")`;
}

export function isPresented(win, frame) {
  if (!frame?.isConnected || frame.closest('[hidden="true"],[collapsed="true"]')) return false;
  for (let node = frame; node && node !== win.document.documentElement; node = node.parentElement) {
    const style = win.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  return frame.getBoxQuads({ box: 'content' }).length > 0;
}

function focusRing(win, frame) {
  const panel = frame.closest('[data-bento-main-panel],[data-bento-panel-tab-id]');
  if (panel?.parentElement?.id !== 'tabbrowser-tabpanels') return null;
  const style = win.getComputedStyle(panel, '::after');
  const colors = [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
  if (colors.every((color) => color === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(color))) return null;
  const color = colors[0] || '';
  const alpha = color.includes('/') ? color.split('/').at(-1).replace(')', '').trim()
    : color.startsWith('rgba(') || color.startsWith('hsla(') ? color.slice(color.lastIndexOf(',') + 1, -1).trim() : '1';
  if (!colors.every((value) => value === color) || !/^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(/.test(color) ||
      (alpha.endsWith('%') ? Number.parseFloat(alpha) !== 100 : Number(alpha) !== 1)) throw new Error('Unsupported native focus ring color');
  const edges = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map((value) => Number.parseFloat(value));
  if (!edges.every((value) => Number.isFinite(value) && value > 0) || ['top', 'right', 'bottom', 'left'].some((key) => Number.parseFloat(style[key]) !== 0)) return null;
  const outer = shapeOf(win, panel, 'border', '::after');
  const layout = quadRect(panel.getBoxQuads({ box: 'border', ignoreTransforms: true })[0]);
  const [top, right, bottom, left] = edges.map((edge, i) => edge * (i % 2 ? width(outer) / width(layout) : height(outer) / height(layout)));
  const inner = { left: outer.left + left, top: outer.top + top, right: outer.right - right, bottom: outer.bottom - bottom,
    radii: outer.radii.map(([x, y], i) => [Math.max(0, x - (i === 0 || i === 3 ? left : right)), Math.max(0, y - (i < 2 ? top : bottom))]) };
  return positive(inner) ? { outer, inner } : null;
}

function settleNativeFocusRings(win, frames) {
  const panels = new Set(frames.filter((frame) => isPresented(win, frame))
    .map((frame) => frame.closest('[data-bento-main-panel],[data-bento-panel-tab-id]'))
    .filter((panel) => panel?.parentElement?.id === 'tabbrowser-tabpanels'));
  for (const panel of panels) {
    // Page-to-footer focus can leave this owned ring between opaque and
    // transparent. Capture its intended endpoint, without waiting another state
    // duration or finishing unrelated element/pseudo/layout animations.
    for (const animation of panel.getAnimations({ pseudoElement: '::after' })) {
      if (animation instanceof win.CSSTransition && animation.playState === 'running' &&
          animation.effect?.target === panel && animation.effect.pseudoElement === '::after' &&
          FOCUS_RING_COLORS.has(animation.transitionProperty)) animation.finish();
    }
    void win.getComputedStyle(panel, '::after').borderTopColor;
  }
}

export function collectModeClip(win, frames, prepared) {
  const viewport = { width: win.innerWidth, height: win.innerHeight };
  const bounds = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  const holes = [];
  const rings = [];
  const ringOwners = new Set();
  for (const frame of new Set(frames)) {
    if (!isPresented(win, frame)) continue;
    if (win.getComputedStyle(frame).objectFit !== 'fill') throw new Error('Non-fill page frame');
    const quads = frame.getBoxQuads({ box: 'content' });
    if (quads.length !== 1) throw new Error('Fragmented page frame');
    let box = intersection(quadRect(quads[0]), bounds);
    const clips = [];
    for (let node = frame.parentElement; node && node !== win.document.documentElement; node = node.parentElement) {
      const style = win.getComputedStyle(node);
      if (style.clipPath !== 'none' || (style.maskImage && style.maskImage !== 'none')) throw new Error('Unsupported native clipping');
      if (['overflowX', 'overflowY'].some((key) => ['clip', 'hidden', 'auto', 'scroll'].includes(style[key]))) {
        const shape = shapeOf(win, node, 'padding');
        box = intersection(box, shape);
        clips.push({ owner: node, shape });
      }
    }
    if (positive(box)) holes.push({ ...box, clips });
    const panel = frame.closest('[data-bento-main-panel],[data-bento-panel-tab-id]');
    if (panel && !ringOwners.has(panel)) {
      ringOwners.add(panel);
      const ring = focusRing(win, frame);
      if (ring) rings.push(ring);
    }
  }
  const surfaces = [];
  for (const { participant, response } of prepared) {
    for (let node = participant.frame; node && node !== win.document.documentElement; node = node.parentElement) {
      if (Number(win.getComputedStyle(node).opacity) !== 1) throw new Error('Translucent native host');
    }
    const geometry = response.geometry;
    if (!geometry || !(geometry.viewport.width > 0 && geometry.viewport.height > 0)) throw new Error('Missing shell geometry');
    const host = quadRect(participant.frame.getBoxQuads({ box: 'content' })[0]);
    const sx = width(host) / geometry.viewport.width;
    const sy = height(host) / geometry.viewport.height;
    for (const surface of geometry.surfaces) {
      const shape = scaledShape(surface.quad, surface.layout, surface.radii);
      surfaces.push({ left: host.left + shape.left * sx, top: host.top + shape.top * sy,
        right: host.left + shape.right * sx, bottom: host.top + shape.bottom * sy,
        radii: shape.radii.map(([x, y]) => [x * sx, y * sy]) });
    }
  }
  return buildModeClip(viewport, holes, surfaces, rings);
}

function movingAnimations(elements) {
  const result = new Set();
  for (const element of new Set(elements)) {
    for (const animation of element?.getAnimations?.() || []) {
      if (['idle', 'finished'].includes(animation.playState)) continue;
      if (!animation.effect?.getKeyframes().some((frame) => Object.keys(frame).some((key) => GEOMETRY_PROPERTIES.has(key)))) continue;
      if (animation.playState === 'paused' || !Number.isFinite(Number(animation.effect.getComputedTiming().endTime))) throw new Error('Unbounded geometry motion');
      result.add(animation);
    }
  }
  return [...result];
}

const equalTarget = (a, b) => a?.pref === b?.pref && a?.resolved === b?.resolved && a?.stamp?.run === b?.stamp?.run && a?.stamp?.seq === b?.stamp?.seq;
function timeMs(value) {
  const text = value.trim();
  const n = Number.parseFloat(text);
  return Number.isFinite(n) && /m?s$/.test(text) ? n * (text.endsWith('ms') ? 1 : 1000) : NaN;
}

/** Parent-owned, per-window native mode transaction. All external values are owner grants. */
export function createModePresenter({ win, hub, getPageFrames, writeNative, onPhase = () => {} }) {
  const doc = win.document;
  const root = doc.documentElement;
  let generation = 0;
  let intent = 0;
  let active = null;
  let current = null;
  let disposed = false;
  let reading = null;
  let readingHint = null;
  const phase = (tx, value) => {
    tx.phase = value;
    onPhase({ generation: tx.generation, phase: value, pref: tx.desired.pref, resolved: tx.desired.resolved });
  };
  const documents = () => hub.modeDocuments(win).filter((participant) => participant.current());
  const visible = () => documents().filter((participant) => isPresented(win, participant.frame));
  const alive = (tx) => !disposed && active === tx && !tx.cancelled;
  const bounded = (promise) => new Promise((resolve, reject) => {
    const timer = win.setTimeout(() => reject(new Error('Mode participant timeout')), 5000);
    Promise.resolve(promise).then(resolve, reject).finally(() => win.clearTimeout(timer));
  });
  async function waitForNativeGeometry() {
    const selector = '.bento-side-panel-host--reordering,panel[panelopen="true"],menupopup[state="open"]';
    const blocker = doc.querySelector(selector);
    if (!blocker) return;
    let observer, check;
    const events = ['popuphidden', 'pointerup', 'pointercancel', 'dragend'];
    try {
      await bounded(new Promise((resolve) => {
        check = () => { if (!doc.querySelector(selector)) resolve(); };
        observer = new win.MutationObserver(check);
        observer.observe(blocker, { attributes: true, attributeFilter: ['class', 'state', 'panelopen'] });
        for (const name of events) win.addEventListener(name, check, true);
      }));
    } finally {
      observer?.disconnect();
      for (const name of events) win.removeEventListener(name, check, true);
    }
  }
  function release(tx) {
    for (const participant of tx.held || []) void participant.query('abort', { generation: tx.generation }).catch(() => {});
    tx.stopActivity?.();
  }
  function removeImage(tx) {
    tx.transition?.skipTransition();
    tx.animation?.cancel();
    if (root.getAttribute('data-bento-mode-presentation-generation') === String(tx.generation)) {
      root.removeAttribute(ATTRIBUTE);
      root.removeAttribute('data-bento-mode-presentation-ready');
      root.removeAttribute('data-bento-mode-presentation-generation');
      root.style.removeProperty(CLIP);
    }
  }
  function finish(tx) {
    if (!alive(tx)) return;
    tx.cancelled = true;
    removeImage(tx);
    release(tx);
    active = null;
    phase(tx, 'idle');
  }
  async function commitAll(tx, target) {
    if (!alive(tx)) throw new Error('Superseded native commit');
    if (!['fading', 'reversing'].includes(tx.phase)) phase(tx, 'committing');
    const prepared = tx.prepared || visible().map((participant) => ({ participant, response: null }));
    const commits = prepared.map(async ({ participant, response }) => {
      const reply = await bounded(participant.query('commit', {
        generation: tx.generation, target, hostGeneration: response?.hostGeneration,
      }));
      if (!alive(tx) || !participant.current() || reply?.generation !== tx.generation ||
          !reply.applied || !reply.styles || !reply.submitted ||
          typeof reply.documentNonce !== 'string' || (response && response.documentNonce !== reply.documentNonce)) throw new Error('Stale mode commit acknowledgement');
    });
    writeNative(target);
    await Promise.all(commits);
    if (!alive(tx)) throw new Error('Superseded native submission');
    // Child updateLayerTree waits for display-list receipt before its actor ACK.
    // One final parent fence flushes the shared scene-builder after those ACKs.
    win.windowUtils.updateLayerTree();
    win.windowUtils.syncFlushCompositor();
    current = target;
    tx.committed = target;
  }
  function queueCommit(tx, target) {
    tx.commits = tx.commits.then(() => commitAll(tx, target));
    return tx.commits;
  }
  function holdOpaque(tx) {
    tx.animation.pause();
    tx.animation.currentTime = 0;
    phase(tx, 'opaque');
    tx.ready = underCover(tx);
    void tx.ready.catch((error) => fail(tx, error));
  }
  function watchFinish(tx) {
    const promise = tx.animation.finished;
    if (promise === tx.finishedPromise) return;
    tx.finishedPromise = promise;
    void promise.then(() => {
      // Pausing at the opaque endpoint must happen before any actor await, or
      // PendingDone could destroy the image while old colours are restored.
      if (!alive(tx)) return;
      if (tx.direction < 0) holdOpaque(tx);
      else { tx.animation.pause(); finish(tx); }
    }, () => {});
  }
  function play(tx, direction) {
    if (!alive(tx)) return;
    tx.direction = direction;
    // play() auto-rewinds negative playback at zero to the effect end. This
    // endpoint is already opaque; keep it held while committing underneath.
    if (direction < 0 && tx.animation.currentTime !== null && tx.animation.currentTime <= 0) {
      holdOpaque(tx);
      return;
    }
    tx.animation.playbackRate = direction;
    tx.animation.play();
    phase(tx, direction < 0 ? 'reversing' : 'fading');
    watchFinish(tx);
  }
  function underCover(tx) {
    // Endpoint, activity and reveal callers join the same latest-target drain.
    if (tx.draining) return tx.draining;
    tx.draining = (async () => {
      do {
        const target = tx.desired;
        await queueCommit(tx, target);
        if (!alive(tx)) return;
      } while (!equalTarget(tx.committed, tx.desired));
      tx.resolve(tx.committed);
      if (!tx.animation || tx.instant || tx.desired.resolved === tx.old.resolved) finish(tx);
      else play(tx, 1);
    })().finally(() => { tx.draining = null; });
    return tx.draining;
  }
  async function fail(tx, error) {
    if (!alive(tx)) return;
    // Never display an unsafe stale-page mask on failure. Settle current
    // authenticated colours without animation and retire the owned capture.
    tx.instant = true;
    removeImage(tx);
    phase(tx, 'settling');
    try {
      tx.prepared = null;
      tx.commits = Promise.resolve();
      await underCover(tx);
    } catch {
      tx.reject(error);
      finish(tx);
    }
  }
  function observeActivity(tx) {
    const react = (event) => {
      if (event.target?.closest?.('[data-bento-mode-control],browser[id^="bento-"]')) return;
      api.activity({ generation: tx.generation, reason: event.type });
    };
    for (const name of ['pointerdown', 'pointermove', 'keydown', 'focusin', 'scroll', 'resize', 'popupshowing', 'dragstart', 'TabSelect']) win.addEventListener(name, react, true);
    const panelState = (element) => {
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height, element.classList.contains('bento-panel--focused'), element.classList.contains('bento-panel--cycle-focused'), element.hidden].join(':');
    };
    const panels = new Map(getPageFrames().map((frame) => frame.closest('[data-bento-panel-tab-id],[data-bento-main-panel]')).filter(Boolean).map((panel) => [panel, panelState(panel)]));
    const hosts = new Set(doc.querySelectorAll('#bento-shell-host,#bento-side-panel-host,#tabbrowser-tabpanels'));
    const observer = new win.MutationObserver((records) => {
      const changed = records.some((record) => {
        if (record.type === 'childList') return true;
        if (record.target === root || hosts.has(record.target)) return record.oldValue !== record.target.getAttribute(record.attributeName);
        return panels.get(record.target) !== panelState(record.target);
      });
      if (changed) api.activity({ generation: tx.generation, reason: 'layout' });
    });
    for (const panel of panels.keys()) observer.observe(panel, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    for (const host of hosts) observer.observe(host, { attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden'] });
    observer.observe(root, { attributes: true, attributeOldValue: true, attributeFilter: ['data-bento-theme'] });
    const deck = doc.getElementById?.('tabbrowser-tabpanels');
    if (deck) observer.observe(deck, { childList: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden'] });
    const sizes = new Map(getPageFrames().map((frame) => [frame, frame.getBoundingClientRect()]));
    const geometry = new win.ResizeObserver((entries) => {
      if (entries.some((entry) => {
        const before = sizes.get(entry.target);
        const after = entry.target.getBoundingClientRect();
        return !before || before.width !== after.width || before.height !== after.height;
      })) api.activity({ generation: tx.generation, reason: 'geometry' });
    });
    for (const frame of sizes.keys()) geometry.observe(frame);
    tx.stopActivity = () => {
      for (const name of ['pointerdown', 'pointermove', 'keydown', 'focusin', 'scroll', 'resize', 'popupshowing', 'dragstart', 'TabSelect']) win.removeEventListener(name, react, true);
      observer.disconnect();
      geometry.disconnect();
    };
  }
  async function begin(tx) {
    try {
      phase(tx, 'preparing');
      const animate = !tx.instant && current && !doc.hidden && !root.hasAttribute('bento-startup-loading') && tx.desired.resolved !== current.resolved;
      if (!animate) { tx.instant = true; await underCover(tx); return; }
      await waitForNativeGeometry();
      if (!alive(tx)) return;
      observeActivity(tx);
      const participants = visible();
      tx.held = participants;
      tx.prepared = await Promise.all(participants.map(async (participant) => {
        const response = await bounded(participant.query('prepare', { generation: tx.generation }));
        if (!response || response.generation !== tx.generation || !participant.current() || typeof response.documentNonce !== 'string') throw new Error('Mode participant unavailable');
        return { participant, response };
      }));
      const motionElements = [...getPageFrames(), ...participants.map((participant) => participant.frame.parentElement), ...doc.querySelectorAll('#bento-shell-host,[data-bento-main-panel],[data-bento-panel-tab-id]')];
      const moving = movingAnimations(motionElements);
      if (moving.length) await bounded(Promise.allSettled(moving.map((animation) => animation.finished)));
      if (!alive(tx)) return;
      if (tx.prepared.some(({ participant }) => !participant.current() || !isPresented(win, participant.frame))) throw new Error('Mode host changed during prepare');
      if (movingAnimations(motionElements).length || doc.querySelector('.bento-side-panel-host--reordering,panel[panelopen="true"],menupopup[state="open"]')) throw new Error('Geometry is moving');
      if (!tx.instant) {
        if (doc.activeViewTransition) throw new Error('Another native presentation is active');
        const frames = getPageFrames();
        settleNativeFocusRings(win, frames);
        const clip = collectModeClip(win, frames, tx.prepared);
        if (!win.CSS.supports('clip-path', clip)) throw new Error('Mode mask unsupported');
        root.style.setProperty(CLIP, clip);
        root.setAttribute('data-bento-mode-presentation-generation', String(tx.generation));
        root.setAttribute(ATTRIBUTE, 'theme');
        tx.transition = doc.startViewTransition();
        void tx.transition.finished.then(() => {
          if (alive(tx)) api.activity({ generation: tx.generation });
        }, () => {
          if (alive(tx)) api.activity({ generation: tx.generation });
        });
        phase(tx, 'capturing');
        await bounded(tx.transition.ready);
        if (!alive(tx) || doc.activeViewTransition !== tx.transition) throw new Error('Native capture replaced');
        // CSS already installs a finite paused unit effect. Own/configure it
        // synchronously in the ready reaction before the first actor await.
        const effects = doc.getAnimations().filter((animation) => animation.animationName === HOLD);
        if (effects.length !== 1) throw new Error('Native old-image hold missing');
        tx.animation = effects[0];
        tx.animation.pause();
        tx.animation.currentTime = 0;
        const style = win.getComputedStyle(root);
        const duration = timeMs(style.getPropertyValue('--muxui-semantic-motion-state-transition-duration'));
        const easing = style.getPropertyValue('--muxui-semantic-motion-state-transition-easing').trim();
        if (!Number.isFinite(duration) || duration < 0 || !easing) throw new Error('Mode motion tokens unavailable');
        tx.instant ||= duration === 0 || win.matchMedia('(prefers-reduced-motion: reduce)').matches;
        tx.animation.effect.setKeyframes([{ opacity: 1 }, { opacity: 0 }]);
        tx.animation.effect.updateTiming({ duration: duration || 1, easing, fill: 'both' });
        const expected = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div').style;
        expected.clipPath = clip;
        const old = win.getComputedStyle(root, '::view-transition-old(root)');
        if (!expected.clipPath || old.clipPath !== expected.clipPath || old.mixBlendMode !== 'normal' || old.pointerEvents !== 'none') throw new Error('Native old-image mask failed validation');
        root.setAttribute('data-bento-mode-presentation-ready', 'true');
        // The validated old pseudo was hidden. Fence its now-visible opaque
        // cover before any remote scene or native colour can change underneath.
        win.windowUtils.updateLayerTree();
        win.windowUtils.syncFlushCompositor();
        if (!alive(tx) || doc.activeViewTransition !== tx.transition) throw new Error('Native capture replaced');
        phase(tx, 'ready');
      }
      await underCover(tx);
    } catch (error) { await fail(tx, error); }
  }
  async function present(target) {
    if (disposed) throw new Error('Mode presenter closed');
    if (active) {
      const tx = active;
      tx.desired = target;
      if (tx.phase === 'fading' || tx.phase === 'reversing') {
        if (target.resolved === tx.old.resolved) play(tx, -1);
        else {
          if (!equalTarget(tx.committed, target)) void queueCommit(tx, target).catch((error) => fail(tx, error));
          play(tx, 1);
        }
      }
      return tx.ready;
    }
    const tx = { generation: ++generation, desired: target, old: current || target, prepared: null, commits: Promise.resolve(), instant: !current, cancelled: false, draining: null };
    tx.ready = new Promise((resolve, reject) => { tx.resolve = resolve; tx.reject = reject; });
    active = tx;
    void begin(tx);
    return tx.ready;
  }
  const api = {
    hasCommitted: () => current !== null,
    request(hint = {}) {
      if (disposed) return Promise.reject(new Error('Mode presenter closed'));
      if (reading && hint.pref === readingHint?.pref && hint.reason === readingHint?.reason) return reading;
      const ticket = ++intent;
      readingHint = hint;
      const read = hub.requestModeState(win).then((owner) => {
        if (disposed) return null;
        if (ticket !== intent) return reading === read ? null : reading;
        const resolved = owner.pref === 'system' ? (win.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : owner.pref;
        return present({ pref: owner.pref, resolved, stamp: owner.stamp });
      });
      reading = read;
      void read.finally(() => { if (reading === read) { reading = null; readingHint = null; } }).catch(() => {});
      return read;
    },
    async synchronizeDocument(participant) {
      if (!current) await api.request({ reason: 'register' });
      if (active && isPresented(win, participant.frame)) await api.settle();
      if (!participant.current() || !current) return null;
      const response = await bounded(participant.query('commit', { generation: ++generation, target: current, submit: false }));
      return response?.applied ? { ready: true } : null;
    },
    async prepareReveal(frame) {
      await api.request({ reason: 'reveal' });
      await api.settle();
      const participant = documents().find((candidate) => candidate.frame === frame);
      if (!participant) throw new Error('Mode writer not ready before reveal');
      return api.synchronizeDocument(participant);
    },
    activity({ generation: eventGeneration, participant } = {}) {
      const tx = active;
      if (!tx || (eventGeneration !== undefined && eventGeneration !== tx.generation) || (participant && !participant.current())) return false;
      tx.instant = true;
      if (tx.phase === 'fading' || tx.phase === 'reversing') {
        if (equalTarget(tx.committed, tx.desired)) finish(tx);
        else {
          removeImage(tx);
          phase(tx, 'settling');
          tx.ready = underCover(tx);
          void tx.ready.catch((error) => fail(tx, error));
        }
      }
      else { removeImage(tx); phase(tx, 'settling'); }
      return true;
    },
    async settle() {
      const tx = active;
      if (!tx) return;
      tx.instant = true;
      tx.animation?.pause();
      await tx.ready;
      // Initial ready can already be resolved while a reversal has a newer
      // desired target. Drain that target (or join its drain) before reveal.
      if (alive(tx)) {
        try { await underCover(tx); }
        catch (error) { await fail(tx, error); throw error; }
      }
    },
    documentClosed(id) {
      if (active?.prepared?.some((entry) => entry.participant.id === id)) api.activity({ generation: active.generation });
    },
    ownerChanged() {
      ++intent;
      if (active) api.activity({ generation: active.generation });
      void api.request({ reason: 'owner' }).catch(() => {});
    },
    dispose() {
      disposed = true;
      ++intent;
      if (active) {
        const tx = active;
        tx.cancelled = true;
        removeImage(tx);
        release(tx);
        tx.reject(new Error('Mode presenter closed'));
        active = null;
      }
    },
  };
  return api;
}
