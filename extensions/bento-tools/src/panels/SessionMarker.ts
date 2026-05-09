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

export interface PanelMarker {
  workspaceId: string;
  position: number;
}

export async function setPanelMarker(
  tabId: number,
  workspaceId: string,
  position: number,
): Promise<void> {
  try {
    await browser.sessions.setTabValue(
      tabId,
      PANEL_SESSION_KEY,
      JSON.stringify({ workspaceId, position }),
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

export async function readPanelMarker(tabId: number): Promise<PanelMarker | null> {
  try {
    const value = await browser.sessions.getTabValue(tabId, PANEL_SESSION_KEY);
    if (typeof value !== 'string') return null;
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed.workspaceId === 'string') {
      return {
        workspaceId: parsed.workspaceId,
        position: typeof parsed.position === 'number' ? parsed.position : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}
