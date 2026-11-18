/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bento content-key bridge — child actor.
//
// Lives in every web content document (one instance per BrowsingContext,
// see registerWindowActor in bento-shell-mount.js). Forwards
// Cmd/Ctrl+Shift+ArrowLeft/Right to chrome for panel cycling, so panel
// navigation works while content has focus — without this, focus has
// to sit on the chrome panel container, which prevents page-bound
// keyboard extensions (Vimium, Surfingkeys, etc.) from receiving any
// keys. Chrome cycles only against a key press it saw itself
// (takeContentKeyPress in bento-shell-mount.js), so this actor cannot cycle
// without one. Cmd/Ctrl+ArrowLeft/Right (panel history) and Cmd/Ctrl+L/E/T
// (address entry) are not forwarded: chrome's keydown handlers take them
// before content sees them.
//
// Filters:
//   - Plain ArrowLeft/Right stay in content for video scrubbing and page-local
//     keyboard behavior.
//   - Form / editable targets (input, textarea, contenteditable,
//     role=textbox) → never forward; text selection stays editable.
//   - Already-defaultPrevented events → never forward; some page
//     handler claimed the key.

const FORWARDED_KEYS = new Set(['ArrowLeft', 'ArrowRight']);

function isEditableTarget(target) {
  if (!target) return false;
  // localName, not tagName: XHTML pages keep tagName lowercase.
  const tag = target.localName;
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  const role = target.getAttribute && target.getAttribute('role');
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
  return false;
}

function hasPlatformAccel(event) {
  if (typeof event.getModifierState === 'function') {
    return event.getModifierState('Accel');
  }
  return event.metaKey || event.ctrlKey;
}

export class BentoKeyChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type !== 'keydown' || event.defaultPrevented) return;
    if (event.altKey || !event.shiftKey || !FORWARDED_KEYS.has(event.key)) return;
    if (!hasPlatformAccel(event) || (event.metaKey && event.ctrlKey)) return;
    if (isEditableTarget(event.composedTarget ?? event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    this.sendAsyncMessage('BentoKey:Cycle', {
      direction: event.key === 'ArrowRight' ? 1 : -1,
    });
  }
}
