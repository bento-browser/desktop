import { dispatch } from '../bridge/useToolsPort';
import { useTabsStore } from '../state/tabs';
import { selectActiveIdForWindow, useWorkspacesStore } from '../state/workspaces';
import { SOFTCAST_STATES, softcastFixture, softcastFixtureUrl } from './softcast';

let started = false;

/** Called only by the demo-gated sidebar after the bus, snapshot and workspace exist. */
export function startSoftcastDemo(windowId: number, workspaceId: string): void {
  if (started) return;
  started = true;
  const shellUrl = location.href;
  let cursor = 0;
  let pendingUrl: string | null = null;
  let unsubscribe = () => {};
  const stop = () => {
    unsubscribe();
    clearTimeout(timeout);
    window.removeEventListener('pagehide', stop);
  };
  // A missing native acknowledgement stops the demo instead of leaving a permanent watcher.
  const timeout = setTimeout(() => {
    stop();
    console.warn('[softcast-demo] Fixture startup stopped before all tabs were acknowledged.');
  }, 30_000);
  const advance = () => {
    if (selectActiveIdForWindow(useWorkspacesStore.getState(), windowId) !== workspaceId) {
      stop();
      return;
    }
    const tabs = Object.values(useTabsStore.getState().byId);
    if (
      pendingUrl &&
      !tabs.some(
        (tab) =>
          tab.url === pendingUrl && tab.windowId === windowId && tab.workspaceId === workspaceId,
      )
    )
      return;
    pendingUrl = null;
    while (cursor < SOFTCAST_STATES.length) {
      const state = SOFTCAST_STATES[cursor++]!;
      if (tabs.some((tab) => softcastFixture(shellUrl, tab.url)?.state === state)) continue;
      pendingUrl = softcastFixtureUrl(shellUrl, state);
      dispatch({ type: 'tab/openUrl', url: pendingUrl, active: false, focusExisting: false });
      return;
    }
    stop();
  };
  unsubscribe = useTabsStore.subscribe(advance);
  window.addEventListener('pagehide', stop, { once: true });
  advance();
}
