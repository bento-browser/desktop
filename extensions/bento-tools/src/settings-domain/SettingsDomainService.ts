import {
  SETTINGS_LIMITS,
  SNAPSHOT_DOMAINS,
  validateAdvancedPrivacyChange,
  validateSettingsChanges,
} from '@shared/settings-rules';
import type {
  BentoExportSchema,
  BentoSettings,
  Event,
  ImportOptions,
  PrivacyAdvancedKey,
  PrivacySettings,
  SearchEngineId,
  SearchEnginesSnapshot,
  SelectablePrivacyProtectionLevel,
} from '@shared/protocol';
import {
  isPrivateForbiddenOperation,
  type EditableSettings,
  type OperationStatus,
  type PendingOperation,
  type PrivacyMutationResult,
  type SearchMutationResult,
  type SettingsClientCaller,
  type SettingsDomain,
  type SettingsOperation,
  type SettingsPrivacy,
  type SettingsSearch,
  type SettingsSnapshot,
  type SettingsUpdateResult,
  type ValidateImportResult,
} from '@shared/settings-client-protocol';
import { splitWindowLocalSettings } from '@shared/windowLocalSettings';
import { validateExportSchema } from '../backup/ExportSchema';
import { executeImport } from '../backup/ImportExecutor';
import type { BackupStore } from '../backup/BackupStore';
import type { BentoMutationCoordinator } from '../mutations/BentoMutationCoordinator';
import {
  failComponents,
  finishComponents,
  type DurableOperationComponent,
  type DurableOperationKind,
  type DurableOperationRecord,
  type OperationRegistry,
} from './OperationRegistry';
import type { PanelStore } from '../panels/PanelStore';
import type { PinnedPanelsStore } from '../pinnedPanels/PinnedPanelsStore';
import type { PrivacyMutationService } from '../privacy/PrivacyMutationService';
import { readPrivacySnapshot, readSearchEnginesSnapshot } from '../privacy/ProtectionLevels';
import {
  graphSkippedComponents,
  type GraphOperationJournal,
  type GraphOperationRecovery,
} from '../replacement/GraphOperationJournal';
import type { SavedPanelsStore } from '../saved-panels/SavedPanelsStore';
import type { SettingsStore } from '../settings/SettingsStore';
import type { TabRegistry } from '../tabs/TabRegistry';
import type { WorkspaceStore } from '../workspaces/WorkspaceStore';
import { SettingsError, toSettingsError } from './SettingsError';

/** How long a finished operation stays listed in `pendingOperations`. */
const RECENT_OPERATION_MS = 10 * 60 * 1000;

const GRAPH_COMPONENTS = [
  'graphStage',
  'graphPersistence',
  'tabRelocation',
  'guards',
  'ownershipProof',
  'usableTabProof',
  'panelSync',
  'oldGraphCleanup',
  'savedPanels',
  'settings',
  'privacy',
  'search',
];

const RESTORE_OPTIONS: ImportOptions = {
  importSettings: false,
  importSavedPanels: false,
  replaceExisting: false,
};

/** Who is asking, independent of the transport that carried the request. */
export interface SettingsCaller {
  /** Binds import validation tokens: the overlay document id. */
  clientId: string;
  /** Binds durable operations: the browser session plus window id. */
  ownerId: string;
  windowId: number;
  isPrivate: boolean;
}

/** Ordinary shell-port handlers carry no document identity; their records are never read back. */
export function shellPortCaller(windowId: number | null): SettingsCaller {
  return {
    clientId: 'shell-port',
    ownerId: 'shell-port',
    windowId: windowId ?? -1,
    isPrivate: false,
  };
}

export interface SettingsDomainContext {
  /** Resolves once startup recovery has run. */
  ready: Promise<unknown>;
  settings: SettingsStore;
  backup: BackupStore;
  workspaces: WorkspaceStore;
  tabs: TabRegistry;
  panels: PanelStore;
  pinnedPanels: PinnedPanelsStore;
  savedPanels: SavedPanelsStore;
  coordinator: BentoMutationCoordinator;
  operations: OperationRegistry;
  journal: GraphOperationJournal;
  recovery: GraphOperationRecovery;
  privacyMutations: PrivacyMutationService;
  /** Reaches every connected shell document. */
  broadcast(event: Event): void;
}

export interface SettingsRequest {
  operation: SettingsOperation;
  payload?: unknown;
  /** Required for durable operations. */
  operationId?: string;
}

