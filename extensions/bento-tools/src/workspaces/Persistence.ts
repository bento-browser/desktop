// storage.local-backed persistence for workspaces. Debounces writes so a
// rename + recolor + new-workspace flurry collapses into one IO (§4.3).
//
// Schema is versioned so a future migration can be detected without losing
// data — bump VERSION + add an upgrade arm in load() when the shape changes.
//
// A single-slot backup (`bento.workspaces.backup`) holds the previous good
// value so a corrupt primary write can be recovered from on next load.
// Phase G.2 — Bento uses one atomic backup rather than a rolling N-file backup because
// the worst case here is "the last debounced flush ate my data," which one
// slot covers.

import type { Workspace } from '@shared/protocol';

const STORAGE_KEY = 'bento.workspaces';
const BACKUP_STORAGE_KEY = 'bento.workspaces.backup';
const VERSION = 1;
const DEBOUNCE_MS = 500;

interface StoredShape {
  version: number;
  workspaces: Workspace[];
  activeId: string | null;
}

export interface PersistedState {
  workspaces: Workspace[];
  activeId: string | null;
}

function parseStored(stored: unknown): PersistedState | null {
  if (!stored || typeof stored !== 'object') return null;
  const obj = stored as Partial<StoredShape>;
  if (obj.version !== VERSION) {
    console.warn('[bento-tools] workspaces: unknown version', obj.version, '— ignoring');
    return null;
  }
  if (!Array.isArray(obj.workspaces)) return null;
  return { workspaces: obj.workspaces, activeId: obj.activeId ?? null };
}

export async function load(): Promise<PersistedState | null> {
  let primary: PersistedState | null = null;
  try {
    const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    primary = parseStored(raw[STORAGE_KEY]);
  } catch (err) {
    console.error('[bento-tools] workspaces: primary load failed', err);
  }
  if (primary) return primary;
  // Primary missing or corrupt — try the backup slot.
  let backup: PersistedState | null = null;
  try {
    const raw = (await browser.storage.local.get(BACKUP_STORAGE_KEY)) as Record<string, unknown>;
    backup = parseStored(raw[BACKUP_STORAGE_KEY]);
  } catch (err) {
    console.error('[bento-tools] workspaces: backup load failed', err);
    return null;
  }
  if (!backup) return null;
  // Immediately rewrite the primary from the backup so the next load
  // doesn't go through the recovery path again.
  const payload: StoredShape = {
    version: VERSION,
    workspaces: backup.workspaces,
    activeId: backup.activeId,
  };
  void browser.storage.local
    .set({ [STORAGE_KEY]: payload })
    .catch((err) => console.error('[bento-tools] workspaces: primary rewrite failed', err));
  return backup;
}

export class Persistence {
  #timer: ReturnType<typeof setTimeout> | null = null;
  #pending: PersistedState | null = null;
  #writeQueue: Promise<void> = Promise.resolve();

  schedule(state: PersistedState): void {
    this.#pending = state;
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const next = this.#pending;
      this.#pending = null;
      if (next) void this.flushNow(next);
    }, DEBOUNCE_MS);
  }

  flushNow(state: PersistedState): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pending = null;
    const write = () => this.#flush(state);
    const result = this.#writeQueue.then(write, write);
    this.#writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #flush(state: PersistedState): Promise<void> {
    const payload: StoredShape = {
      version: VERSION,
      workspaces: state.workspaces,
      activeId: state.activeId,
    };
    // Two-step write: copy the existing primary to the backup slot
    // before overwriting. Skips when there's no prior primary (first
    // ever write) since there's nothing worth backing up. Backup failure
    // doesn't block the primary write — losing the backup is far less
    // bad than failing to persist the latest state.
    try {
      const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
      const prev = raw[STORAGE_KEY];
      if (prev !== undefined) {
        await browser.storage.local.set({ [BACKUP_STORAGE_KEY]: prev });
      }
    } catch (err) {
      console.warn('[bento-tools] workspaces: backup write failed', err);
    }
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: payload });
    } catch (err) {
      console.error('[bento-tools] workspaces: save failed', err);
    }
  }
}
