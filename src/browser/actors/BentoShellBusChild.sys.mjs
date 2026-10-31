/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bento shell bus relay: child actor. See BentoShellBusParent.sys.mjs.
//
// Lives in every moz-extension document (registered by bento-shell-mount.js,
// one instance per window global). The shell document hands it a JSON string
// as the detail of a 'bento-bus-up' CustomEvent; messages from the shell
// background come back as a 'bento-bus-down' CustomEvent with a JSON string
// detail. Strings only: no content object crosses the privilege boundary.
// The parent decides whether bus traffic belongs to a bento-shell frame. The
// host-presentation query separately validates the own shell document and
// acknowledges its root update before chrome reveals the native host.

// Limit on the serialized message, so JSON escaping counts: a 10 MiB backup file import is two
// times that at worst (quotes and newlines become two characters). Keep equal to
// RELAY_UP_MAX_CHARS in extensions/bento-shell/src/settings-palette/relayLimit.ts.
const MAX_MESSAGE_CHARS = 22 * 1024 * 1024;
const SHELL_ADDON_ID = 'bento-shell@bento.app';
// These are the public opaque surfaces. Menu popup/positioner wrappers and
// scrims are transparent; only the menu BODY belongs in the old UI mask.
const MODE_SURFACES = '.muxui-command-palette__popup,.muxui-dialog,.muxui-alert-dialog__popup,.muxui-menu,.muxui-popover,.muxui-tooltip';
const GEOMETRY_PROPERTIES = new Set(['opacity', 'transform', 'translate', 'scale', 'rotate', 'filter', 'clipPath', 'width', 'height', 'left', 'top', 'right', 'bottom']);

function ownModeDocument(actor) {
  const doc = actor.document;
  const win = doc?.defaultView;
  const root = doc?.documentElement;
  const policy = WebExtensionPolicy.getByID(SHELL_ADDON_ID);
  if (!win || win.document !== doc || !root || !policy) return null;
  const url = new win.URL(doc.documentURI);
  if (url.protocol !== 'moz-extension:' || url.hostname !== policy.mozExtensionHostname ||
      new win.URLSearchParams(url.hash.slice(1)).get('bentoNativeMode') !== '1') return null;
  return { doc, win, root };
}

function visibleSurface(win, element) {
  const style = win.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
}

function surfaceMotion(doc) {
  const animations = new Set();
  const checked = new Set();
  for (const surface of doc.querySelectorAll(MODE_SURFACES)) {
    for (let node = surface; node && node !== doc.documentElement; node = node.parentElement) {
      if (checked.has(node)) break;
      checked.add(node);
      for (const animation of node.getAnimations()) {
        if (animation.playState === 'finished' || animation.playState === 'idle') continue;
        const effect = animation.effect;
        if (effect?.getKeyframes().some((frame) => Object.keys(frame).some((key) => GEOMETRY_PROPERTIES.has(key)))) {
          if (animation.playState === 'paused' || !Number.isFinite(Number(effect.getComputedTiming().endTime))) throw new Error('Unbounded surface geometry motion');
          animations.add(animation);
        }
      }
    }
  }
  return [...animations];
}

function opaqueColor(color) {
  if (!color || color === 'transparent') return false;
  if (!/^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\(/.test(color)) return false;
  const alpha = color.includes('/') ? color.split('/').at(-1).replace(')', '').trim()
    : color.startsWith('rgba(') || color.startsWith('hsla(') ? color.slice(color.lastIndexOf(',') + 1, -1).trim() : '1';
  return alpha.endsWith('%') ? Number.parseFloat(alpha) === 100 : Number(alpha) === 1;
}

function modeSurfaceGeometry({ doc, win }) {
  const surfaces = [];
  for (const element of doc.querySelectorAll(MODE_SURFACES)) {
    if (!visibleSurface(win, element)) continue;
    const quads = element.getBoxQuads({ box: 'border' });
    if (quads.length === 0) continue;
    if (quads.length !== 1) throw new Error('Fragmented mode surface');
    const style = win.getComputedStyle(element);
    if (Number(style.opacity) !== 1 || style.filter !== 'none' || style.backdropFilter !== 'none' || !opaqueColor(style.backgroundColor)) {
      throw new Error('Translucent mode surface');
    }
    const bounds = quads[0].getBounds();
    for (let node = element.parentElement; node && node !== doc.documentElement; node = node.parentElement) {
      const ancestor = win.getComputedStyle(node);
      if (Number(ancestor.opacity) !== 1 || ancestor.filter !== 'none' || ancestor.backdropFilter !== 'none') throw new Error('Translucent surface ancestor');
      if (['overflowX', 'overflowY'].some((key) => ['clip', 'hidden', 'auto', 'scroll'].includes(ancestor[key]))) {
        const clip = node.getBoxQuads({ box: 'padding' })[0]?.getBounds();
        if (!clip || bounds.left < clip.left || bounds.right > clip.right || bounds.top < clip.top || bounds.bottom > clip.bottom) throw new Error('Clipped opaque surface');
      }
    }
    const layout = element.getBoxQuads({ box: 'border', ignoreTransforms: true });
    if (layout.length !== 1) throw new Error('Missing surface layout');
    const quad = (value) => Object.fromEntries(['p1', 'p2', 'p3', 'p4'].map((key) => [key, { x: value[key].x, y: value[key].y }]));
    surfaces.push({ quad: quad(quads[0]), layout: quad(layout[0]), radii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius] });
  }
  return { surfaces, viewport: { width: win.innerWidth, height: win.innerHeight } };
}

