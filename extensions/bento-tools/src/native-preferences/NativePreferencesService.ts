import {
  CONTRACT_SHA256,
  PROTOCOL_VERSION,
  validateAdvancedPrivacyChange,
  validateEnvelope,
  validateSettingsChanges,
} from '@shared/generated/native-preferences-protocol';
import type { BentoExportSchema, BentoSettings, ImportOptions } from '@shared/protocol';
import { validateExportSchema } from '../backup/ExportSchema';
import { executeImport } from '../backup/ImportExecutor';
import type { BackupStore } from '../backup/BackupStore';
import type { PanelStore } from '../panels/PanelStore';
import type { PinnedPanelsStore } from '../pinnedPanels/PinnedPanelsStore';
import { readPrivacySnapshot, readSearchEnginesSnapshot } from '../privacy/ProtectionLevels';
import type { SavedPanelsStore } from '../saved-panels/SavedPanelsStore';
import type { SettingsStore } from '../settings/SettingsStore';
import type { TabRegistry } from '../tabs/TabRegistry';
import type { WorkspaceStore } from '../workspaces/WorkspaceStore';
import type { BentoMutationCoordinator } from '../mutations/BentoMutationCoordinator';
import type {
  NativeOperationKind,
  NativeOperationRecord,
  OperationRegistry,
} from './OperationRegistry';
import { OperationConflictError, OperationOwnershipError } from './OperationRegistry';
import type {
  GraphOperationJournal,
  GraphOperationRecovery,
} from '../replacement/GraphOperationJournal';
import type { PrivacyMutationService } from '../privacy/PrivacyMutationService';
import type { GraphPublicationCoordinator } from '../replacement/GraphPublicationCoordinator';

const SESSION_STORAGE_KEY = 'bento.nativeSessions.v1';
const SESSION_IDLE_MS = 15 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const VALIDATION_TOKEN_MS = 5 * 60 * 1000;

interface SessionRecord {
  clientInstanceId: string;
  tokenDigest: string;
  sessionGeneration: number;
  lastSequence: number;
  targetWindowId: number;
  isPrivate: boolean;
  acceptedParentSessionId: string;
  acceptedParentBootId: string;
  issuedAt: number;
  lastActivityAt: number;
  expiresAt: number;
  absoluteExpiresAt: number;
  state: 'active' | 'closed' | 'expired' | 'restart-expired';
}

interface RequestMessage {
  request: Record<string, unknown>;
  targetWindowId: number;
  isPrivate: boolean;
  receivedAt?: number;
}

interface ServiceContext {
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
  graphPublications: GraphPublicationCoordinator;
  backendInstanceId: string;
}

