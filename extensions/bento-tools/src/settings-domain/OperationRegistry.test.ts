import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  failComponents,
  finishComponents,
  OperationConflictError,
  OperationRegistry,
  type DurableOperationKind,
} from './OperationRegistry';

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
  describe('startup settlement', () => {
    async function reserve(
      registry: OperationRegistry,
      kind: DurableOperationKind,
      state?: 'running',
      components = ['settings', 'privacy'],
    ) {
      const operationId = crypto.randomUUID();
      await registry.reserve({
        operationId,
        kind,
        ownerClientInstanceId: 'owner',
        targetWindowId: 1,
        isPrivate: false,
        payloadHash: 'd'.repeat(64),
        components,
      });
      if (state) await registry.update(operationId, { state, phase: 'running' });
      return operationId;
    }

    it('fails every orphaned reserved or running record, whatever its kind', async () => {
      const registry = new OperationRegistry();
      await registry.init();
      const reset = await reserve(registry, 'settings/reset', 'running');
      const remove = await reserve(registry, 'backup/delete', 'running', ['backupRecord']);
      // Reserved, but the process died before the journal existed.
      const importOp = await reserve(registry, 'backup/importValidated');
      const done = await reserve(registry, 'backup/restore');
      await registry.update(done, { state: 'succeeded', phase: 'terminal' });

      await expect(registry.settleInterrupted()).resolves.toBe(3);

      for (const id of [reset, remove, importOp]) {
        expect(registry.getOwned(id, 'owner')).toMatchObject({
          state: 'failed',
          phase: 'terminal',
          errorCode: 'backend_restarted',
          recovered: true,
          terminalAt: expect.any(Number),
        });
      }
      expect(registry.getOwned(reset, 'owner')?.components.map((c) => c.state)).toEqual([
        'failed',
        'failed',
      ]);
      expect(registry.getOwned(done, 'owner')?.state).toBe('succeeded');
      // Idempotent, and durable across a restart.
      await expect(registry.settleInterrupted()).resolves.toBe(0);
      const restarted = new OperationRegistry();
      await restarted.init();
      expect(restarted.getOwned(remove, 'owner')?.state).toBe('failed');
    });

    it('leaves the record the graph journal still covers to graph recovery', async () => {
      const registry = new OperationRegistry();
      await registry.init();
      const covered = await reserve(registry, 'backup/restore', 'running');
      const orphan = await reserve(registry, 'backup/delete', 'running');
      await expect(registry.settleInterrupted(covered)).resolves.toBe(1);
      expect(registry.getOwned(covered, 'owner')?.state).toBe('running');
      expect(registry.getOwned(orphan, 'owner')?.state).toBe('failed');
    });

    it('notices only what recovery settled', async () => {
      const registry = new OperationRegistry();
      await registry.init();
      const finished = await reserve(registry, 'backup/delete');
      await registry.update(finished, { state: 'succeeded', phase: 'terminal' });
      const orphan = await reserve(registry, 'settings/reset', 'running');
      await registry.settleInterrupted();
      expect(registry.recoveredNotices('owner', false).map((r) => r.operationId)).toEqual([orphan]);
      expect(registry.recoveredNotices('owner', true)).toEqual([]);
    });
  });

  it('lists an owner running and recently finished records only', async () => {
    let now = 1_000_000;
    const registry = new OperationRegistry({ now: () => now });
    await registry.init();
    const reserveFor = async (owner: string) => {
      const operationId = crypto.randomUUID();
      await registry.reserve({
        operationId,
        kind: 'backup/delete',
        ownerClientInstanceId: owner,
        targetWindowId: 1,
        isPrivate: false,
        payloadHash: 'e'.repeat(64),
      });
      return operationId;
    };
    const running = await reserveFor('a');
    const old = await reserveFor('a');
    await registry.update(old, { state: 'succeeded', phase: 'terminal' });
    now += 11 * 60 * 1000;
    const recent = await reserveFor('a');
    await registry.update(recent, { state: 'succeeded', phase: 'terminal' });
    await reserveFor('b');
    expect(
      registry
        .listOwned('a', 10 * 60 * 1000)
        .map((r) => r.operationId)
        .sort(),
    ).toEqual([recent, running].sort());
  });

  it('derives final component states', () => {
    const pending = ['a', 'b', 'c'].map((component) => ({
      component,
      state: 'pending' as const,
      retryable: false,
    }));
    const failure = { component: 'b', state: 'failed' as const, retryable: true, errorCode: 'x' };
    expect(
      finishComponents(pending, [failure], new Set(['c'])).map((c) => [c.component, c.state]),
    ).toEqual([
      ['a', 'succeeded'],
      ['b', 'failed'],
      ['c', 'skipped'],
    ]);
    // Finished components keep their state; `only` limits which pending ones fail.
    expect(failComponents(pending, 'boom', true, ['a']).map((c) => c.state)).toEqual([
      'failed',
      'pending',
      'pending',
    ]);
    expect(
      failComponents(finishComponents(pending, [], new Set(['c'])), 'boom', true).map(
        (c) => c.state,
      ),
    ).toEqual(['succeeded', 'succeeded', 'skipped']);
    expect(failComponents(pending, 'boom', true).every((c) => c.state === 'failed')).toBe(true);
  });
});
