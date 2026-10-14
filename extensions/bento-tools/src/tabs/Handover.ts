// A window that closes while another Bento window stays open adopts its live tabs into that
// window in chrome (gBrowser.adoptTab, in bento-shell-mount.js), so the pages keep their state.
// The mount script marks each adopted tab with a 'bento.handover' tab value; reading it is how
// tools tells that move from a user dragging a tab between windows, which does not keep the
// workspace binding. The value stays on the tab until it expires: both tabs.onDetached and
// tabs.onAttached read it, and neither is ordered against the other.

const HANDOVER_SESSION_KEY = 'bento.handover';

/** Longer than the events take to arrive, short enough that a leftover value (it rides the
 * session file) can never match a later drag between the same two windows. */
export const HANDOVER_TTL_MS = 15_000;

export interface HandoverMarker {
  from: number;
  to: number;
  at: number;
}

function isMarker(value: unknown): value is HandoverMarker {
  if (typeof value !== 'object' || value === null) return false;
  const marker = value as Record<string, unknown>;
  return (
    typeof marker.from === 'number' &&
    typeof marker.to === 'number' &&
    typeof marker.at === 'number'
  );
}

/**
 * Whether chrome just handed `tabId` over between these windows. Pass the window the tab left
 * (`onDetached`) or the one it arrived in (`onAttached`). A fresh marker is cleaned up once it
 * expires.
 */
export async function wasHandedOver(
  tabId: number,
  windows: { from: number } | { to: number },
): Promise<boolean> {
  let marker: unknown;
  try {
    marker = await browser.sessions.getTabValue(tabId, HANDOVER_SESSION_KEY);
  } catch {
    return false;
  }
  if (!isMarker(marker) || Date.now() - marker.at > HANDOVER_TTL_MS) return false;
  if ('from' in windows ? marker.from !== windows.from : marker.to !== windows.to) return false;
  setTimeout(() => {
    browser.sessions.removeTabValue(tabId, HANDOVER_SESSION_KEY).catch(() => {
      // The tab closed or the value is already gone.
    });
  }, HANDOVER_TTL_MS);
  return true;
}
