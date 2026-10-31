// Wire contract between the Settings overlay (through the shell background) and bento-tools.
//
// The shell background forwards a document's request on the authenticated tools port as a
// `settings-client/request`, with a `caller` block derived in chrome (a document never names its
// own window or privacy). Tools answers with a `settings/result` on that port only; it is never
// broadcast. Profile-wide change notices (`settings/changed`, `privacy/changed`,
// `searchEngines/changed`) are ordinary broadcast Events in `protocol.ts`.
//
// Everything here is type-only or a small runtime guard, so the shell can import it cheaply.
// Payload validation against the settings inventory lives in bento-tools.

import type {
  BentoSettings,
  ColorStamp,
  UiColorModePref,
  ImportOptions,
  ImportSummary,
  BackupListEntry,
  PrivacyAdvancedKey,
  PrivacySettings,
  SearchEngineChoice,
  SearchEngineId,
  SelectablePrivacyProtectionLevel,
} from './protocol';

export const SETTINGS_OPERATIONS = [
  'snapshot/get',
  'settings/update',
  'settings/reset',
  'privacy/setProtectionLevel',
  'privacy/setAdvanced',
  'privacy/setDefaultSearchEngine',
  'backup/getContext',
  'backup/export',
  'backup/validateImport',
  'backup/importValidated',
  'backup/restore',
  'backup/delete',
  'operation/status',
  'recovery/acknowledgeNotice',
] as const;

export type SettingsOperation = (typeof SETTINGS_OPERATIONS)[number];

/** Operations that reserve a retained, replayable record and require an `operationId`. */
export const DURABLE_SETTINGS_OPERATIONS = [
  'settings/reset',
  'backup/importValidated',
  'backup/restore',
  'backup/delete',
] as const satisfies readonly SettingsOperation[];

export type DurableSettingsOperation = (typeof DURABLE_SETTINGS_OPERATIONS)[number];

export function isSettingsOperation(value: unknown): value is SettingsOperation {
  return SETTINGS_OPERATIONS.includes(value as SettingsOperation);
}

export function isDurableSettingsOperation(
  operation: SettingsOperation,
): operation is DurableSettingsOperation {
  return (DURABLE_SETTINGS_OPERATIONS as readonly string[]).includes(operation);
}

/**
 * Refused for private-window callers: backups and their notices (a private window keeps nothing
 * on disk) and the reset, which rewrites the whole profile and reopens the welcome flow in a
 * regular window.
 */
export function isPrivateForbiddenOperation(operation: SettingsOperation): boolean {
  return (
    operation.startsWith('backup/') ||
    operation === 'recovery/acknowledgeNotice' ||
    operation === 'settings/reset'
  );
}

/** Error codes with their `retryable` flag. */
export const SETTINGS_ERROR_RETRYABLE = {
  invalid_payload: false,
  caller_unbound: true,
  private_window_forbidden: false,
  payload_too_large: false,
  schema_invalid: false,
  token_invalid: false,
  not_found: false,
  conflict: false,
  busy: true,
  snapshot_changed: true,
  graph_reserved: true,
  operation_unknown: false,
  operation_not_owned: false,
  internal_error: true,
} as const satisfies Record<string, boolean>;

export type SettingsErrorCode = keyof typeof SETTINGS_ERROR_RETRYABLE;

export function isSettingsErrorCode(value: unknown): value is SettingsErrorCode {
  return typeof value === 'string' && Object.hasOwn(SETTINGS_ERROR_RETRYABLE, value);
}

/** Chrome-derived identity of the requesting document. */
export interface SettingsClientCaller {
  documentId: string;
  windowId: number;
  isPrivate: boolean;
  /** One browser run, minted by the chrome hub. Window ids repeat across runs, so the owner of a
   * durable operation is this plus the window id: it survives a reload of tools, not a restart. */
  sessionId: string;
}

export interface SettingsClientRequest {
  kind: 'settings-client/request';
  shellBackgroundInstanceId: string;
  caller: SettingsClientCaller;
  /** Minted by the document; echoed on the result. */
  requestId: string;
  /** A uuid, required for durable operations and forbidden otherwise. */
  operationId?: string;
  operation: SettingsOperation;
  /** Validated by tools per operation. */
  payload?: unknown;
}

export type SettingsResult =
  | {
      type: 'settings/result';
      requestId: string;
      operationId?: string;
      ok: true;
      result: unknown;
      revision: number;
    }
  | {
      type: 'settings/result';
      requestId: string;
      operationId?: string;
      ok: false;
      error: { code: SettingsErrorCode; retryable: boolean };
    };

