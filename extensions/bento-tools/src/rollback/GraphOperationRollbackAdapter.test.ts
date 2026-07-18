import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphOperationRollbackAdapter } from './GraphOperationRollbackAdapter';

describe('GraphOperationRollbackAdapter', () => {
  let storage: Record<string, unknown>;
  beforeEach(() => {
    storage = {};
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => {
            const selected = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(selected.map((key) => [key, storage[key]]));
          }),
          set: vi.fn(async (patch: Record<string, unknown>) => Object.assign(storage, patch)),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          }),
        },
      },
    });
  });

  it('durably zeroes native artifacts before allowing legacy startup', async () => {
    storage['bento.nativeSessions.v1'] = { version: 1, sessions: [] };
    const adapter = new GraphOperationRollbackAdapter();
    await expect(adapter.run()).resolves.toMatchObject({ ready: true });
    expect(storage['bento.nativeSessions.v1']).toBeUndefined();
    expect(storage['bento.rollbackTransition.v1']).toMatchObject({ state: 'verifying' });
  });

  it('keeps a nonterminal graph operation blocked', async () => {
    storage['bento.graphOperation.v1'] = { phase: 'creating-tabs' };
    const adapter = new GraphOperationRollbackAdapter();
    await expect(adapter.run()).resolves.toMatchObject({
      ready: false,
      record: { state: 'blocked-corrupt' },
    });
  });
});
