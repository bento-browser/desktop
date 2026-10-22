// Settings overlay traffic in the shell background.
//
// The Settings overlay is a shell document in every window, regular or private. It reaches the
// background through the BentoShellBus relay (BroadcastChannel is partitioned away from a private
// window), and the hub stamps each message with the window id and privacy of the chrome window
// that hosts the document. This module turns the document's request into a
// `settings-client/request` for tools on the authenticated port, with that chrome-derived
// `caller`, and delivers tools' `settings/result` to the one document that asked. Profile-wide
// change notices reach every Settings document.
//
// A private window keeps its own colour mode (and sidebar state) in memory, never saved: its
// Settings document edits and reads that value, not the profile's. Tools strips the window-local
// keys from a private caller's update; the value is held here (PrivateWindowSettings) and
// projected over the results and notices that document receives.
//
// Contract: extensions/_shared/settings-client-protocol.ts, plans/settings-palette/port-contract.md.

import type { BentoSettings, Event } from '@shared/protocol';
import {
  SETTINGS_ERROR_RETRYABLE,
  isSettingsOperation,
  isSettingsResult,
  settingsRequestIdOf,
  type SettingsErrorCode,
  type SettingsOperation,
  type SettingsResult,
} from '@shared/settings-client-protocol';
import { splitWindowLocalSettings, type WindowLocalSettings } from '@shared/windowLocalSettings';
import type { PrivateWindowSettings } from './privateWindowSettings';
import type { BusDown } from './shellBus';

/** Who a Settings document is, as the hub derived it from chrome. */
export interface SettingsDocumentIdentity {
  windowId: number;
  isPrivate: boolean;
}

export interface SettingsRelayDeps {
  /** Names this background to tools (`shellBackgroundInstanceId`). */
  instanceId: string;
  /** Sends on the tools port; false when the port is not connected. */
  toTools(message: object): boolean;
  /** Posts to one document through the hub; false when the document is gone. */
  toDocument(documentId: string, message: BusDown): Promise<boolean>;
  privateSettings: PrivateWindowSettings;
  /** Records a private window's own sidebar or colour-mode change and tells its documents. */
  applyLocalSettings(windowId: number, local: Partial<WindowLocalSettings>): void;
  newId?: () => string;
}

interface PendingRequest extends SettingsDocumentIdentity {
  documentId: string;
  /** The id the document chose; the one on the wire to tools is the map key. */
  requestId: string;
  operation: SettingsOperation;
  /** Window-local settings a private `settings/update` carried; applied once tools answers. */
  local?: Partial<WindowLocalSettings>;
}

