// State of the Settings palette document: the last snapshot from tools, the writes in flight
// and the latest failure. Downstream of bento-tools like every other mirror: a write goes to
// tools through the client, and the answer (or a `*/changed` notice) updates the mirror.
// Built on an injected client so tests and stories never need a connection.

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SearchEnginesSnapshot } from '@shared/protocol';
import type {
  DurableSettingsOperation,
  EditableSettings,
  SettingsDomain,
  SettingsPayloads,
  SettingsPrivacy,
  SettingsSearch,
  SettingsSnapshot,
} from '@shared/settings-client-protocol';
import type {
  SettingsPaletteActions,
  SettingsPaletteModel,
  SettingsPaletteView,
} from '../components/SettingsPalette/types';
import { describeOutcome, describeSettingsError } from './errorCopy';
import type { DurableOutcome, SettingsChangeEvent, SettingsClient } from './settingsClient';

/** Effects that leave the document: chrome sentinels and the download of an export. */
export interface SettingsPaletteHost {
  openFirefoxSearchSettings(): void;
  openMergePalette(): void;
  saveFile(filename: string, json: string): void;
}

// The settings and privacy snapshots of the ordinary events carry more fields than the palette
// edits. They are assignable to the narrower model types, so they are stored as they come.

const ALL_DOMAINS: SettingsDomain[] = ['settings', 'privacy', 'search', 'backup'];

/** The relay carries at most 8 Mi characters per message (BentoShellBusChild.sys.mjs); a file
 * that would not fit is refused here instead of timing out. */
export const MAX_IMPORT_FILE_CHARS = 8 * 1024 * 1024 - 4096;

/** The state a finished reset leaves, when the retained result carries it. */
function readResetResult(
  result: Record<string, unknown> | undefined,
): Pick<SettingsPaletteModel, 'settings' | 'privacy' | 'search'> | null {
  const inner = result?.result;
  if (typeof inner !== 'object' || inner === null) return null;
  const { settings, privacy, search } = inner as Record<string, unknown>;
  if (typeof settings !== 'object' || settings === null) return null;
  if (typeof privacy !== 'object' || privacy === null) return null;
  if (typeof search !== 'object' || search === null) return null;
  return {
    settings: settings as EditableSettings,
    privacy: privacy as SettingsPrivacy,
    search: search as SettingsSearch,
  };
}

export function toSettingsSearch(snapshot: SearchEnginesSnapshot): SettingsSearch {
  return {
    defaultSearchEngine: snapshot.defaultSearchEngine,
    availableSearchEngines: snapshot.availableSearchEngines.map(({ id, name, isDefault }) => ({
      id,
      name,
      isDefault,
    })),
  };
}

interface StoreState {
  view: SettingsPaletteView;
}

export interface SettingsPaletteStore {
  store: StoreApi<StoreState>;
  actions: SettingsPaletteActions;
  dispose(): void;
}

const WHAT: Record<DurableSettingsOperation, string> = {
  'settings/reset': 'The reset',
  'backup/importValidated': 'The import',
  'backup/restore': 'The restore',
  'backup/delete': 'The delete',
};

