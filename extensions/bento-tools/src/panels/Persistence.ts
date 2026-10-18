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
  headerHidden?: boolean;
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
  mainWidthByWorkspace: Map<string, number>;
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
      Record<string, unknown> | undefined;
    const stripScrollByWorkspace = parseStripScroll(raw[STRIP_SCROLL_STORAGE_KEY]);
    const byWorkspace = new Map<string, PersistedWorkspacePanels>();
    const mainWidthByWorkspace = new Map<string, number>();
    const legacyGlobalWidth =
      legacyMainWidths && typeof legacyMainWidths.__global__ === 'number'
        ? legacyMainWidths.__global__
        : undefined;
    let legacyMainWidth =
      typeof storedMainWidth === 'number' && storedMainWidth > 0
        ? Math.max(MAIN_PANEL_MIN_WIDTH, storedMainWidth)
        : undefined;

    if (
      legacyMainWidth === undefined &&
      typeof legacyGlobalWidth === 'number' &&
      legacyGlobalWidth > 0
    ) {
      legacyMainWidth = Math.max(MAIN_PANEL_MIN_WIDTH, legacyGlobalWidth);
    }

    if (!storedRaw || typeof storedRaw !== 'object') {
      return { byWorkspace, mainWidthByWorkspace, stripScrollByWorkspace };
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
      return { byWorkspace, mainWidthByWorkspace, stripScrollByWorkspace };
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
      const storedMainWidths = (stored as StoredShapeV3 | StoredShapeV4 | StoredShapeV5)
        .mainWidthByWorkspace;
      for (const [workspaceId, width] of Object.entries(storedMainWidths ?? {})) {
        if (workspaceId === '__global__') continue;
        if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
          mainWidthByWorkspace.set(workspaceId, Math.max(MAIN_PANEL_MIN_WIDTH, Math.round(width)));
        }
      }
      const storedLegacyGlobal = storedMainWidths?.__global__;
      if (
        legacyMainWidth === undefined &&
        typeof storedLegacyGlobal === 'number' &&
        storedLegacyGlobal > 0
      ) {
        legacyMainWidth = Math.max(MAIN_PANEL_MIN_WIDTH, storedLegacyGlobal);
      }
    }
    if (typeof legacyMainWidth === 'number' && legacyMainWidth > 0) {
      for (const workspaceId of byWorkspace.keys()) {
        if (!mainWidthByWorkspace.has(workspaceId)) {
          mainWidthByWorkspace.set(workspaceId, legacyMainWidth);
        }
      }
    }
    return { byWorkspace, mainWidthByWorkspace, stripScrollByWorkspace };
  } catch (err) {
    console.error('[bento-tools] panels: load failed', err);
    return null;
  }
}

/** Positional state a write needs; the maps are copies taken when the write was requested. */
type Snapshot = [
  layouts: Map<string, WorkspacePanelLayout>,
  persistedWorkspaces: Map<string, PersistedWorkspacePanels>,
  widths: Map<number, number>,
  headerHiddenByTabId: Map<number, true>,
  mainWidthByWorkspace: Map<string, number>,
  stripScrollByWorkspace: Map<string, number>,
];

/**
 * The single place a live tab becomes a storable URL. Return null to keep a tab
 * out of `bento.panels`. Private-window tabs are never stored; the caller drops
 * the panel slot from the entries and the persisted layout.
 */
function persistableUrl(tab: browser.tabs.Tab): string | null {
  if (tab.incognito === true) return null;
  const pendingUrl = (tab as { pendingUrl?: unknown }).pendingUrl;
  const url =
    tab.url && tab.url !== 'about:blank'
      ? tab.url
      : typeof pendingUrl === 'string'
        ? pendingUrl
        : '';
  return url && url !== 'about:blank' ? url : null;
}

/**
 * Writes the whole panel graph to `bento.panels`. Each write is a read-modify-write
 * of every panel's live URL, so writes must never overlap: only one is in flight,
 * and a newer request replaces any request still queued behind it. Writes therefore
 * land in request order and an older snapshot cannot overwrite a newer one.
 *
 * `schedule` is the throttled path for high-frequency triggers (URL changes, strip
 * scroll); `flushNow` is for discrete mutations and callers that await durability.
 */
