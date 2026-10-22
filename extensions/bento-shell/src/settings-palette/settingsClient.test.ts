import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsResult } from '@shared/settings-client-protocol';
import {
  SettingsClientError,
  createSettingsClient,
  readDurableOutcome,
  type SettingsRequestBody,
  type SettingsTransport,
} from './settingsClient';

const OPERATION_ID = '3f2b8c1e-8a4d-4b6e-9c1f-0a1b2c3d4e5f';

function fakeTransport() {
  const sent: SettingsRequestBody[] = [];
  const handlers = new Set<(message: unknown) => void>();
  let failSend = false;
  const transport: SettingsTransport = {
    send(request) {
      if (failSend) throw new Error('relay down');
      sent.push(request);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return {
    transport,
    sent,
    last: () => sent[sent.length - 1]!,
    deliver: (message: unknown) => handlers.forEach((handler) => handler(message)),
    ok(request: SettingsRequestBody, result: unknown) {
      const message: SettingsResult = {
        type: 'settings/result',
        requestId: request.requestId,
        ...(request.operationId ? { operationId: request.operationId } : {}),
        ok: true,
        result,
        revision: 1,
      };
      handlers.forEach((handler) => handler(message));
    },
    fail(request: SettingsRequestBody, code: 'busy' | 'operation_unknown' | 'invalid_payload') {
      const message: SettingsResult = {
        type: 'settings/result',
        requestId: request.requestId,
        ok: false,
        error: { code, retryable: code === 'busy' },
      };
      handlers.forEach((handler) => handler(message));
    },
    failSends: () => {
      failSend = true;
    },
    handlerCount: () => handlers.size,
  };
}

const done = (state: 'succeeded' | 'partial' = 'succeeded') => ({
  kind: 'settings/reset',
  operationId: OPERATION_ID,
  state,
  components: [],
  reconcileComponents: [],
});

const status = (state: string, result?: unknown) => ({
  operationId: OPERATION_ID,
  kind: 'settings/reset',
  state,
  phase: state === 'running' ? 'running' : 'terminal',
  components: [],
  reconcileComponents: [],
  cancelRequested: false,
  result,
  createdAt: 1,
  updatedAt: 2,
});

let counter = 0;
const options = { newId: () => `request-${++counter}`, pollAfterMs: 1000, pollIntervalMs: 500 };

beforeEach(() => {
  vi.useFakeTimers();
  counter = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('request correlation', () => {
  it('resolves each request with its own result, in any order', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    const first = client.request('snapshot/get', { domains: ['settings'] });
    const second = client.request('backup/getContext', {});
    const [a, b] = fake.sent;
    fake.ok(b!, { marker: 'second' });
    fake.ok(a!, { marker: 'first' });
    await expect(first).resolves.toEqual({ marker: 'first' });
    await expect(second).resolves.toEqual({ marker: 'second' });
  });

  it('sends the operation and payload, and no operation id for plain operations', () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    void client.request('settings/update', { changes: { panelShadowsEnabled: true } });
    expect(fake.last()).toEqual({
      requestId: 'request-1',
      operation: 'settings/update',
      payload: { changes: { panelShadowsEnabled: true } },
    });
  });

  it('rejects with the tools error code and its retryable flag', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    const request = client.request('snapshot/get', { domains: ['settings'] });
    fake.fail(fake.last(), 'busy');
    await expect(request).rejects.toMatchObject({ code: 'busy', retryable: true });
    await expect(request).rejects.toBeInstanceOf(SettingsClientError);
  });

  it('ignores results for unknown requests and malformed messages', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    const request = client.request('snapshot/get', { domains: ['settings'] });
    fake.deliver({
      type: 'settings/result',
      requestId: 'someone-else',
      ok: true,
      result: 1,
      revision: 1,
    });
    fake.deliver({ nonsense: true });
    fake.deliver('text');
    fake.ok(fake.last(), 'mine');
    await expect(request).resolves.toBe('mine');
  });

  it('rejects when the transport cannot send', async () => {
    const fake = fakeTransport();
    fake.failSends();
    const client = createSettingsClient(fake.transport, options);
    await expect(client.request('snapshot/get', { domains: ['settings'] })).rejects.toMatchObject({
      code: 'transport_unavailable',
    });
  });

  it('rejects open requests and stops listening on dispose', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    const request = client.request('snapshot/get', { domains: ['settings'] });
    client.dispose();
    await expect(request).rejects.toMatchObject({ code: 'disposed' });
    expect(fake.handlerCount()).toBe(0);
    await expect(client.request('snapshot/get', { domains: ['settings'] })).rejects.toMatchObject({
      code: 'disposed',
    });
  });
});

