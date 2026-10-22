// Request/result client of the Settings palette document.
//
// The document never names its window or privacy: it hands a request body to a transport
// (the private-window relay, `relayTransport.ts`), chrome stamps the caller, the shell
// background wraps it as a `settings-client/request`, and tools answers with a
// `settings/result` addressed to this document only. The client matches results to requests by
// `requestId`, enforces the deadline and, for durable operations, falls back to polling
// `operation/status` so a slow or lost reply never reads as a failure.
//
// Contract: extensions/_shared/settings-client-protocol.ts, plans/settings-palette/port-contract.md.

import type { Event } from '@shared/protocol';
import {
  isDurableSettingsOperation,
  isSettingsErrorCode,
  isSettingsResult,
  type BackupContext,
  type BackupExportResult,
  type DurableSettingsOperation,
  type OperationComponent,
  type OperationStatus,
  type PendingOperation,
  type PrivacyMutationResult,
  type SearchMutationResult,
  type SettingsRequestBody,
  type SettingsErrorCode,
  type SettingsOperation,
  type SettingsPayloads,
  type SettingsResult,
  type SettingsSnapshot,
  type SettingsUpdateResult,
  type ValidateImportResult,
} from '@shared/settings-client-protocol';

export type { SettingsRequestBody };

export type SettingsChangeEvent = Extract<
  Event,
  { type: 'settings/changed' | 'privacy/changed' | 'searchEngines/changed' }
>;

/** What a transport delivers: a result for one request, or a profile-wide change notice. */
export type SettingsInbound = SettingsResult | SettingsChangeEvent;

/** The connection to tools. `send` may throw when the relay is not available. */
export interface SettingsTransport {
  send(request: SettingsRequestBody): void;
  /** Registers the handler for everything the transport receives; returns the unsubscribe. */
  onMessage(handler: (message: unknown) => void): () => void;
}

export type SettingsClientErrorCode =
  SettingsErrorCode | 'timeout' | 'transport_unavailable' | 'disposed';

export class SettingsClientError extends Error {
  readonly code: SettingsClientErrorCode;
  readonly retryable: boolean;

