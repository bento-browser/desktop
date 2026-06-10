// Per-tab session marker that records "this tab is a Bento panel in
// workspace X at slot N". Persists via browser.sessions.setTabValue,
// so it survives the close → Cmd+Shift+T restore round-trip — Firefox's
// SessionStore preserves session values across that path. The
// onCreated handler in background.ts reads the marker and inserts the
// restored tab into PanelStore at the recorded position.
//
// Position is kept in sync by syncPanelMarkersForWorkspace in
// background.ts: any add/remove/reorder rewrites every marker in the
// affected workspace with its current index, so the marker captures
// the slot the panel was in WHEN IT WAS CLOSED, not when it was added.
//
// Mirrors the TabRegistry's WORKSPACE_SESSION_KEY pattern.

const PANEL_SESSION_KEY = 'bento.isPanel';
const DEVTOOLS_PANEL_SESSION_KEY = 'bento.isDevtoolsPanel';
const SESSION_READ_RETRY_DELAY_MS = 50;

export interface PanelMarker {
  workspaceId: string;
  rootIndex: number;
  containingRootNodeId?: string;
  pinnedPanel?: boolean;
}

export async function setPanelMarker(
  tabId: number,
  workspaceId: string,
  marker: { rootIndex: number; containingRootNodeId?: string },
): Promise<void> {
  try {
    await browser.sessions.setTabValue(
      tabId,
      PANEL_SESSION_KEY,
      JSON.stringify({
        version: 2,
        workspaceId,
        rootIndex: marker.rootIndex,
        containingRootNodeId: marker.containingRootNodeId,
      }),
    );
  } catch (err) {
    console.warn('[bento-tools] setPanelMarker failed:', tabId, err);
  }
}

export async function clearPanelMarker(tabId: number): Promise<void> {
  try {
    await browser.sessions.removeTabValue(tabId, PANEL_SESSION_KEY);
  } catch {
    // removeTabValue throws if the key isn't set — safe to ignore;
    // the goal (no marker present) is satisfied either way.
  }
}

export async function setDevtoolsPanelMarker(tabId: number): Promise<void> {
  try {
    await browser.sessions.setTabValue(tabId, DEVTOOLS_PANEL_SESSION_KEY, '1');
  } catch (err) {
    console.warn('[bento-tools] setDevtoolsPanelMarker failed:', tabId, err);
  }
}

export async function clearDevtoolsPanelMarker(tabId: number): Promise<void> {
  try {
    await browser.sessions.removeTabValue(tabId, DEVTOOLS_PANEL_SESSION_KEY);
  } catch {
    // Desired end state is no marker.
  }
}

export async function readDevtoolsPanelMarker(tabId: number): Promise<boolean> {
  try {
    const value = await browser.sessions.getTabValue(tabId, DEVTOOLS_PANEL_SESSION_KEY);
    return value !== undefined && value !== null;
  } catch {
    return false;
  }
}

export async function readPanelMarker(tabId: number): Promise<PanelMarker | null> {
  try {
    const value = await browser.sessions.getTabValue(tabId, PANEL_SESSION_KEY);
    if (typeof value !== 'string') return null;
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.workspaceId === 'string') {
      if (parsed.version === 2) {
        return {
          workspaceId: parsed.workspaceId,
          rootIndex: typeof parsed.rootIndex === 'number' ? parsed.rootIndex : 0,
          containingRootNodeId:
            typeof parsed.containingRootNodeId === 'string'
              ? parsed.containingRootNodeId
              : undefined,
          pinnedPanel: parsed.pinnedPanel === true,
        };
      }
      return {
        workspaceId: parsed.workspaceId,
        rootIndex: typeof parsed.position === 'number' ? parsed.position : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function readPanelMarkerWithRetries(
  tabId: number,
  attempts = 8,
): Promise<PanelMarker | null> {
  for (let i = 0; i < attempts; i++) {
    const marker = await readPanelMarker(tabId);
    if (marker) return marker;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_READ_RETRY_DELAY_MS));
    }
  }
  return null;
}
