import {
  migrateLegacyEntriesToPersistence,
  panelKeysForLayout,
  toPersistenceLayout,
  type LegacyPersistedPanelEntry,
  type PanelPersistenceWorkspaceLayout,
  type WorkspacePanelLayout,
} from './PanelLayout';
import type { PersistedPanelEntry, PersistedWorkspacePanels } from './PanelStore';

const STORAGE_KEY = 'bento.panels';
const MAIN_WIDTH_STORAGE_KEY = 'bento.panelMainWidth';
const LEGACY_MAIN_WIDTHS_STORAGE_KEY = 'bento.panelMainWidths';
const STRIP_SCROLL_STORAGE_KEY = 'bento.panelStripScroll';
const VERSION = 5;
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

interface StoredEntryV5 {
  panelKey: string;
  url: string;
  widthPx?: number;
}

interface StoredWorkspaceV5 {
  entries: StoredEntryV5[];
  panelLayout: PanelPersistenceWorkspaceLayout;
}

interface StoredShapeV5 {
  version: 5;
  byWorkspace: Record<string, StoredWorkspaceV5>;
  mainWidthByWorkspace: Record<string, number>;
}

interface StoredShapeV4 {
  version: 4;
  byWorkspace: Record<string, StoredEntryV4[]>;
  mainWidthByWorkspace: Record<string, number>;
}

interface StoredShapeV3 {
  version: 3;
  byWorkspace: Record<string, StoredEntryV2[]>;
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

type StoredShape = StoredShapeV1 | StoredShapeV2 | StoredShapeV3 | StoredShapeV4 | StoredShapeV5;

export interface PersistedPanels {
  byWorkspace: Map<string, PersistedWorkspacePanels>;
  mainWidthPx?: number;
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
    const stripScrollByWorkspace = parseStripScroll(raw[STRIP_SCROLL_STORAGE_KEY]);
    const byWorkspace = new Map<string, PersistedWorkspacePanels>();
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
    if (
      storedVersion !== 1 &&
      storedVersion !== 2 &&
      storedVersion !== 3 &&
      storedVersion !== 4 &&
      storedVersion !== 5
    ) {
      console.warn('[bento-tools] panels: unknown version', storedVersion, '- ignoring');
      return { byWorkspace, mainWidthPx, stripScrollByWorkspace };
    }
    const stored = storedRaw as StoredShape;

    if (stored.version === 5) {
      for (const [workspaceId, workspace] of Object.entries(stored.byWorkspace)) {
        const entries = parseStoredEntriesV5(workspace.entries);
        byWorkspace.set(workspaceId, {
          entries,
          layout: sanitizePersistenceLayout(workspace.panelLayout),
        });
      }
    } else {
      for (const [workspaceId, legacyEntries] of legacyEntriesByWorkspace(stored)) {
        const migrated = migrateLegacyEntriesToPersistence(legacyEntries, workspaceId);
        byWorkspace.set(workspaceId, {
          entries: migrated.entries,
          layout: migrated.layout,
        });
      }
    }

    if (stored.version === 3 || stored.version === 4 || stored.version === 5) {
      const storedLegacyGlobal = (stored as StoredShapeV3 | StoredShapeV4 | StoredShapeV5)
        .mainWidthByWorkspace?.__global__;
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
  #pendingLayouts: Map<string, WorkspacePanelLayout> | null = null;
  #pendingWidths: Map<number, number> | null = null;
  #pendingMainWidth: number | undefined;
  #pendingStripScroll: Map<string, number> | null = null;

  schedule(
    layouts: Map<string, WorkspacePanelLayout>,
    widths: Map<number, number>,
    mainWidthPx: number | undefined,
    stripScrollByWorkspace: Map<string, number>,
  ): void {
    this.#pendingLayouts = layouts;
    this.#pendingWidths = widths;
    this.#pendingMainWidth = mainWidthPx;
    this.#pendingStripScroll = stripScrollByWorkspace;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const nextLayouts = this.#pendingLayouts;
      const nextWidths = this.#pendingWidths;
      const nextMainWidth = this.#pendingMainWidth;
      const nextStripScroll = this.#pendingStripScroll;
      this.#pendingLayouts = null;
      this.#pendingWidths = null;
      this.#pendingMainWidth = undefined;
      this.#pendingStripScroll = null;
      if (nextLayouts && nextWidths && nextStripScroll) {
        void this.#flush(nextLayouts, nextWidths, nextMainWidth, nextStripScroll);
      }
    }, DEBOUNCE_MS);
  }

