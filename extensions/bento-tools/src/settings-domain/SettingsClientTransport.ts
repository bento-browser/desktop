import {
  isSettingsClientMessage,
  isSettingsClientRequest,
  settingsRequestIdOf,
  type SettingsErrorCode,
  type SettingsResult,
} from '@shared/settings-client-protocol';
import type { WindowRegistry } from '../messaging/shell-action-intake';
import type { SettingsDomainService } from './SettingsDomainService';
import { SettingsError, toSettingsError } from './SettingsError';

interface TransportDeps {
  service: SettingsDomainService;
  /** Windows tools knows to exist; a relayed caller must name one of them. */
  windows: Pick<WindowRegistry, 'confirm'>;
}

function failure(
  requestId: string,
  operationId: string | undefined,
  code: SettingsErrorCode,
  retryable: boolean,
): SettingsResult {
  return {
    type: 'settings/result',
    requestId,
    ...(operationId ? { operationId } : {}),
    ok: false,
    error: { code, retryable },
  };
}

/**
 * Overlay transport: Settings requests the shell background relays on the authenticated tools
 * port. The `caller` block is derived in chrome, never by the document, and the result goes back
 * through `reply` to that port only. Never throws; payloads are not logged.
 */
export function createSettingsClientTransport({ service, windows }: TransportDeps) {
  async function run(message: unknown, reply: (result: SettingsResult) => void): Promise<void> {
    if (!isSettingsClientRequest(message)) {
      console.warn('[bento-tools] dropped invalid settings request');
      const requestId = settingsRequestIdOf(message);
      if (requestId) reply(failure(requestId, undefined, 'invalid_payload', false));
      return;
    }
    const { requestId, operationId, operation, caller, payload } = message;
    try {
      if (!(await windows.confirm(caller.windowId))) throw new SettingsError('caller_unbound');
      const result = await service.execute(
        { operation, payload, operationId },
        service.overlayCaller(caller),
      );
      reply({
        type: 'settings/result',
        requestId,
        ...(operationId ? { operationId } : {}),
        ok: true,
        result,
        revision: service.revision,
      });
    } catch (error) {
      const { code, retryable } = toSettingsError(error);
      console.warn('[bento-tools] settings request failed:', operation, code);
      reply(failure(requestId, operationId, code, retryable));
    }
  }

  return {
    /** True when `message` is a Settings request; it is then handled here, asynchronously. */
    handle(message: unknown, reply: (result: SettingsResult) => void): boolean {
      if (!isSettingsClientMessage(message)) return false;
      void run(message, reply);
      return true;
    },
  };
}