/** The part of a request the document supplies; the shell background adds the caller. */
export type SettingsRequestBody = Pick<
  SettingsClientRequest,
  'requestId' | 'operationId' | 'operation' | 'payload'
>;

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Bound on the opaque ids a document supplies (request, document and instance ids). */
const MAX_ID_LENGTH = 128;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}

function isBoundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** True when the message claims to be a Settings request, valid or not. */
export function isSettingsClientMessage(
  value: unknown,
): value is { kind: 'settings-client/request' } & Record<string, unknown> {
  return isPlainRecord(value) && value.kind === 'settings-client/request';
}

/** The request id of a malformed request, so an error result can still be addressed. */
export function settingsRequestIdOf(value: unknown): string | null {
  return isPlainRecord(value) && isBoundedId(value.requestId) ? value.requestId : null;
}

/** Exact-shape check of a request: unknown keys, bad ids and operation-id misuse all fail. */
export function isSettingsClientRequest(value: unknown): value is SettingsClientRequest {
  if (!isPlainRecord(value) || value.kind !== 'settings-client/request') return false;
  if (
    !hasExactKeys(
      value,
      ['kind', 'shellBackgroundInstanceId', 'caller', 'requestId', 'operation'],
      ['operationId', 'payload'],
    )
  ) {
    return false;
  }
  const { caller, operation } = value;
  if (
    !isBoundedId(value.shellBackgroundInstanceId) ||
    !isBoundedId(value.requestId) ||
    !isPlainRecord(caller) ||
    !hasExactKeys(caller, ['documentId', 'windowId', 'isPrivate', 'sessionId']) ||
    !isBoundedId(caller.documentId) ||
    !isBoundedId(caller.sessionId) ||
    !Number.isInteger(caller.windowId) ||
    (caller.windowId as number) < 0 ||
    typeof caller.isPrivate !== 'boolean' ||
    !isSettingsOperation(operation)
  ) {
    return false;
  }
  if (isDurableSettingsOperation(operation)) {
    return typeof value.operationId === 'string' && UUID_PATTERN.test(value.operationId);
  }
  return value.operationId === undefined;
}

/** Guard for the shell background: tells a result from a broadcast Event. */
export function isSettingsResult(value: unknown): value is SettingsResult {
  if (!isPlainRecord(value) || value.type !== 'settings/result' || !isBoundedId(value.requestId)) {
    return false;
  }
  if (value.operationId !== undefined && typeof value.operationId !== 'string') return false;
  if (value.ok === true) {
    return (
      hasExactKeys(value, ['type', 'requestId', 'ok', 'result', 'revision'], ['operationId']) &&
      Number.isSafeInteger(value.revision)
    );
  }
  const error = value.error;
  return (
    value.ok === false &&
    hasExactKeys(value, ['type', 'requestId', 'ok', 'error'], ['operationId']) &&
    isPlainRecord(error) &&
    hasExactKeys(error, ['code', 'retryable']) &&
    isSettingsErrorCode(error.code) &&
    typeof error.retryable === 'boolean'
  );
}

// ---- Payloads and results, per operation ----

export type SettingsDomain = 'settings' | 'privacy' | 'search' | 'backup';

/** The settings the Settings surface edits; the rest belong to welcome, the sidebar and the mount. */
export type EditableSettings = Omit<
  BentoSettings,
  | 'commandPaletteEnabled'
  | 'welcomeSeen'
  | 'contentColorMode'
  | 'sidebarCollapsed'
  | 'sidebarHidden'
  | 'privacyProtectionLevel'
  | 'defaultSearchEngine'
>;

/** Privacy snapshot without the search-engine fields, which have their own domain. */
export type SettingsPrivacy = Omit<
  PrivacySettings,
  'defaultSearchEngine' | 'availableSearchEngines' | 'searchSuggestionsEnabled'
>;

export interface SettingsSearch {
  defaultSearchEngine: SearchEngineId;
  availableSearchEngines: Array<Pick<SearchEngineChoice, 'id' | 'name' | 'isDefault'>>;
}

