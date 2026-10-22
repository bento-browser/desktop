// State of the Settings palette document: the last snapshot from tools, the writes in flight
// and the latest failure. Downstream of bento-tools like every other mirror: a write goes to
// tools through the client, and the answer (or a `*/changed` notice) updates the mirror.
// Built on an injected client so tests and stories never need a connection.

import { createStore, type StoreApi } from 'zustand/vanilla';
import type { SearchEnginesSnapshot } from '@shared/protocol';
import { SETTINGS_LIMITS } from '@shared/settings-rules';
import type {
  DurableSettingsOperation,
  EditableSettings,
  PendingOperation,
  RecoveredOperationNotice,
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
import { fitsRelayUp } from './relayLimit';
import {
  readDurableOutcome,
  type DurableOutcome,
  type SettingsChangeEvent,
  type SettingsClient,
} from './settingsClient';

/** Effects that leave the document: chrome sentinels and the download of an export. */
export interface SettingsPaletteHost {
  openFirefoxSearchSettings(): void;
  openMergePalette(): void;
  saveFile(filename: string, json: string): void;
}

// The settings and privacy snapshots of the ordinary events carry more fields than the palette
// edits. They are assignable to the narrower model types, so they are stored as they come.

const ALL_DOMAINS: SettingsDomain[] = ['settings', 'privacy', 'search', 'backup'];

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

/** The model fields that tools publishes and other windows can change under a request. */
const VERSIONED = ['settings', 'privacy', 'search'] as const;
type Versioned = (typeof VERSIONED)[number];

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
  // Every request that brings back a published value (a write, a snapshot) takes the next ticket
  // when it is sent. `shown` is, per field, the newest ticket whose value the model holds, and a
  // change notice counts as the newest ticket sent so far: it was sent after everything issued
  // before it arrived. An answer applies only to fields it is newer than, so a value that landed
  // while it was away is never replaced by the older picture it brings back.
  let tickets = 0;
  const shown: Record<Versioned, number> = { settings: 0, privacy: 0, search: 0 };
  // Durable operations this document has reported or is already handling, by id.
  const handled = new Set<string>();
  let durableRuns = 0;

  function patch(change: Partial<SettingsPaletteModel>): void {
    store.setState(({ view }) =>
      view.kind === 'ready' ? { view: { kind: 'ready', model: { ...view.model, ...change } } } : {},
    );
  }

  /** Patches the model with the answer to request `ticket` (a change notice has none and always
   * applies). Published fields a newer value already holds are left as they are. */
  function patchPublished(change: Partial<SettingsPaletteModel>, ticket?: number): void {
    if (!model()) return;
    const fresh = { ...change };
    for (const field of VERSIONED) {
      if (!(field in fresh)) continue;
      if (ticket !== undefined && ticket <= shown[field]) delete fresh[field];
      else shown[field] = Math.max(shown[field], ticket ?? tickets);
    }
    patch(fresh);
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
    const ticket = ++tickets;
    try {
      const change = apply(await run());
      if (change) patchPublished(change, ticket);
      return true;
    } catch (error) {
      patch({ notice: describeSettingsError(error) });
      return false;
    } finally {
      end(key);
    }
  }

  /** A field a newer value holds (a write or notice that landed while the snapshot was being
   * collected) keeps that value. */
  function applySnapshot(snapshot: SettingsSnapshot, ticket: number): void {
    if (!snapshot.settings) throw new Error('snapshot without settings');
    const previous = model();
    const newer = (field: Versioned) => previous !== null && ticket <= shown[field];
    const next: SettingsPaletteModel = {
      isPrivate: snapshot.backup === undefined,
      settings: previous && newer('settings') ? previous.settings : snapshot.settings,
      privacy: previous && newer('privacy') ? previous.privacy : (snapshot.privacy ?? null),
      search: previous && newer('search') ? previous.search : (snapshot.search ?? null),
      backup: snapshot.backup ?? null,
      pending: previous?.pending ?? new Set(),
      notice: previous?.notice ?? null,
      importPreview: previous?.importPreview ?? null,
    };
    for (const field of VERSIONED) if (!newer(field)) shown[field] = Math.max(shown[field], ticket);
    store.setState({ view: { kind: 'ready', model: next } });
    client.resume(snapshot.pendingOperations);
    void reportFinished(finishedOperations(snapshot));
  }

  async function refresh(): Promise<void> {
    const token = ++refreshToken;
    const ticket = ++tickets;
    try {
      const snapshot = await client.request('snapshot/get', { domains: ALL_DOMAINS });
      if (token === refreshToken) applySnapshot(snapshot, ticket);
    } catch (error) {
      if (token !== refreshToken) return;
      const message = describeSettingsError(error);
      if (model()) patch({ notice: message });
      else store.setState({ view: { kind: 'error', message } });
    }
  }

  /** The sentence for how an operation ended, or null when the palette already shows it. A
   * success is shown only for one that ended out of sight, while the palette was closed or
   * reloading. */
  function outcomeNotice(outcome: DurableOutcome, late: boolean): string | null {
    if (outcome.state === 'succeeded') return late ? `${WHAT[outcome.kind]} finished.` : null;
    return describeOutcome(outcome.state, outcome.errorCode, WHAT[outcome.kind]);
  }

  /** Marks an ended operation as reported, here and in tools, so a reload does not repeat it. */
  function conclude(outcome: DurableOutcome): void {
    handled.add(outcome.operationId);
    void client
      .request('recovery/acknowledgeNotice', { operationId: outcome.operationId })
      .catch(() => undefined);
  }

  /** What a durable operation's end means for the mirror and the notice. */
  function settleDurable(outcome: DurableOutcome, late = false): boolean {
    conclude(outcome);
    const notice = outcomeNotice(outcome, late);
    if (notice) patch({ notice });
    return outcome.state === 'succeeded';
  }

  /** Operations that ended without this document seeing them: finished while it was reloading,
   * or cut short by a restart of tools, and not reported yet. Ones still running are followed
   * by the client. */
  function finishedOperations(
    snapshot: SettingsSnapshot,
  ): Array<Pick<PendingOperation, 'operationId' | 'kind'>> {
    const found = new Map<string, Pick<PendingOperation, 'operationId' | 'kind'>>();
    const unreported = (entry: Pick<PendingOperation, 'operationId'>) =>
      !handled.has(entry.operationId);
    for (const entry of snapshot.pendingOperations) {
      const ended = entry.state !== 'reserved' && entry.state !== 'running';
      if (ended && !entry.noticeAcknowledged && unreported(entry))
        found.set(entry.operationId, entry);
    }
    const recovered: RecoveredOperationNotice[] = snapshot.recoveredOperationNotices ?? [];
    for (const entry of recovered) if (unreported(entry)) found.set(entry.operationId, entry);
    return [...found.values()];
  }

  /** Reports each of them once. One this document is running itself is left to that run. */
  async function reportFinished(
    operations: Array<Pick<PendingOperation, 'operationId' | 'kind'>>,
  ): Promise<void> {
    if (durableRuns > 0) return;
    const notices: string[] = [];
    for (const { operationId, kind } of operations) {
      if (handled.has(operationId)) continue;
      handled.add(operationId);
      try {
        const status = await client.request('operation/status', { operationId });
        const outcome = readDurableOutcome(kind, operationId, status);
        if (!outcome) {
          handled.delete(operationId); // Not finished after all; a later snapshot looks again.
          continue;
        }
        const notice = outcomeNotice(outcome, true);
        if (notice) notices.push(notice);
        conclude(outcome);
      } catch {
        handled.delete(operationId);
      }
    }
    if (notices.length > 0) patch({ notice: notices.join(' ') });
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
    durableRuns += 1;
    try {
      const outcome = await client.run(operation, payload);
      const done = settleDurable(outcome);
      hooks.after?.(outcome);
      return done;
    } catch (error) {
      patch({ notice: describeSettingsError(error) });
      return false;
    } finally {
      durableRuns -= 1;
      hooks.finish?.();
      end(key);
    }
  }

  const offChange = client.onChange((event: SettingsChangeEvent) => {
    switch (event.type) {
      case 'settings/changed':
        patchPublished({ settings: event.settings });
        break;
      case 'privacy/changed':
        patchPublished({ privacy: event.privacy });
        break;
      case 'searchEngines/changed':
        patchPublished({ search: toSettingsSearch(event.snapshot) });
        break;
    }
  });

  const offResumed = client.onResumed((outcome) => {
    settleDurable(outcome, true);
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
            if (reset) patchPublished(reset);
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
      // The size tools accepts, then what the relay can carry once the text is escaped into a
      // message: a file over either is refused here instead of timing out.
      const json = file.size > SETTINGS_LIMITS.backupFileBytes ? null : await file.text();
      if (json === null || !fitsRelayUp(json)) {
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
