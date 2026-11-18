/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bento content-key bridge — parent actor.
//
// One instance per BrowsingContext in the parent process. Receives
// BentoKey:Cycle from the content child actor and dispatches it as a
// CustomEvent on the chrome window for bento-shell-mount.js, with the
// sender's top-level <browser>. Going through a CustomEvent (instead of
// stashing a callback on window) keeps the chrome script's handlers as
// closure-private as they were before the actor existed.
//
// The child runs in untrusted web content processes (the registration sets
// safeForUntrustedWebProcess), so a compromised process can send this message
// at any time. The message alone therefore never acts: the mount script cycles
// only by consuming a real key press it saw for that <browser>
// (takeContentKeyPress). This actor drops anything that is not a Cycle of 1 or
// -1 from a current document whose top-level <browser> belongs to the window,
// as one of its tabs (the main slot or a panel) or a Bento chrome frame showing
// a bento-shell page (the sidebar and palettes).

const BENTO_SHELL_ID = 'bento-shell@bento.app';

export class BentoKeyParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== 'BentoKey:Cycle') return;
    const direction = message.data?.direction;
    if (direction !== 1 && direction !== -1) return;
    if (!this.manager?.isCurrentGlobal) return;
    const bc = this.browsingContext;
    const win = bc.topChromeWindow;
    const browser = bc.top?.embedderElement;
    if (!win || !browser || browser.ownerDocument?.defaultView !== win) return;
    if (!win.gBrowser?.getTabForBrowser(browser)) {
      const principal = bc.top.currentWindowGlobal?.documentPrincipal;
      if (principal?.addonId !== BENTO_SHELL_ID) return;
    }
    try {
      win.dispatchEvent(new win.CustomEvent('BentoKey:Cycle', { detail: { direction, browser } }));
    } catch (err) {
      // Top chrome window may be tearing down (closing tab during
      // a bookmarklet, etc.) — drop the event silently.
      console.warn('[BentoKeyParent] dispatch failed:', err);
    }
  }
}
