import { SETTINGS_ERROR_RETRYABLE, type SettingsErrorCode } from '@shared/settings-client-protocol';
import {
  OperationConflictError,
  OperationOwnershipError,
} from '../native-preferences/OperationRegistry';

/** A failed settings operation, named with the shared error catalogue. */
export class SettingsError extends Error {
  readonly code: SettingsErrorCode;

  constructor(code: SettingsErrorCode) {
    super(code);
    this.code = code;
  }

  get retryable(): boolean {
    return SETTINGS_ERROR_RETRYABLE[this.code];
  }
}

// Messages thrown by the layers below (coordinator, journal, executor) and the code each maps to.
const LOWER_LAYER_ERRORS: ReadonlyArray<readonly [string, SettingsErrorCode]> = [
  ['snapshot_changed', 'snapshot_changed'],
  ['target_window_unavailable', 'caller_unbound'],
  ['graph_reserved', 'graph_reserved'],
  ['operation_unknown', 'operation_unknown'],
  ['not_found', 'not_found'],
  ['busy', 'busy'],
];

/** Maps anything thrown while running an operation to a `SettingsError`. */
export function toSettingsError(error: unknown): SettingsError {
  if (error instanceof SettingsError) return error;
  if (error instanceof OperationOwnershipError) return new SettingsError('operation_not_owned');
  if (error instanceof OperationConflictError) return new SettingsError('conflict');
  const message = error instanceof Error ? error.message : String(error);
  const match = LOWER_LAYER_ERRORS.find(([text]) => message.includes(text));
  return new SettingsError(match?.[1] ?? 'internal_error');
}
