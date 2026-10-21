// The one writer for the shell-to-chrome title channel (title IPC).
//
// A document has a single title slot. The content process reports a title to
// chrome from a runnable queued by the first write, and that runnable reads the
// title when it runs. Any write made before it runs replaces the pending one,
// so chrome's 'pagetitlechanged' listener never sees the replaced title. That
// is not limited to one synchronous block: a message handler that writes
// BENTO_PANELS and a later task already in the queue (a React effect, the next
// bus message) that writes another sentinel both land before the report.
//
// sendChromeTitle writes the first title straight away and holds any title sent
// before the report has run. The next held title is released by a message on a
// private MessageChannel: each write is followed by a postMessage to itself,
// and the message handler writes the next title.
//
// Why a MessagePort and not setTimeout(0), with Firefox 154 sources:
// - The title write dispatches the report runnable synchronously
//   (Document.cpp:10131-10153 NotifyPossibleTitleChange) and the following
//   postMessage dispatches the delivery runnable (MessagePort.cpp:343-344,
//   :449). Both are Normal-priority main-thread dispatches (no
//   nsIRunnablePriority; ThreadEventTarget.cpp:90) and equal-priority tasks run
//   in dispatch order (TaskController.h:172-178), so the report runs first.
// - A zero-delay timeout has no such order: TimeoutManager::RunTimeout marks
//   every expired timeout up front and runs them in one task
//   (TimeoutManager.cpp:742-765), so a timeout created after an earlier
//   zero-delay one joins its batch and can write the next title before the
//   report runs.
//
// The channel is created on first use and reused for the document's lifetime;
// the browser tears the ports down with the window. Do not assign
// document.title anywhere else in a shell document (ESLint enforces this).

const queue: string[] = [];
let writing = false;
let channel: MessageChannel | undefined;

/** The port that posts to the release handler. */
function releasePort(): MessagePort {
  if (channel === undefined) {
    channel = new MessageChannel();
    // Assigning onmessage starts the port; addEventListener would need start().
    channel.port2.onmessage = writeNext;
  }
  return channel.port1;
}

function writeNext(): void {
  const title = queue.shift();
  if (title === undefined) {
    writing = false;
    return;
  }
  document.title = title;
  releasePort().postMessage(null);
}

export function sendChromeTitle(title: string): void {
  queue.push(title);
  if (writing) return;
  writing = true;
  writeNext();
}

/**
 * base64 of the UTF-8 JSON of `payload`, the tail of a payload title
 * (`BENTO_<NAME>:<timestamp>:<this>`). Chrome decodes it with the matching
 * `decodeURIComponent(escape(atob(...)))`, so non-ASCII text survives.
 */
export function encodeTitlePayload(payload: object): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}