const CHANGE_NOTICES: ReadonlySet<Event['type']> = new Set([
  'settings/changed',
  'privacy/changed',
  'searchEngines/changed',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(
  requestId: string,
  operationId: string | undefined,
  code: SettingsErrorCode,
): SettingsResult {
  return {
    type: 'settings/result',
    requestId,
    ...(operationId ? { operationId } : {}),
    ok: false,
    error: { code, retryable: SETTINGS_ERROR_RETRYABLE[code] },
  };
}

export class SettingsRelay {
  readonly #deps: SettingsRelayDeps;
  readonly #documents = new Map<string, SettingsDocumentIdentity>();
  readonly #pending = new Map<string, PendingRequest>();

  constructor(deps: SettingsRelayDeps) {
    this.#deps = deps;
  }

  /** The document says hello; it may send requests once it hears the ack. */
  hello(documentId: string, identity: SettingsDocumentIdentity, helloId: unknown): void {
    if (typeof helloId !== 'string') return;
    this.#documents.set(documentId, identity);
    if (identity.isPrivate) this.#deps.privateSettings.open(identity.windowId);
    this.#post(documentId, { kind: 'ack', helloId });
  }

  /** Forwards one request to tools. Never throws; an unusable request is answered or dropped. */
  request(documentId: string, identity: SettingsDocumentIdentity, raw: unknown): void {
    const requestId = settingsRequestIdOf(raw);
    if (requestId === null || !isRecord(raw)) return; // Nothing to address an answer to.
    // The hello may have been lost (a background reload): the identity is the hub's, so the
    // request registers the document as well.
    this.#documents.set(documentId, identity);
    const { operationId, operation, payload } = raw;
    if (
      !isSettingsOperation(operation) ||
      (operationId !== undefined && typeof operationId !== 'string')
    ) {
      this.#reply(documentId, failure(requestId, undefined, 'invalid_payload'));
      return;
    }
    // The id on the wire is this background's, so two documents can never collide on a
    // result; the document's own id is put back before the answer is delivered.
    const wireId = (this.#deps.newId ?? (() => crypto.randomUUID()))();
    const sent = this.#deps.toTools({
      kind: 'settings-client/request',
      shellBackgroundInstanceId: this.#deps.instanceId,
      caller: { documentId, windowId: identity.windowId, isPrivate: identity.isPrivate },
      requestId: wireId,
      ...(operationId === undefined ? {} : { operationId }),
      operation,
      ...(payload === undefined ? {} : { payload }),
    });
    if (!sent) {
      this.#reply(documentId, failure(requestId, operationId, 'internal_error'));
      return;
    }
    this.#pending.set(wireId, {
      documentId,
      requestId,
      operation,
      ...identity,
      local:
        identity.isPrivate && operation === 'settings/update' ? localChangesOf(payload) : undefined,
    });
  }

  /** Delivers tools' answer to the document that asked. True when `message` was a result. */
  result(message: unknown): boolean {
    if (!isSettingsResult(message)) return false;
    const pending = this.#pending.get(message.requestId);
    if (!pending) return true; // Its document is gone.
    this.#pending.delete(message.requestId);
    const answer: SettingsResult = { ...message, requestId: pending.requestId };
    this.#reply(pending.documentId, answer.ok ? this.#project(pending, answer) : answer);
    return true;
  }

  /** Profile-wide change notices reach every Settings document, a private window's with
   * its own values over the saved ones. */
  notice(event: Event): void {
    if (!CHANGE_NOTICES.has(event.type)) return;
    for (const [documentId, identity] of this.#documents) {
      let shown = event;
      if (identity.isPrivate && event.type === 'settings/changed') {
        const settings = this.#deps.privateSettings.view(identity.windowId, event.settings);
        shown = { ...event, settings: settings ?? event.settings };
      }
      this.#post(documentId, { kind: 'event', event: shown });
    }
  }

  /** Posts to the Settings documents of one window. */
  postToWindow(windowId: number, message: BusDown): void {
    for (const [documentId, identity] of this.#documents) {
      if (identity.windowId === windowId) this.#post(documentId, message);
    }
  }

  /** Drops a closed document and the requests it was still waiting on. */
  forget(documentId: string): SettingsDocumentIdentity | undefined {
    const identity = this.#documents.get(documentId);
    if (!identity) return undefined;
    this.#documents.delete(documentId);
    for (const [wireId, pending] of this.#pending) {
      if (pending.documentId === documentId) this.#pending.delete(wireId);
    }
    return identity;
  }

  /** The tools port went away: no answer to a request already sent can arrive. */
  dropPending(): void {
    this.#pending.clear();
  }

  /** What a private window sees of a successful answer: its own colour mode over the profile's. */
  #project(pending: PendingRequest, answer: Extract<SettingsResult, { ok: true }>): SettingsResult {
    if (!pending.isPrivate || !isRecord(answer.result) || !isRecord(answer.result.settings)) {
      return answer;
    }
    const { settings } = answer.result;
    if (pending.operation === 'settings/update') {
      if (pending.local) this.#deps.applyLocalSettings(pending.windowId, pending.local);
      const own = this.#deps.privateSettings.own(pending.windowId);
      return own
        ? { ...answer, result: { ...answer.result, settings: { ...settings, ...own } } }
        : answer;
    }
    if (pending.operation === 'snapshot/get') {
      // The editable snapshot has no sidebar keys; the colour mode is the one value that differs.
      const own = this.#deps.privateSettings.own(pending.windowId);
      return own
        ? {
            ...answer,
            result: { ...answer.result, settings: { ...settings, uiColorMode: own.uiColorMode } },
          }
        : answer;
    }
    return answer;
  }

  #reply(documentId: string, result: SettingsResult): void {
    this.#post(documentId, { kind: 'settings-result', result });
  }

  #post(documentId: string, message: BusDown): void {
    this.#deps
      .toDocument(documentId, message)
      .then((delivered) => {
        if (!delivered) this.forget(documentId);
      })
      .catch((error: unknown) => {
        console.warn('[bento-shell] settings relay delivery failed:', error);
      });
  }
}

/** The window-local part of a `settings/update` payload, or undefined when it has none. */
function localChangesOf(payload: unknown): Partial<WindowLocalSettings> | undefined {
  if (!isRecord(payload) || !isRecord(payload.changes)) return undefined;
  const { local } = splitWindowLocalSettings(payload.changes as Partial<BentoSettings>);
  return Object.keys(local).length > 0 ? local : undefined;
}
