// storage.local-backed persistence for pinned panels. Stores per-entry URL
// (NOT tabId — tab IDs aren't stable across browser restarts) so the boot
// restorer can match a persisted pin back to its live panel tab after
// PanelStore has restored the workspace's panels.
//
// Mirrors workspaces/Persistence.ts: versioned StoredShape so a future
// migration can be detected, two-slot backup so a corrupt primary write
// is recoverable on next load, debounced writes so a flurry of add/remove
// collapses into one IO.

const STORAGE_KEY = 'bento.pinnedPanels';
const BACKUP_STORAGE_KEY = 'bento.pinnedPanels.backup';
const VERSION = 3;
const DEBOUNCE_MS = 500;

interface StoredEntryV1 {
  workspaceId: string;
  url: string;
  order: number;
}

interface StoredEntryV2 extends StoredEntryV1 {
  panelKey?: string;
}

interface StoredEntryV3 extends StoredEntryV2 {
  title?: string;
  favIconUrl?: string;
}

interface StoredShapeV1 {
  version: 1;
  entries: StoredEntryV1[];
}

interface StoredShapeV2 {
  version: 2;
  entries: StoredEntryV2[];
}

interface StoredShapeV3 {
  version: 3;
  entries: StoredEntryV3[];
}

export interface PersistedPinnedEntry {
  workspaceId: string;
  panelKey?: string;
  url: string;
  order: number;
  title?: string;
  favIconUrl?: string;
}

export interface PersistedState {
  entries: PersistedPinnedEntry[];
}

function parseStored(stored: unknown): PersistedState | null {
  if (!stored || typeof stored !== 'object') return null;
  const obj = stored as Partial<StoredShapeV1 | StoredShapeV2 | StoredShapeV3>;
  if (obj.version !== 1 && obj.version !== 2 && obj.version !== 3) {
    console.warn('[bento-tools] pinnedPanels: unknown version', obj.version, '— ignoring');
    return null;
  }
  if (!Array.isArray(obj.entries)) return null;
  const entries: PersistedPinnedEntry[] = [];
  for (const e of obj.entries) {
    if (!e || typeof e.workspaceId !== 'string' || typeof e.url !== 'string') continue;
    if (typeof e.order !== 'number' || !Number.isFinite(e.order)) continue;
    entries.push({
      workspaceId: e.workspaceId,
      panelKey:
        typeof (e as StoredEntryV2).panelKey === 'string'
          ? (e as StoredEntryV2).panelKey
          : undefined,
      url: e.url,
      order: e.order,
      title:
        typeof (e as StoredEntryV3).title === 'string' ? (e as StoredEntryV3).title : undefined,
      favIconUrl:
        typeof (e as StoredEntryV3).favIconUrl === 'string'
          ? (e as StoredEntryV3).favIconUrl
          : undefined,
    });
  }
  return { entries };
}

export async function load(): Promise<PersistedState | null> {
  let primary: PersistedState | null = null;
  try {
    const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    primary = parseStored(raw[STORAGE_KEY]);
  } catch (err) {
    console.error('[bento-tools] pinnedPanels: primary load failed', err);
  }
  if (primary) return primary;
  let backup: PersistedState | null = null;
  try {
    const raw = (await browser.storage.local.get(BACKUP_STORAGE_KEY)) as Record<string, unknown>;
    backup = parseStored(raw[BACKUP_STORAGE_KEY]);
  } catch (err) {
    console.error('[bento-tools] pinnedPanels: backup load failed', err);
    return null;
  }
  if (!backup) return null;
  const payload: StoredShapeV3 = {
    version: VERSION,
    entries: backup.entries,
  };
  void browser.storage.local
    .set({ [STORAGE_KEY]: payload })
    .catch((err) => console.error('[bento-tools] pinnedPanels: primary rewrite failed', err));
  return backup;
}

export class Persistence {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: PersistedState | null = null;

  schedule(state: PersistedState): void {
    this.#pending = state;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const next = this.#pending;
      this.#pending = null;
      if (next) void this.#flush(next);
    }, DEBOUNCE_MS);
  }

  async #flush(state: PersistedState): Promise<void> {
    const payload: StoredShapeV3 = {
      version: VERSION,
      entries: state.entries,
    };
    // Two-step write: copy the existing primary to the backup slot
    // before overwriting. Same trade-off as workspaces/Persistence —
    // losing the backup is far less bad than failing to persist.
    try {
      const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
      const prev = raw[STORAGE_KEY];
      if (prev !== undefined) {
        await browser.storage.local.set({ [BACKUP_STORAGE_KEY]: prev });
      }
    } catch (err) {
      console.warn('[bento-tools] pinnedPanels: backup write failed', err);
    }
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: payload });
    } catch (err) {
      console.error('[bento-tools] pinnedPanels: save failed', err);
    }
  }
}
