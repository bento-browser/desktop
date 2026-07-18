import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OperationConflictError, OperationRegistry } from './OperationRegistry';

describe('OperationRegistry', () => {
  let stored: Record<string, unknown>;

  beforeEach(() => {
    stored = {};
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => stored),
          set: vi.fn(async (patch: Record<string, unknown>) => Object.assign(stored, patch)),
        },
      },
    });
  });

  it('deduplicates matching operations and rejects changed payloads', async () => {
    const registry = new OperationRegistry();
    await registry.init();
    const input = {
      operationId: crypto.randomUUID(),
      kind: 'backup/delete' as const,
      ownerClientInstanceId: crypto.randomUUID(),
      targetWindowId: 4,
      isPrivate: false,
      payloadHash: 'a'.repeat(64),
    };
    await expect(registry.reserve(input)).resolves.toMatchObject({ existing: false });
    await expect(registry.reserve(input)).resolves.toMatchObject({ existing: true });
    await expect(
      registry.reserve({ ...input, payloadHash: 'b'.repeat(64) }),
    ).rejects.toBeInstanceOf(OperationConflictError);
  });

  it('survives restart and retains terminal status', async () => {
    const operationId = crypto.randomUUID();
    const ownerClientInstanceId = crypto.randomUUID();
    const first = new OperationRegistry();
    await first.init();
    await first.reserve({
      operationId,
      kind: 'backup/restore',
      ownerClientInstanceId,
      targetWindowId: 7,
      isPrivate: false,
      payloadHash: 'c'.repeat(64),
    });
    await first.update(operationId, {
      state: 'succeeded',
      phase: 'terminal',
      result: { done: true },
    });

    const restarted = new OperationRegistry();
    await restarted.init();
    expect(restarted.getOwned(operationId, ownerClientInstanceId)).toMatchObject({
      state: 'succeeded',
      result: { done: true },
    });
  });
});