interface ImportToken {
  clientId: string;
  windowId: number;
  expiresAt: number;
  data: BentoExportSchema;
}

/** What an operation's effect reports; the registry record and result are built from it. */
interface EffectOutcome {
  /** Operation-specific fields merged into the result. */
  extra: Record<string, unknown>;
  /** Components that did not complete; any entry makes the operation `partial`. */
  failed?: DurableOperationComponent[];
  skipped?: ReadonlySet<string>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= SETTINGS_LIMITS.idCodeUnits
  );
}

function invalidPayload(): SettingsError {
  return new SettingsError('invalid_payload');
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function settingsPrivacy(snapshot: PrivacySettings): SettingsPrivacy {
  const privacy: Partial<PrivacySettings> = { ...snapshot };
  delete privacy.defaultSearchEngine;
  delete privacy.availableSearchEngines;
  delete privacy.searchSuggestionsEnabled;
  return privacy as SettingsPrivacy;
}

function settingsSearch(snapshot: SearchEnginesSnapshot): SettingsSearch {
  return {
    defaultSearchEngine: snapshot.defaultSearchEngine,
    availableSearchEngines: snapshot.availableSearchEngines.map(({ id, name, isDefault }) => ({
      id,
      name,
      isDefault,
    })),
  };
}

export function toPublicOperation(record: DurableOperationRecord): OperationStatus {
  return {
    operationId: record.operationId,
    kind: record.kind,
    state: record.state,
    phase: record.phase,
    components: record.components,
    reconcileComponents: record.reconcileComponents,
    cancelRequested: record.cancelRequested,
    result: record.result,
    errorCode: record.errorCode,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Settings, privacy, search and backup operations with their validation, private-window policy,
 * serialization, durable operation records and change notices. Transport-free: the Settings
 * overlay calls `execute`, and ordinary shell-port handlers call the typed mutations below, so
 * the outcome of a change never depends on how it arrived.
 */
export class SettingsDomainService {
  #ctx: SettingsDomainContext;
  #revision = 0;
  #tokens = new Map<string, ImportToken>();
  #settingsListeners = new Set<(settings: EditableSettings, revision: number) => void>();
  #ready: Promise<void>;

  constructor(ctx: SettingsDomainContext) {
    this.#ctx = ctx;
    ctx.settings.onChange(() => {
      this.#revision += 1;
      const settings = this.editableSettings();
      for (const listener of this.#settingsListeners) listener(settings, this.#revision);
    });
    this.#ready = this.#initialize();
  }

  get revision(): number {
    return this.#revision;
  }

  /** Resolves once startup settlement is done; requests wait for it. */
  ready(): Promise<void> {
    return this.#ready;
  }

  onSettingsChange(listener: (settings: EditableSettings, revision: number) => void): () => void {
    this.#settingsListeners.add(listener);
    return () => this.#settingsListeners.delete(listener);
  }

  editableSettings(): EditableSettings {
    const editable: Partial<BentoSettings> = { ...this.#ctx.settings.snapshot() };
    delete editable.commandPaletteEnabled;
    delete editable.welcomeSeen;
    delete editable.contentColorMode;
    delete editable.sidebarCollapsed;
    delete editable.sidebarHidden;
    delete editable.privacyProtectionLevel;
    delete editable.defaultSearchEngine;
    return editable as EditableSettings;
  }

  /**
   * The caller for a document the shell background relayed. Durable operations belong to a
   * window of one browser session (chrome mints the session id; window ids repeat across
   * sessions), so a reloaded Settings document, or a reloaded tools background, still reaches the
   * work of the window, while records from an earlier browser session stay unreachable.
   */
  overlayCaller(caller: SettingsClientCaller): SettingsCaller {
    return {
      clientId: caller.documentId,
      ownerId: `window:${caller.sessionId}:${caller.windowId}`,
      windowId: caller.windowId,
      isPrivate: caller.isPrivate,
    };
  }

  /** Validates and runs one request. Throws `SettingsError` only. */
  async execute(request: SettingsRequest, caller: SettingsCaller): Promise<unknown> {
    try {
      await this.#ready;
      if (caller.isPrivate && isPrivateForbiddenOperation(request.operation)) {
        throw new SettingsError('private_window_forbidden');
      }
      return await this.#dispatch(request, caller);
    } catch (error) {
      throw toSettingsError(error);
    }
  }

  // ---- Typed mutations. Callers validated their input; ordinary handlers use these directly.
  // They wait for startup settlement like `execute` does: a record reserved before it ran
  // would be failed by it. ----

  /** Any shell setting (the editable subset is enforced by `execute`, not here). */
  async updateSettings(changes: Partial<BentoSettings>): Promise<SettingsUpdateResult> {
    await this.#ready;
    return this.#ctx.coordinator.runExclusive('settings', () => this.#ctx.settings.update(changes));
  }

  async setProtectionLevel(
    level: SelectablePrivacyProtectionLevel,
  ): Promise<PrivacyMutationResult> {
    await this.#ready;
    const outcome = await this.#ctx.coordinator.runExclusive('privacy', () =>
      this.#ctx.privacyMutations.setProtectionLevel(level),
    );
    await this.#announce(outcome.value);
    return {
      privacy: settingsPrivacy(outcome.value),
      durableRevision: ++this.#revision,
      state: outcome.state,
      component: outcome.component,
    };
  }

  async setAdvanced(
    key: PrivacyAdvancedKey,
    value: boolean | string,
  ): Promise<PrivacyMutationResult> {
    await this.#ready;
    const outcome = await this.#ctx.coordinator.runExclusive('privacy', () =>
      this.#ctx.privacyMutations.setAdvanced(key, value),
    );
    await this.#announce(outcome.value);
    return {
      privacy: settingsPrivacy(outcome.value),
      durableRevision: ++this.#revision,
      state: outcome.state,
      component: outcome.component,
    };
  }

  async setSearchEngine(id: SearchEngineId): Promise<SearchMutationResult> {
    await this.#ready;
    const outcome = await this.#ctx.coordinator.runExclusive('search', () =>
      this.#ctx.privacyMutations.setSearchEngine(id),
    );
    await this.#announce();
    return {
      search: settingsSearch(outcome.value),
      durableRevision: ++this.#revision,
      state: outcome.state,
      component: outcome.component,
    };
  }

  /** Resets settings, then re-applies the default privacy level and search engine. */
  async reset(operationId: string, caller: SettingsCaller): Promise<unknown> {
    await this.#ready;
    return this.#runOperation(
      {
        kind: 'settings/reset',
        operationId,
        caller,
        payload: { confirm: true },
        components: ['settings', 'privacy', 'search'],
      },
      async () => {
        const { privacy, search } = await this.#ctx.coordinator.runExclusive(
          'settings',
          async () => {
            const committed = await this.#ctx.settings.reset();
            return {
              privacy: await this.#ctx.privacyMutations.setProtectionLevel(
                committed.settings.privacyProtectionLevel,
              ),
              search: await this.#ctx.privacyMutations.setSearchEngine(
                committed.settings.defaultSearchEngine,
              ),
            };
          },
        );
        await this.#announce();
        return {
          extra: {
            result: {
              settings: this.editableSettings(),
              privacy: settingsPrivacy(privacy.value),
              search: settingsSearch(search.value),
            },
          },
          failed: [privacy.component, search.component].filter(
            (component) => component.state === 'failed',
          ),
        };
      },
    );
  }

  // ---- Dispatch ----

  async #initialize(): Promise<void> {
    await this.#ctx.ready;
    // Recovery has settled what the graph journal covered; whatever is still `reserved` or
    // `running` was cut off by the restart and can never finish.
    await this.#ctx.operations.settleInterrupted(this.#ctx.journal.current()?.operationId);
  }

  async #dispatch(request: SettingsRequest, caller: SettingsCaller): Promise<unknown> {
    const payload = request.payload ?? {};
    const operationId = request.operationId ?? '';
    switch (request.operation) {
      case 'snapshot/get':
        return this.#snapshot(payload, caller);
      case 'settings/update': {
        if (!exactKeys(payload, ['changes']) || !validateSettingsChanges(payload.changes)) {
          throw invalidPayload();
        }
        const changes = payload.changes as Partial<BentoSettings>;
        // A private window keeps its own colour mode in the shell background and never saves it;
        // whatever else it changed is a normal profile-wide preference.
        return this.updateSettings(
          caller.isPrivate ? splitWindowLocalSettings(changes).rest : changes,
        );
      }
      case 'settings/reset':
        if (!exactKeys(payload, ['confirm']) || payload.confirm !== true) throw invalidPayload();
        return this.reset(this.#requireOperationId(operationId), caller);
      case 'privacy/setProtectionLevel': {
        if (
          !exactKeys(payload, ['level']) ||
          !['standard', 'enhanced', 'hardened'].includes(String(payload.level))
        ) {
          throw invalidPayload();
        }
        return this.setProtectionLevel(payload.level as SelectablePrivacyProtectionLevel);
      }
      case 'privacy/setAdvanced':
        if (!validateAdvancedPrivacyChange(payload)) throw invalidPayload();
        return this.setAdvanced(
          (payload as { key: PrivacyAdvancedKey }).key,
          (payload as { value: boolean | string }).value,
        );
      case 'privacy/setDefaultSearchEngine':
        if (!exactKeys(payload, ['id']) || !isBoundedId(payload.id)) throw invalidPayload();
        return this.setSearchEngine(payload.id);
      case 'backup/getContext':
        if (!exactKeys(payload, [])) throw invalidPayload();
        return this.#backupContext();
      case 'backup/export':
        return this.#exportBackup(payload);
      case 'backup/validateImport':
        return this.#validateImport(payload, caller);
      case 'backup/importValidated': {
        const { validationToken, options } = this.#importValidatedPayload(payload);
        return this.#runOperation(
          {
            kind: 'backup/importValidated',
            operationId: this.#requireOperationId(operationId),
            caller,
            payload,
            components: GRAPH_COMPONENTS,
          },
          // Only a new reservation consumes the token, so replaying a finished import with the
          // same operation id never depends on it.
          async () => {
            const cached = this.#consumeToken(validationToken, caller);
            return this.#importGraph(
              'backup/importValidated',
              operationId,
              caller,
              cached.data,
              options,
            );
          },
        );
      }
      case 'backup/restore': {
        if (!exactKeys(payload, ['backupId']) || !isBoundedId(payload.backupId)) {
          throw invalidPayload();
        }
        const backupId = payload.backupId;
        return this.#runOperation(
          {
            kind: 'backup/restore',
            operationId: this.#requireOperationId(operationId),
            caller,
            payload,
            components: GRAPH_COMPONENTS,
          },
          async () => {
            const data = await this.#ctx.backup.getBackupData(backupId);
            if (!data) throw new SettingsError('not_found');
            return this.#importGraph('backup/restore', operationId, caller, data, RESTORE_OPTIONS);
          },
        );
      }
      case 'backup/delete': {
        if (
          !exactKeys(payload, ['backupId', 'confirm']) ||
          !isBoundedId(payload.backupId) ||
          payload.confirm !== true
        ) {
          throw invalidPayload();
        }
        const backupId = payload.backupId;
        return this.#runOperation(
          {
            kind: 'backup/delete',
            operationId: this.#requireOperationId(operationId),
            caller,
            payload,
            components: ['backupRecord'],
          },
          () =>
            this.#ctx.coordinator.runExclusive('backup-write', async () => {
              await this.#ctx.backup.deleteBackup(backupId);
              return { extra: { backups: await this.#ctx.backup.listBackups() } };
            }),
        );
      }
      case 'operation/status': {
        if (!exactKeys(payload, ['operationId']) || !isBoundedId(payload.operationId)) {
          throw invalidPayload();
        }
        const record = this.#ctx.operations.getOwned(payload.operationId, caller.ownerId);
        if (!record) throw new SettingsError('operation_unknown');
        if (caller.isPrivate && record.kind.startsWith('backup/')) {
          throw new SettingsError('private_window_forbidden');
        }
        return toPublicOperation(record);
      }
      case 'recovery/acknowledgeNotice':
        if (!exactKeys(payload, ['operationId']) || !isBoundedId(payload.operationId)) {
          throw invalidPayload();
        }
        await this.#ctx.operations.acknowledgeNotice(payload.operationId, caller.ownerId);
        return { acknowledged: true };
      default: {
        const unreachable: never = request.operation;
        throw new Error(`unsupported operation ${String(unreachable)}`);
      }
    }
  }

  #requireOperationId(operationId: string): string {
    if (operationId.length === 0) throw invalidPayload();
    return operationId;
  }

  // ---- Reads ----

  async #snapshot(payload: unknown, caller: SettingsCaller): Promise<SettingsSnapshot> {
    const publicationDomains: readonly string[] = SNAPSHOT_DOMAINS;
    if (
      !exactKeys(payload, ['domains']) ||
      !Array.isArray(payload.domains) ||
      payload.domains.length > publicationDomains.length ||
      !payload.domains.every((domain) => publicationDomains.includes(String(domain)))
    ) {
      throw invalidPayload();
    }
    const domains = new Set<SettingsDomain>(payload.domains as SettingsDomain[]);
    const snapshot: SettingsSnapshot = {
      revision: this.#revision,
      pendingOperations: this.#pendingOperations(caller),
    };
    if (domains.has('settings')) {
      // No await between these reads: the mode and stamp name one owner state.
      snapshot.settings = this.editableSettings();
      snapshot.colorStamp = this.#ctx.settings.colorStamp();
    }
    if (domains.has('privacy')) snapshot.privacy = settingsPrivacy(await readPrivacySnapshot());
    if (domains.has('search')) snapshot.search = settingsSearch(await readSearchEnginesSnapshot());
    if (!caller.isPrivate) {
      if (domains.has('backup')) snapshot.backup = await this.#backupContext();
      snapshot.recoveredOperationNotices = this.#ctx.operations
        .recoveredNotices(caller.ownerId, caller.isPrivate)
        .map(({ operationId, kind, state, components, updatedAt }) => ({
          operationId,
          kind,
          state,
          components,
          updatedAt,
        }));
    }
    return snapshot;
  }

  #pendingOperations(caller: SettingsCaller): PendingOperation[] {
    return this.#ctx.operations
      .listOwned(caller.ownerId, RECENT_OPERATION_MS)
      .filter((record) => !(caller.isPrivate && record.kind.startsWith('backup/')))
      .map(({ operationId, kind, state, updatedAt, noticeAcknowledged }) => ({
        operationId,
        kind,
        state,
        updatedAt,
        ...(noticeAcknowledged ? { noticeAcknowledged: true as const } : {}),
      }));
  }

  async #backupContext() {
    const exported = await this.#ctx.backup.collectSnapshot();
    return {
      workspaces: exported.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        normalTabCount: workspace.tabs.length,
        panelCount: workspace.panels.length,
        pinCount: workspace.pinnedPanels.length,
      })),
      backups: await this.#ctx.backup.listBackups(),
      savedPanelCount: this.#ctx.savedPanels.list().length,
      revision: this.#revision,
    };
  }

  // ---- Backup ----

  async #exportBackup(payload: unknown) {
    if (!exactKeys(payload, [], ['workspaceIds'])) throw invalidPayload();
    const ids = payload.workspaceIds;
    if (
      ids !== undefined &&
      (!Array.isArray(ids) ||
        ids.length > SETTINGS_LIMITS.workspaceCount ||
        !ids.every(isBoundedId))
    ) {
      throw invalidPayload();
    }
    const data = await this.#ctx.coordinator.runExclusive('backup-read', () =>
      this.#ctx.coordinator.readStableSnapshot(() =>
        this.#ctx.backup.collectSnapshot(ids as string[] | undefined),
      ),
    );
    const json = JSON.stringify(data, null, 2);
    if (utf8Length(json) > SETTINGS_LIMITS.backupFileBytes) {
      throw new SettingsError('payload_too_large');
    }
    return {
      json,
      filename: `bento-backup-${new Date().toISOString().slice(0, 10)}.json`,
      schemaVersion: data.schemaVersion,
      snapshotRevision: this.#revision,
    };
  }

  #validateImport(payload: unknown, caller: SettingsCaller): ValidateImportResult {
    if (!exactKeys(payload, ['json']) || typeof payload.json !== 'string') throw invalidPayload();
    const { json } = payload;
    // A string is never shorter in UTF-8 than in UTF-16 code units, so the cheap test settles
    // the common oversize case without encoding the whole file.
    if (
      json.length > SETTINGS_LIMITS.backupFileBytes ||
      utf8Length(json) > SETTINGS_LIMITS.backupFileBytes
    ) {
      throw new SettingsError('payload_too_large');
    }
    let parsed: BentoExportSchema | null;
    try {
      parsed = validateExportSchema(JSON.parse(json));
    } catch {
      throw new SettingsError('schema_invalid');
    }
    if (!parsed) throw new SettingsError('schema_invalid');

    // A document previews one file at a time: its earlier token goes, as do expired ones.
    const now = Date.now();
    for (const [key, entry] of this.#tokens) {
      if (entry.expiresAt <= now || entry.clientId === caller.clientId) this.#tokens.delete(key);
    }
    const validationToken = newToken();
    const expiresAt = now + SETTINGS_LIMITS.validationTokenMs;
    this.#tokens.set(validationToken, {
      clientId: caller.clientId,
      windowId: caller.windowId,
      expiresAt,
      data: parsed,
    });
    return {
      validationToken,
      expiresAt,
      preview: {
        schemaVersion: parsed.schemaVersion,
        totals: {
          workspaceCount: parsed.workspaces.length,
          normalTabCount: parsed.workspaces.reduce((sum, ws) => sum + ws.tabs.length, 0),
          panelCount: parsed.workspaces.reduce((sum, ws) => sum + ws.panels.length, 0),
          pinCount: parsed.workspaces.reduce((sum, ws) => sum + ws.pinnedPanels.length, 0),
        },
        workspaces: parsed.workspaces.map((workspace, sourceOrdinal) => ({
          sourceOrdinal,
          sourceId: workspace.id,
          name: workspace.name,
          normalTabCount: workspace.tabs.length,
          panelCount: workspace.panels.length,
          pinCount: workspace.pinnedPanels.length,
        })),
        hasSettings: Boolean(parsed.settings),
        savedPanelCount: parsed.savedPanels.length,
        privacySafety: 'file-unclassified',
      },
    };
  }

  #importValidatedPayload(payload: unknown): { validationToken: string; options: ImportOptions } {
    if (
      !exactKeys(payload, ['validationToken', 'options']) ||
      typeof payload.validationToken !== 'string' ||
      payload.validationToken.length === 0 ||
      payload.validationToken.length > 128 ||
      !exactKeys(payload.options, ['importSettings', 'importSavedPanels', 'replaceExisting'])
    ) {
      throw invalidPayload();
    }
    const options = payload.options as Record<string, unknown>;
    if (
      typeof options.importSettings !== 'boolean' ||
      typeof options.importSavedPanels !== 'boolean' ||
      typeof options.replaceExisting !== 'boolean'
    ) {
      throw invalidPayload();
    }
    return {
      validationToken: payload.validationToken,
      options: options as unknown as ImportOptions,
    };
  }

  /** Single use, and only for the document and window that previewed the file. */
  #consumeToken(validationToken: string, caller: SettingsCaller): ImportToken {
    const cached = this.#tokens.get(validationToken);
    if (
      !cached ||
      cached.clientId !== caller.clientId ||
      cached.windowId !== caller.windowId ||
      cached.expiresAt <= Date.now()
    ) {
      throw new SettingsError('token_invalid');
    }
    this.#tokens.delete(validationToken);
    return cached;
  }

  // ---- Durable operations ----

  /**
   * Reserves the operation (ownership, kind and payload hash are checked, and a repeat of the
   * same operation id replays the retained result), then runs `effect` once. Sources the effect
   * needs (validation token, stored backup) are resolved inside it, so replays never touch them.
   */
  async #runOperation(
    input: {
      kind: DurableOperationKind;
      operationId: string;
      caller: SettingsCaller;
      payload: unknown;
      components: string[];
    },
    effect: () => Promise<EffectOutcome>,
  ): Promise<unknown> {
    const { kind, operationId, caller } = input;
    const reservation = await this.#ctx.operations.reserve({
      operationId,
      kind,
      ownerClientInstanceId: caller.ownerId,
      targetWindowId: caller.windowId,
      isPrivate: caller.isPrivate,
      payloadHash: await digest(JSON.stringify(input.payload ?? {})),
      components: input.components,
    });
    if (reservation.existing) {
      if (reservation.record.result !== undefined) return reservation.record.result;
      return toPublicOperation(reservation.record);
    }
    await this.#ctx.operations.update(operationId, { state: 'running', phase: 'running' });
    try {
      const outcome = await effect();
      const failed = outcome.failed ?? [];
      const state = failed.length > 0 ? 'partial' : 'succeeded';
      const components = finishComponents(reservation.record.components, failed, outcome.skipped);
      const reconcileComponents = failed.map((entry) => entry.component);
      const result = {
        kind,
        operationId,
        state,
        components,
        reconcileComponents,
        ...outcome.extra,
      };
      await this.#ctx.operations.update(operationId, {
        state,
        phase: 'terminal',
        components,
        reconcileComponents,
        result,
      });
      return result;
    } catch (error) {
      const failure = toSettingsError(error);
      await this.#ctx.operations.update(operationId, {
        state: 'failed',
        phase: 'terminal',
        errorCode: failure.code,
        components: failComponents(reservation.record.components, failure.code, failure.retryable),
      });
      throw failure;
    }
  }

  async #importGraph(
    kind: 'backup/importValidated' | 'backup/restore',
    operationId: string,
    caller: SettingsCaller,
    data: BentoExportSchema,
    options: ImportOptions,
  ): Promise<EffectOutcome> {
    let failed: DurableOperationComponent[] = [];
    const summary = await this.#ctx.coordinator.runExclusive(
      options.replaceExisting ? 'graph-replacement' : 'graph-additive',
      async (mutation) => {
        const sourceJson = JSON.stringify(data);
        const sourceHash = await digest(sourceJson);
        const regularWindows = (await browser.windows.getAll()).filter(
          (window) => window.type === 'normal' && window.incognito !== true,
        ).length;
        const plannedCount = Math.max(
          1,
          data.workspaces.length,
          options.replaceExisting ? regularWindows : 1,
        );
        const plannedWorkspaceIds = Array.from({ length: plannedCount }, () => crypto.randomUUID());
        await this.#ctx.journal.begin({
          operationId,
          kind,
          mode: options.replaceExisting ? 'replace' : 'additive',
          applySettings: options.importSettings,
          applySavedPanels: options.importSavedPanels,
          ownerClientInstanceId: caller.ownerId,
          targetWindowId: caller.windowId,
          sourceHash,
          sourceJson,
          oldWorkspaceIds: options.replaceExisting
            ? this.#ctx.workspaces.snapshot().workspaces.map((workspace) => workspace.id)
            : [],
        });
        try {
          const result = await executeImport(data, options, {
            workspaces: this.#ctx.workspaces,
            tabs: this.#ctx.tabs,
            panels: this.#ctx.panels,
            pinnedPanels: this.#ctx.pinnedPanels,
            settings: this.#ctx.settings,
            savedPanels: this.#ctx.savedPanels,
            targetWindowId: caller.windowId,
            operation: {
              plannedWorkspaceIds,
              onPhase: async (phase) => {
                await this.#ctx.journal.update(operationId, { phase: phase as never });
                await this.#ctx.operations.update(operationId, { phase });
              },
              onWorkspaceCreated: (workspaceId) =>
                this.#ctx.journal.registerWorkspace(operationId, workspaceId),
              onTabCreated: (tabId) => this.#ctx.journal.registerTab(operationId, tabId),
              onOldTabRemoved: async (tabId) => {
                const current = this.#ctx.journal.current();
                await this.#ctx.journal.update(operationId, {
                  removedOldTabIds: [...(current?.removedOldTabIds ?? []), tabId],
                });
              },
              onWindowMap: async (mapping) => {
                await this.#ctx.journal.update(operationId, {
                  postReplacementWindowMap: Object.fromEntries(Object.entries(mapping)),
                });
              },
              onLiveEffectFailures: (list) => {
                failed = list;
              },
            },
          });
          mutation.markGraphChanged();
          await this.#ctx.journal.clear(operationId);
          return result;
        } catch (error) {
          await this.#ctx.recovery.bootstrap();
          throw error;
        }
      },
    );
    if (options.importSettings) await this.#announce();
    return {
      extra: { summary },
      failed,
      skipped: graphSkippedComponents(
        {
          mode: options.replaceExisting ? 'replace' : 'additive',
          applySettings: options.importSettings,
          applySavedPanels: options.importSavedPanels,
        },
        data.settings,
      ),
    };
  }

  // ---- Notices ----

  /** Tells every shell document that privacy and search state may have changed. */
  async #announce(privacy?: PrivacySettings): Promise<void> {
    try {
      const value = privacy ?? (await readPrivacySnapshot());
      this.#ctx.broadcast({ type: 'privacy/changed', privacy: value });
      this.#ctx.broadcast({
        type: 'searchEngines/changed',
        snapshot: {
          defaultSearchEngine: value.defaultSearchEngine,
          availableSearchEngines: value.availableSearchEngines,
        },
      });
    } catch (error) {
      console.warn('[bento-tools] privacy change notice failed:', String(error));
    }
  }
}
