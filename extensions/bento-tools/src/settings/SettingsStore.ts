// User-configurable settings store. Same mirror pattern as WorkspaceStore:
// in-memory state + storage.local persistence + listener broadcast for shell
// mirrors. UI dispatches `settings/update` actions; tools mutates + persists +
// broadcasts the new full settings object (snapshot, not delta — settings are
// small and atomic).
//
// Defaults mirror prefs/bento.js. Storing only deltas-from-default keeps the
// storage payload small and lets us evolve defaults without migrating data.

import type { BentoSettings } from '@shared/protocol';

const STORAGE_KEY = 'bento.settings';
const VERSION = 1;
const DEBOUNCE_MS = 250;

export const DEFAULT_SETTINGS: Readonly<BentoSettings> = Object.freeze({
  tabSleepEnabled: true,
  tabSleepAfterMinutes: 30,
  tabSleepKeepAlivePerWorkspace: 10,
  defaultWorkspaceName: 'Personal',
  commandPaletteEnabled: true,
  welcomeSeen: false,
});

interface StoredShape {
  version: number;
  /** Sparse — only fields the user has overridden from defaults. */
  overrides: Partial<BentoSettings>;
}

type Listener = (settings: BentoSettings) => void;

async function load(): Promise<Partial<BentoSettings>> {
  try {
    const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    const stored = raw[STORAGE_KEY] as StoredShape | undefined;
    if (!stored || typeof stored !== 'object') return {};
    if (stored.version !== VERSION) {
      console.warn('[bento-tools] settings: unknown version', stored.version, '— ignoring');
      return {};
    }
    return stored.overrides ?? {};
  } catch (err) {
    console.error('[bento-tools] settings: load failed', err);
    return {};
  }
}

export class SettingsStore {
  #current: BentoSettings = { ...DEFAULT_SETTINGS };
  #listeners = new Set<Listener>();
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingOverrides: Partial<BentoSettings> | null = null;

  async init(): Promise<void> {
    const overrides = await load();
    this.#current = { ...DEFAULT_SETTINGS, ...overrides };
  }

  snapshot(): BentoSettings {
    return { ...this.#current };
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Merge `changes` into current settings + persist + broadcast. No-op if
   * nothing actually changed (referential check on each field). */
  update(changes: Partial<BentoSettings>): void {
    let dirty = false;
    const next = { ...this.#current };
    for (const [key, value] of Object.entries(changes) as [
      keyof BentoSettings,
      BentoSettings[keyof BentoSettings],
    ][]) {
      if (next[key] === value) continue;
      // The cast is necessary because TS can't narrow value to the exact
      // field's type when iterating heterogeneous keys.
      (next as Record<keyof BentoSettings, unknown>)[key] = value;
      dirty = true;
    }
    if (!dirty) return;
    this.#current = next;
    this.#schedulePersist();
    this.#broadcast();
  }

  /** Restore all settings to defaults. */
  reset(): void {
    this.#current = { ...DEFAULT_SETTINGS };
    this.#schedulePersist();
    this.#broadcast();
  }

  #broadcast(): void {
    const snap = this.snapshot();
    for (const l of this.#listeners) l(snap);
  }

  #schedulePersist(): void {
    // Compute sparse overrides (omit fields equal to default) so the stored
    // payload tracks only what the user actually changed.
    const overrides: Partial<BentoSettings> = {};
    for (const [key, value] of Object.entries(this.#current) as [
      keyof BentoSettings,
      BentoSettings[keyof BentoSettings],
    ][]) {
      if (value !== DEFAULT_SETTINGS[key]) {
        (overrides as Record<keyof BentoSettings, unknown>)[key] = value;
      }
    }
    this.#pendingOverrides = overrides;
    if (this.#saveTimer) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      const next = this.#pendingOverrides;
      this.#pendingOverrides = null;
      if (next === null) return;
      void this.#flush(next);
    }, DEBOUNCE_MS);
  }

  async #flush(overrides: Partial<BentoSettings>): Promise<void> {
    const payload: StoredShape = { version: VERSION, overrides };
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: payload });
    } catch (err) {
      console.error('[bento-tools] settings: save failed', err);
    }
  }
}
