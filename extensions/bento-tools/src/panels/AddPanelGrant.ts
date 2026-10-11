// "Add panel" handshake with chrome (bento-shell-mount.js addNewPanel).
//
// Chrome creates the tab at about:blank?bento_add_as_panel=<uuid> and attaches
// a one-time grant for that token to the native tab. A page can navigate to a
// URL of the same shape, so the URL is only a hint: this tool counts the tab
// as an added panel only when the privileged experiment confirms a live grant
// for (tabId, token) and consumes it. The experiment returns the metadata
// chrome recorded; an unknown, replayed, expired, or foreign-tab token yields
// null and the URL is ignored.

export type AddPanelSource = 'main' | 'end' | number;

export interface AddPanelGrant {
  windowId: number;
  source: AddPanelSource;
}

const MARKER_URL =
  /^about:blank\?bento_add_as_panel=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The grant token from a marker-shaped URL, or null for every other URL. */
export function parseAddPanelMarker(url: string): string | null {
  return MARKER_URL.exec(url)?.[1] ?? null;
}

/** Validates the experiment result at the boundary; null means no grant. */
export function readAddPanelGrant(value: unknown): AddPanelGrant | null {
  if (typeof value !== 'object' || value === null) return null;
  const { windowId, source } = value as Record<string, unknown>;
  if (typeof windowId !== 'number' || !Number.isSafeInteger(windowId) || windowId < 0) return null;
  const validSource =
    source === 'main' ||
    source === 'end' ||
    (typeof source === 'number' && Number.isSafeInteger(source) && source >= 0);
  return validSource ? { windowId, source } : null;
}

interface AddPanelMarkerHandlerDeps {
  /** Privileged check-and-delete of the chrome-issued grant. */
  consume(tabId: number, token: string): Promise<unknown>;
  /** Adds the tab to the grant window's active workspace. */
  apply(tabId: number, grant: AddPanelGrant): void;
}

/**
 * Handles tab URLs from tabs.onCreated and tabs.onUpdated. Each tab gets one
 * consume attempt, so onCreated and onUpdated for the same marker do not race
 * and a page cannot make repeated guesses on a tab.
 */
export function createAddPanelMarkerHandler({ consume, apply }: AddPanelMarkerHandlerDeps) {
  const attempted = new Set<number>();
  return {
    handle(tabId: number, url: string): void {
      const token = parseAddPanelMarker(url);
      if (token === null || attempted.has(tabId)) return;
      attempted.add(tabId);
      void (async () => {
        try {
          const grant = readAddPanelGrant(await consume(tabId, token));
          if (grant) apply(tabId, grant);
          else console.warn('[bento-tools] add-as-panel: no matching grant, ignoring marker URL');
        } catch (err) {
          console.warn('[bento-tools] add-as-panel: grant check failed:', err);
        }
      })();
    },
    forget(tabId: number): void {
      attempted.delete(tabId);
    },
  };
}
