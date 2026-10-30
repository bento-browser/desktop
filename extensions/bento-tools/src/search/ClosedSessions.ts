/** Closed tabs are scoped to the trusted requesting window, never inferred from focus. */
export interface ClosedSessionContext {
  windowId: number | null;
  incognito: boolean | undefined;
}

const CLOSED_SCAN_LIMIT = 25;
type ClosedTabSession = browser.sessions.Session & {
  tab: browser.tabs.Tab & { sessionId: string; url: string };
};

export async function eligibleClosedTabs(context?: ClosedSessionContext) {
  if (
    !context ||
    context.windowId === null ||
    context.windowId < 0 ||
    typeof context.incognito !== 'boolean'
  )
    return [];
  const sessions = await browser.sessions.getRecentlyClosed({ maxResults: CLOSED_SCAN_LIMIT });
  return sessions.slice(0, CLOSED_SCAN_LIMIT).filter((session): session is ClosedTabSession => {
    const tab = session.tab;
    return (
      !session.window &&
      typeof tab?.sessionId === 'string' &&
      tab.sessionId.length > 0 &&
      typeof tab.url === 'string' &&
      tab.url.length > 0 &&
      tab.windowId === context.windowId &&
      tab.incognito === context.incognito
    );
  });
}
