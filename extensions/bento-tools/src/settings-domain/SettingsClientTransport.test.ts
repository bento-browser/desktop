import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isSettingsClientRequest,
  isSettingsResult,
  type SettingsClientRequest,
  type SettingsResult,
} from '@shared/settings-client-protocol';
import { createSettingsClientTransport } from './SettingsClientTransport';
import type { SettingsDomainService } from './SettingsDomainService';
import { SettingsError } from './SettingsError';

const operationId = crypto.randomUUID();

function request(overrides: Record<string, unknown> = {}): SettingsClientRequest {
  return {
    kind: 'settings-client/request',
    shellBackgroundInstanceId: 'background-1',
    caller: { documentId: 'doc-1', windowId: 4, isPrivate: false },
    requestId: 'request-1',
    operation: 'snapshot/get',
    payload: { domains: ['settings'] },
    ...overrides,
  } as SettingsClientRequest;
}

describe('settings client request guard', () => {
  it('accepts the contract shapes', () => {
    expect(isSettingsClientRequest(request())).toBe(true);
    expect(isSettingsClientRequest(request({ payload: undefined }))).toBe(true);
    const withoutPayload = request();
    delete withoutPayload.payload;
    expect(isSettingsClientRequest(withoutPayload)).toBe(true);
    expect(
      isSettingsClientRequest(
        request({ operation: 'settings/reset', operationId, payload: { confirm: true } }),
      ),
    ).toBe(true);
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown key', { injected: true }],
    ['an unknown operation', { operation: 'session/hello' }],
    ['a retired operation', { operation: 'operation/reconcile' }],
    ['a missing request id', { requestId: undefined }],
    ['an oversized request id', { requestId: 'x'.repeat(200) }],
    [
      'a caller with an extra key',
      { caller: { documentId: 'd', windowId: 1, isPrivate: false, role: 'primary' } },
    ],
    ['a caller without privacy', { caller: { documentId: 'd', windowId: 1 } }],
    ['a fractional window id', { caller: { documentId: 'd', windowId: 1.5, isPrivate: false } }],
    ['a negative window id', { caller: { documentId: 'd', windowId: -1, isPrivate: false } }],
    ['a durable operation without an operation id', { operation: 'backup/delete' }],
    [
      'a durable operation with a malformed operation id',
      { operation: 'backup/delete', operationId: 'nope' },
    ],
    ['an operation id on a non-durable operation', { operationId }],
  ])('rejects %s', (_label, overrides) => {
    expect(isSettingsClientRequest(request(overrides))).toBe(false);
  });

  it('tells results apart from events', () => {
    const ok: SettingsResult = {
      type: 'settings/result',
      requestId: 'r',
      ok: true,
      result: {},
      revision: 3,
    };
    const failed: SettingsResult = {
      type: 'settings/result',
      requestId: 'r',
      operationId,
      ok: false,
      error: { code: 'busy', retryable: true },
    };
    expect(isSettingsResult(ok)).toBe(true);
    expect(isSettingsResult(failed)).toBe(true);
    expect(isSettingsResult({ type: 'settings/changed' })).toBe(false);
    expect(isSettingsResult({ ...failed, error: { code: 'nope', retryable: true } })).toBe(false);
    expect(isSettingsResult({ ...ok, revision: 1.5 })).toBe(false);
  });
});

describe('settings client transport', () => {
  const service = {
    revision: 12,
    overlayCaller: vi.fn(),
    execute: vi.fn(),
  };
  const windows = { confirm: vi.fn() };
  const replies: SettingsResult[] = [];
  const reply = (result: SettingsResult) => {
    replies.push(result);
  };
  let transport: ReturnType<typeof createSettingsClientTransport>;

  async function send(message: unknown): Promise<SettingsResult> {
    const before = replies.length;
    expect(transport.handle(message, reply)).toBe(true);
    await vi.waitFor(() => expect(replies.length).toBe(before + 1));
    return replies[before]!;
  }

  beforeEach(() => {
    replies.length = 0;
    service.overlayCaller.mockReset().mockImplementation((caller) => ({
      clientId: caller.documentId,
      ownerId: `window:${caller.windowId}`,
      windowId: caller.windowId,
      isPrivate: caller.isPrivate,
    }));
    service.execute.mockReset().mockResolvedValue({ revision: 12 });
    windows.confirm.mockReset().mockResolvedValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    transport = createSettingsClientTransport({
      service: service as unknown as SettingsDomainService,
      windows,
    });
  });

  it('leaves other messages alone', () => {
    expect(transport.handle({ type: 'ping' }, reply)).toBe(false);
    expect(transport.handle(null, reply)).toBe(false);
    expect(replies).toEqual([]);
  });

  it('runs a request as the chrome-derived caller and answers on the reply channel only', async () => {
    const result = await send(request({ payload: { domains: ['settings'], caller: 'forged' } }));
    expect(result).toEqual({
      type: 'settings/result',
      requestId: 'request-1',
      ok: true,
      result: { revision: 12 },
      revision: 12,
    });
    expect(windows.confirm).toHaveBeenCalledWith(4);
    expect(service.execute).toHaveBeenCalledWith(
      {
        operation: 'snapshot/get',
        payload: { domains: ['settings'], caller: 'forged' },
        operationId: undefined,
      },
      { clientId: 'doc-1', ownerId: 'window:4', windowId: 4, isPrivate: false },
    );
  });

  it('echoes the operation id of a durable operation', async () => {
    const result = await send(
      request({ operation: 'settings/reset', operationId, payload: { confirm: true } }),
    );
    expect(result).toMatchObject({ ok: true, operationId, requestId: 'request-1' });
  });

  it('answers a malformed request that still names its request id, and drops the rest', async () => {
    await expect(send(request({ operation: 'nope' }))).resolves.toEqual({
      type: 'settings/result',
      requestId: 'request-1',
      ok: false,
      error: { code: 'invalid_payload', retryable: false },
    });
    expect(service.execute).not.toHaveBeenCalled();
    expect(transport.handle({ kind: 'settings-client/request' }, reply)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(replies).toHaveLength(1);
  });

  it('refuses a caller whose window tools does not know', async () => {
    windows.confirm.mockResolvedValue(false);
    await expect(send(request())).resolves.toMatchObject({
      ok: false,
      error: { code: 'caller_unbound', retryable: true },
    });
    expect(service.execute).not.toHaveBeenCalled();
  });

  it('maps service failures to the catalogue and hides unexpected ones', async () => {
    service.execute.mockRejectedValueOnce(new SettingsError('private_window_forbidden'));
    await expect(send(request())).resolves.toMatchObject({
      ok: false,
      error: { code: 'private_window_forbidden', retryable: false },
    });
    service.execute.mockRejectedValueOnce(new SettingsError('graph_reserved'));
    await expect(send(request())).resolves.toMatchObject({
      error: { code: 'graph_reserved', retryable: true },
    });
    service.execute.mockRejectedValueOnce(new Error('secret detail /Users/x'));
    const unexpected = await send(request());
    expect(unexpected).toMatchObject({ error: { code: 'internal_error', retryable: true } });
    expect(JSON.stringify(unexpected)).not.toContain('secret');
  });
});
