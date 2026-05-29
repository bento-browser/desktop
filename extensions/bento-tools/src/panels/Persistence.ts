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

import type { PersistedPanelEntry, SubdivisionRuntime } from './PanelStore';

const STORAGE_KEY = 'bento.panels';
const MAIN_WIDTH_STORAGE_KEY = 'bento.panelMainWidth';
const LEGACY_MAIN_WIDTHS_STORAGE_KEY = 'bento.panelMainWidths';
/** Per-workspace horizontal scroll position of the chrome panel strip, in
 * CSS pixels. Stored in a top-level storage key (rather than nested inside
 * the versioned StoredShape) so this lightweight UI state doesn't require a
 * schema bump and won't be discarded if a future version migration is
 * incomplete. Record<workspaceId, scrollLeft>. */
const STRIP_SCROLL_STORAGE_KEY = 'bento.panelStripScroll';
const VERSION = 4;
const DEBOUNCE_MS = 500;
const MAIN_PANEL_MIN_WIDTH = 320;

interface StoredEntryV2 {
  url: string;
  widthPx?: number;
}

interface StoredSubdivisionV4 {
  mode: 'single' | 'dual';
  topHeightFraction: number;
  subPanelUrls: string[];
  splitRatio?: number;
}

interface StoredEntryV4 extends StoredEntryV2 {
  subdivision?: StoredSubdivisionV4;
}

