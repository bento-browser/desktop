import {
  CONTRACT_SHA256,
  PROTOCOL_VERSION,
  validateEnvelope,
} from '@shared/generated/native-preferences-protocol';
import { isSettingsOperation } from '@shared/settings-client-protocol';
import { SettingsError, toSettingsError } from '../settings-domain/SettingsError';
import {
  toPublicOperation,
  type SettingsCaller,
  type SettingsDomainService,
} from '../settings-domain/SettingsDomainService';
import type { OperationRegistry } from './OperationRegistry';

const SESSION_STORAGE_KEY = 'bento.nativeSessions.v1';
const SESSION_IDLE_MS = 15 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

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
  domain: SettingsDomainService;
  /** For `operation/reconcile` and `request/cancel`, which only this transport offers. */
  operations: OperationRegistry;
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

/** Wire codes of the generated native contract for the domain's error codes that differ. */
const NATIVE_ERROR_CODES: Record<string, string> = {
  schema_invalid: 'invalid_payload',
  token_invalid: 'validation_token_invalid',
  caller_unbound: 'target_window_unavailable',
};

function nativeCaller(session: SessionRecord): SettingsCaller {
  return {
    clientId: session.clientInstanceId,
    ownerId: session.clientInstanceId,
    windowId: session.targetWindowId,
    isPrivate: session.isPrivate,
  };
}

export class NativePreferencesService {
  #ctx: ServiceContext;
  #backendInstanceId: string;
  #sessions = new Map<string, SessionRecord>();
  #rawTokens = new Map<string, string>();
  #helloCache = new Map<string, { requestHash: string; response: Record<string, unknown> }>();
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
    this.#ctx.domain.onSettingsChange((settings) => void this.#publishSettings(settings));
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
      const result = await this.#dispatch(operation, request, session);
      await browser.bentoNativePreferences.respond({
        ...base,
        ...(typeof request.operationId === 'string' ? { operationId: request.operationId } : {}),
        expiresAt: session.expiresAt,
        revision: this.#ctx.domain.revision,
        ok: true,
        result,
      });
    } catch (error) {
      console.warn('[bento-tools] native preferences request failed:', String(error));
      const { code, retryable } = this.#failure(error);
      await browser.bentoNativePreferences.respond({
        ...base,
        ok: false,
        error: wireError(code, retryable),
      });
    }
  }

  async #initialize(): Promise<void> {
    await this.#ctx.domain.ready();
    const raw = (await browser.storage.local.get(SESSION_STORAGE_KEY)) as Record<string, unknown>;
    const stored = raw[SESSION_STORAGE_KEY] as
      { version?: unknown; sessions?: unknown } | undefined;
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

  /** Wire code and retry flag; the domain's code is renamed where the native contract differs. */
  #failure(error: unknown): { code: string; retryable: boolean } {
    // Codes only this transport raises.
    const message = error instanceof Error ? error.message : '';
    if (message === 'deadline_exceeded') return { code: message, retryable: true };
    if (message === 'operation_not_reconcilable') return { code: message, retryable: false };
    const failure = toSettingsError(error);
    return { code: NATIVE_ERROR_CODES[failure.code] ?? failure.code, retryable: failure.retryable };
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
        revision: this.#ctx.domain.revision,
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
      case 'operation/reconcile': {
        if (!exactKeys(payload, ['operationId']) || typeof payload.operationId !== 'string') {
          throw new SettingsError('invalid_payload');
        }
        const record = this.#ctx.operations.getOwned(payload.operationId, session.clientInstanceId);
        if (!record) throw new SettingsError('operation_unknown');
        if (record.state !== 'partial') throw new Error('operation_not_reconcilable');
        return toPublicOperation(record);
      }
      case 'request/cancel': {
        if (!exactKeys(payload, ['operationId']) || typeof payload.operationId !== 'string') {
          throw new SettingsError('invalid_payload');
        }
        return toPublicOperation(
          await this.#ctx.operations.requestCancel(payload.operationId, session.clientInstanceId),
        );
      }
      default:
        if (!isSettingsOperation(operation)) throw new Error(`unsupported operation ${operation}`);
        return this.#ctx.domain.execute(
          {
            operation,
            payload,
            ...(typeof request.operationId === 'string'
              ? { operationId: request.operationId }
              : {}),
          },
          nativeCaller(session),
        );
    }
  }

  async #publishSettings(settings: unknown) {
    const revision = this.#ctx.domain.revision;
    for (const session of this.#sessions.values()) {
      if (session.state !== 'active') continue;
      await browser.bentoNativePreferences.publish({
        protocolVersion: PROTOCOL_VERSION,
        contractHash: CONTRACT_SHA256,
        publicationId: crypto.randomUUID(),
        clientInstanceId: session.clientInstanceId,
        backendInstanceId: this.#backendInstanceId,
        sequence: revision,
        revision,
        domain: 'settings',
        payload: settings,
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
