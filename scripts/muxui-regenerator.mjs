/**
 * Debounced, serialized regeneration: a change during a run queues exactly one
 * rerun, which starts when the current run finishes. `close()` drops the pending
 * timer and any queued rerun, and nothing starts afterwards; the caller stops an
 * in-flight run itself.
 */
export function createRegenerator(generate, delayMs = 200) {
  let running = false;
  let closed = false;
  let queued;
  let timer;
  async function start(reason) {
    running = true;
    try {
      await generate(reason);
    } finally {
      running = false;
    }
    if (!closed && queued !== undefined) {
      const next = queued;
      queued = undefined;
      await start(next);
    }
  }
  return {
    trigger(reason) {
      if (closed) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (running) queued = reason;
        else void start(reason);
      }, delayMs);
    },
    close() {
      closed = true;
      queued = undefined;
      clearTimeout(timer);
    },
  };
}