interface StoredShapeV4 {
  version: 4;
  byWorkspace: Record<string, StoredEntryV4[]>;
  mainWidthByWorkspace: Record<string, number>;
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

type StoredShape = StoredShapeV1 | StoredShapeV2 | StoredShapeV3 | StoredShapeV4;

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
    if (storedVersion !== 1 && storedVersion !== 2 && storedVersion !== 3 && storedVersion !== 4) {
      console.warn('[bento-tools] panels: unknown version', storedVersion, '— ignoring');
      return { byWorkspace, mainWidthPx, stripScrollByWorkspace };
    }
    const stored = storedRaw as StoredShape;
    if (stored.version >= 2) {
      const v2plus = stored as StoredShapeV2 | StoredShapeV3 | StoredShapeV4;
      for (const [wsId, list] of Object.entries(v2plus.byWorkspace)) {
        if (!Array.isArray(list)) continue;
        const entries: PersistedPanelEntry[] = [];
        for (const e of list) {
          if (!e || typeof e.url !== 'string') continue;
          const entry: PersistedPanelEntry = { url: e.url };
          if (typeof e.widthPx === 'number' && e.widthPx > 0) entry.widthPx = e.widthPx;
          const ev4 = e as StoredEntryV4;
          if (stored.version >= 4 && ev4.subdivision && typeof ev4.subdivision === 'object') {
            const s = ev4.subdivision;
            if (
              (s.mode === 'single' || s.mode === 'dual') &&
              typeof s.topHeightFraction === 'number' &&
              Array.isArray(s.subPanelUrls)
            ) {
              entry.subdivision = {
                mode: s.mode,
                topHeightFraction: s.topHeightFraction,
                subPanelUrls: s.subPanelUrls.filter((u): u is string => typeof u === 'string'),
                splitRatio: typeof s.splitRatio === 'number' ? s.splitRatio : undefined,
              };
            }
          }
          entries.push(entry);
        }
        byWorkspace.set(wsId, entries);
      }
    } else {
      for (const [wsId, urls] of Object.entries(stored.byWorkspace)) {
        if (!Array.isArray(urls)) continue;
        byWorkspace.set(
          wsId,
          urls.filter((u): u is string => typeof u === 'string').map((url) => ({ url })),
        );
      }
    }
    if (stored.version === 3 || stored.version === 4) {
      const v3plus = stored as StoredShapeV3 | StoredShapeV4;
      const storedLegacyGlobal = v3plus.mainWidthByWorkspace?.__global__;
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
  #pendingByWs: Map<string, number[]> | null = null;
  #pendingWidths: Map<number, number> | null = null;
  #pendingMainWidth: number | undefined;
  #pendingStripScroll: Map<string, number> | null = null;
  #pendingSubdivisions: Map<number, SubdivisionRuntime> | null = null;

  schedule(
    state: Map<string, number[]>,
    widths: Map<number, number>,
    mainWidthPx: number | undefined,
    stripScrollByWorkspace: Map<string, number>,
    subdivisions: Map<number, SubdivisionRuntime>,
  ): void {
    this.#pendingByWs = state;
    this.#pendingWidths = widths;
    this.#pendingMainWidth = mainWidthPx;
    this.#pendingStripScroll = stripScrollByWorkspace;
    this.#pendingSubdivisions = subdivisions;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const nextState = this.#pendingByWs;
      const nextWidths = this.#pendingWidths;
      const nextMainWidth = this.#pendingMainWidth;
      const nextStripScroll = this.#pendingStripScroll;
      const nextSubs = this.#pendingSubdivisions;
      this.#pendingByWs = null;
      this.#pendingWidths = null;
      this.#pendingMainWidth = undefined;
      this.#pendingStripScroll = null;
      this.#pendingSubdivisions = null;
      if (nextState && nextWidths && nextStripScroll && nextSubs) {
        void this.#flush(nextState, nextWidths, nextMainWidth, nextStripScroll, nextSubs);
      }
    }, DEBOUNCE_MS);
  }

  flushNow(
    state: Map<string, number[]>,
    widths: Map<number, number>,
    mainWidthPx: number | undefined,
    stripScrollByWorkspace: Map<string, number>,
    subdivisions: Map<number, SubdivisionRuntime>,
  ): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pendingByWs = null;
    this.#pendingWidths = null;
    this.#pendingMainWidth = undefined;
    this.#pendingStripScroll = null;
    this.#pendingSubdivisions = null;
    void this.#flush(state, widths, mainWidthPx, stripScrollByWorkspace, subdivisions);
  }

  async #resolveSubdivision(sub: SubdivisionRuntime): Promise<StoredSubdivisionV4 | undefined> {
    if (sub.subPanelTabIds.length === 0) {
      return {
        mode: sub.mode,
        topHeightFraction: sub.topHeightFraction,
        subPanelUrls: [],
        splitRatio: sub.mode === 'dual' ? sub.splitRatio : undefined,
      };
    }
    const urls: string[] = [];
    for (const spId of sub.subPanelTabIds) {
      try {
        const tab = await browser.tabs.get(spId);
        const pendingUrl =
          typeof (tab as browser.tabs.Tab & { pendingUrl?: unknown }).pendingUrl === 'string'
            ? ((tab as browser.tabs.Tab & { pendingUrl?: string }).pendingUrl ?? '')
            : '';
        const url = tab.url && tab.url !== 'about:blank' ? tab.url : pendingUrl;
        if (url && url !== 'about:blank') urls.push(url);
      } catch {
        // sub-panel tab gone
      }
    }
    if (urls.length === 0 && sub.subPanelTabIds.length > 0) return undefined;
    return {
      mode: sub.mode,
      topHeightFraction: sub.topHeightFraction,
      subPanelUrls: urls,
      splitRatio: sub.mode === 'dual' ? sub.splitRatio : undefined,
    };
  }

  async #flush(
    state: Map<string, number[]>,
    widths: Map<number, number>,
    mainWidthPx: number | undefined,
    stripScrollByWorkspace: Map<string, number>,
    subdivisions: Map<number, SubdivisionRuntime>,
  ): Promise<void> {
    const byWorkspace: Record<string, StoredEntryV4[]> = {};
    for (const [wsId, tabIds] of state) {
      const entries: StoredEntryV4[] = [];
      for (const id of tabIds) {
        try {
          const tab = await browser.tabs.get(id);
          const pendingUrl =
            typeof (tab as browser.tabs.Tab & { pendingUrl?: unknown }).pendingUrl === 'string'
              ? ((tab as browser.tabs.Tab & { pendingUrl?: string }).pendingUrl ?? '')
              : '';
          const url = tab.url && tab.url !== 'about:blank' ? tab.url : pendingUrl;
          if (!url || url === 'about:blank') continue;
          const entry: StoredEntryV4 = { url };
          const w = widths.get(id);
          if (typeof w === 'number' && w > 0) entry.widthPx = w;
          const sub = subdivisions.get(id);
          if (sub) {
            const resolved = await this.#resolveSubdivision(sub);
            if (resolved) entry.subdivision = resolved;
          }
          entries.push(entry);
        } catch {
          // Tab gone between schedule and flush — drop silently.
        }
      }
      if (entries.length > 0) byWorkspace[wsId] = entries;
    }
    const roundedMainWidth =
      typeof mainWidthPx === 'number' && mainWidthPx > 0
        ? Math.max(MAIN_PANEL_MIN_WIDTH, Math.round(mainWidthPx))
        : undefined;
    const payload: StoredShapeV4 = {
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
