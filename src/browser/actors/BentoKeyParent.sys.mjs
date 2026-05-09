// Bento content-key bridge — parent actor.
//
// One instance per BrowsingContext in the parent process. Receives
// BentoKey:* messages from the content child actor and dispatches a
// CustomEvent on the chrome window for bento-shell-mount.js to handle.
// Going through a CustomEvent (instead of stashing a callback on
// window) keeps the chrome script's handlers as closure-private as
// they were before the actor existed.

export class BentoKeyParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== 'BentoKey:Cycle') return;
    const win = this.browsingContext.topChromeWindow;
    if (!win) return;
    try {
      win.dispatchEvent(
        new win.CustomEvent('BentoKey:Cycle', {
          detail: { direction: message.data.direction },
        }),
      );
    } catch (err) {
      // Top chrome window may be tearing down (closing tab during
      // a bookmarklet, etc.) — drop the event silently.
      console.warn('[BentoKeyParent] dispatch failed:', err);
    }
  }
}