describe('deadline', () => {
  it('resolves a reply that lands just inside the 15 second deadline', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, { newId: options.newId });
    const request = client.request('snapshot/get', { domains: ['settings'] });
    await vi.advanceTimersByTimeAsync(14_999);
    fake.ok(fake.last(), 'in time');
    await expect(request).resolves.toBe('in time');
  });

  it('rejects at the deadline and ignores the late reply', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, { newId: options.newId });
    const request = client.request('snapshot/get', { domains: ['settings'] });
    const settled = expect(request).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
    fake.ok(fake.last(), 'late');
  });
});

describe('durable operations', () => {
  it('returns the direct result and sends the operation id', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    const run = client.run('settings/reset', { confirm: true }, OPERATION_ID);
    expect(fake.last()).toMatchObject({ operation: 'settings/reset', operationId: OPERATION_ID });
    fake.ok(fake.last(), done());
    await expect(run).resolves.toMatchObject({ state: 'succeeded', operationId: OPERATION_ID });
  });

  it('mints a uuid operation id when none is given', () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, {});
    void client.run('backup/delete', { backupId: 'b1', confirm: true });
    expect(fake.last().operationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not apply the 15 second deadline to the original request', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, { ...options, pollAfterMs: 60_000 });
    const run = client.run('settings/reset', { confirm: true }, OPERATION_ID);
    await vi.advanceTimersByTimeAsync(30_000);
    fake.ok(fake.sent[0]!, done('partial'));
    await expect(run).resolves.toMatchObject({ state: 'partial' });
  });

  it('polls operation/status when the reply is slow and returns the retained result', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    const run = client.run('settings/reset', { confirm: true }, OPERATION_ID);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.last()).toMatchObject({
      operation: 'operation/status',
      payload: { operationId: OPERATION_ID },
    });
    fake.ok(fake.last(), status('running'));
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.last().operation).toBe('operation/status');
    expect(fake.sent.filter((r) => r.operation === 'operation/status')).toHaveLength(2);
    fake.ok(fake.last(), status('succeeded', done()));
    await expect(run).resolves.toMatchObject({ state: 'succeeded', operationId: OPERATION_ID });
  });

  it('keeps polling through a status request that times out', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, { ...options, deadlineMs: 2000 });
    const run = client.run('backup/restore', { backupId: 'b1' }, OPERATION_ID);
    await vi.advanceTimersByTimeAsync(1000); // first status request, never answered
    await vi.advanceTimersByTimeAsync(2000); // its deadline passes
    await vi.advanceTimersByTimeAsync(500); // next poll
    const polls = fake.sent.filter((r) => r.operation === 'operation/status');
    expect(polls.length).toBeGreaterThanOrEqual(2);
    fake.ok(polls[polls.length - 1]!, status('failed'));
    await expect(run).resolves.toMatchObject({ state: 'failed' });
  });

  it('treats a replayed status record that is still running as not done', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    const run = client.run('settings/reset', { confirm: true }, OPERATION_ID);
    fake.ok(fake.sent[0]!, status('running'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.sent).toHaveLength(2);
    expect(fake.last().operation).toBe('operation/status');
    fake.ok(fake.last(), status('succeeded', done()));
    await expect(run).resolves.toMatchObject({ state: 'succeeded' });
  });

  it('resends the original request when tools has no record of it, then follows it', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    const run = client.run('backup/delete', { backupId: 'b1', confirm: true }, OPERATION_ID);
    await vi.advanceTimersByTimeAsync(1000);
    fake.fail(fake.last(), 'operation_unknown');
    await vi.advanceTimersByTimeAsync(0);
    const resent = fake.last();
    expect(resent).toMatchObject({ operation: 'backup/delete', operationId: OPERATION_ID });
    expect(resent.requestId).not.toBe(fake.sent[0]!.requestId);
    fake.ok(resent, { ...done(), kind: 'backup/delete' });
    await expect(run).resolves.toMatchObject({ state: 'succeeded' });
  });

  it('gives up resending after the limit', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, { ...options, maxResends: 1 });
    const run = client.run('backup/restore', { backupId: 'b1' }, OPERATION_ID);
    const settled = expect(run).rejects.toMatchObject({ code: 'operation_unknown' });
    for (let round = 0; round < 3; round += 1) {
      await vi.advanceTimersByTimeAsync(1000);
      const lastStatus = [...fake.sent].reverse().find((r) => r.operation === 'operation/status');
      if (lastStatus) fake.fail(lastStatus, 'operation_unknown');
    }
    await settled;
    expect(fake.sent.filter((r) => r.operation === 'backup/restore')).toHaveLength(2);
  });

  it('rejects when tools refuses the original request', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    const run = client.run('backup/delete', { backupId: 'b1', confirm: true }, OPERATION_ID);
    fake.fail(fake.last(), 'invalid_payload');
    await expect(run).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('stops following after the maximum wait', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, { ...options, durableMaxWaitMs: 3000 });
    const run = client.run('settings/reset', { confirm: true }, OPERATION_ID);
    const settled = expect(run).rejects.toMatchObject({ code: 'timeout' });
    for (let step = 0; step < 12; step += 1) {
      await vi.advanceTimersByTimeAsync(500);
      const lastStatus = [...fake.sent].reverse().find((r) => r.operation === 'operation/status');
      if (lastStatus) fake.ok(lastStatus, status('running'));
    }
    await settled;
  });
});

