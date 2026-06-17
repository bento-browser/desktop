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
const VERSION = 2;
const DEBOUNCE_MS = 250;

export const DEFAULT_SETTINGS: Readonly<BentoSettings> = Object.freeze({
  tabSleepEnabled: true,
  tabSleepAfterMinutes: 30,
  tabSleepKeepAlivePerWorkspace: 3,
  defaultWorkspaceName: 'Personal',
  commandPaletteEnabled: true,
  welcomeSeen: false,
  // Fresh profiles start light; UI can also follow the OS via 'system'
  // from onboarding or the sidebar footer. Content defaults light because
  // most sites are designed light-bg-first.
  uiColorMode: 'light',
  contentColorMode: 'light',
  sidebarCollapsed: false,
  defaultPanelWidthPx: 640,
  customPanelSizes: [320, 480, 768, 1280],
  panelCycleWraparound: false,
  panelShadowsEnabled: true,
  autoBackupEnabled: true,
  autoBackupIntervalMinutes: 30,
  autoBackupMaxCount: 5,
  privacyProtectionLevel: 'standard',
  defaultSearchEngine: 'ddg',
});

interface StoredShape {
  version: number;
  /** Sparse — only fields the user has overridden from defaults. */
  overrides: Partial<BentoSettings>;
}

type Listener = (settings: BentoSettings) => void;

async function load(): Promise<{
  overrides: Partial<BentoSettings>;
  overrideKeys: Set<keyof BentoSettings>;
}> {
  try {
    const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
    const stored = raw[STORAGE_KEY] as StoredShape | undefined;
    if (!stored || typeof stored !== 'object') return { overrides: {}, overrideKeys: new Set() };
    if (stored.version !== 1 && stored.version !== VERSION) {
      console.warn('[bento-tools] settings: unknown version', stored.version, '— ignoring');
      return { overrides: {}, overrideKeys: new Set() };
    }
    const overrides = stored.overrides ?? {};
    return {
      overrides,
      overrideKeys: new Set(Object.keys(overrides) as Array<keyof BentoSettings>),
    };
  } catch (err) {
    console.error('[bento-tools] settings: load failed', err);
    return { overrides: {}, overrideKeys: new Set() };
  }
}

export class SettingsStore {
  #current: BentoSettings = { ...DEFAULT_SETTINGS };
  #listeners = new Set<Listener>();
  #overrideKeys = new Set<keyof BentoSettings>();
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingOverrides: Partial<BentoSettings> | null = null;

  async init(): Promise<void> {
    const { overrides, overrideKeys } = await load();
    this.#overrideKeys = overrideKeys;
    // Content color mode stays an explicit Firefox content override.
    // Profiles from older builds may have 'system' persisted there; map it
    // back to the content default while allowing uiColorMode='system'.
    if ((overrides.contentColorMode as string | undefined) === 'system')
      overrides.contentColorMode = 'light';
    this.#current = { ...DEFAULT_SETTINGS, ...overrides };
  }

  snapshot(): BentoSettings {
    return { ...this.#current };
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  hasOverride(key: keyof BentoSettings): boolean {
    return this.#overrideKeys.has(key);
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
      this.#overrideKeys.add(key);
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
    this.#overrideKeys.clear();
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
    this.#overrideKeys = new Set(Object.keys(overrides) as Array<keyof BentoSettings>);
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
