import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BentoExportSchema } from '@shared/protocol';
import { OperationRegistry } from '../native-preferences/OperationRegistry';
import { GraphOperationJournal, GraphOperationRecovery } from './GraphOperationJournal';

const OWNER = 'owner';

function exportFile(settings?: BentoExportSchema['settings']): BentoExportSchema {
  return {
    schemaVersion: 2,
    bentoVersion: '0.0.0',
    exportedAt: 1,
    workspaces: [],
    savedPanels: [],
    ...(settings ? { settings } : {}),
  };
}

describe('GraphOperationRecovery', () => {
  let storage: Record<string, unknown>;
  let journal: GraphOperationJournal;
  let operations: OperationRegistry;
  const privacyMutations = {
    setProtectionLevel: vi.fn(),
    setSearchEngine: vi.fn(),
  };
  const settings = { update: vi.fn(async () => undefined) };

  function recovery() {
    return new GraphOperationRecovery({
      journal,
      operations,
      workspaces: { delete: vi.fn() },
      tabs: { snapshot: () => [] },
      panels: { removeWorkspace: vi.fn() },
      pinnedPanels: { removeForWorkspace: vi.fn() },
      settings,
      savedPanels: { list: () => [], save: vi.fn() },
      privacyMutations,
    } as unknown as ConstructorParameters<typeof GraphOperationRecovery>[0]);
  }

  async function startOperation(
    operationId: string,
    options: { applySettings?: boolean; json?: string; kind?: 'backup/restore' } = {},
  ) {
    await operations.reserve({
      operationId,
      kind: options.kind ?? 'backup/importValidated',
      ownerClientInstanceId: OWNER,
      targetWindowId: 1,
      isPrivate: false,
      payloadHash: 'f'.repeat(64),
      components: ['graphStage', 'oldGraphCleanup', 'savedPanels', 'settings', 'privacy', 'search'],
    });
    await operations.update(operationId, { state: 'running', phase: 'running' });
    await journal.begin({
      operationId,
      kind: options.kind ?? 'backup/importValidated',
      mode: 'additive',
      applySettings: options.applySettings ?? false,
      applySavedPanels: false,
      ownerClientInstanceId: OWNER,
      targetWindowId: 1,
      acceptedParentSessionId: 'session',
      acceptedParentBootId: 'boot',
      sourceHash: 'hash',
      sourceJson: options.json ?? JSON.stringify(exportFile()),
      oldWorkspaceIds: [],
    });
  }

  beforeEach(() => {
    storage = {};
    privacyMutations.setProtectionLevel.mockReset();
    privacyMutations.setSearchEngine.mockReset();
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
      sessions: {
        setWindowValue: vi.fn(async () => undefined),
        removeWindowValue: vi.fn(async () => undefined),
      },
      tabs: {
        remove: vi.fn(async () => undefined),
        get: vi.fn(async () => {
          throw new Error('Invalid tab ID');
        }),
      },
    });
    journal = new GraphOperationJournal();
    operations = new OperationRegistry();
  });

  it('releases the journal when it can only record a partial outcome', async () => {
    const first = crypto.randomUUID();
    await operations.init();
    await startOperation(first);
    // Interrupted after the graph was committed but before it published: nothing can finish it.
    await journal.update(first, { phase: 'relocating', createdTabIds: [7] });
    vi.mocked(browser.tabs.remove).mockRejectedValue(new Error('busy'));
    vi.mocked(browser.tabs.get).mockResolvedValue({ id: 7 } as browser.tabs.Tab);

    await recovery().bootstrap();

    expect(operations.getOwned(first, OWNER)).toMatchObject({
      state: 'partial',
      errorCode: 'backend_restarted',
      reconcileComponents: ['graphPersistence'],
      recovered: true,
    });
    expect(journal.current()).toBeNull();
    expect(storage['bento.graphOperation.v1']).toBeUndefined();
    expect(storage['bento.graphOperation.sources.v1']).toEqual({ version: 1, entries: [] });

    // The next import is no longer refused with graph_reserved.
    const second = crypto.randomUUID();
    await startOperation(second);
    expect(journal.current()?.operationId).toBe(second);
  });

  it('clears a terminal journal an earlier build left behind', async () => {
    const stuck = crypto.randomUUID();
    await operations.init();
    await startOperation(stuck);
    await operations.update(stuck, { state: 'partial', phase: 'terminal' });
    await journal.update(stuck, { phase: 'terminal' });

    await recovery().bootstrap();

    expect(journal.current()).toBeNull();
    expect(operations.getOwned(stuck, OWNER)?.state).toBe('partial');
  });

  it('fails an operation cut off before publication and rolls its components back', async () => {
    const id = crypto.randomUUID();
    await operations.init();
    await startOperation(id);
    await journal.update(id, { phase: 'creating-tabs' });

    await recovery().bootstrap();

    const record = operations.getOwned(id, OWNER);
    expect(record).toMatchObject({ state: 'failed', errorCode: 'backend_restarted' });
    expect(record?.components.every((c) => c.state === 'failed')).toBe(true);
    expect(journal.current()).toBeNull();
  });

  describe('after publication', () => {
    const source = exportFile({ privacyProtectionLevel: 'hardened', defaultSearchEngine: 'ddg' });

    it('succeeds and settles the components it applied', async () => {
      const id = crypto.randomUUID();
      await operations.init();
      await startOperation(id, { applySettings: true, json: JSON.stringify(source) });
      await journal.update(id, { phase: 'graph-published' });
      privacyMutations.setProtectionLevel.mockResolvedValue({ state: 'succeeded' });
      privacyMutations.setSearchEngine.mockResolvedValue({ state: 'succeeded' });

      await recovery().bootstrap();

      const record = operations.getOwned(id, OWNER);
      expect(record).toMatchObject({
        state: 'succeeded',
        reconcileComponents: [],
        recovered: true,
      });
      expect(Object.fromEntries(record!.components.map((c) => [c.component, c.state]))).toEqual({
        graphStage: 'succeeded',
        oldGraphCleanup: 'skipped',
        savedPanels: 'skipped',
        settings: 'succeeded',
        privacy: 'succeeded',
        search: 'succeeded',
      });
    });

    it('reports partial with the failed components when a live effect did not stick', async () => {
      const id = crypto.randomUUID();
      await operations.init();
      await startOperation(id, { applySettings: true, json: JSON.stringify(source) });
      await journal.update(id, { phase: 'graph-published' });
      privacyMutations.setProtectionLevel.mockResolvedValue({
        state: 'partial',
        component: {
          component: 'privacy',
          state: 'failed',
          retryable: true,
          errorCode: 'live_effect_failed',
        },
      });
      privacyMutations.setSearchEngine.mockResolvedValue({ state: 'succeeded' });

      await recovery().bootstrap();

      const record = operations.getOwned(id, OWNER);
      expect(record).toMatchObject({
        state: 'partial',
        reconcileComponents: ['privacy'],
        result: { recovered: true, state: 'partial', reconcileComponents: ['privacy'] },
      });
      expect(record?.components.find((c) => c.component === 'privacy')).toMatchObject({
        state: 'failed',
        errorCode: 'live_effect_failed',
      });
      expect(record?.components.find((c) => c.component === 'search')?.state).toBe('succeeded');
      expect(journal.current()).toBeNull();
    });
  });
});
