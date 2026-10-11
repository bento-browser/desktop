// Entry point for Action messages from the shell port. Every message is
// validated (parseWireAction) before it reaches the protocol handler, and a
// message that claims a source window is dropped unless that window exists.
// The listener never throws: invalid or stale messages are logged by type only
// (payloads can hold URLs and titles) and dropped.

import { parseWireAction } from '@shared/wire-action';
import type { Action } from '@shared/protocol';

interface WindowsApi {
  get(windowId: number): Promise<unknown>;
  onRemoved: { addListener(listener: (windowId: number) => void): void };
}

/**
 * Remembers windows confirmed to exist so only the first message per window
 * pays for browser.windows.get. Window ids are not reused within a session, so
 * onRemoved is the only invalidation needed.
 */
export function createWindowRegistry(api: WindowsApi) {
  const live = new Set<number>();
  api.onRemoved.addListener((windowId) => live.delete(windowId));
  return {
    isLive: (windowId: number) => live.has(windowId),
    async confirm(windowId: number): Promise<boolean> {
      if (live.has(windowId)) return true;
      try {
        await api.get(windowId);
      } catch {
        return false;
      }
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