function submitModeDocument(win) {
  // This synchronously waits for the child transaction's receipt. The parent
  // performs the one shared scene-builder flush after all child ACKs.
  win.windowUtils.updateLayerTree();
}

export class BentoShellBusChild extends JSWindowActorChild {
  #presentationGeneration = -1;
  #modeGeneration = -1;
  #modeQuery = 0;
  handleEvent(event) {
    if (event.type === 'bento-mode-up') {
      try {
        const context = ownModeDocument(this);
        if (!context || typeof event.detail !== 'string' || event.detail.length > 2048 ||
            context.root.getAttribute('data-bento-mode-writer') !== '1') return;
        const data = JSON.parse(event.detail);
        if (!Number.isSafeInteger(data.request) || !['register', 'intent', 'activity'].includes(data.kind)) return;
        const suffix = data.kind === 'register' ? 'ModeRegister' : data.kind === 'activity' ? 'ModeActivity' : 'ModeIntent';
        void this.sendQuery(`BentoShellBus:${suffix}`, data).catch(() => {});
      } catch { /* A destroyed actor cannot redirect a writer into a new document. */ }
      return;
    }
    if (event.type !== 'bento-bus-up') return;
    const detail = event.detail;
    if (typeof detail !== 'string' || detail.length > MAX_MESSAGE_CHARS) return;
    this.sendAsyncMessage('BentoShellBus:Up', detail);
  }

  receiveMessage(message) {
    if (message.name === 'BentoShellBus:ModeCommand') return this.#modeCommand(message.data);
    if (message.name === 'BentoShellBus:HostPresentation') {
      try {
        const doc = this.document;
        const win = doc?.defaultView;
        const root = doc?.documentElement;
        const { presented, generation } = message.data ?? {};
        if (
          !win ||
          win.document !== doc ||
          !root ||
          typeof presented !== 'boolean' ||
          !Number.isSafeInteger(generation) ||
          generation < 0
        )
          return null;
        const policy = WebExtensionPolicy.getByID(SHELL_ADDON_ID);
        const url = new win.URL(doc.documentURI);
        if (
          !policy ||
          url.protocol !== 'moz-extension:' ||
          url.hostname !== policy.mozExtensionHostname ||
          new win.URLSearchParams(url.hash.slice(1)).get('bentoHostedOverlay') !== '1'
        )
          return null;
        if (generation < this.#presentationGeneration) return null;
        this.#presentationGeneration = generation;
        root.setAttribute('data-bento-host-presented', String(presented));
        doc.dispatchEvent(new win.CustomEvent('bento-host-presentation'));
        return { presented, generation };
      } catch {
        // The actor/document can be destroyed while its query is in flight.
        return null;
      }
    }
    if (message.name !== 'BentoShellBus:Down' || typeof message.data !== 'string') return;
    const win = this.contentWindow;
    if (!win) return;
    win.dispatchEvent(new win.CustomEvent('bento-bus-down', { detail: message.data }));
  }

  async #modeCommand(data) {
    try {
      const context = ownModeDocument(this);
      if (!context || !Number.isSafeInteger(data?.generation) || data.generation < this.#modeGeneration ||
          !['prepare', 'commit', 'abort'].includes(data.command) || typeof data.documentId !== 'string' ||
          (data.hostGeneration !== undefined && data.hostGeneration !== this.#presentationGeneration)) return null;
      this.#modeGeneration = data.generation;
      const queryId = String(++this.#modeQuery);
      context.root.removeAttribute('data-bento-mode-response');
      context.doc.dispatchEvent(new context.win.CustomEvent('bento-mode-command', {
        detail: JSON.stringify({ ...data, queryId }),
      }));
      const response = JSON.parse(context.root.getAttribute('data-bento-mode-response') || 'null');
      if (response?.queryId !== queryId || response.generation !== data.generation) return null;
      let geometry;
      if (data.command === 'prepare') {
        const moving = surfaceMotion(context.doc);
        if (moving.length) await Promise.allSettled(moving.map((animation) => animation.finished));
        if (surfaceMotion(context.doc).length) throw new Error('Surface geometry changed during prepare');
        geometry = modeSurfaceGeometry(context);
      }
      if (ownModeDocument(this)?.doc !== context.doc || this.#modeGeneration !== data.generation ||
          (data.hostGeneration !== undefined && data.hostGeneration !== this.#presentationGeneration)) return null;
      if (data.command === 'commit' && data.submit !== false) submitModeDocument(context.win);
      return { ...response, documentId: data.documentId, geometry, hostGeneration: this.#presentationGeneration,
        presented: context.root.getAttribute('data-bento-host-presented') !== 'false', submitted: data.command === 'commit' && data.submit !== false };
    } catch { return null; }
  }
}
