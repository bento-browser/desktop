// User-configurable settings store. Same mirror pattern as WorkspaceStore:
// in-memory state + storage.local persistence + listener broadcast for shell
// mirrors. UI dispatches `settings/update` actions; tools mutates + persists +
// broadcasts the new full settings object (snapshot, not delta — settings are
// small and atomic).
//
// Defaults mirror prefs/bento.js. Storing only deltas-from-default keeps the
// storage payload small and lets us evolve defaults without migrating data.

import type { BentoSettings, ColorStamp } from '@shared/protocol';
import { dropRetiredSettings, isValidBentoSettingsPatch } from '@shared/export-schema';

const STORAGE_KEY = 'bento.settings';

/**
 * How far ahead of a colour mode change the stamp's `flipAt` is set (see ColorStamp). Chrome, the
 * sidebar and each overlay receive the mode by different routes (a direct window event, the shell
 * background's BroadcastChannel, the BentoShellBus relay), 5 to 40 ms after the change, and the
 * shell documents share one process that spends about 60 ms after receipt on re-rendering the new
 * settings. Each document waits for `flipAt` and applies then, so the lead has to cover that
 * delivery; the cost is the same delay between the click and the flip. Measured with the window
 * screen-recorded (theming.md, "Mode flip fade"), palette flips with the fade start more than a
 * frame plus 8 ms apart: 1 of 8 at 80 ms, 1 of 12 at 100 ms, 1 and 2 of 12 at 120 ms (two runs),
 * 2 of 16 at 160 ms. A longer lead does not shorten that tail and only delays the flip.
 */
export const COLOR_FLIP_LEAD_MS = 120;
const VERSION = 2;

export const DEFAULT_SETTINGS: Readonly<BentoSettings> = Object.freeze({
  tabSleepEnabled: true,
  tabSleepAfterMinutes: 30,
  tabSleepKeepAlivePerWorkspace: 3,
  commandPaletteEnabled: true,
  welcomeSeen: false,
  // Fresh profiles start light; UI can also follow the OS via 'system'
  // from onboarding or the sidebar footer. Content defaults light because
  // most sites are designed light-bg-first.
  uiColorMode: 'light',
  contentColorMode: 'light',
  sidebarCollapsed: false,
  sidebarHidden: false,
  sidebarShortcutBehavior: 'collapse',
  defaultPanelWidthPx: 640,
  customPanelSizes: [320, 480, 768, 1280],
  panelCycleWraparound: false,
  panelShadowsEnabled: true,
  panelCornerRadiusPx: 12,
  panelSplitterSizePx: 14,
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

function settingValuesEqual(left: unknown, right: unknown): boolean {
  return Array.isArray(left)
    ? Array.isArray(right) &&
        left.length === right.length &&
        left.every((entry, index) => entry === right[index])
    : left === right;
}

export interface SettingsCommit {
  settings: BentoSettings;
  durableRevision: number;
}

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
    const overrides = dropRetiredSettings(stored.overrides ?? {});
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
  #durableRevision = 0;
  // Names this run of tools (a run is one lifetime of this store) and counts its colour changes.
  #colorRun = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  #colorSeq = 1;
  #colorFlipAt: number | undefined;
  #mutationQueue: Promise<void> = Promise.resolve();

  async init(): Promise<void> {
    const loaded = await load();
    const { overrides } = loaded;
    // Content color mode stays an explicit Firefox content override.
    // Profiles from older builds may have 'system' persisted there; map it
    // back to the content default while allowing uiColorMode='system'.
    if ((overrides.contentColorMode as string | undefined) === 'system')
      overrides.contentColorMode = 'light';
    if (!isValidBentoSettingsPatch(overrides)) {
      console.warn('[bento-tools] settings: invalid stored overrides — ignoring');
      this.#overrideKeys.clear();
      this.#current = { ...DEFAULT_SETTINGS };
      return;
    }
    this.#overrideKeys = loaded.overrideKeys;
    this.#current = { ...DEFAULT_SETTINGS, ...overrides };
  }

  snapshot(): BentoSettings {
    return { ...this.#current };
  }

  onChange(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Orders changes of `uiColorMode` for chrome: the run id plus a sequence that is 1 for the
   * state this run started with and rises with each change after it, before the listeners run.
   * Every settings event and the direct colour signal carry it, so the state chrome first hears
   * is stamped too. Chrome compares sequences only inside one run (see ColorStamp), so nothing
   * here depends on the clock or survives a restart.
   */
  colorStamp(): ColorStamp {
    return this.#colorFlipAt === undefined
      ? { run: this.#colorRun, seq: this.#colorSeq }
      : { run: this.#colorRun, seq: this.#colorSeq, flipAt: this.#colorFlipAt };
  }

  hasOverride(key: keyof BentoSettings): boolean {
    return this.#overrideKeys.has(key);
  }

  /** Merge `changes` into current settings + persist + broadcast. No-op if
   * nothing actually changed (referential check on each field). */
  update(changes: Partial<BentoSettings>): Promise<SettingsCommit> {
    if (!isValidBentoSettingsPatch(changes)) {
      console.warn('[bento-tools] settings: rejected invalid changes');
      return Promise.resolve({
        settings: this.snapshot(),
        durableRevision: this.#durableRevision,
      });
    }
    return this.#enqueue(async () => {
      const next = { ...this.#current };
      let dirty = false;
      for (const [key, value] of Object.entries(changes) as [
        keyof BentoSettings,
        BentoSettings[keyof BentoSettings],
      ][]) {
        const currentValue = next[key];
        const equal = settingValuesEqual(currentValue, value);
        if (equal) continue;
        (next as Record<keyof BentoSettings, unknown>)[key] = value;
        dirty = true;
      }
      if (dirty) await this.#persistAndPublish(next);
      return {
        settings: this.snapshot(),
        durableRevision: this.#durableRevision,
      };
    });
  }

  /** Restore all settings to defaults. */
  reset(): Promise<SettingsCommit> {
    return this.#enqueue(async () => {
      await this.#persistAndPublish({ ...DEFAULT_SETTINGS });
      return {
        settings: this.snapshot(),
        durableRevision: this.#durableRevision,
      };
    });
  }

  #broadcast(): void {
    const snap = this.snapshot();
    for (const l of this.#listeners) l(snap);
  }

  async #persistAndPublish(next: BentoSettings): Promise<void> {
    // Compute sparse overrides (omit fields equal to default) so the stored
    // payload tracks only what the user actually changed.
    const overrides: Partial<BentoSettings> = {};
    for (const [key, value] of Object.entries(next) as [
      keyof BentoSettings,
      BentoSettings[keyof BentoSettings],
    ][]) {
      if (!settingValuesEqual(value, DEFAULT_SETTINGS[key])) {
        (overrides as Record<keyof BentoSettings, unknown>)[key] = value;
      }
    }
    const payload: StoredShape = { version: VERSION, overrides };
    await browser.storage.local.set({ [STORAGE_KEY]: payload });
    if (next.uiColorMode !== this.#current.uiColorMode) {
      this.#colorSeq += 1;
      this.#colorFlipAt = Date.now() + COLOR_FLIP_LEAD_MS;
    }
    this.#current = next;
    this.#overrideKeys = new Set(Object.keys(overrides) as Array<keyof BentoSettings>);
    this.#durableRevision += 1;
    this.#broadcast();
  }

  #enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.#mutationQueue.then(mutation, mutation);
    this.#mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