  flushNow(
    layouts: Map<string, WorkspacePanelLayout>,
    widths: Map<number, number>,
    mainWidthPx: number | undefined,
    stripScrollByWorkspace: Map<string, number>,
  ): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pendingLayouts = null;
    this.#pendingWidths = null;
    this.#pendingMainWidth = undefined;
    this.#pendingStripScroll = null;
    void this.#flush(layouts, widths, mainWidthPx, stripScrollByWorkspace);
  }

  async #flush(
    layouts: Map<string, WorkspacePanelLayout>,
    widths: Map<number, number>,
    mainWidthPx: number | undefined,
    stripScrollByWorkspace: Map<string, number>,
  ): Promise<void> {
    const byWorkspace: Record<string, StoredWorkspaceV5> = {};
    for (const [workspaceId, layout] of layouts) {
      const panelKeys = panelKeysForLayout(layout);
      const entries: StoredEntryV5[] = [];
      const keptKeysByTabId = new Map<number, string>();
      for (const [tabId, panelKey] of panelKeys) {
        try {
          const tab = await browser.tabs.get(tabId);
          const pendingUrl =
            typeof (tab as browser.tabs.Tab & { pendingUrl?: unknown }).pendingUrl === 'string'
              ? ((tab as browser.tabs.Tab & { pendingUrl?: string }).pendingUrl ?? '')
              : '';
          const url = tab.url && tab.url !== 'about:blank' ? tab.url : pendingUrl;
          if (!url || url === 'about:blank') continue;
          const entry: StoredEntryV5 = { panelKey, url };
          const widthPx = widths.get(tabId);
          if (typeof widthPx === 'number' && widthPx > 0) entry.widthPx = widthPx;
          entries.push(entry);
          keptKeysByTabId.set(tabId, panelKey);
        } catch {
          // Tab gone between schedule and flush.
        }
      }
      if (entries.length > 0) {
        byWorkspace[workspaceId] = {
          entries,
          panelLayout: toPersistenceLayout(layout, keptKeysByTabId),
        };
      }
    }
    const roundedMainWidth =
      typeof mainWidthPx === 'number' && mainWidthPx > 0
        ? Math.max(MAIN_PANEL_MIN_WIDTH, Math.round(mainWidthPx))
        : undefined;
    const payload: StoredShapeV5 = {
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
      for (const [workspaceId, scrollLeft] of stripScrollByWorkspace) {
        if (Number.isFinite(scrollLeft) && scrollLeft >= 0) {
          stripScrollRecord[workspaceId] = Math.round(scrollLeft);
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

function parseStripScroll(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== 'object') return out;
  for (const [workspaceId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      out.set(workspaceId, value);
    }
  }
  return out;
}

function parseStoredEntriesV5(raw: unknown): PersistedPanelEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: PersistedPanelEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Partial<StoredEntryV5>;
    if (typeof obj.panelKey !== 'string' || typeof obj.url !== 'string') continue;
    const next: PersistedPanelEntry = { panelKey: obj.panelKey, url: obj.url };
    if (typeof obj.widthPx === 'number' && obj.widthPx > 0) next.widthPx = obj.widthPx;
    entries.push(next);
  }
  return entries;
}

function sanitizePersistenceLayout(raw: unknown): PanelPersistenceWorkspaceLayout {
  if (!raw || typeof raw !== 'object') return { root: [] };
  const root = (raw as { root?: unknown }).root;
  return { root: Array.isArray(root) ? (root as PanelPersistenceWorkspaceLayout['root']) : [] };
}

function legacyEntriesByWorkspace(
  stored: Exclude<StoredShape, StoredShapeV5>,
): Array<[string, LegacyPersistedPanelEntry[]]> {
  const out: Array<[string, LegacyPersistedPanelEntry[]]> = [];
  if (stored.version >= 2) {
    const v2plus = stored as StoredShapeV2 | StoredShapeV3 | StoredShapeV4;
    for (const [workspaceId, list] of Object.entries(v2plus.byWorkspace)) {
      if (!Array.isArray(list)) continue;
      const entries: LegacyPersistedPanelEntry[] = [];
      for (const item of list) {
        if (!item || typeof item.url !== 'string') continue;
        const entry: LegacyPersistedPanelEntry = { url: item.url };
        if (typeof item.widthPx === 'number' && item.widthPx > 0) entry.widthPx = item.widthPx;
        const ev4 = item as StoredEntryV4;
        if (stored.version >= 4 && ev4.subdivision && typeof ev4.subdivision === 'object') {
          const sub = ev4.subdivision;
          if (
            (sub.mode === 'single' || sub.mode === 'dual') &&
            typeof sub.topHeightFraction === 'number' &&
            Array.isArray(sub.subPanelUrls)
          ) {
            entry.subdivision = {
              mode: sub.mode,
              topHeightFraction: sub.topHeightFraction,
              subPanelUrls: sub.subPanelUrls.filter(
                (url): url is string => typeof url === 'string',
              ),
              splitRatio: typeof sub.splitRatio === 'number' ? sub.splitRatio : undefined,
            };
          }
        }
        entries.push(entry);
      }
      out.push([workspaceId, entries]);
    }
    return out;
  }
  for (const [workspaceId, urls] of Object.entries(stored.byWorkspace)) {
    if (!Array.isArray(urls)) continue;
    out.push([
      workspaceId,
      urls.filter((url): url is string => typeof url === 'string').map((url) => ({ url })),
    ]);
  }
  return out;
}