  constructor(code: SettingsClientErrorCode, retryable: boolean) {
    super(`settings request failed: ${code}`);
    this.name = 'SettingsClientError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Result type per non-durable operation. Tools validated these before sending them. */
export interface SettingsResults {
  'snapshot/get': SettingsSnapshot;
  'settings/update': SettingsUpdateResult;
  'privacy/setProtectionLevel': PrivacyMutationResult;
  'privacy/setAdvanced': PrivacyMutationResult;
  'privacy/setDefaultSearchEngine': SearchMutationResult;
  'backup/getContext': BackupContext;
  'backup/export': BackupExportResult;
  'backup/validateImport': ValidateImportResult;
  'operation/status': OperationStatus;
  'recovery/acknowledgeNotice': { acknowledged: true };
}

export type PlainOperation = keyof SettingsResults;

/** How a durable operation ended. `failed` and `cancelled` carry the tools error code. */
export interface DurableOutcome {
  operationId: string;
  kind: DurableSettingsOperation;
  state: 'succeeded' | 'partial' | 'failed' | 'cancelled';
  components: OperationComponent[];
  reconcileComponents: string[];
  errorCode?: string;
  /** The retained result record: reset result, import summary, remaining backups. */
  result?: Record<string, unknown>;
}

export interface SettingsClientOptions {
  /** Deadline of a non-durable request. */
  deadlineMs?: number;
  /** How long a durable request waits for its own result before polling `operation/status`. */
  pollAfterMs?: number;
  pollIntervalMs?: number;
  /** Longest a durable operation is followed; it keeps running in tools after that. */
  durableMaxWaitMs?: number;
  /** Times the original durable request is resent when tools has no record of it. */
  maxResends?: number;
  newId?: () => string;
}

export const DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_POLL_AFTER_MS = 4_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_DURABLE_MAX_WAIT_MS = 10 * 60_000;
const DEFAULT_MAX_RESENDS = 2;

export interface SettingsClient {
  request<O extends PlainOperation>(
    operation: O,
    payload: SettingsPayloads[O],
  ): Promise<SettingsResults[O]>;
  /** Runs a durable operation under a fresh operation id (or the given one, to retry it). */
  run<O extends DurableSettingsOperation>(
    operation: O,
    payload: SettingsPayloads[O],
    operationId?: string,
  ): Promise<DurableOutcome>;
  /** Follows durable operations a previous document of this window left running. */
  resume(pending: readonly PendingOperation[]): void;
  /** Called with the outcome of each operation `resume` followed to its end. */
  onResumed(listener: (outcome: DurableOutcome) => void): () => void;
  onChange(listener: (event: SettingsChangeEvent) => void): () => void;
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isSettingsChangeEvent(value: unknown): value is SettingsChangeEvent {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'settings/changed':
      return isRecord(value.settings);
    case 'privacy/changed':
      return isRecord(value.privacy);
    case 'searchEngines/changed':
      return isRecord(value.snapshot);
    default:
      return false;
  }
}

function parseInbound(value: unknown): SettingsInbound | null {
  return isSettingsResult(value) || isSettingsChangeEvent(value) ? value : null;
}

type Terminal = 'succeeded' | 'partial' | 'failed' | 'cancelled';

function isTerminal(state: unknown): state is Terminal {
  return (
    state === 'succeeded' || state === 'partial' || state === 'failed' || state === 'cancelled'
  );
}

function components(value: unknown): OperationComponent[] {
  return Array.isArray(value) ? (value as OperationComponent[]) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Reads what a durable operation answered with: its final result, or a status record while it
 * still runs (a replay of an unfinished operation returns the record). Null means not done.
 */
export function readDurableOutcome(
  kind: DurableSettingsOperation,
  operationId: string,
  value: unknown,
): DurableOutcome | null {
  if (!isRecord(value) || !isTerminal(value.state)) return null;
  // A status record keeps the final result under `result`; a final result is the record itself.
  const final = isRecord(value.result) && isTerminal(value.result.state) ? value.result : value;
  return {
    operationId,
    kind,
    state: value.state,
    components: components(final.components ?? value.components),
    reconcileComponents: strings(final.reconcileComponents ?? value.reconcileComponents),
    errorCode: typeof value.errorCode === 'string' ? value.errorCode : undefined,
    result: final,
  };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: SettingsClientError): void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export function createSettingsClient(
  transport: SettingsTransport,
  options: SettingsClientOptions = {},
): SettingsClient {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const pollAfterMs = options.pollAfterMs ?? DEFAULT_POLL_AFTER_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const durableMaxWaitMs = options.durableMaxWaitMs ?? DEFAULT_DURABLE_MAX_WAIT_MS;
  const maxResends = options.maxResends ?? DEFAULT_MAX_RESENDS;
  const newId = options.newId ?? (() => crypto.randomUUID());

  const pending = new Map<string, PendingRequest>();
  const changeListeners = new Set<(event: SettingsChangeEvent) => void>();
  const resumedListeners = new Set<(outcome: DurableOutcome) => void>();
  /** Operations already followed, so a second snapshot does not start a second poll. */
  const following = new Set<string>();
  let disposed = false;

  const unsubscribe = transport.onMessage((message) => {
    const inbound = parseInbound(message);
    if (inbound === null) return;
    if (!isSettingsResult(inbound)) {
      for (const listener of changeListeners) listener(inbound);
      return;
    }
    const waiting = pending.get(inbound.requestId);
    if (!waiting) return;
    pending.delete(inbound.requestId);
    clearTimeout(waiting.timer);
    if (inbound.ok) {
      waiting.resolve(inbound.result);
    } else {
      const code = isSettingsErrorCode(inbound.error.code) ? inbound.error.code : 'internal_error';
      waiting.reject(new SettingsClientError(code, inbound.error.retryable));
    }
  });

  /** One request/result exchange. `timeoutMs` undefined waits for as long as the client lives. */
  function exchange(
    operation: SettingsOperation,
    payload: unknown,
    operationId: string | undefined,
    timeoutMs: number | undefined,
  ): Promise<unknown> {
    if (disposed) return Promise.reject(new SettingsClientError('disposed', false));
    const requestId = newId();
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingRequest = { resolve, reject, timer: undefined };
      if (timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new SettingsClientError('timeout', true));
        }, timeoutMs);
      }
      pending.set(requestId, entry);
      try {
        transport.send({
          requestId,
          operation,
          ...(operationId === undefined ? {} : { operationId }),
          ...(payload === undefined ? {} : { payload }),
        });
      } catch {
        pending.delete(requestId);
        clearTimeout(entry.timer);
        reject(new SettingsClientError('transport_unavailable', true));
      }
    });
  }

  /**
   * Waits for a durable operation to end. `first` is the original request's exchange, when this
   * document sent it; its reply settles the operation at any time. Otherwise (and while it has
   * no reply) the record is polled. A record tools has never heard of means the request was
   * lost on the way, so the original request is sent again under the same operation id, which
   * tools replays rather than runs twice.
   */
  async function follow(
    kind: DurableSettingsOperation,
    operationId: string,
    resend: (() => Promise<unknown>) | undefined,
    firstExchange: Promise<unknown> | undefined,
  ): Promise<DurableOutcome> {
    const startedAt = Date.now();
    let direct: { value: unknown } | { error: unknown } | undefined;
    let wake: (() => void) | undefined;
    const watch = (reply: Promise<unknown>) => {
      reply.then(
        (value) => {
          direct = { value };
          wake?.();
        },
        (error: unknown) => {
          // No deadline applies to these, so this is a refusal from tools or a closed client.
          direct = { error };
          wake?.();
        },
      );
    };
    /** Sleeps, but returns as soon as the original reply lands. */
    const pause = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });

    if (firstExchange) watch(firstExchange);
    let resends = 0;
    let waitMs = firstExchange ? pollAfterMs : 0;

    for (;;) {
      if (waitMs > 0 && !direct) await pause(waitMs);
      if (direct) {
        if ('error' in direct) throw direct.error;
        const outcome = readDurableOutcome(kind, operationId, direct.value);
        if (outcome) return outcome;
        direct = undefined; // A replay of an unfinished operation answers with its status.
      }
      if (disposed) throw new SettingsClientError('disposed', false);
      if (Date.now() - startedAt > durableMaxWaitMs) throw new SettingsClientError('timeout', true);
      try {
        const status = await exchange('operation/status', { operationId }, undefined, deadlineMs);
        const outcome = readDurableOutcome(kind, operationId, status);
        if (outcome) return outcome;
      } catch (error) {
        if (!(error instanceof SettingsClientError)) throw error;
        if (error.code === 'operation_unknown') {
          if (!resend || resends >= maxResends) throw error;
          resends += 1;
          watch(resend());
        } else if (error.code !== 'timeout' && error.code !== 'transport_unavailable') {
          throw error;
        }
      }
      waitMs = pollIntervalMs;
    }
  }

  return {
    request(operation, payload) {
      return exchange(operation, payload, undefined, deadlineMs) as Promise<
        SettingsResults[typeof operation]
      >;
    },

    run(operation, payload, operationId = newId()) {
      if (!isDurableSettingsOperation(operation)) {
        return Promise.reject(new TypeError(`${operation} is not a durable operation`));
      }
      following.add(operationId);
      const send = () => exchange(operation, payload, operationId, undefined);
      return follow(operation, operationId, send, send()).finally(() => {
        following.delete(operationId);
      });
    },

    resume(operations) {
      for (const operation of operations) {
        if (operation.state !== 'reserved' && operation.state !== 'running') continue;
        if (following.has(operation.operationId)) continue;
        following.add(operation.operationId);
        follow(operation.kind, operation.operationId, undefined, undefined)
          .then(
            (outcome) => {
              for (const listener of resumedListeners) listener(outcome);
            },
            () => {
              // The record stays in tools; the next snapshot lists it again.
            },
          )
          .finally(() => following.delete(operation.operationId));
      }
    },

    onResumed(listener) {
      resumedListeners.add(listener);
      return () => resumedListeners.delete(listener);
    },

    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },

    dispose() {
      disposed = true;
      unsubscribe();
      for (const [requestId, entry] of pending) {
        pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.reject(new SettingsClientError('disposed', false));
      }
      changeListeners.clear();
      resumedListeners.clear();
    },
  };
}
