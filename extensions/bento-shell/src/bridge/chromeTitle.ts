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
// before the next task. The release timer is queued after the report runnable,
// so every title is observable by chrome, in send order, with no polling.
// Do not assign document.title anywhere else in a shell document (ESLint
// enforces this).

const queue: string[] = [];
let writing = false;

function writeNext(): void {
  const title = queue.shift();
  if (title === undefined) {
    writing = false;
    return;
  }
  document.title = title;
  setTimeout(writeNext, 0);
}

export function sendChromeTitle(title: string): void {
  queue.push(title);
  if (writing) return;
  writing = true;
  writeNext();
}
