import type { TabFolder } from '@shared/protocol';

const STORAGE_KEY = 'bento.tabFolders';
const BACKUP_STORAGE_KEY = 'bento.tabFolders.backup';
const VERSION = 1;
const DEBOUNCE_MS = 500;

interface StoredShapeV1 {
  version: 1;
  folders: TabFolder[];
}

export interface PersistedState {
  folders: TabFolder[];
}

function parseStored(stored: unknown): PersistedState | null {
  if (!stored || typeof stored !== 'object') return null;
  const obj = stored as Partial<StoredShapeV1>;
  if (obj.version !== VERSION) {
    console.warn('[bento-tools] tabFolders: unknown version', obj.version, '- ignoring');
    return null;
  }
  if (!Array.isArray(obj.folders)) return null;
  const folders: TabFolder[] = [];
  for (const f of obj.folders) {
    if (!f || typeof f !== 'object') continue;
    const folder = f as Partial<TabFolder>;
    if (
      typeof folder.id !== 'string' ||
      typeof folder.workspaceId !== 'string' ||
      typeof folder.name !== 'string' ||
      typeof folder.order !== 'number' ||
      !Number.isFinite(folder.order) ||
      typeof folder.collapsed !== 'boolean' ||
      typeof folder.createdAt !== 'number' ||
      !Number.isFinite(folder.createdAt)
    ) {
      continue;
    }
    folders.push({
      id: folder.id,
      workspaceId: folder.workspaceId,
      name: folder.name,
      order: Math.max(0, Math.floor(folder.order)),
      collapsed: folder.collapsed,
      createdAt: folder.createdAt,
    });
  }
  return { folders };
}

export async function load(): Promise<PersistedState | null> {
  let primary: PersistedState | null = null;
  try {
    const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    primary = parseStored(raw[STORAGE_KEY]);
  } catch (err) {
    console.error('[bento-tools] tabFolders: primary load failed', err);
  }
  if (primary) return primary;

  let backup: PersistedState | null = null;
  try {
    const raw = (await browser.storage.local.get(BACKUP_STORAGE_KEY)) as Record<string, unknown>;
    backup = parseStored(raw[BACKUP_STORAGE_KEY]);
  } catch (err) {
    console.error('[bento-tools] tabFolders: backup load failed', err);
    return null;
  }
  if (!backup) return null;
  const payload: StoredShapeV1 = { version: VERSION, folders: backup.folders };
  void browser.storage.local
    .set({ [STORAGE_KEY]: payload })
    .catch((err) => console.error('[bento-tools] tabFolders: primary rewrite failed', err));
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
    const payload: StoredShapeV1 = { version: VERSION, folders: state.folders };
    try {
      const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
      const prev = raw[STORAGE_KEY];
      if (prev !== undefined) {
        await browser.storage.local.set({ [BACKUP_STORAGE_KEY]: prev });
      }
    } catch (err) {
      console.warn('[bento-tools] tabFolders: backup write failed', err);
    }
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: payload });
    } catch (err) {
      console.error('[bento-tools] tabFolders: save failed', err);
    }
  }
}
