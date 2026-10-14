// A window that closes while another Bento window stays open adopts its live tabs into that
// window in chrome (gBrowser.adoptTab, in bento-shell-mount.js), so the pages keep their state.
// The mount script appends a hop (the two window ids and a time) to each adopted tab's
// 'bento.handover' tab value; reading it is how tools tells that move from a user dragging a
// tab between windows, which does not keep the workspace binding. A tab can be handed on again
// before tools has seen its first hop (two windows closing in one task), so the value is a list
// and each hop is matched once per side: a later drag of the same tab between the same two
// windows is not mistaken for it.

const HANDOVER_SESSION_KEY = 'bento.handover';

/** Longer than the events take to arrive, short enough that a leftover value (it rides the
 * session file) can never match a later drag between the same two windows. */
export const HANDOVER_TTL_MS = 15_000;

/** Values older than this tools instance belong to a previous run, whose window ids repeat. */
const STARTED_AT = Date.now();

interface Hop {
  from: number;
  to: number;
  at: number;
}

function isHop(value: unknown): value is Hop {
  if (typeof value !== 'object' || value === null) return false;
  const hop = value as Record<string, unknown>;
  return typeof hop.from === 'number' && typeof hop.to === 'number' && typeof hop.at === 'number';
}

function isFresh(hop: Hop): boolean {
  return hop.at >= STARTED_AT && Date.now() - hop.at <= HANDOVER_TTL_MS;
}

async function readHops(tabId: number): Promise<Hop[]> {
  try {
    const value = await browser.sessions.getTabValue(tabId, HANDOVER_SESSION_KEY);
    return Array.isArray(value) ? value.filter(isHop) : [];
  } catch {
    return [];
  }
}

/** Hop sides already matched: `tab:at:from:to:side` to the hop's time, pruned as hops expire. */
const matched = new Map<string, number>();

/**
 * Whether chrome just handed `tabId` over between these windows. Pass the window the tab left
 * (`onDetached`) or the one it arrived in (`onAttached`). Each side of a hop matches once.
 */
export async function wasHandedOver(
  tabId: number,
  windows: { from: number } | { to: number },
): Promise<boolean> {
  const hops = await readHops(tabId);
  const side = 'from' in windows ? 'from' : 'to';
  const windowId = 'from' in windows ? windows.from : windows.to;
  for (const [key, at] of matched) if (Date.now() - at > HANDOVER_TTL_MS) matched.delete(key);
  const keyOf = (hop: Hop) => `${tabId}:${hop.at}:${hop.from}:${hop.to}:${side}`;
  const hop = hops.find((h) => h[side] === windowId && isFresh(h) && !matched.has(keyOf(h)));
  if (!hop) return false;
  matched.set(keyOf(hop), hop.at);
  setTimeout(() => void removeExpiredHops(tabId), HANDOVER_TTL_MS + 1);
  return true;
}

/** Drops the value once every hop in it has expired; a newer hop written meanwhile stays. */
async function removeExpiredHops(tabId: number): Promise<void> {
  if ((await readHops(tabId)).some(isFresh)) return;
  await browser.sessions.removeTabValue(tabId, HANDOVER_SESSION_KEY).catch(() => {
    // The tab closed or the value is already gone.
  });
}
