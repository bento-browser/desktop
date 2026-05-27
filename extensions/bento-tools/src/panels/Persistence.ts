// storage.local-backed persistence for side panels. Stores per-workspace
// panel URLs (NOT tab IDs — tab IDs aren't stable across browser restarts)
// + per-panel widths in CSS pixels + the main-panel width.
// On boot, the restorer matches persisted URLs back to live tabs (or
// opens new ones), re-promotes them via PanelStore.add, and re-applies
// per-panel widths via PanelStore.setWidth. The main width hydrates
// straight at panels.init() time and broadcasts via emitPanelsSync.
//
// Mirrors workspaces/Persistence.ts: versioned StoredShape so a future
// migration can be detected, debounced writes so a flurry of add/remove/
// reorder collapses into one IO. Versions:
//   - v1: byWorkspace = Record<wsId, string[]>             (URLs only)
//   - v2: byWorkspace = Record<wsId, {url, widthPx?}[]>    (added per-panel widths)
//   - v3: + mainWidthByWorkspace = Record<wsId, number>    (legacy per-workspace main width)

import type { PersistedPanelEntry } from './PanelStore';

const STORAGE_KEY = 'bento.panels';
const MAIN_WIDTH_STORAGE_KEY = 'bento.panelMainWidth';
const LEGACY_MAIN_WIDTHS_STORAGE_KEY = 'bento.panelMainWidths';
/** Per-workspace horizontal scroll position of the chrome panel strip, in
 * CSS pixels. Stored in a top-level storage key (rather than nested inside
 * the versioned StoredShape) so this lightweight UI state doesn't require a
 * schema bump and won't be discarded if a future version migration is
 * incomplete. Record<workspaceId, scrollLeft>. */
const STRIP_SCROLL_STORAGE_KEY = 'bento.panelStripScroll';
const VERSION = 3;
const DEBOUNCE_MS = 500;
const MAIN_PANEL_MIN_WIDTH = 320;

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
  mainWidthPx?: number;
  /** workspaceId → horizontal scroll position of the chrome panel strip
   * in CSS pixels at last shutdown. */
  stripScrollByWorkspace: Map<string, number>;
}

