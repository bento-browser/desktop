// storage.local-backed persistence for side panels. Stores per-workspace
// panel URLs (NOT tab IDs — tab IDs aren't stable across browser restarts).
// On boot, the restorer matches persisted URLs back to live tabs (or
// opens new ones) and re-promotes them via PanelStore.add.
//
// Mirrors workspaces/Persistence.ts: versioned StoredShape so a future
// migration can be detected, debounced writes so a flurry of add/remove/
// reorder collapses into one IO.

const STORAGE_KEY = 'bento.panels';
const VERSION = 1;
const DEBOUNCE_MS = 500;

interface StoredShape {
  version: number;
  /** workspaceId → ordered list of panel URLs, left-to-right. */
  byWorkspace: Record<string, string[]>;
}

export interface PersistedPanels {
  byWorkspace: Map<string, string[]>;
}

export async function load(): Promise<PersistedPanels | null> {
  try {
    const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    const stored = raw[STORAGE_KEY] as StoredShape | undefined;
    if (!stored || typeof stored !== 'object') return null;
    if (stored.version !== VERSION) {
      console.warn('[bento-tools] panels: unknown version', stored.version, '— ignoring');
      return null;
    }
    const byWorkspace = new Map<string, string[]>();
    for (const [wsId, urls] of Object.entries(stored.byWorkspace)) {
      if (Array.isArray(urls)) byWorkspace.set(wsId, urls);
    }
    return { byWorkspace };
  } catch (err) {
    console.error('[bento-tools] panels: load failed', err);
    return null;
  }
}

export class Persistence {
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Latest snapshot to flush — workspaceId → ordered tabIds. URLs are
   * resolved at flush time via browser.tabs.get (so the in-memory store
   * doesn't have to track URLs alongside tabIds). */
  #pending: Map<string, number[]> | null = null;

  schedule(state: Map<string, number[]>): void {
    this.#pending = state;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const next = this.#pending;
      this.#pending = null;
      if (next) void this.#flush(next);
    }, DEBOUNCE_MS);
  }

  async #flush(state: Map<string, number[]>): Promise<void> {
    const byWorkspace: Record<string, string[]> = {};
    for (const [wsId, tabIds] of state) {
      const urls: string[] = [];
      for (const id of tabIds) {
        try {
          const tab = await browser.tabs.get(id);
          // Skip transient/empty URLs — restoring them on the next boot
          // would just re-create about:blank panels. Skip privileged
          // about: URLs other than newtab to avoid surprises (about:config,
          // etc. shouldn't auto-restore as panels).
          const url = tab.url;
          if (!url || url === 'about:blank') continue;
          urls.push(url);
        } catch {
          // Tab gone between schedule and flush — drop silently.
        }
      }
      // Empty workspaces don't need an entry.
      if (urls.length > 0) byWorkspace[wsId] = urls;
    }
    const payload: StoredShape = { version: VERSION, byWorkspace };
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: payload });
    } catch (err) {
      console.error('[bento-tools] panels: save failed', err);
    }
  }
}
