// Test double for a shell document's main thread and title slot, as chrome can
// observe them (docs/core-functionality-technical.md, "Shell to chrome bridge").
//
// It models the Gecko behavior the title writer depends on:
// - One FIFO task queue. The title report, MessagePort deliveries, the timeout
//   executor, and tasks the test queues are all tasks on it, run in dispatch
//   order (Normal priority; Document.cpp NotifyPossibleTitleChange, MessagePort.cpp
//   Dispatch, TimeoutExecutor.cpp ScheduleImmediate).
// - The first title write queues a report task; the task reads the title when it
//   runs, and a write made before then replaces the pending title. `observed` is
//   what chrome's 'pagetitlechanged' listener would see.
// - One timeout executor task per batch. Every timeout already expired when the
//   executor runs fires inside that one task, including a zero-delay timeout
//   created after the executor was queued (TimeoutManager.cpp RunTimeout).
//   Timeouts created while the batch runs wait for the next executor task.
// - A MessagePort delivers one message per task, and a port starts only when
//   onmessage is assigned or start() is called (MessagePort.cpp).
//
// setTimeout, clearTimeout, setInterval, clearInterval, MessageChannel, and
// document are stubbed globals on a virtual clock; unstub them with
// vi.unstubAllGlobals(). Microtasks are the real ones, so tests that need them
// to run `await` before calling settle().

import { vi } from 'vitest';

interface Timeout {
  id: number;
  seq: number;
  due: number;
  interval?: number;
  callback: () => void;
}

export function installFakeChromeTitle(documentProps: object = {}) {
  const tasks: Array<() => void> = [];
  let timeouts: Timeout[] = [];
  let now = 0;
  let nextId = 1;
  let executorQueued = false;
  let channelsCreated = 0;
  let title = '';
  let reportPending = false;
  const observed: string[] = [];

  function runTasks(): void {
    for (let task = tasks.shift(); task; task = tasks.shift()) task();
  }

  function sortTimeouts(): void {
    timeouts.sort((a, b) => a.due - b.due || a.seq - b.seq);
  }

  function armExecutor(): void {
    const first = timeouts[0];
    if (executorQueued || !first || first.due > now) return;
    executorQueued = true;
    tasks.push(runExpiredTimeouts);
  }

  function runExpiredTimeouts(): void {
    executorQueued = false;
    const batch = timeouts.filter((timeout) => timeout.due <= now);
    for (const timeout of batch) {
      if (!timeouts.includes(timeout)) continue; // cleared by an earlier callback
      if (timeout.interval === undefined) {
        timeouts = timeouts.filter((other) => other !== timeout);
      } else {
        timeout.due = now + Math.max(1, timeout.interval);
      }
      timeout.callback();
    }
    sortTimeouts();
    armExecutor();
  }

  function addTimeout(callback: () => void, delay: number, repeat: boolean): number {
    const id = nextId++;
    timeouts.push({
      id,
      seq: id,
      due: now + delay,
      interval: repeat ? delay : undefined,
      callback,
    });
    sortTimeouts();
    armExecutor();
    return id;
  }

  function clearTimer(id: unknown): void {
    timeouts = timeouts.filter((timeout) => timeout.id !== id);
  }

  class FakeMessagePort {
    other!: FakeMessagePort;
    private handler: ((event: { data: unknown }) => void) | null = null;
    private started = false;
    private inbox: unknown[] = [];
    private deliveryQueued = false;

    get onmessage() {
      return this.handler;
    }

    set onmessage(handler: ((event: { data: unknown }) => void) | null) {
      this.handler = handler;
      this.start();
    }

    start(): void {
      this.started = true;
      this.dispatch();
    }

    postMessage(data: unknown): void {
      this.other.inbox.push(data);
      this.other.dispatch();
    }

    private dispatch(): void {
      if (!this.started || this.deliveryQueued || this.inbox.length === 0) return;
      this.deliveryQueued = true;
      const data = this.inbox.shift();
      tasks.push(() => {
        this.handler?.({ data });
        this.deliveryQueued = false;
        this.dispatch();
      });
    }
  }

  class FakeMessageChannel {
    port1 = new FakeMessagePort();
    port2 = new FakeMessagePort();

    constructor() {
      this.port1.other = this.port2;
      this.port2.other = this.port1;
      channelsCreated += 1;
    }
  }

  vi.stubGlobal('setTimeout', (callback: () => void, delay = 0) =>
    addTimeout(callback, delay, false),
  );
  vi.stubGlobal('setInterval', (callback: () => void, delay = 0) =>
    addTimeout(callback, delay, true),
  );
  vi.stubGlobal('clearTimeout', clearTimer);
  vi.stubGlobal('clearInterval', clearTimer);
  vi.stubGlobal('MessageChannel', FakeMessageChannel);
  vi.stubGlobal('document', {
    ...documentProps,
    get title() {
      return title;
    },
    set title(value: string) {
      title = value;
      if (reportPending) return;
      reportPending = true;
      tasks.push(() => {
        reportPending = false;
        observed.push(title);
      });
    },
  });

  return {
    observed,
    /** Queues a plain main-thread task (a bus message, a React effect). */
    queueTask: (task: () => void) => void tasks.push(task),
    /** Number of MessageChannels the document has created. */
    channelsCreated: () => channelsCreated,
    /** Runs every task, and every timeout due within `ms` of virtual time (default 1 s). */
    settle: (ms = 1000) => {
      const end = now + ms;
      for (;;) {
        runTasks();
        const next = timeouts[0];
        if (!next || next.due > end) break;
        now = Math.max(now, next.due);
        armExecutor();
      }
      now = end;
    },
  };
}
