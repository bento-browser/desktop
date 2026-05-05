// storage.local-backed persistence for workspaces. Debounces writes so a
// rename + recolor + new-workspace flurry collapses into one IO (§4.3).
//
// Schema is versioned so a future migration can be detected without losing
// data — bump VERSION + add an upgrade arm in load() when the shape changes.

import type { Workspace } from '@shared/protocol';

const STORAGE_KEY = 'bento.workspaces';
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

export async function load(): Promise<PersistedState | null> {
  try {
    const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    const stored = raw[STORAGE_KEY] as StoredShape | undefined;
    if (!stored || typeof stored !== 'object') return null;
    if (stored.version !== VERSION) {
      console.warn('[bento-tools] workspaces: unknown version', stored.version, '— ignoring');
      return null;
    }
    return { workspaces: stored.workspaces, activeId: stored.activeId };
  } catch (err) {
    console.error('[bento-tools] workspaces: load failed', err);
    return null;
  }
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
    const payload: StoredShape = {
      version: VERSION,
      workspaces: state.workspaces,
      activeId: state.activeId,
    };
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: payload });
    } catch (err) {
      console.error('[bento-tools] workspaces: save failed', err);
    }
  }
}
