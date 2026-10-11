// Test double for a shell document's title slot as chrome can observe it.
//
// Models the content-process behavior described in
// docs/core-functionality-technical.md ("Shell to chrome bridge"): the first
// write queues a report task, the task reads the title when it runs, and a
// write made before then replaces the pending title. `observed` is what chrome's
// 'pagetitlechanged' listener would see. Tasks are vitest fake timers, which run
// in the order they were queued; tests queue their own work with setTimeout to
// put a task ahead of a report.

import { vi } from 'vitest';

export function installFakeChromeTitle(documentProps: object = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  let title = '';
  let reportPending = false;
  const observed: string[] = [];
  vi.stubGlobal('document', {
    ...documentProps,
    get title() {
      return title;
    },
    set title(value: string) {
      title = value;
      if (reportPending) return;
      reportPending = true;
      setTimeout(() => {
        reportPending = false;
        observed.push(title);
      }, 0);
    },
  });
  return {
    observed,
    /** Runs every task queued within `ms` of fake time (default: 1 s). */
    settle: (ms = 1000) => vi.advanceTimersByTime(ms),
  };
}
