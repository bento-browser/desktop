// storage.local-backed persistence for side panels. Stores per-workspace
// panel URLs (NOT tab IDs — tab IDs aren't stable across browser restarts)
// + per-panel widths in CSS pixels + per-workspace main-panel widths.
// On boot, the restorer matches persisted URLs back to live tabs (or
// opens new ones), re-promotes them via PanelStore.add, and re-applies
// per-panel widths via PanelStore.setWidth. Per-workspace main widths
// hydrate straight at panels.init() time and broadcast via emitPanelsSync.
//
// Mirrors workspaces/Persistence.ts: versioned StoredShape so a future
// migration can be detected, debounced writes so a flurry of add/remove/
// reorder collapses into one IO. Versions:
//   - v1: byWorkspace = Record<wsId, string[]>             (URLs only)
//   - v2: byWorkspace = Record<wsId, {url, widthPx?}[]>    (added per-panel widths)
//   - v3: + mainWidthByWorkspace = Record<wsId, number>    (added per-workspace main width)

import type { PersistedPanelEntry } from './PanelStore';

const STORAGE_KEY = 'bento.panels';
const VERSION = 3;
const DEBOUNCE_MS = 500;

interface StoredEntryV2 {
  url: string;
  widthPx?: number;
}

interface StoredShapeV3 {
  version: 3;
  /** workspaceId → ordered list of panel entries, left-to-right. */
  byWorkspace: Record<string, StoredEntryV2[]>;
  /** workspaceId → main-panel width in CSS pixels. Optional per workspace. */
  mainWidthByWorkspace: Record<string, number>;
}

interface StoredShapeV2 {
  version: 2;
  byWorkspace: Record<string, StoredEntryV2[]>;
}

interface StoredShapeV1 {
  version: 1;
  byWorkspace: Record<string, string[]>;
}

type StoredShape = StoredShapeV1 | StoredShapeV2 | StoredShapeV3;

export interface PersistedPanels {
  byWorkspace: Map<string, PersistedPanelEntry[]>;
  mainWidthByWorkspace: Map<string, number>;
}

export async function load(): Promise<PersistedPanels | null> {
  try {
    const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    const stored = raw[STORAGE_KEY] as StoredShape | undefined;
    if (!stored || typeof stored !== 'object') return null;
    if (stored.version !== 1 && stored.version !== 2 && stored.version !== 3) {
      console.warn('[bento-tools] panels: unknown version', stored.version, '— ignoring');
      return null;
    }
    const byWorkspace = new Map<string, PersistedPanelEntry[]>();
    const mainWidthByWorkspace = new Map<string, number>();
    if (stored.version >= 2) {
      const v2 = stored as StoredShapeV2 | StoredShapeV3;
      for (const [wsId, list] of Object.entries(v2.byWorkspace)) {
        if (!Array.isArray(list)) continue;
        const entries: PersistedPanelEntry[] = [];
        for (const e of list) {
          if (!e || typeof e.url !== 'string') continue;
          const entry: PersistedPanelEntry = { url: e.url };
          if (typeof e.widthPx === 'number' && e.widthPx > 0) entry.widthPx = e.widthPx;
          entries.push(entry);
        }
        byWorkspace.set(wsId, entries);
      }
    } else {
      // v1 → upgrade to v2 (no widths recorded yet)
      for (const [wsId, urls] of Object.entries(stored.byWorkspace)) {
        if (!Array.isArray(urls)) continue;
        byWorkspace.set(
          wsId,
          urls.filter((u): u is string => typeof u === 'string').map((url) => ({ url })),
        );
      }
    }
    if (stored.version === 3) {
      for (const [wsId, w] of Object.entries(stored.mainWidthByWorkspace ?? {})) {
        if (typeof w === 'number' && w > 0) mainWidthByWorkspace.set(wsId, w);
      }
    }
    return { byWorkspace, mainWidthByWorkspace };
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
  #pendingByWs: Map<string, number[]> | null = null;
  /** Latest width snapshot — tabId → widthPx. Resolved alongside URLs at
   * flush time so a single debounced write captures both. */
  #pendingWidths: Map<number, number> | null = null;
  /** Latest main-panel width snapshot per workspace. */
  #pendingMainWidths: Map<string, number> | null = null;

  schedule(
    state: Map<string, number[]>,
    widths: Map<number, number>,
    mainWidths: Map<string, number>,
  ): void {
    this.#pendingByWs = state;
    this.#pendingWidths = widths;
    this.#pendingMainWidths = mainWidths;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const nextState = this.#pendingByWs;
      const nextWidths = this.#pendingWidths;
      const nextMainWidths = this.#pendingMainWidths;
      this.#pendingByWs = null;
      this.#pendingWidths = null;
      this.#pendingMainWidths = null;
      if (nextState && nextWidths && nextMainWidths) {
        void this.#flush(nextState, nextWidths, nextMainWidths);
      }
    }, DEBOUNCE_MS);
  }

  async #flush(
    state: Map<string, number[]>,
    widths: Map<number, number>,
    mainWidths: Map<string, number>,
  ): Promise<void> {
    const byWorkspace: Record<string, StoredEntryV2[]> = {};
    for (const [wsId, tabIds] of state) {
      const entries: StoredEntryV2[] = [];
      for (const id of tabIds) {
        try {
          const tab = await browser.tabs.get(id);
          // Skip transient/empty URLs — restoring them on the next boot
          // would just re-create about:blank panels. Skip privileged
          // about: URLs other than newtab to avoid surprises (about:config,
          // etc. shouldn't auto-restore as panels).
          const url = tab.url;
          if (!url || url === 'about:blank') continue;
          const entry: StoredEntryV2 = { url };
          const w = widths.get(id);
          if (typeof w === 'number' && w > 0) entry.widthPx = w;
          entries.push(entry);
        } catch {
          // Tab gone between schedule and flush — drop silently.
        }
      }
      // Empty workspaces don't need an entry.
      if (entries.length > 0) byWorkspace[wsId] = entries;
    }
    const mainWidthByWorkspace: Record<string, number> = {};
    for (const [wsId, w] of mainWidths) {
      if (typeof w === 'number' && w > 0) mainWidthByWorkspace[wsId] = w;
    }
    const payload: StoredShapeV3 = { version: VERSION, byWorkspace, mainWidthByWorkspace };
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: payload });
    } catch (err) {
      console.error('[bento-tools] panels: save failed', err);
    }
  }
}
