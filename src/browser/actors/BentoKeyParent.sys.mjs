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

const BENTO_SHELL_ID = 'bento-shell@bento.app';

export class BentoKeyParent extends JSWindowActorParent {
  // The child runs in untrusted web content processes (the registration sets
  // safeForUntrustedWebProcess), so a compromised process can send any message
  // at any time. The parent therefore acts only for a sender that is a real
  // key target (see senderWindow), drops a direction other than 1 or -1, and
  // normalises the address mode.
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
    const win = this.senderWindow();
    if (!win) return;
    try {
      win.dispatchEvent(new win.CustomEvent(eventName, { detail }));
    } catch (err) {
      // Top chrome window may be tearing down (closing tab during
      // a bookmarklet, etc.) — drop the event silently.
      console.warn('[BentoKeyParent] dispatch failed:', err);
    }
  }

  // The chrome window to dispatch on, or null to drop the message. A key reaches
  // only the focused document, so the sender must be the current global of the
  // focused content browsing context (the focused frame, not just its tab), and
  // its top-level <browser> must belong to that window: one of its tabs (the main
  // slot or a panel) or a Bento chrome frame showing a bento-shell page (the
  // sidebar and palettes). Anything else, such as a background tab, an unfocused
  // panel or frame, or a page left in the back-forward cache, is ignored.
  senderWindow() {
    if (!this.manager?.isCurrentGlobal) return null;
    const bc = this.browsingContext;
    const focused = Services.focus.focusedContentBrowsingContext;
    if (!focused || focused.id !== bc.id) return null;
    const win = bc.topChromeWindow;
    const browser = bc.top?.embedderElement;
    if (!win || !browser || browser.ownerDocument?.defaultView !== win) return null;
    if (win.gBrowser?.getTabForBrowser(browser)) return win;
    const principal = bc.top.currentWindowGlobal?.documentPrincipal;
    return principal?.addonId === BENTO_SHELL_ID ? win : null;
  }
}
