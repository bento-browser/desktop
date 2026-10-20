// Chrome reaches the welcome page with a frame script that calls content.postMessage
// (bento-shell-mount.js, WELCOME_HANDOFF_FRAME_SCRIPT_SRC). The page accepts only those messages.

/**
 * True for a `window` message that chrome's frame script posted. That script runs in a sandbox with
 * the system principal and no window, and for such a caller `GatherPostMessageData`
 * (nsGlobalWindowOuter.cpp) leaves the event's origin empty. Any web or extension page that posts
 * gets its own origin (`moz-extension://...`, `null`), so none of them passes this check.
 */
export function isChromeRelayMessage(event: MessageEvent): boolean {
  return event.origin === '';
}
