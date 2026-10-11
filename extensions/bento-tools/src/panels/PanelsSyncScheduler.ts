// Coalesces panels/sync requests. Many code paths ask for a sync in quick
// succession (a tab-update batch that refreshes the same workspace twice, a
// handler that mutates layout and width, several windows reacting to one
// activation). Each emit resolves every panel tab and broadcasts the whole
// payload to every shell document, so a burst should cost one message per
// workspace, not one per request.
//
// The window is one task (a microtask flush), not a timer: several callers
// time follow-up work against the emit, for example the 80 ms delay before
// closing the old main tab after a panel promotion, so the emit must not
// start noticeably later than the call.

export interface PanelsSyncOptions {
  scrollToPanelTabId?: number;
  scrollToPanelReveal?: 'full' | 'right-edge';
  windowId?: number;
}

interface PendingEmit {
  options: PanelsSyncOptions;
  done: Promise<void>;
}

/**
 * Wraps `emit` so requests for the same workspace and target window made in
 * one task share one call. The call runs when the task's synchronous work is
 * done, so it reads state after every mutation in the burst. Every caller
 * gets a promise that settles with that shared emit.
 *
 * A request that arrives after the shared call has started gets a new call:
 * the running one may already have read older state.
 *
 * The one-shot scroll target is the only option that can differ between
 * requests for the same key; the most recent target wins, and a request
 * without one never drops an earlier target.
 */
export function createPanelsSyncScheduler(
  emit: (workspaceId: string, options: PanelsSyncOptions) => Promise<void>,
): (workspaceId: string, options?: PanelsSyncOptions) => Promise<void> {
  const pending = new Map<string, PendingEmit>();

  return (workspaceId, options = {}) => {
    const key = `${workspaceId}\u0000${options.windowId ?? ''}`;
    const existing = pending.get(key);
    if (existing) {
      if (options.scrollToPanelTabId !== undefined) {
        existing.options = {
          ...existing.options,
          scrollToPanelTabId: options.scrollToPanelTabId,
          scrollToPanelReveal: options.scrollToPanelReveal,
        };
      }
      return existing.done;
    }

    const entry: PendingEmit = { options: { ...options }, done: Promise.resolve() };
    entry.done = new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        pending.delete(key);
        emit(workspaceId, entry.options).then(resolve, reject);
      });
    });
    pending.set(key, entry);
    return entry.done;
  };
}
