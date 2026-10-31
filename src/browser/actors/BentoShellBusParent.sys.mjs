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
// a dev reload) wait here, bounded by count and by the total length of the
// document messages: a Settings import is a single message of up to the child
// actor's 22 Mi characters, so the length budget holds one of those with 2 Mi
// to spare, and a second large message pushes the oldest out instead of both
// piling up while nothing listens.
const MAX_BACKLOG = 128;
const MAX_BACKLOG_CHARS = 24 * 1024 * 1024;

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PrivateBrowsingUtils: 'resource://gre/modules/PrivateBrowsingUtils.sys.mjs',
});

// One browser run: the parent-process hub loads once and lives as long as the browser.
const SESSION_ID = Services.uuid.generateUUID().toString().slice(1, -1);

const documents = new Map();
const upListeners = new Set();
let backlog = []; // { record, chars }
let backlogChars = 0;
const modePresenters = new Map();
const modeReads = new Map();
let modeOwner = null;

function replaceModeOwner(owner) {
  if (modeOwner === owner) return;
  modeOwner = owner;
  for (const pending of [...modeReads.values()]) pending.finish(null);
  for (const presenter of modePresenters.values()) {
    try { presenter.ownerChanged(); } catch (error) { console.warn('[BentoShellBus] mode owner changed:', error); }
  }
}

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

// `chars` is the length of the document message the record carries (0 for a
// record chrome raised itself), counted against the backlog budget.
function emitUp(record, chars = 0) {
  record = { ...record, sessionId: SESSION_ID };
  if (upListeners.size === 0) {
    if (chars > MAX_BACKLOG_CHARS) return;
    backlog.push({ record, chars });
    backlogChars += chars;
    while (backlog.length > MAX_BACKLOG || backlogChars > MAX_BACKLOG_CHARS) {
      backlogChars -= backlog.shift().chars;
    }
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
    replaceModeOwner(listener);
    const pending = backlog.map((entry) => entry.record);
    backlog = [];
    backlogChars = 0;
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
    if (modeOwner === listener) replaceModeOwner(null);
  },

  registerModePresenter(win, presenter) {
    modePresenters.set(win, presenter);
    return () => {
      if (modePresenters.get(win) === presenter) modePresenters.delete(win);
    };
  },

  modeDocuments(win) {
    return [...documents.values()].map((actor) => actor.modeDocument(win)).filter(Boolean);
  },

  /** No backlog: a read belongs to this actual window and this background registration. */
  requestModeState(win) {
    const info = describeWindow(win);
    if (!info || !modeOwner || !win.document?.nodePrincipal?.isSystemPrincipal ||
        win.document.documentElement?.getAttribute('windowtype') !== 'navigator:browser') {
      return Promise.reject(new Error('Mode owner unavailable'));
    }
    const owner = modeOwner;
    const requestId = Services.uuid.generateUUID().toString().slice(1, -1);
    return new Promise((resolve, reject) => {
      let timer;
      const closed = () => finish(null);
      const finish = (response) => {
        if (!modeReads.delete(requestId)) return;
        win.clearTimeout(timer);
        win.removeEventListener?.('unload', closed);
        if (!response?.ok || win.closed || modeOwner !== owner ||
            windowIdOf(win) !== info.windowId) reject(new Error(response?.error || 'Mode owner replaced or closed'));
        else resolve(response);
      };
      modeReads.set(requestId, { owner, win, finish });
      win.addEventListener?.('unload', closed, { once: true });
      timer = win.setTimeout(() => finish(null), 5000);
      try {
        owner({ documentId: null, ...info, sessionId: SESSION_ID, message: { kind: 'mode-state-request', requestId } });
      } catch { finish(null); }
    });
  },

  replyModeState(owner, requestId, response) {
    const pending = modeReads.get(requestId);
    if (!owner || owner !== modeOwner || pending?.owner !== owner) return false;
    const valid = response?.ok === false || (response?.ok === true &&
      ['light', 'dark', 'system'].includes(response.pref) &&
      typeof response.stamp?.run === 'string' && response.stamp.run.length > 0 &&
      Number.isSafeInteger(response.stamp.seq) && response.stamp.seq >= 0);
    if (!valid) return false;
    pending.finish(response);
    return true;
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
  #modeWriter = false;
  #modeNativeWindow = null;
  #modeRequest = 0;

  #modeWindow() {
    if (!this.#identify() || this.browsingContext?.currentWindowGlobal !== this.manager) return null;
    const win = this.browsingContext?.top?.topChromeWindow;
    return win && !win.closed ? win : null;
  }

  modeDocument(win) {
    if (!this.#modeWriter || this.#modeWindow() !== win) return null;
    return {
      id: this.#documentId,
      frame: this.browsingContext.embedderElement,
      current: () => this.#modeWindow() === win,
      query: async (command, data) => {
        if (this.#modeWindow() !== win) throw new Error('Stale mode document');
        const response = await this.sendQuery('BentoShellBus:ModeCommand', { ...data, command, documentId: this.#documentId });
        if (this.#modeWindow() !== win || response?.documentId !== this.#documentId) throw new Error('Mode document navigated');
        return response;
      },
    };
  }

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
    if (['BentoShellBus:ModeRegister', 'BentoShellBus:ModeIntent', 'BentoShellBus:ModeActivity'].includes(message.name)) {
      const win = this.#modeWindow();
      const presenter = win && modePresenters.get(win);
      if (!presenter || !Number.isSafeInteger(message.data?.request) || message.data.request <= this.#modeRequest) return null;
      this.#modeRequest = message.data.request;
      if (!this.#documentId) {
        this.#documentId = Services.uuid.generateUUID().toString().slice(1, -1);
        documents.set(this.#documentId, this);
      }
      this.#modeWriter = true;
      this.#modeNativeWindow = win;
      const participant = this.modeDocument(win);
      if (message.name === 'BentoShellBus:ModeActivity') return presenter.activity({ participant, generation: message.data.generation, reason: message.data.reason });
      return message.name === 'BentoShellBus:ModeRegister'
        ? presenter.synchronizeDocument(participant)
        : presenter.request({ participant, request: message.data.request, pref: message.data.pref, reason: message.data.reason });
    }
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
    emitUp({ documentId: this.#documentId, ...info, message: parsed }, message.data.length);
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
    const win = this.#modeNativeWindow;
    modePresenters.get(win)?.documentClosed(this.#documentId);
    this.#modeWriter = false;
    this.#modeNativeWindow = null;
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
