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
  // What a switch write in flight asked for, by key: the switch shows it until the write ends.
  const targets = new Map<string, boolean>();
  let refreshToken = 0;
  // Every request that brings back a published value (a write, a snapshot) takes the next ticket
  // when it is sent. `shown` is, per field, the newest ticket whose value the model holds, and a
  // change notice counts as the newest ticket sent so far: it was sent after everything issued
  // before it arrived. An answer applies only to fields it is newer than, so a value that landed
  // while it was away is never replaced by the older picture it brings back.
  let tickets = 0;
  const shown: Record<Versioned, number> = { settings: 0, privacy: 0, search: 0 };
  // Change notices that arrive before the first snapshot has made a model have nowhere to go.
  // They wait here with the ticket count they arrived at, and the first snapshot yields to the
  // ones that arrived after it was asked for.
  const early: {
    change: Partial<Pick<SettingsPaletteModel, Versioned>>;
    at: Partial<Record<Versioned, number>>;
  } = { change: {}, at: {} };
  // Durable operations this document has reported or is already handling, by id.
  const handled = new Set<string>();
  let durableRuns = 0;
  // Whether the palette is on screen. Chrome keeps the document loaded while it is hidden, and
  // an outcome is only reported (and acknowledged in tools) when someone could see it: one that
  // ends while hidden waits in `unseen` for the next show.
  let visible = true;
  const unseen = new Map<string, { outcome: DurableOutcome; notice: string | null }>();

  function patch(change: Partial<SettingsPaletteModel>): void {
    store.setState(({ view }) =>
      view.kind === 'ready' ? { view: { kind: 'ready', model: { ...view.model, ...change } } } : {},
    );
  }

  /** Patches the model with the answer to request `ticket` (a change notice has none and always
   * applies). Published fields a newer value already holds are left as they are. */
  function patchPublished(change: Partial<SettingsPaletteModel>, ticket?: number): void {
    if (!model()) {
      if (ticket !== undefined) return;
      for (const field of VERSIONED) {
        if (!(field in change)) continue;
        Object.assign(early.change, { [field]: change[field] });
        early.at[field] = tickets;
      }
      return;
    }
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

  function begin(key: string, target?: boolean): void {
    inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
    if (target !== undefined) targets.set(key, target);
    patch({ pending: new Set(inFlight.keys()), pendingTargets: new Map(targets), notice: null });
  }

  function end(key: string): void {
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left <= 0) {
      inFlight.delete(key);
      targets.delete(key);
    } else {
      inFlight.set(key, left);
    }
    patch({ pending: new Set(inFlight.keys()), pendingTargets: new Map(targets) });
  }

  /** Runs one write. Resolves whether tools applied it; a failure leaves a notice. */
  async function write<T>(
    key: string,
    run: () => Promise<T>,
    apply: (result: T) => Partial<SettingsPaletteModel> | undefined,
    target?: boolean,
  ): Promise<boolean> {
    begin(key, target);
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
    // Newer than the snapshot: held by the model, or (before there is one) a notice that came in
    // after the snapshot was asked for.
    const newer = (field: Versioned) =>
      previous ? ticket <= shown[field] : ticket <= (early.at[field] ?? 0);
    const next: SettingsPaletteModel = {
      isPrivate: snapshot.backup === undefined,
      settings: newer('settings')
        ? (previous?.settings ?? early.change.settings ?? snapshot.settings)
        : snapshot.settings,
      privacy: newer('privacy')
        ? (previous?.privacy ?? early.change.privacy ?? null)
        : (snapshot.privacy ?? null),
      search: newer('search')
        ? (previous?.search ?? early.change.search ?? null)
        : (snapshot.search ?? null),
      backup: snapshot.backup ?? null,
      pending: previous?.pending ?? new Set(),
      pendingTargets: previous?.pendingTargets ?? new Map(),
      notice: previous?.notice ?? null,
      importPreview: previous?.importPreview ?? null,
    };
    for (const field of VERSIONED) {
      shown[field] = Math.max(shown[field], newer(field) ? (early.at[field] ?? 0) : ticket);
    }
    early.change = {};
    early.at = {};
    store.setState({ view: { kind: 'ready', model: next } });
    client.resume(snapshot.pendingOperations);
    showUnseen();
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

  /** How an operation ended, for a palette that may be hidden. Returns the sentence to show now:
   * on screen the outcome is reported and acknowledged here; hidden, it is kept (and left
   * unacknowledged, so a reload would still find it) for the next show. */
  function takeOutcome(outcome: DurableOutcome, late: boolean): string | null {
    if (!visible) {
      handled.add(outcome.operationId);
      unseen.set(outcome.operationId, { outcome, notice: outcomeNotice(outcome, true) });
      return null;
    }
    conclude(outcome);
    return outcomeNotice(outcome, late);
  }

  /** Puts the outcomes kept while hidden on screen, once there is a model to show them in. */
  function showUnseen(): void {
    if (!visible || unseen.size === 0 || !model()) return;
    const notices: string[] = [];
    for (const { outcome, notice } of unseen.values()) {
      if (notice) notices.push(notice);
      conclude(outcome);
    }
    unseen.clear();
    if (notices.length > 0) patch({ notice: notices.join(' ') });
  }

  /** What a durable operation's end means for the mirror and the notice. */
  function settleDurable(outcome: DurableOutcome, late = false): boolean {
    const notice = takeOutcome(outcome, late);
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
        const notice = takeOutcome(outcome, true);
        if (notice) notices.push(notice);
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
    hooks: { after?: (outcome: DurableOutcome, ticket: number) => void; finish?: () => void } = {},
  ): Promise<boolean> {
    // One at a time per key: a second activation while it runs would start it again.
    if (inFlight.has(key)) return false;
    begin(key);
    durableRuns += 1;
    // Taken when the operation is sent: what it returns is no newer than that.
    const ticket = ++tickets;
    try {
      const outcome = await client.run(operation, payload);
      const done = settleDurable(outcome);
      hooks.after?.(outcome, ticket);
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
    update: (changes) => {
      // A lone on or off is a switch write: the switch shows what it asked for until it ends.
      const entries = Object.entries(changes);
      const target =
        entries.length === 1 && typeof entries[0]![1] === 'boolean' ? entries[0]![1] : undefined;
      return write(
        entries[0]?.[0] ?? 'settings',
        () => client.request('settings/update', { changes }),
        (result) => ({ settings: result.settings }),
        target,
      );
    },

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
        typeof value === 'boolean' ? value : undefined,
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
          after(outcome, ticket) {
            const reset = readResetResult(outcome.result);
            if (reset) patchPublished(reset, ticket);
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
    setVisible(next) {
      visible = next;
      if (!next) return;
      // A show starts clean; what ended while hidden is then the only notice left.
      patch({ notice: null });
      showUnseen();
    },
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