describe('rediscovery of pending operations', () => {
  it('follows reserved and running operations and reports how they ended', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    const ended: string[] = [];
    client.onResumed((outcome) => ended.push(`${outcome.kind}:${outcome.state}`));
    client.resume([
      { operationId: OPERATION_ID, kind: 'settings/reset', state: 'running', updatedAt: 1 },
      { operationId: 'old', kind: 'backup/delete', state: 'succeeded', updatedAt: 1 },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.sent).toHaveLength(1);
    expect(fake.last()).toMatchObject({
      operation: 'operation/status',
      payload: { operationId: OPERATION_ID },
    });
    fake.ok(fake.last(), status('succeeded', done()));
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toEqual(['settings/reset:succeeded']);
  });

  it('does not follow the same operation twice', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    const pending = [
      {
        operationId: OPERATION_ID,
        kind: 'settings/reset' as const,
        state: 'running' as const,
        updatedAt: 1,
      },
    ];
    client.resume(pending);
    client.resume(pending);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.sent).toHaveLength(1);
  });

  it('does not follow an operation this client is already running', async () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    void client.run('settings/reset', { confirm: true }, OPERATION_ID).catch(() => undefined);
    client.resume([
      { operationId: OPERATION_ID, kind: 'settings/reset', state: 'running', updatedAt: 1 },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.sent).toHaveLength(1);
  });
});

describe('change events', () => {
  it('delivers the three profile-wide notices to listeners', () => {
    const fake = fakeTransport();
    const client = createSettingsClient(fake.transport, options);
    const seen: string[] = [];
    const stop = client.onChange((event) => seen.push(event.type));
    fake.deliver({ type: 'settings/changed', settings: {} });
    fake.deliver({ type: 'privacy/changed', privacy: {} });
    fake.deliver({ type: 'searchEngines/changed', snapshot: {} });
    fake.deliver({ type: 'tabs/snapshot', tabs: [] });
    fake.deliver({ type: 'privacy/changed' });
    stop();
    fake.deliver({ type: 'settings/changed', settings: {} });
    expect(seen).toEqual(['settings/changed', 'privacy/changed', 'searchEngines/changed']);
  });
});

describe('readDurableOutcome', () => {
  it('reads a final result, a failed record and an unfinished record', () => {
    expect(readDurableOutcome('settings/reset', OPERATION_ID, done('partial'))).toMatchObject({
      state: 'partial',
    });
    expect(
      readDurableOutcome('settings/reset', OPERATION_ID, { ...status('failed'), errorCode: 'x' }),
    ).toMatchObject({ state: 'failed', errorCode: 'x' });
    expect(readDurableOutcome('settings/reset', OPERATION_ID, status('running'))).toBeNull();
    expect(readDurableOutcome('settings/reset', OPERATION_ID, status('reserved'))).toBeNull();
    expect(readDurableOutcome('settings/reset', OPERATION_ID, 'nope')).toBeNull();
  });

  it('keeps the retained result and its component outcomes from a status record', () => {
    const outcome = readDurableOutcome(
      'backup/importValidated',
      OPERATION_ID,
      status('partial', {
        ...done('partial'),
        components: [{ component: 'graph', state: 'failed', retryable: true }],
        reconcileComponents: ['graph'],
        summary: { workspaces: 2 },
      }),
    );
    expect(outcome?.reconcileComponents).toEqual(['graph']);
    expect(outcome?.components).toHaveLength(1);
    expect(outcome?.result).toMatchObject({ summary: { workspaces: 2 } });
  });
});
