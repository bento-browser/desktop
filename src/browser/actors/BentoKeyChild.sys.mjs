/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Bento content-key bridge — child actor.
//
// Lives in every web content document (one instance per BrowsingContext,
// see registerWindowActor in bento-shell-mount.js). Forwards a small
// allowlist of chrome-bound keys (Cmd/Ctrl+Shift+ArrowLeft/Right for panel
// cycling, Cmd/Ctrl+ArrowLeft/Right for panel history, Cmd/Ctrl+E for the
// floating address bar) back to chrome, so panel navigation works while
// content has focus — without this, focus has to sit on the chrome panel
// container, which prevents page-bound
// keyboard extensions (Vimium, Surfingkeys, etc.) from receiving any
// keys.
//
// Filters:
//   - Plain ArrowLeft/Right stay in content for video scrubbing and page-local
//     keyboard behavior.
//   - Form / editable targets (input, textarea, contenteditable,
//     role=textbox) → never forward for panel cycling or history; text
//     selection stays editable.
//   - Already-defaultPrevented events → never forward; some page
//     handler claimed the key.

const FORWARDED_KEYS = new Set(['ArrowLeft', 'ArrowRight']);

function isEditableTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  const role = target.getAttribute && target.getAttribute('role');
  if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
  return false;
}

export class BentoKeyChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type !== 'keydown') return;
    if (event.defaultPrevented) return;
    if (!event.altKey && !event.shiftKey && event.code === 'KeyE') {
      const accel = event.metaKey || event.ctrlKey;
      const extraModifier = event.metaKey && event.ctrlKey;
      if (accel && !extraModifier) {
        event.preventDefault();
        event.stopPropagation();
        this.sendAsyncMessage('BentoKey:AddrbarOpen');
        return;
      }
    }
    if (!event.altKey && FORWARDED_KEYS.has(event.key)) {
      const accel = event.metaKey || event.ctrlKey;
      const extraModifier = event.metaKey && event.ctrlKey;
      if (accel && !extraModifier) {
        if (isEditableTarget(event.composedTarget ?? event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          this.sendAsyncMessage('BentoKey:Cycle', {
            direction: event.key === 'ArrowRight' ? 1 : -1,
          });
        } else {
          this.sendAsyncMessage('BentoKey:PanelHistory', {
            direction: event.key === 'ArrowRight' ? 1 : -1,
          });
        }
        return;
      }
    }
  }
}