export async function load(): Promise<PersistedPanels | null> {
  try {
    const raw = (await browser.storage.local.get([
      STORAGE_KEY,
      MAIN_WIDTH_STORAGE_KEY,
      LEGACY_MAIN_WIDTHS_STORAGE_KEY,
      STRIP_SCROLL_STORAGE_KEY,
    ])) as Record<string, unknown>;
    const storedRaw = raw[STORAGE_KEY];
    const storedMainWidth = raw[MAIN_WIDTH_STORAGE_KEY];
    const legacyMainWidths = raw[LEGACY_MAIN_WIDTHS_STORAGE_KEY] as
      | Record<string, unknown>
      | undefined;
    const stripScrollRaw = raw[STRIP_SCROLL_STORAGE_KEY] as Record<string, unknown> | undefined;
    const stripScrollByWorkspace = new Map<string, number>();
    if (stripScrollRaw && typeof stripScrollRaw === 'object') {
      for (const [wsId, value] of Object.entries(stripScrollRaw)) {
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          stripScrollByWorkspace.set(wsId, value);
        }
      }
    }
    const byWorkspace = new Map<string, PersistedPanelEntry[]>();
    const legacyGlobalWidth =
      legacyMainWidths && typeof legacyMainWidths.__global__ === 'number'
        ? legacyMainWidths.__global__
        : undefined;
    let mainWidthPx =
      typeof storedMainWidth === 'number' && storedMainWidth > 0
        ? Math.max(MAIN_PANEL_MIN_WIDTH, storedMainWidth)
        : undefined;

    if (
      mainWidthPx === undefined &&
      typeof legacyGlobalWidth === 'number' &&
      legacyGlobalWidth > 0
    ) {
      mainWidthPx = Math.max(MAIN_PANEL_MIN_WIDTH, legacyGlobalWidth);
    }

    if (!storedRaw || typeof storedRaw !== 'object') {
      return { byWorkspace, mainWidthPx, stripScrollByWorkspace };
    }
    const storedVersion = (storedRaw as { version?: unknown }).version;
    if (storedVersion !== 1 && storedVersion !== 2 && storedVersion !== 3) {
      console.warn('[bento-tools] panels: unknown version', storedVersion, '— ignoring');
      return { byWorkspace, mainWidthPx, stripScrollByWorkspace };
    }
    const stored = storedRaw as StoredShape;
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
      const storedLegacyGlobal = stored.mainWidthByWorkspace?.__global__;
      if (
        mainWidthPx === undefined &&
        typeof storedLegacyGlobal === 'number' &&
        storedLegacyGlobal > 0
      ) {
        mainWidthPx = Math.max(MAIN_PANEL_MIN_WIDTH, storedLegacyGlobal);
      }
    }
    return { byWorkspace, mainWidthPx, stripScrollByWorkspace };
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
  /** Latest main-panel width snapshot. */
  #pendingMainWidth: number | undefined;
  /** Latest per-workspace strip-scroll snapshot. */
  #pendingStripScroll: Map<string, number> | null = null;

  schedule(
    state: Map<string, number[]>,
    widths: Map<number, number>,
    mainWidthPx: number | undefined,
    stripScrollByWorkspace: Map<string, number>,
  ): void {
    this.#pendingByWs = state;
    this.#pendingWidths = widths;
    this.#pendingMainWidth = mainWidthPx;
    this.#pendingStripScroll = stripScrollByWorkspace;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const nextState = this.#pendingByWs;
      const nextWidths = this.#pendingWidths;
      const nextMainWidth = this.#pendingMainWidth;
      const nextStripScroll = this.#pendingStripScroll;
      this.#pendingByWs = null;
      this.#pendingWidths = null;
      this.#pendingMainWidth = undefined;
      this.#pendingStripScroll = null;
      if (nextState && nextWidths && nextStripScroll) {
        void this.#flush(nextState, nextWidths, nextMainWidth, nextStripScroll);
      }
    }, DEBOUNCE_MS);
  }

  flushNow(
    state: Map<string, number[]>,
    widths: Map<number, number>,
    mainWidthPx: number | undefined,
    stripScrollByWorkspace: Map<string, number>,
  ): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pendingByWs = null;
    this.#pendingWidths = null;
    this.#pendingMainWidth = undefined;
    this.#pendingStripScroll = null;
    void this.#flush(state, widths, mainWidthPx, stripScrollByWorkspace);
  }

  async #flush(
    state: Map<string, number[]>,
    widths: Map<number, number>,
    mainWidthPx: number | undefined,
    stripScrollByWorkspace: Map<string, number>,
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
    const roundedMainWidth =
      typeof mainWidthPx === 'number' && mainWidthPx > 0
        ? Math.max(MAIN_PANEL_MIN_WIDTH, Math.round(mainWidthPx))
        : undefined;
    const payload: StoredShapeV3 = {
      version: VERSION,
      byWorkspace,
      mainWidthByWorkspace: roundedMainWidth !== undefined ? { __global__: roundedMainWidth } : {},
    };
    try {
      const writePayload: Record<string, unknown> = { [STORAGE_KEY]: payload };
      if (roundedMainWidth !== undefined) {
        writePayload[MAIN_WIDTH_STORAGE_KEY] = roundedMainWidth;
        writePayload[LEGACY_MAIN_WIDTHS_STORAGE_KEY] = { __global__: roundedMainWidth };
      }
      const stripScrollRecord: Record<string, number> = {};
      for (const [wsId, scrollLeft] of stripScrollByWorkspace) {
        if (Number.isFinite(scrollLeft) && scrollLeft >= 0) {
          stripScrollRecord[wsId] = Math.round(scrollLeft);
        }
      }
      if (Object.keys(stripScrollRecord).length > 0) {
        writePayload[STRIP_SCROLL_STORAGE_KEY] = stripScrollRecord;
      }
      await browser.storage.local.set(writePayload);
      if (roundedMainWidth === undefined) {
        await browser.storage.local.remove([
          MAIN_WIDTH_STORAGE_KEY,
          LEGACY_MAIN_WIDTHS_STORAGE_KEY,
        ]);
      }
      if (Object.keys(stripScrollRecord).length === 0) {
        await browser.storage.local.remove([STRIP_SCROLL_STORAGE_KEY]);
      }
    } catch (err) {
      console.error('[bento-tools] panels: save failed', err);
    }
  }
}
