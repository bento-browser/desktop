// Bento content-key bridge — child actor.
//
// Lives in every web content document (one instance per BrowsingContext,
// see registerWindowActor in bento-shell-mount.js). Forwards a small
// allowlist of chrome-bound keys (currently ArrowLeft / ArrowRight for
// panel cycling) back to chrome via the parent actor, so panel
// navigation works while content has focus — without this, focus has
// to sit on the chrome panel container, which prevents page-bound
// keyboard extensions (Vimium, Surfingkeys, etc.) from receiving any
// keys.
//
// Filters:
//   - Modifier keys (alt/ctrl/meta/shift) → never forward; chrome's
//     own accelerator handlers cover modified shortcuts.
//   - Form / editable targets (input, textarea, contenteditable,
//     role=textbox) → never forward; the user is typing.
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
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!FORWARDED_KEYS.has(event.key)) return;
    if (isEditableTarget(event.composedTarget ?? event.target)) return;

    event.preventDefault();
    event.stopPropagation();
    this.sendAsyncMessage('BentoKey:Cycle', {
      direction: event.key === 'ArrowRight' ? 1 : -1,
    });
  }
}
