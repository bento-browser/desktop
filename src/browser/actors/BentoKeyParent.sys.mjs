/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bento content-key bridge — parent actor.
//
// One instance per BrowsingContext in the parent process. Receives
// BentoKey:* messages from the content child actor and dispatches a
// CustomEvent on the chrome window for bento-shell-mount.js to handle.
// Going through a CustomEvent (instead of stashing a callback on
// window) keeps the chrome script's handlers as closure-private as
// they were before the actor existed.

export class BentoKeyParent extends JSWindowActorParent {
  // The child runs in untrusted web content processes (the registration sets
  // safeForUntrustedWebProcess), so treat message data as hostile: a direction
  // other than 1 or -1 is dropped, and the address mode is normalised.
  receiveMessage(message) {
    let eventName;
    let detail;
    if (message.name === 'BentoKey:AddrbarOpen') {
      eventName = message.name;
      detail = { mode: message.data?.mode === 'newTab' ? 'newTab' : 'current' };
    } else if (message.name === 'BentoKey:Cycle' || message.name === 'BentoKey:PanelHistory') {
      const direction = message.data?.direction;
      if (direction !== 1 && direction !== -1) return;
      eventName = message.name;
      detail = { direction };
    } else {
      return;
    }
    const win = this.browsingContext.topChromeWindow;
    if (!win) return;
    try {
      win.dispatchEvent(new win.CustomEvent(eventName, { detail }));
    } catch (err) {
      // Top chrome window may be tearing down (closing tab during
      // a bookmarklet, etc.) — drop the event silently.
      console.warn('[BentoKeyParent] dispatch failed:', err);
    }
  }
}
