/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bento shell bus relay: parent actor and parent-process hub.
//
// A shell document in a private window cannot reach the shell background over
// BroadcastChannel: Firefox partitions the channel by privateBrowsingId. The
// child actor forwards the document's 'bento-bus-up' CustomEvent here, and
// this hub hands it to the shell background (through the chrome-bridge
// experiment, bentoChrome.onBusMessage) together with the document id, window
// id and privacy that THIS process derives from the hosting chrome window. The
// page supplies only the message, never its own routing identity. Downward
// traffic goes back through postToDocument.
//
// Every upward record also carries `sessionId`, minted when this module loads, so it names one
// browser run: window ids repeat across runs, and tools scopes a window's durable operations
// to this pair, which survives a reload of tools or the shell background but not a restart.
//
// The actor attaches to every bento-shell extension frame in every window.
// Regular windows keep their BroadcastChannel path; only private-window
// documents and the Settings overlay use this one.

const SHELL_ADDON_ID = 'bento-shell@bento.app';
// Messages that arrive before the shell background listens (its first start,
// a dev reload) wait here, bounded.
const MAX_BACKLOG = 128;

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: 'resource://gre/modules/PrivateBrowsingUtils.sys.mjs',
});

// One browser run: the parent-process hub loads once and lives as long as the browser.
const SESSION_ID = Services.uuid.generateUUID().toString().slice(1, -1);

const documents = new Map();
const upListeners = new Set();
let backlog = [];

function windowIdOf(win) {
  try {
    const { Management } = ChromeUtils.importESModule('resource://gre/modules/Extension.sys.mjs');
    const id = Management.global?.windowTracker?.getId(win);
    return Number.isInteger(id) && id >= 0 ? id : null;
  } catch (err) {
    console.warn('[BentoShellBus] windowTracker.getId failed:', err);
    return null;
  }
}

function describeWindow(win) {
  if (!win || win.closed) return null;
  const windowId = windowIdOf(win);
  if (windowId === null) return null;
  return { windowId, isPrivate: lazy.PrivateBrowsingUtils.isWindowPrivate(win) };
}

function emitUp(record) {
  record = { ...record, sessionId: SESSION_ID };
  if (upListeners.size === 0) {
    backlog.push(record);
    if (backlog.length > MAX_BACKLOG) backlog.shift();
    return;
  }
  for (const listener of [...upListeners]) {
    try {
      listener(record);
    } catch (err) {
      console.error('[BentoShellBus] listener failed:', err);
    }
  }
}

export const BentoShellBusHub = {
  /** Registers the single consumer of upward messages and hands it the backlog. */
  onUp(listener) {
    upListeners.add(listener);
    const pending = backlog;
    backlog = [];
    for (const record of pending) {
      try {
        listener(record);
      } catch (err) {
        console.error('[BentoShellBus] listener failed:', err);
      }
    }
  },

  offUp(listener) {
    upListeners.delete(listener);
  },

  /** Sends a message down to one document. Returns false when it is gone. */
  postToDocument(documentId, message) {
    return documents.get(documentId)?.sendDown(message) ?? false;
  },

  /** An action raised by chrome itself (a menu item, a shortcut) for the shell
   * background, when the frame-script BroadcastChannel post cannot reach it
   * (private windows). Identity comes from the chrome window. */
  postFromChrome(win, message) {
    const info = describeWindow(win);
    if (!info) return false;
    emitUp({ documentId: null, ...info, message });
    return true;
  },
};

export class BentoShellBusParent extends JSWindowActorParent {
  #documentId = null;
  #info = null;

  // Window id and privacy are read once, while the hosting window is alive, so
  // the close notification can still name them.
  #identify() {
    if (this.#info) return this.#info;
    const policy = WebExtensionPolicy.getByID(SHELL_ADDON_ID);
    const uri = this.manager?.documentURI;
    if (!policy || uri?.scheme !== 'moz-extension' || uri.host !== policy.mozExtensionHostname) {
      return null;
    }
    const win = this.browsingContext?.top?.topChromeWindow;
    if (win?.document?.documentElement?.getAttribute('windowtype') !== 'navigator:browser') {
      return null;
    }
    this.#info = describeWindow(win);
    return this.#info;
  }

  receiveMessage(message) {
    if (message.name !== 'BentoShellBus:Up' || typeof message.data !== 'string') return;
    const info = this.#identify();
    if (!info) return;
    let parsed;
    try {
      parsed = JSON.parse(message.data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    if (!this.#documentId) {
      this.#documentId = Services.uuid.generateUUID().toString().slice(1, -1);
      documents.set(this.#documentId, this);
    }
    emitUp({ documentId: this.#documentId, ...info, message: parsed });
  }

  sendDown(message) {
    try {
      this.sendAsyncMessage('BentoShellBus:Down', JSON.stringify(message));
      return true;
    } catch {
      // The document went away between the lookup and the send.
      return false;
    }
  }

  didDestroy() {
    if (!this.#documentId) return;
    documents.delete(this.#documentId);
    if (this.#info) {
      emitUp({
        documentId: this.#documentId,
        ...this.#info,
        message: { kind: 'document-closed' },
      });
    }
    this.#documentId = null;
  }
}
