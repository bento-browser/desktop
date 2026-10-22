import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRelayTransport, RELAY_DOWN_EVENT, RELAY_UP_EVENT } from './relayTransport';

function setup(queueMs?: number) {
  const target = new EventTarget();
  const up: Array<Record<string, unknown>> = [];
  target.addEventListener(RELAY_UP_EVENT, (event) => {
    up.push(JSON.parse((event as CustomEvent).detail as string) as Record<string, unknown>);
  });
  const transport = createRelayTransport({ target, queueMs, newId: () => 'hello-1' });
  const down = (message: unknown) =>
    target.dispatchEvent(new CustomEvent(RELAY_DOWN_EVENT, { detail: JSON.stringify(message) }));
  return { target, up, transport, down };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('relay transport', () => {
  it('says hello again with a growing delay until the relay acknowledges', async () => {
    const { up, transport, down } = setup();
    transport.connect();
    expect(up).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(500);
    expect(up.filter((m) => m.kind === 'hello')).toHaveLength(3);
    down({ kind: 'ack', helloId: 'hello-1' });
    expect(transport.isReady).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(up.filter((m) => m.kind === 'hello')).toHaveLength(3);
  });

  it('ignores an acknowledgement for another hello', () => {
    const { transport, down } = setup();
    transport.connect();
    down({ kind: 'ack', helloId: 'someone-else' });
    expect(transport.isReady).toBe(false);
  });

  it('holds requests until ready, then sends them as settings actions', () => {
    const { up, transport, down } = setup();
    transport.connect();
    transport.send({
      requestId: 'r1',
      operation: 'snapshot/get',
      payload: { domains: ['settings'] },
    });
    expect(up.some((m) => m.kind === 'action')).toBe(false);
    down({ kind: 'ack', helloId: 'hello-1' });
    expect(up.filter((m) => m.kind === 'action')).toEqual([
      {
        kind: 'action',
        action: {
          type: 'settings/request',
          requestId: 'r1',
          operation: 'snapshot/get',
          payload: { domains: ['settings'] },
        },
      },
    ]);
    transport.send({ requestId: 'r2', operation: 'backup/getContext', payload: {} });
    expect(up.filter((m) => m.kind === 'action')).toHaveLength(2);
  });

  it('drops a request that waited longer than the queue time', async () => {
    const { up, transport, down } = setup(1000);
    transport.connect();
    transport.send({ requestId: 'old', operation: 'snapshot/get', payload: {} });
    await vi.advanceTimersByTimeAsync(1500);
    transport.send({ requestId: 'new', operation: 'snapshot/get', payload: {} });
    down({ kind: 'ack', helloId: 'hello-1' });
    const ids = up
      .filter((m) => m.kind === 'action')
      .map((m) => (m.action as { requestId: string }).requestId);
    expect(ids).toEqual(['new']);
  });

  it('hands relayed events to the client and skips everything else', () => {
    const { transport, down, target } = setup();
    const seen: unknown[] = [];
    transport.onMessage((message) => seen.push(message));
    transport.connect();
    down({ kind: 'event', event: { type: 'settings/changed', settings: {} } });
    down({ kind: 'ack', helloId: 'hello-1' });
    down({ kind: 'unknown' });
    target.dispatchEvent(new CustomEvent(RELAY_DOWN_EVENT, { detail: 'not json' }));
    target.dispatchEvent(new CustomEvent(RELAY_DOWN_EVENT, { detail: 42 }));
    expect(seen).toEqual([{ type: 'settings/changed', settings: {} }]);
  });

  it('stops listening and clears the queue when disconnected', () => {
    const { up, transport, down } = setup();
    const disconnect = transport.connect();
    transport.send({ requestId: 'r1', operation: 'snapshot/get', payload: {} });
    disconnect();
    down({ kind: 'ack', helloId: 'hello-1' });
    expect(up.some((m) => m.kind === 'action')).toBe(false);
    expect(transport.isReady).toBe(false);
  });
});
