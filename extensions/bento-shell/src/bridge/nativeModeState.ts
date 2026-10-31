import type { ColorStamp, UiColorModePref } from '@shared/protocol';
import { isSettingsResult, type NativeModeStateReply } from '@shared/settings-client-protocol';
import type { PrivateWindowSettings } from './privateWindowSettings';

interface NativeRecord {
  documentId: string | null;
  windowId: number;
  isPrivate: boolean;
  sessionId: string;
  message: unknown;
}

interface Dependencies {
  instanceId: string;
  privateSettings: PrivateWindowSettings;
  send(message: object): boolean;
  reply(requestId: string, response: NativeModeStateReply): void;
}

const REQUEST_TIMEOUT_MS = 5000;
const pref = (value: unknown): value is UiColorModePref =>
  value === 'light' || value === 'dark' || value === 'system';
function stamp(value: unknown): value is ColorStamp {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ColorStamp>;
  return typeof candidate.run === 'string' && candidate.run.length > 0 &&
    Number.isSafeInteger(candidate.seq) && (candidate.seq ?? -1) >= 0 &&
    (candidate.flipAt === undefined || Number.isFinite(candidate.flipAt));
}

/** Native reads have their own correlation/lifetime; they never enter the UI relay backlog. */
export class NativeModeStateOwner {
  readonly #deps: Dependencies;
  readonly #prefix: string;
  #next = 0;
  #pending = new Map<string, { nativeId: string; windowId: number; timer: ReturnType<typeof setTimeout> }>();

  constructor(deps: Dependencies) {
    this.#deps = deps;
    this.#prefix = `native-mode:${deps.instanceId}:`;
  }

  request(record: NativeRecord): boolean {
    const message = record.message as { kind?: unknown; requestId?: unknown } | null;
    if (record.documentId !== null || message?.kind !== 'mode-state-request' ||
        typeof message.requestId !== 'string' || !message.requestId || message.requestId.length > 128) return false;
    const nativeId = message.requestId;
    if (record.isPrivate) {
      this.#deps.privateSettings.open(record.windowId);
      const state = this.#deps.privateSettings.modeState(record.windowId);
      this.#deps.reply(nativeId, state ? { ok: true, ...state } : { ok: false, error: 'owner_not_ready' });
      return true;
    }
    const requestId = `${this.#prefix}${++this.#next}`;
    const timer = setTimeout(() => this.#finish(requestId, { ok: false, error: 'owner_timeout' }), REQUEST_TIMEOUT_MS);
    this.#pending.set(requestId, { nativeId, windowId: record.windowId, timer });
    const sent = this.#deps.send({
      kind: 'settings-client/request', shellBackgroundInstanceId: this.#deps.instanceId,
      caller: { documentId: `native:${nativeId}`, windowId: record.windowId, isPrivate: false, sessionId: record.sessionId },
      requestId, operation: 'snapshot/get', payload: { domains: ['settings'] },
    });
    if (!sent) this.#finish(requestId, { ok: false, error: 'owner_disconnected' });
    return true;
  }

  /** Consume internal answers before SettingsRelay; late answers stay internal. */
  result(message: unknown): boolean {
    if (!isSettingsResult(message) || !message.requestId.startsWith(this.#prefix)) return false;
    if (!this.#pending.has(message.requestId)) return true;
    if (!message.ok || !message.result || typeof message.result !== 'object') {
      this.#finish(message.requestId, { ok: false, error: 'owner_read_failed' });
      return true;
    }
    const result = message.result as { settings?: { uiColorMode?: unknown }; colorStamp?: unknown };
    this.#finish(message.requestId, pref(result.settings?.uiColorMode) && stamp(result.colorStamp)
      ? { ok: true, pref: result.settings.uiColorMode, stamp: { ...result.colorStamp } }
      : { ok: false, error: 'owner_state_invalid' });
    return true;
  }

  #finish(requestId: string, response: NativeModeStateReply): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(requestId);
    this.#deps.reply(pending.nativeId, response);
  }

  dropPending(windowId?: number): void {
    for (const [id, pending] of this.#pending) {
      if (windowId === undefined || pending.windowId === windowId) {
        this.#finish(id, { ok: false, error: 'owner_disconnected' });
      }
    }
  }
}