export class Persistence {
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Latest snapshot waiting on the trailing timer. */
  #scheduled: Snapshot | null = null;
  /** Newest snapshot waiting for the in-flight write to finish. */
  #queued: Snapshot | null = null;
  /** Callers of `flushNow` covered by `#queued`; resolved once it is written. */
  #waiters: Array<() => void> = [];
  #draining = false;

  schedule(...snapshot: Snapshot): void {
    this.#scheduled = snapshot;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const next = this.#scheduled;
      this.#scheduled = null;
      if (next) void this.#enqueue(next);
    }, DEBOUNCE_MS);
  }

  /** Resolves once a write at least as new as this snapshot has landed. */
  flushNow(...snapshot: Snapshot): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#scheduled = null;
    return this.#enqueue(snapshot);
  }

  #enqueue(snapshot: Snapshot): Promise<void> {
    this.#queued = snapshot;
    const written = new Promise<void>((resolve) => this.#waiters.push(resolve));
    if (!this.#draining) void this.#drain();
    return written;
  }

  async #drain(): Promise<void> {
    this.#draining = true;
    try {
      while (this.#queued) {
        const snapshot = this.#queued;
        const waiters = this.#waiters;
        this.#queued = null;
        this.#waiters = [];
        try {
          await this.#flush(...snapshot);
        } catch (err) {
          console.error('[bento-tools] panels: flush failed', err);
        }
        for (const resolve of waiters) resolve();
      }
    } finally {
      this.#draining = false;
    }
  }

  async #flush(
    layouts: Map<string, WorkspacePanelLayout>,
    persistedWorkspaces: Map<string, PersistedWorkspacePanels>,
    widths: Map<number, number>,
    headerHiddenByTabId: Map<number, true>,
    mainWidthByWorkspace: Map<string, number>,
    stripScrollByWorkspace: Map<string, number>,
  ): Promise<void> {
    const byWorkspace: Record<string, StoredWorkspaceV5> = {};
    for (const [workspaceId, persisted] of persistedWorkspaces) {
      if (persisted.entries.length === 0) continue;
      byWorkspace[workspaceId] = {
        entries: persisted.entries.map((entry) => ({ ...entry })),
        panelLayout: persisted.layout,
      };
    }
    for (const [workspaceId, layout] of layouts) {
      // A workspace with persisted entries not applied yet (`restorePanelsForWorkspace`) has only
      // the panels that came back with their session markers, in marker order, numbered from the
      // start. Written out, that would replace the entries, their keys and their layout.
      if (persistedWorkspaces.has(workspaceId)) continue;
      const panelKeys = panelKeysForLayout(layout);
      const entries: StoredEntryV5[] = [];
      const keptKeysByTabId = new Map<number, string>();
      for (const [tabId, panelKey] of panelKeys) {
        try {
          const url = persistableUrl(await browser.tabs.get(tabId));
          if (!url) continue;
          const entry: StoredEntryV5 = { panelKey, url };
          const widthPx = widths.get(tabId);
          if (typeof widthPx === 'number' && widthPx > 0) entry.widthPx = widthPx;
          if (headerHiddenByTabId.has(tabId)) entry.headerHidden = true;
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
    const mainWidthRecord: Record<string, number> = {};
    for (const [workspaceId, width] of mainWidthByWorkspace) {
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
        mainWidthRecord[workspaceId] = Math.max(MAIN_PANEL_MIN_WIDTH, Math.round(width));
      }
    }
    const payload: StoredShapeV5 = {
      version: VERSION,
      byWorkspace,
      mainWidthByWorkspace: mainWidthRecord,
    };
    try {
      const writePayload: Record<string, unknown> = { [STORAGE_KEY]: payload };
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
      await browser.storage.local.remove([MAIN_WIDTH_STORAGE_KEY, LEGACY_MAIN_WIDTHS_STORAGE_KEY]);
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
    if (obj.headerHidden === true) next.headerHidden = true;
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