export interface SettingsPayloads {
  'snapshot/get': { domains: SettingsDomain[] };
  'settings/update': { changes: Partial<EditableSettings> };
  'settings/reset': { confirm: true };
  'privacy/setProtectionLevel': { level: SelectablePrivacyProtectionLevel };
  'privacy/setAdvanced': { key: PrivacyAdvancedKey; value: boolean | string };
  'privacy/setDefaultSearchEngine': { id: SearchEngineId };
  'backup/getContext': Record<string, never>;
  'backup/export': { workspaceIds?: string[] };
  'backup/validateImport': { json: string };
  'backup/importValidated': { validationToken: string; options: ImportOptions };
  'backup/restore': { backupId: string };
  'backup/delete': { backupId: string; confirm: true };
  'operation/status': { operationId: string };
  'recovery/acknowledgeNotice': { operationId: string };
}

export type OperationState =
  'reserved' | 'running' | 'partial' | 'succeeded' | 'failed' | 'cancelled';

export interface OperationComponent {
  component: string;
  state: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';
  retryable: boolean;
  errorCode?: string;
}

/** Retained public record of a durable operation (`operation/status`). */
export interface OperationStatus {
  operationId: string;
  kind: DurableSettingsOperation;
  state: OperationState;
  phase: string;
  components: OperationComponent[];
  reconcileComponents: string[];
  cancelRequested: boolean;
  result?: unknown;
  errorCode?: string;
  createdAt: number;
  updatedAt: number;
}

/** A durable operation of the caller's window that is running or finished recently. */
export interface PendingOperation {
  operationId: string;
  kind: DurableSettingsOperation;
  state: OperationState;
  updatedAt: number;
  /** True once a document reported how it ended (`recovery/acknowledgeNotice`); omitted before. */
  noticeAcknowledged?: true;
}

export interface RecoveredOperationNotice {
  operationId: string;
  kind: DurableSettingsOperation;
  state: OperationState;
  components: OperationComponent[];
  updatedAt: number;
}

export interface BackupContext {
  workspaces: Array<{
    id: string;
    name: string;
    normalTabCount: number;
    panelCount: number;
    pinCount: number;
  }>;
  backups: BackupListEntry[];
  savedPanelCount: number;
  revision: number;
}

export interface SettingsSnapshot {
  revision: number;
  settings?: EditableSettings;
  /** Sampled synchronously with settings.uiColorMode by its owner. */
  colorStamp?: ColorStamp;
  privacy?: SettingsPrivacy;
  search?: SettingsSearch;
  /** Omitted for private callers. */
  backup?: BackupContext;
  /** Omitted for private callers. */
  recoveredOperationNotices?: RecoveredOperationNotice[];
  /** Lets a reloaded document resume polling `operation/status`. */
  pendingOperations: PendingOperation[];
}

/** Reply to the chrome hub's native-only, window-bound owner read. */
export type NativeModeStateReply =
  | { ok: true; pref: UiColorModePref; stamp: ColorStamp }
  | { ok: false; error: string };

export interface SettingsUpdateResult {
  settings: BentoSettings;
  durableRevision: number;
}

interface LiveMutationFields {
  durableRevision: number;
  state: 'succeeded' | 'partial';
  component: OperationComponent;
}

export type PrivacyMutationResult = LiveMutationFields & { privacy: SettingsPrivacy };
export type SearchMutationResult = LiveMutationFields & { search: SettingsSearch };

export interface BackupExportResult {
  json: string;
  filename: string;
  schemaVersion: 1 | 2;
  snapshotRevision: number;
}

export interface ImportPreview {
  schemaVersion: 1 | 2;
  totals: {
    workspaceCount: number;
    normalTabCount: number;
    panelCount: number;
    pinCount: number;
  };
  workspaces: Array<{
    sourceOrdinal: number;
    sourceId: string;
    name: string;
    normalTabCount: number;
    panelCount: number;
    pinCount: number;
  }>;
  hasSettings: boolean;
  savedPanelCount: number;
  privacySafety: 'file-unclassified';
}

export interface ValidateImportResult {
  validationToken: string;
  expiresAt: number;
  preview: ImportPreview;
}

/** Result of a durable operation, as returned and retained. */
export interface DurableOperationResult {
  kind: DurableSettingsOperation;
  operationId: string;
  /** `partial` when a component failed; see `components` and `reconcileComponents`. */
  state: 'succeeded' | 'partial';
  components: OperationComponent[];
  reconcileComponents: string[];
}

export type SettingsResetResult = DurableOperationResult & {
  result: { settings: EditableSettings; privacy: SettingsPrivacy; search: SettingsSearch };
};
export type BackupImportResult = DurableOperationResult & { summary: ImportSummary };
export type BackupDeleteResult = DurableOperationResult & { backups: BackupListEntry[] };