function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function exactKeys(value: unknown, required: readonly string[], optional: readonly string[] = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function wireError(code: string, retryable = false) {
  const ids: Record<string, string> = {
    invalid_envelope: 'bento-error-invalid-envelope',
    unsupported_version: 'bento-error-unsupported-version',
    invalid_session: 'bento-error-invalid-session',
    private_window_forbidden: 'bento-error-private-window-forbidden',
    persistence_failed: 'bento-error-persistence-failed',
    target_window_unavailable: 'bento-error-target-window-unavailable',
  };
  return { code, retryable, messageL10nId: ids[code] ?? 'bento-error-internal' };
}

function nativePrivacy(snapshot: Awaited<ReturnType<typeof readPrivacySnapshot>>) {
  const privacy: Partial<typeof snapshot> = { ...snapshot };
  delete privacy.defaultSearchEngine;
  delete privacy.availableSearchEngines;
  delete privacy.searchSuggestionsEnabled;
  return privacy;
}

function nativeSearch(snapshot: Awaited<ReturnType<typeof readSearchEnginesSnapshot>>) {
  return {
    defaultSearchEngine: snapshot.defaultSearchEngine,
    availableSearchEngines: snapshot.availableSearchEngines.map(({ id, name, isDefault }) => ({
      id,
      name,
      isDefault,
    })),
  };
}

export class NativePreferencesService {
  #ctx: ServiceContext;
  #backendInstanceId: string;
  #sessions = new Map<string, SessionRecord>();
  #rawTokens = new Map<string, string>();
  #validationTokens = new Map<
    string,
    {
      clientInstanceId: string;
      expiresAt: number;
      data: NonNullable<ReturnType<typeof validateExportSchema>>;
    }
  >();
  #helloCache = new Map<string, { requestHash: string; response: Record<string, unknown> }>();
  #revision = 0;
  #initialized: Promise<void>;

  constructor(ctx: ServiceContext) {
    this.#ctx = ctx;
    this.#backendInstanceId = ctx.backendInstanceId;
    this.#initialized = this.#initialize();
  }

  start(): void {
    browser.bentoNativePreferences.onRequest.addListener((message) => {
      void this.#handle({ ...(message as RequestMessage), receivedAt: performance.now() });
    });
    this.#ctx.settings.onChange(() => {
      this.#revision += 1;
      void this.#publish('settings', this.#editableSettings());
    });
  }

  async #handle(message: RequestMessage): Promise<void> {
    const request = message.request;
    const requestId = typeof request.requestId === 'string' ? request.requestId : '';
    const clientInstanceId =
      typeof request.clientInstanceId === 'string' ? request.clientInstanceId : '';
    const base = {
      protocolVersion: PROTOCOL_VERSION,
      contractHash: CONTRACT_SHA256,
      requestId,
      clientInstanceId,
      backendInstanceId: this.#backendInstanceId,
    };
    try {
      if (!validateEnvelope(request)) {
        await browser.bentoNativePreferences.respond({
          ...base,
          ok: false,
          error: wireError(
            request.contractHash === CONTRACT_SHA256 ? 'invalid_envelope' : 'unsupported_version',
          ),
        });
        return;
      }
      await this.#initialized;
      if (
        typeof message.receivedAt === 'number' &&
        performance.now() - message.receivedAt > Number(request.deadlineMs)
      ) {
        throw new Error('deadline_exceeded');
      }
      const operation = String(request.operation);
      if (operation === 'session/hello') {
        await this.#hello(message, base);
        return;
      }
      const session = await this.#authorize(message);
      if (!session) {
        await browser.bentoNativePreferences.respond({
          ...base,
          ok: false,
          error: wireError('invalid_session'),
        });
        return;
      }
      if (
        session.isPrivate &&
        (operation.startsWith('backup/') || operation === 'recovery/acknowledgeNotice')
      ) {
        await browser.bentoNativePreferences.respond({
          ...base,
          expiresAt: session.expiresAt,
          ok: false,
          error: wireError('private_window_forbidden'),
        });
        return;
      }
      const result = await this.#dispatch(operation, request, session);
      await browser.bentoNativePreferences.respond({
        ...base,
        ...(typeof request.operationId === 'string' ? { operationId: request.operationId } : {}),
        expiresAt: session.expiresAt,
        revision: this.#revision,
        ok: true,
        result,
      });
    } catch (error) {
      console.warn('[bento-tools] native preferences request failed:', String(error));
      await browser.bentoNativePreferences.respond({
        ...base,
        ok: false,
        error: wireError(this.#errorCode(error), this.#errorCode(error) !== 'invalid_payload'),
      });
    }
  }

  async #initialize(): Promise<void> {
    await this.#ctx.ready;
    const raw = (await browser.storage.local.get(SESSION_STORAGE_KEY)) as Record<string, unknown>;
    const stored = raw[SESSION_STORAGE_KEY] as
      | { version?: unknown; sessions?: unknown }
      | undefined;
    if (stored?.version !== 1 || !Array.isArray(stored.sessions)) return;
    for (const candidate of stored.sessions) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const session = candidate as Partial<SessionRecord>;
      if (
        typeof session.clientInstanceId !== 'string' ||
        typeof session.tokenDigest !== 'string' ||
        !Number.isInteger(session.targetWindowId) ||
        typeof session.acceptedParentSessionId !== 'string' ||
        typeof session.acceptedParentBootId !== 'string' ||
        typeof session.expiresAt !== 'number' ||
        typeof session.absoluteExpiresAt !== 'number'
      ) {
        continue;
      }
      this.#sessions.set(session.clientInstanceId, {
        ...(session as SessionRecord),
        lastSequence: Number.isInteger(session.lastSequence) ? session.lastSequence! : -1,
      });
    }
  }

  #errorCode(error: unknown): string {
    if (error instanceof OperationOwnershipError) return 'operation_not_owned';
    if (error instanceof OperationConflictError) return 'conflict';
    const message = error instanceof Error ? error.message : String(error);
    const known = [
      'invalid_payload',
      'payload_too_large',
      'not_found',
      'conflict',
      'busy',
      'deadline_exceeded',
      'cancelled',
      'backend_restarted',
      'persistence_failed',
      'live_effect_failed',
      'snapshot_changed',
      'target_window_unavailable',
      'validation_token_invalid',
      'validation_token_expired',
      'validation_token_used',
      'operation_unknown',
      'operation_not_owned',
      'operation_not_reconcilable',
      'graph_reserved',
    ];
    return known.find((code) => message.includes(code)) ?? 'internal_error';
  }

  async #hello(message: RequestMessage, base: Record<string, unknown>): Promise<void> {
    const request = message.request;
    const clientInstanceId = String(request.clientInstanceId);
    const helloKey = `${clientInstanceId}:${String(request.requestId)}`;
    const requestHash = await digest(JSON.stringify(request));
    const cachedHello = this.#helloCache.get(helloKey);
    if (cachedHello) {
      if (cachedHello.requestHash !== requestHash) throw new Error('conflict');
      await browser.bentoNativePreferences.respond(cachedHello.response);
      return;
    }
    const now = Date.now();
    const attestation = await browser.bentoNativePreferences.getCurrentBootAttestation();
    const payload = request.payload as Record<string, unknown>;
    const suppliedToken = typeof payload?.resumeToken === 'string' ? payload.resumeToken : null;
    let session = this.#sessions.get(clientInstanceId);
    if (session && suppliedToken) {
      const matches =
        (await digest(suppliedToken)) === session.tokenDigest &&
        session.targetWindowId === message.targetWindowId &&
        session.isPrivate === message.isPrivate &&
        session.acceptedParentSessionId === attestation.currentParentSessionId &&
        session.acceptedParentBootId === attestation.currentBootId &&
        session.absoluteExpiresAt > now;
      if (!matches) session = undefined;
    } else {
      session = undefined;
    }
    const resumeToken = token();
    if (!session) {
      session = {
        clientInstanceId,
        tokenDigest: await digest(resumeToken),
        sessionGeneration: 1,
        lastSequence: -1,
        targetWindowId: message.targetWindowId,
        isPrivate: message.isPrivate,
        acceptedParentSessionId: attestation.currentParentSessionId,
        acceptedParentBootId: attestation.currentBootId,
        issuedAt: now,
        lastActivityAt: now,
        expiresAt: now + SESSION_IDLE_MS,
        absoluteExpiresAt: now + SESSION_ABSOLUTE_MS,
        state: 'active',
      };
    } else {
      session.sessionGeneration += 1;
      session.tokenDigest = await digest(resumeToken);
      // A successful hello rotates the capability token and starts a new
      // document generation. Its authenticated sequence therefore restarts at
      // zero without being mistaken for a replay from the prior document.
      session.lastSequence = -1;
      session.lastActivityAt = now;
      session.expiresAt = Math.min(now + SESSION_IDLE_MS, session.absoluteExpiresAt);
      session.state = 'active';
    }
    this.#sessions.set(clientInstanceId, session);
    this.#rawTokens.set(clientInstanceId, resumeToken);
    await this.#persistSessions();
    const response = {
      ...base,
      ok: true,
      result: {
        resumeToken,
        sessionGeneration: session.sessionGeneration,
        expiresAt: session.expiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        targetWindowId: session.targetWindowId,
        isPrivate: session.isPrivate,
        capabilities: {
          settings: true,
          privacy: true,
          search: true,
          shortcuts: true,
          backup: !session.isPrivate,
        },
        revision: this.#revision,
        recoveredOperationNotices: this.#ctx.operations
          .recoveredNotices(clientInstanceId, session.isPrivate)
          .map((record) => ({
            operationId: record.operationId,
            kind: record.kind,
            state: record.state,
            components: record.components,
            updatedAt: record.updatedAt,
          })),
      },
    };
    this.#helloCache.set(helloKey, { requestHash, response });
    while (this.#helloCache.size > 256) {
      this.#helloCache.delete(this.#helloCache.keys().next().value!);
    }
    await browser.bentoNativePreferences.respond(response);
  }

  async #authorize(message: RequestMessage): Promise<SessionRecord | null> {
    const request = message.request;
    const clientId = String(request.clientInstanceId);
    const resumeToken = typeof request.resumeToken === 'string' ? request.resumeToken : '';
    const session = this.#sessions.get(clientId);
    if (!session || !resumeToken || session.state !== 'active') return null;
    const now = Date.now();
    const attestation = await browser.bentoNativePreferences.getCurrentBootAttestation();
    if (
      session.targetWindowId !== message.targetWindowId ||
      session.isPrivate !== message.isPrivate ||
      session.expiresAt <= now ||
      session.absoluteExpiresAt <= now ||
      session.acceptedParentSessionId !== attestation.currentParentSessionId ||
      session.acceptedParentBootId !== attestation.currentBootId ||
      (await digest(resumeToken)) !== session.tokenDigest
    ) {
      return null;
    }
    const sequence = Number(request.sequence);
    if (!Number.isInteger(sequence) || sequence <= session.lastSequence) return null;
    session.lastSequence = sequence;
    session.lastActivityAt = now;
    session.expiresAt = Math.min(now + SESSION_IDLE_MS, session.absoluteExpiresAt);
    await this.#persistSessions();
    return session;
  }

  async #dispatch(operation: string, request: Record<string, unknown>, session: SessionRecord) {
    const payload = (request.payload ?? {}) as Record<string, unknown>;
    switch (operation) {
      case 'session/renew': {
        const resumeToken = token();
        session.tokenDigest = await digest(resumeToken);
        session.sessionGeneration += 1;
        this.#rawTokens.set(session.clientInstanceId, resumeToken);
        await this.#persistSessions();
        return {
          resumeToken,
          sessionGeneration: session.sessionGeneration,
          expiresAt: session.expiresAt,
          absoluteExpiresAt: session.absoluteExpiresAt,
        };
      }
      case 'session/close':
        session.state = 'closed';
        await this.#persistSessions();
        return { closed: true };
      case 'snapshot/get':
        return this.#snapshot(payload, session);
      case 'settings/update': {
        if (!exactKeys(payload, ['changes']) || !validateSettingsChanges(payload.changes)) {
          throw new Error('invalid_payload');
        }
        return this.#ctx.coordinator.runExclusive('settings', () =>
          this.#ctx.settings.update(payload.changes as never),
        );
      }
      case 'settings/reset': {
        if (!exactKeys(payload, ['confirm']) || payload.confirm !== true) {
          throw new Error('invalid_payload');
        }
        return this.#runOperation(
          request,
          session,
          'settings/reset',
          ['settings', 'privacy', 'search'],
          () =>
            this.#ctx.coordinator.runExclusive('settings', async () => {
              const settings = await this.#ctx.settings.reset();
              const privacy = await this.#ctx.privacyMutations.setProtectionLevel(
                settings.settings.privacyProtectionLevel,
              );
              const search = await this.#ctx.privacyMutations.setSearchEngine(
                settings.settings.defaultSearchEngine,
              );
              const components = [
                { component: 'settings', state: 'succeeded', retryable: false },
                privacy.component,
                search.component,
              ];
              return {
                kind: 'settings/reset',
                operationId: request.operationId,
                state:
                  privacy.state === 'succeeded' && search.state === 'succeeded'
                    ? 'succeeded'
                    : 'partial',
                components,
                reconcileComponents: components
                  .filter((component) => component.state === 'failed')
                  .map((component) => component.component),
                result: {
                  settings: this.#editableSettings(),
                  privacy: nativePrivacy(privacy.value),
                  search: nativeSearch(search.value),
                },
              };
            }),
        );
      }
      case 'privacy/setProtectionLevel': {
        if (
          !exactKeys(payload, ['level']) ||
          !['standard', 'enhanced', 'hardened'].includes(String(payload.level))
        ) {
          throw new Error('invalid_payload');
        }
        const outcome = await this.#ctx.coordinator.runExclusive('privacy', () =>
          this.#ctx.privacyMutations.setProtectionLevel(
            payload.level as 'standard' | 'enhanced' | 'hardened',
          ),
        );
        return {
          privacy: nativePrivacy(outcome.value),
          durableRevision: ++this.#revision,
          state: outcome.state,
          component: outcome.component,
        };
      }
      case 'privacy/setAdvanced': {
        if (!validateAdvancedPrivacyChange(payload)) throw new Error('invalid_payload');
        const outcome = await this.#ctx.coordinator.runExclusive('privacy', () =>
          this.#ctx.privacyMutations.setAdvanced(payload.key as never, payload.value as never),
        );
        return {
          privacy: nativePrivacy(outcome.value),
          durableRevision: ++this.#revision,
          state: outcome.state,
          component: outcome.component,
        };
      }
      case 'privacy/setDefaultSearchEngine': {
        if (!exactKeys(payload, ['id']) || typeof payload.id !== 'string') {
          throw new Error('invalid_payload');
        }
        const outcome = await this.#ctx.coordinator.runExclusive('search', () =>
          this.#ctx.privacyMutations.setSearchEngine(payload.id as never),
        );
        return {
          search: nativeSearch(outcome.value),
          durableRevision: ++this.#revision,
          state: outcome.state,
          component: outcome.component,
        };
      }
      case 'backup/getContext':
        return this.#backupContext();
      case 'backup/export': {
        const ids = Array.isArray(payload.workspaceIds)
          ? (payload.workspaceIds as string[])
          : undefined;
        const data = await this.#ctx.coordinator.runExclusive('backup-read', () =>
          this.#ctx.coordinator.readStableSnapshot(() => this.#ctx.backup.collectSnapshot(ids)),
        );
        const json = JSON.stringify(data, null, 2);
        if (new TextEncoder().encode(json).length > 10 * 1024 * 1024) throw new Error('size');
        return {
          json,
          filename: `bento-backup-${new Date().toISOString().slice(0, 10)}.json`,
          schemaVersion: 2,
          snapshotRevision: this.#revision,
        };
      }
      case 'backup/validateImport': {
        if (
          !exactKeys(payload, ['json']) ||
          typeof payload.json !== 'string' ||
          new TextEncoder().encode(payload.json).length > 10 * 1024 * 1024
        )
          throw new Error('file');
        const parsed = validateExportSchema(JSON.parse(payload.json));
        if (!parsed) throw new Error('schema');
        const validationToken = token();
        const expiresAt = Date.now() + VALIDATION_TOKEN_MS;
        this.#validationTokens.set(validationToken, {
          clientInstanceId: session.clientInstanceId,
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
              normalTabCount: parsed.workspaces.reduce(
                (sum, workspace) => sum + workspace.tabs.length,
                0,
              ),
              panelCount: parsed.workspaces.reduce(
                (sum, workspace) => sum + workspace.panels.length,
                0,
              ),
              pinCount: parsed.workspaces.reduce(
                (sum, workspace) => sum + workspace.pinnedPanels.length,
                0,
              ),
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
      case 'backup/importValidated': {
        const validationToken = String(payload.validationToken ?? '');
        const cached = this.#validationTokens.get(validationToken);
        if (
          !cached ||
          cached.clientInstanceId !== session.clientInstanceId ||
          cached.expiresAt <= Date.now()
        )
          throw new Error('token');
        this.#validationTokens.delete(validationToken);
        const options = payload.options as {
          importSettings: boolean;
          importSavedPanels: boolean;
          replaceExisting: boolean;
        };
        return this.#runGraphOperation(
          request,
          session,
          'backup/importValidated',
          cached.data,
          options,
        );
      }
      case 'backup/restore': {
        const data = await this.#ctx.backup.getBackupData(String(payload.backupId));
        if (!data) throw new Error('not_found');
        return this.#runGraphOperation(request, session, 'backup/restore', data, {
          importSettings: false,
          importSavedPanels: false,
          replaceExisting: false,
        });
      }
      case 'backup/delete': {
        if (
          !exactKeys(payload, ['backupId', 'confirm']) ||
          typeof payload.backupId !== 'string' ||
          payload.confirm !== true
        ) {
          throw new Error('invalid_payload');
        }
        return this.#runOperation(request, session, 'backup/delete', ['backupRecord'], () =>
          this.#ctx.coordinator.runExclusive('backup-write', async () => {
            await this.#ctx.backup.deleteBackup(payload.backupId as string);
            return {
              kind: 'backup/delete',
              operationId: request.operationId,
              state: 'succeeded',
              backups: await this.#ctx.backup.listBackups(),
            };
          }),
        );
      }
      case 'operation/status': {
        if (!exactKeys(payload, ['operationId']) || typeof payload.operationId !== 'string') {
          throw new Error('invalid_payload');
        }
        const record = this.#ctx.operations.getOwned(payload.operationId, session.clientInstanceId);
        if (!record) throw new Error('operation_unknown');
        return this.#publicOperation(record);
      }
      case 'operation/reconcile': {
        if (!exactKeys(payload, ['operationId']) || typeof payload.operationId !== 'string') {
          throw new Error('invalid_payload');
        }
        const record = this.#ctx.operations.getOwned(payload.operationId, session.clientInstanceId);
        if (!record) throw new Error('operation_unknown');
        if (record.state !== 'partial') throw new Error('operation_not_reconcilable');
        return this.#publicOperation(record);
      }
      case 'request/cancel': {
        if (!exactKeys(payload, ['operationId']) || typeof payload.operationId !== 'string') {
          throw new Error('invalid_payload');
        }
        return this.#publicOperation(
          await this.#ctx.operations.requestCancel(payload.operationId, session.clientInstanceId),
        );
      }
      case 'recovery/acknowledgeNotice':
        if (!exactKeys(payload, ['operationId']) || typeof payload.operationId !== 'string') {
          throw new Error('invalid_payload');
        }
        await this.#ctx.operations.acknowledgeNotice(payload.operationId, session.clientInstanceId);
        return { acknowledged: true };
      default:
        throw new Error(`unsupported operation ${operation}`);
    }
  }

  async #runOperation<T>(
    request: Record<string, unknown>,
    session: SessionRecord,
    kind: NativeOperationKind,
    components: string[],
    effect: () => Promise<T>,
  ): Promise<unknown> {
    const operationId = String(request.operationId ?? '');
    const payloadHash = await digest(JSON.stringify(request.payload ?? {}));
    const reservation = await this.#ctx.operations.reserve({
      operationId,
      kind,
      ownerClientInstanceId: session.clientInstanceId,
      targetWindowId: session.targetWindowId,
      isPrivate: session.isPrivate,
      payloadHash,
      components,
    });
    if (reservation.existing) {
      if (reservation.record.result !== undefined) return reservation.record.result as T;
      return this.#publicOperation(reservation.record);
    }
    await this.#ctx.operations.update(operationId, { state: 'running', phase: 'running' });
    try {
      const result = await effect();
      const state =
        result && typeof result === 'object' && (result as { state?: unknown }).state === 'partial'
          ? 'partial'
          : 'succeeded';
      await this.#ctx.operations.update(operationId, {
        state,
        phase: 'terminal',
        result,
        reconcileComponents:
          result &&
          typeof result === 'object' &&
          Array.isArray((result as { reconcileComponents?: unknown }).reconcileComponents)
            ? (result as unknown as { reconcileComponents: string[] }).reconcileComponents
            : [],
      });
      return result;
    } catch (error) {
      await this.#ctx.operations.update(operationId, {
        state: 'failed',
        phase: 'terminal',
        errorCode: this.#errorCode(error),
      });
      throw error;
    }
  }

  async #runGraphOperation(
    request: Record<string, unknown>,
    session: SessionRecord,
    kind: Extract<NativeOperationKind, 'backup/importValidated' | 'backup/restore'>,
    data: BentoExportSchema,
    options: ImportOptions,
  ) {
    return this.#runOperation(
      request,
      session,
      kind,
      [
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
      ],
      () =>
        this.#ctx.coordinator.runExclusive(
          options.replaceExisting ? 'graph-replacement' : 'graph-additive',
          async (mutation) => {
            const operationId = String(request.operationId);
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
            const plannedWorkspaceIds = Array.from({ length: plannedCount }, () =>
              crypto.randomUUID(),
            );
            const attestation = await browser.bentoNativePreferences.getCurrentBootAttestation();
            await this.#ctx.journal.begin({
              operationId,
              kind,
              mode: options.replaceExisting ? 'replace' : 'additive',
              applySettings: options.importSettings,
              applySavedPanels: options.importSavedPanels,
              ownerClientInstanceId: session.clientInstanceId,
              targetWindowId: session.targetWindowId,
              acceptedParentSessionId: attestation.currentParentSessionId,
              acceptedParentBootId: attestation.currentBootId,
              sourceHash,
              sourceJson,
              oldWorkspaceIds: options.replaceExisting
                ? this.#ctx.workspaces.snapshot().workspaces.map((workspace) => workspace.id)
                : [],
            });
            try {
              const summary = await executeImport(data, options, {
                workspaces: this.#ctx.workspaces,
                tabs: this.#ctx.tabs,
                panels: this.#ctx.panels,
                pinnedPanels: this.#ctx.pinnedPanels,
                settings: this.#ctx.settings,
                savedPanels: this.#ctx.savedPanels,
                targetWindowId: session.targetWindowId,
                operation: {
                  plannedWorkspaceIds,
                  onPhase: async (phase) => {
                    if (phase === 'graph-published') {
                      await this.#ctx.journal.update(operationId, { phase: 'publishing' });
                      await this.#ctx.operations.update(operationId, { phase: 'publishing' });
                      const publication = await this.#ctx.graphPublications.publishReplacement();
                      await this.#ctx.journal.update(operationId, { phase: 'graph-published' });
                      await this.#ctx.operations.update(operationId, { phase: 'graph-published' });
                      await this.#ctx.graphPublications.complete(publication.publicationId);
                      return;
                    }
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
                      postReplacementWindowMap: Object.fromEntries(
                        Object.entries(mapping).map(([windowId, workspaceId]) => [
                          windowId,
                          workspaceId,
                        ]),
                      ),
                    });
                  },
                },
              });
              mutation.markGraphChanged();
              await this.#ctx.journal.clear(operationId);
              return { kind, operationId, state: 'succeeded', summary };
            } catch (error) {
              await this.#ctx.recovery.bootstrap();
              throw error;
            }
          },
        ),
    );
  }

  #publicOperation(record: NativeOperationRecord) {
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

  async #snapshot(payload: Record<string, unknown>, session: SessionRecord) {
    const domains = Array.isArray(payload.domains) ? new Set(payload.domains) : new Set();
    const result: Record<string, unknown> = { revision: this.#revision };
    if (domains.has('settings')) result.settings = this.#editableSettings();
    if (domains.has('privacy')) result.privacy = nativePrivacy(await readPrivacySnapshot());
    if (domains.has('search')) result.search = nativeSearch(await readSearchEnginesSnapshot());
    if (domains.has('backup') && !session.isPrivate) result.backup = await this.#backupContext();
    return result;
  }

  #editableSettings() {
    const editable: Partial<BentoSettings> = { ...this.#ctx.settings.snapshot() };
    delete editable.commandPaletteEnabled;
    delete editable.welcomeSeen;
    delete editable.contentColorMode;
    delete editable.sidebarCollapsed;
    delete editable.sidebarHidden;
    delete editable.privacyProtectionLevel;
    delete editable.defaultSearchEngine;
    return editable;
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

  async #publish(domain: 'settings' | 'privacy' | 'search' | 'backup', payload: unknown) {
    for (const session of this.#sessions.values()) {
      if (session.state !== 'active' || (domain === 'backup' && session.isPrivate)) continue;
      await browser.bentoNativePreferences.publish({
        protocolVersion: PROTOCOL_VERSION,
        contractHash: CONTRACT_SHA256,
        publicationId: crypto.randomUUID(),
        clientInstanceId: session.clientInstanceId,
        backendInstanceId: this.#backendInstanceId,
        sequence: this.#revision,
        revision: this.#revision,
        domain,
        payload,
      });
    }
  }

  async #persistSessions() {
    await browser.storage.local.set({
      [SESSION_STORAGE_KEY]: {
        version: 1,
        sessions: Array.from(this.#sessions.values()),
      },
    });
  }
}
