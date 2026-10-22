// Entry point for Action messages from the shell port. Every message is
// validated (parseWireAction) before it reaches the protocol handler, and a
// message that claims a source window is dropped unless that window exists.
// The listener never throws: invalid or stale messages are logged by type only
// (payloads can hold URLs and titles) and dropped.

import { parseWireAction } from '@shared/wire-action';
import type { Action } from '@shared/protocol';

interface WindowInfo {
  id?: number;
  incognito?: boolean;
}

interface WindowsApi {
  get(windowId: number): Promise<WindowInfo>;
  getAll(): Promise<WindowInfo[]>;
  onCreated: { addListener(listener: (window: WindowInfo) => void): void };
  onRemoved: { addListener(listener: (windowId: number) => void): void };
}

/**
 * How long a message for a window that no event or listing has announced waits before
 * `windows.get` is asked about it. A window announces itself only once it has a tab
 * browser, and a slow start (first window of a launch, a busy machine) can take several
 * seconds; dropping the window's first message, its `shell/hello`, leaves it without a
 * workspace for good because the shell sends it once.
 */
const WINDOW_ANNOUNCE_TIMEOUT_MS = 20_000;

/**
 * Remembers which windows exist. Window ids are not reused within a session, so a removed
 * id is remembered for good: a lookup that was already pending when the window closed must
 * not resolve into "live" again, or a queued shell/hello could reassign workspace ownership
 * to the closed window.
 *
 * A window is live once `windows.onCreated` or the listing at startup names it. Both only
 * name windows Firefox has finished loading. `windows.get` is not used on a window that
 * has not been announced yet: Firefox accepts an id for a window that is still starting
 * and then throws inside its own code while it builds the result
 * (`this.window.gBrowser is undefined`), because the shell frame of a new window can
 * send its first message before the window has a tab browser. Such a message waits for
 * the announcement instead (no probing in between: a probe of a window that is still
 * starting fails, and logs an error in Firefox, for an answer the announcement gives for
 * free) and is probed once only when none comes within `announceTimeoutMs`.
 */
export function createWindowRegistry(
  api: WindowsApi,
  announceTimeoutMs = WINDOW_ANNOUNCE_TIMEOUT_MS,
  /** Runs for every window the registry learns of, before it counts as live, so a
   * message for the window is never handled before the caller has seen the window
   * (a private window gets its Private workspace first). */
  onWindow: (window: WindowInfo) => void = () => {},
) {
  const live = new Set<number>();
  const removed = new Set<number>();
  const waiting = new Map<number, Set<() => void>>();
  const wake = (windowId: number) => {
    for (const resume of waiting.get(windowId) ?? []) resume();
    waiting.delete(windowId);
  };
  api.onCreated.addListener((window) => {
    if (typeof window.id !== 'number' || removed.has(window.id)) return;
    onWindow(window);
    live.add(window.id);
    wake(window.id);
  });
  api.onRemoved.addListener((windowId) => {
    live.delete(windowId);
    removed.add(windowId);
    wake(windowId);
  });
  // Windows that finished loading before the listener existed never fire onCreated.
  const listed = api
    .getAll()
    .then((windows) => {
      for (const window of windows) {
        if (typeof window.id !== 'number' || removed.has(window.id)) continue;
        onWindow(window);
        live.add(window.id);
      }
    })
    .catch(() => undefined);

  const announced = (windowId: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        const resumes = waiting.get(windowId);
        resumes?.delete(done);
        if (resumes?.size === 0) waiting.delete(windowId);
        resolve();
      };
      const timer = setTimeout(done, announceTimeoutMs);
      const resumes = waiting.get(windowId) ?? new Set();
      resumes.add(done);
      waiting.set(windowId, resumes);
    });

  return {
    isLive: (windowId: number) => live.has(windowId),
    /** Windows with a message still waiting for their announcement. */
    waitingWindows: () => waiting.size,
    async confirm(windowId: number): Promise<boolean> {
      if (live.has(windowId)) return true;
      if (removed.has(windowId)) return false;
      await listed;
      if (!live.has(windowId) && !removed.has(windowId)) await announced(windowId);
      if (live.has(windowId)) return true;
      if (removed.has(windowId)) return false;
      let found: WindowInfo;
      try {
        found = await api.get(windowId);
      } catch {
        return false;
      }
      if (removed.has(windowId)) return false;
      onWindow({ ...found, id: windowId });
      live.add(windowId);
      return true;
    },
  };
}

export type WindowRegistry = ReturnType<typeof createWindowRegistry>;

interface IntakeDeps {
  windows: WindowRegistry;
  /** Runs a validated action for the (existing) window it claims, or null. */
  run(action: Action, sourceWindowId: number | null): void;
}

/** One intake per port. Messages are delivered in arrival order. */
export function createShellActionIntake({ windows, run }: IntakeDeps) {
  // While a window check is in flight, later messages queue behind it so a
  // fast message cannot overtake an earlier one (e.g. snapshot before hello).
  let tail: Promise<void> | null = null;

  const deliver = (action: Action, windowId: number | null) => {
    try {
      run(action, windowId);
    } catch (err) {
      console.warn('[bento-tools] shell action failed:', action.type, err);
    }
  };

  return (message: unknown): void => {
    const parsed = parseWireAction(message);
    if (!parsed) {
      const type = (message as { type?: unknown } | null)?.type;
      console.warn(
        '[bento-tools] dropped invalid shell message:',
        typeof type === 'string' ? type.slice(0, 64) : typeof message,
      );
      return;
    }
    const { action, windowId } = parsed;
    // shell/hello registers the window named in its payload, so that window is
    // a claim too and must agree with the envelope.
    const helloWindowId = action.type === 'shell/hello' ? action.windowId : null;
    if (helloWindowId !== null && windowId !== null && helloWindowId !== windowId) {
      console.warn('[bento-tools] dropped shell/hello with mismatched window ids');
      return;
    }
    const claimedWindowId = windowId ?? helloWindowId;
    if (tail === null && (claimedWindowId === null || windows.isLive(claimedWindowId))) {
      deliver(action, windowId);
      return;
    }
    const step: Promise<void> = (tail ?? Promise.resolve())
      .then(async () => {
        if (claimedWindowId !== null && !(await windows.confirm(claimedWindowId))) {
          console.warn('[bento-tools] dropped shell action for unknown window:', action.type);
          return;
        }
        deliver(action, windowId);
      })
      .finally(() => {
        if (tail === step) tail = null;
      });
    tail = step;
  };
}
