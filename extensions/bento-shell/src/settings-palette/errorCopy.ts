// What the Settings palette tells the user when a request fails.

import { SettingsClientError } from './settingsClient';

const COPY: Record<string, string> = {
  timeout: 'Bento did not answer in time. Try again.',
  transport_unavailable: 'Settings are not reachable right now. Try again.',
  disposed: 'Settings closed before the change finished.',
  caller_unbound: 'This window is not ready for settings yet. Try again.',
  private_window_forbidden: 'This is not available in private windows.',
  payload_too_large: 'That file is too large to import.',
  schema_invalid: 'That file is not a Bento backup.',
  token_invalid: 'The file check expired. Choose the file again.',
  not_found: 'That item no longer exists.',
  conflict: 'Another change conflicted with this one. Try again.',
  busy: 'Bento is busy with another change. Try again in a moment.',
  graph_reserved: 'Bento is busy with another change. Try again in a moment.',
  snapshot_changed: 'Your data changed while this was running. Try again.',
  invalid_payload: 'Bento did not accept that value.',
  operation_unknown: 'Bento lost track of that change. Check the result and try again.',
  operation_not_owned: 'That change belongs to another window.',
  backend_restarted: 'Bento restarted first. Check the result and try again.',
};

const FALLBACK = 'Something went wrong. Try again.';

export function describeSettingsError(error: unknown): string {
  if (error instanceof SettingsClientError) return COPY[error.code] ?? FALLBACK;
  return FALLBACK;
}

/** Copy for a durable operation that ended without succeeding in full. */
export function describeOutcome(
  state: 'partial' | 'failed' | 'cancelled',
  errorCode: string | undefined,
  what: string,
): string {
  if (state === 'partial') {
    return `${what} finished, but some parts did not apply. Check it and try again if needed.`;
  }
  const reason = errorCode ? COPY[errorCode] : undefined;
  return reason ? `${what} did not finish. ${reason}` : `${what} did not finish.`;
}
