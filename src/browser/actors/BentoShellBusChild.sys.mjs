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
// The parent decides whether the document is a bento-shell frame and who it
// belongs to; this side only moves strings.

const MAX_MESSAGE_CHARS = 8 * 1024 * 1024;

export class BentoShellBusChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type !== 'bento-bus-up') return;
    const detail = event.detail;
    if (typeof detail !== 'string' || detail.length > MAX_MESSAGE_CHARS) return;
    this.sendAsyncMessage('BentoShellBus:Up', detail);
  }

  receiveMessage(message) {
    if (message.name !== 'BentoShellBus:Down' || typeof message.data !== 'string') return;
    const win = this.contentWindow;
    if (!win) return;
    win.dispatchEvent(new win.CustomEvent('bento-bus-down', { detail: message.data }));
  }
}