export function createSettingsPaletteStore(
  client: SettingsClient,
  host: SettingsPaletteHost,
): SettingsPaletteStore {
  const store = createStore<StoreState>(() => ({ view: { kind: 'loading' } }));
  const inFlight = new Map<string, number>();
  let refreshToken = 0;

  function patch(change: Partial<SettingsPaletteModel>): void {
    store.setState(({ view }) =>
      view.kind === 'ready' ? { view: { kind: 'ready', model: { ...view.model, ...change } } } : {},
    );
  }

  function model(): SettingsPaletteModel | null {
    const { view } = store.getState();
    return view.kind === 'ready' ? view.model : null;
  }

  function begin(key: string): void {
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    patch({ pending: new Set(inFlight.keys()), notice: null });
  }

  function end(key: string): void {
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left <= 0) inFlight.delete(key);
    else inFlight.set(key, left);
    patch({ pending: new Set(inFlight.keys()) });
  }

  /** Runs one write. Resolves whether tools applied it; a failure leaves a notice. */
  async function write<T>(
    key: string,
    run: () => Promise<T>,
    apply: (result: T) => Partial<SettingsPaletteModel> | undefined,
  ): Promise<boolean> {
    begin(key);
    try {
      const change = apply(await run());
      if (change) patch(change);
      return true;
    } catch (error) {
      patch({ notice: describeSettingsError(error) });
      return false;
    } finally {
      end(key);
    }
  }

  function applySnapshot(snapshot: SettingsSnapshot): void {
    if (!snapshot.settings) throw new Error('snapshot without settings');
    const previous = model();
    const next: SettingsPaletteModel = {
      isPrivate: snapshot.backup === undefined,
      settings: snapshot.settings,
      privacy: snapshot.privacy ?? null,
      search: snapshot.search ?? null,
      backup: snapshot.backup ?? null,
      pending: previous?.pending ?? new Set(),
      notice: previous?.notice ?? null,
      importPreview: previous?.importPreview ?? null,
    };
    store.setState({ view: { kind: 'ready', model: next } });
    client.resume(snapshot.pendingOperations);
  }

  async function refresh(): Promise<void> {
    const token = ++refreshToken;
    try {
      const snapshot = await client.request('snapshot/get', { domains: ALL_DOMAINS });
      if (token === refreshToken) applySnapshot(snapshot);
    } catch (error) {
      if (token !== refreshToken) return;
      const message = describeSettingsError(error);
      if (model()) patch({ notice: message });
      else store.setState({ view: { kind: 'error', message } });
    }
  }

  /** What a durable operation's end means for the mirror and the notice. */
  function settleDurable(outcome: DurableOutcome): boolean {
    if (outcome.state === 'succeeded') return true;
    patch({ notice: describeOutcome(outcome.state, outcome.errorCode, WHAT[outcome.kind]) });
    return false;
  }

  /** Runs a durable operation to its end. `after` sees the outcome of a call that returned;
   * `finish` runs either way. */
  async function runDurable<O extends DurableSettingsOperation>(
    key: string,
    operation: O,
    payload: SettingsPayloads[O],
    hooks: { after?: (outcome: DurableOutcome) => void; finish?: () => void } = {},
  ): Promise<boolean> {
    // One at a time per key: a second activation while it runs would start it again.
    if (inFlight.has(key)) return false;
    begin(key);
    try {
      const outcome = await client.run(operation, payload);
      const done = settleDurable(outcome);
      hooks.after?.(outcome);
      return done;
    } catch (error) {
      patch({ notice: describeSettingsError(error) });
      return false;
    } finally {
      hooks.finish?.();
      end(key);
    }
  }

  const offChange = client.onChange((event: SettingsChangeEvent) => {
    switch (event.type) {
      case 'settings/changed':
        patch({ settings: event.settings });
        break;
      case 'privacy/changed':
        patch({ privacy: event.privacy });
        break;
      case 'searchEngines/changed':
        patch({ search: toSettingsSearch(event.snapshot) });
        break;
    }
  });

  const offResumed = client.onResumed((outcome) => {
    settleDurable(outcome);
    void refresh();
  });

  /** A live mutation tools could only partly apply (Firefox did not take the new value). */
  function partialNotice(state: 'succeeded' | 'partial'): string | undefined {
    return state === 'partial' ? 'Saved, but Firefox did not apply it yet.' : undefined;
  }

  const actions: SettingsPaletteActions = {
    update: (changes) =>
      write(
        Object.keys(changes)[0] ?? 'settings',
        () => client.request('settings/update', { changes }),
        (result) => ({ settings: result.settings }),
      ),

    setProtectionLevel: (level) =>
      write(
        'protection',
        () => client.request('privacy/setProtectionLevel', { level }),
        (result) => ({ privacy: result.privacy, notice: partialNotice(result.state) ?? null }),
      ),

    setAdvanced: (key, value) =>
      write(
        `advanced:${key}`,
        () => client.request('privacy/setAdvanced', { key, value }),
        (result) => ({ privacy: result.privacy, notice: partialNotice(result.state) ?? null }),
      ),

    setSearchEngine: (id) =>
      write(
        'search',
        () => client.request('privacy/setDefaultSearchEngine', { id }),
        (result) => ({ search: result.search, notice: partialNotice(result.state) ?? null }),
      ),

    reset: () =>
      runDurable(
        'reset',
        'settings/reset',
        { confirm: true },
        {
          after(outcome) {
            const reset = readResetResult(outcome.result);
            if (reset) patch(reset);
            else void refresh();
          },
        },
      ),

    exportBackup: () =>
      write(
        'backup',
        () => client.request('backup/export', {}),
        (result) => {
          host.saveFile(result.filename, result.json);
          return undefined;
        },
      ),

    async pickImportFile(file) {
      const json = await file.text();
      if (json.length > MAX_IMPORT_FILE_CHARS) {
        patch({ notice: 'That file is too large to import.' });
        return false;
      }
      return write(
        'backup',
        () => client.request('backup/validateImport', { json }),
        (result) => ({
          importPreview: {
            fileName: file.name,
            validationToken: result.validationToken,
            preview: result.preview,
          },
        }),
      );
    },

    async confirmImport() {
      const current = model()?.importPreview;
      if (!current) return false;
      return runDurable(
        'backup',
        'backup/importValidated',
        {
          validationToken: current.validationToken,
          options: {
            importSettings: current.preview.hasSettings,
            importSavedPanels: current.preview.savedPanelCount > 0,
            replaceExisting: false,
          },
        },
        {
          after: () => void refresh(),
          // The token is spent whether or not the import went through.
          finish: () => patch({ importPreview: null }),
        },
      );
    },

    cancelImport: () => patch({ importPreview: null }),

    restoreBackup: (backupId) =>
      runDurable('backup', 'backup/restore', { backupId }, { after: () => void refresh() }),

    deleteBackup: (backupId) =>
      runDurable(
        'backup',
        'backup/delete',
        { backupId, confirm: true },
        { after: () => void refresh() },
      ),

    openFirefoxSearchSettings: () => host.openFirefoxSearchSettings(),
    openMergePalette: () => host.openMergePalette(),
    refresh: () => void refresh(),
    clearNotice: () => patch({ notice: null }),
  };

  return {
    store,
    actions,
    dispose() {
      offChange();
      offResumed();
      client.dispose();
    },
  };
}
