import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BentoExportSchema, Event, PrivacySettings } from '@shared/protocol';
import { SETTINGS_LIMITS } from '@shared/settings-rules';
import type { SettingsOperation } from '@shared/settings-client-protocol';
import { executeImport, type ImportContext } from '../backup/ImportExecutor';
import { BentoMutationCoordinator } from '../mutations/BentoMutationCoordinator';
import { OperationRegistry } from './OperationRegistry';
import { readPrivacySnapshot, readSearchEnginesSnapshot } from '../privacy/ProtectionLevels';
import { GraphOperationJournal } from '../replacement/GraphOperationJournal';
import { SettingsStore } from '../settings/SettingsStore';
import {
  SettingsDomainService,
  shellPortCaller,
  type SettingsCaller,
  type SettingsDomainContext,
} from './SettingsDomainService';
import { SettingsError } from './SettingsError';

vi.mock('../backup/ImportExecutor', () => ({ executeImport: vi.fn() }));
vi.mock('../privacy/ProtectionLevels', () => ({
  readPrivacySnapshot: vi.fn(),
  readSearchEnginesSnapshot: vi.fn(),
}));

const uuid = () => crypto.randomUUID();

function privacySnapshot(): PrivacySettings {
  return {
    protectionLevel: 'standard',
    defaultSearchEngine: 'ddg',
    availableSearchEngines: [{ id: 'ddg', name: 'DuckDuckGo', isDefault: true }],
    safeBrowsingEnabled: true,
    searchSuggestionsEnabled: false,
  } as PrivacySettings;
}

const FAILED_PRIVACY = {
  component: 'privacy',
  state: 'failed',
  retryable: true,
  errorCode: 'live_effect_failed',
} as const;

function liveOutcome(component: 'privacy' | 'search', ok = true) {
  return {
    state: ok ? 'succeeded' : 'partial',
    value:
      component === 'privacy'
        ? privacySnapshot()
        : { defaultSearchEngine: 'ddg', availableSearchEngines: [] },
    component: ok
      ? { component, state: 'succeeded', retryable: false }
      : { ...FAILED_PRIVACY, component },
  };
}

function exportFile(overrides: Partial<BentoExportSchema> = {}): BentoExportSchema {
  return {
    schemaVersion: 2,
    bentoVersion: '0.0.0',
    exportedAt: 1,
    workspaces: [{ id: 'ws-1', name: 'One', createdAt: 1, tabs: [], panels: [], pinnedPanels: [] }],
    savedPanels: [],
    ...overrides,
  };
}

interface Harness {
  service: SettingsDomainService;
  ctx: SettingsDomainContext;
  storage: Record<string, unknown>;
  broadcast: ReturnType<typeof vi.fn<(event: Event) => void>>;
  backup: {
    collectSnapshot: ReturnType<typeof vi.fn>;
    listBackups: ReturnType<typeof vi.fn>;
    getBackupData: ReturnType<typeof vi.fn>;
    deleteBackup: ReturnType<typeof vi.fn>;
  };
  privacyMutations: {
    setProtectionLevel: ReturnType<typeof vi.fn>;
    setAdvanced: ReturnType<typeof vi.fn>;
    setSearchEngine: ReturnType<typeof vi.fn>;
  };
  recovery: { bootstrap: ReturnType<typeof vi.fn> };
  /** Browser-session pieces a test may prepare before the service starts. */
  operations: OperationRegistry;
  journal: GraphOperationJournal;
  settings: SettingsStore;
}

async function createHarness(
  prepare?: (parts: {
    operations: OperationRegistry;
    journal: GraphOperationJournal;
  }) => Promise<void>,
): Promise<Harness> {
  const storage: Record<string, unknown> = {};
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
    windows: { getAll: vi.fn(async () => [{ id: 1, type: 'normal', incognito: false }]) },
  });
  vi.mocked(readPrivacySnapshot).mockImplementation(async () => privacySnapshot());
  vi.mocked(readSearchEnginesSnapshot).mockResolvedValue({
    defaultSearchEngine: 'ddg',
    availableSearchEngines: [{ id: 'ddg', name: 'DuckDuckGo', isDefault: true }],
  });
  vi.mocked(executeImport).mockReset();
  vi.mocked(executeImport).mockImplementation(async (data, _options, ctx: ImportContext) => {
    await ctx.operation?.onPhase('creating-workspaces');
    await ctx.operation?.onPhase('graph-published');
    return {
      workspacesCreated: data.workspaces.length,
      tabsOpened: 0,
      panelsRestored: 0,
      settingsApplied: false,
    };
  });

  const settings = new SettingsStore();
  await settings.init();
  const operations = new OperationRegistry();
  const journal = new GraphOperationJournal();
  await Promise.all([operations.init(), journal.init()]);
  await prepare?.({ operations, journal });

  const backup = {
    collectSnapshot: vi.fn(async () => exportFile()),
    listBackups: vi.fn(async () => []),
    getBackupData: vi.fn(async () => exportFile()),
    deleteBackup: vi.fn(async () => undefined),
  };
  const privacyMutations = {
    setProtectionLevel: vi.fn(async () => liveOutcome('privacy')),
    setAdvanced: vi.fn(async () => liveOutcome('privacy')),
    setSearchEngine: vi.fn(async () => liveOutcome('search')),
  };
  // Real recovery rolls back an interrupted import and releases its journal record.
  const recovery = {
    bootstrap: vi.fn(async () => {
      const current = journal.current();
      if (current) await journal.clear(current.operationId);
    }),
  };
  const broadcast = vi.fn<(event: Event) => void>();
  const ctx = {
    ready: Promise.resolve(),
    settings,
    backup,
    workspaces: { snapshot: () => ({ workspaces: [{ id: 'ws-1' }] }) },
    tabs: {},
    panels: {},
    pinnedPanels: {},
    savedPanels: { list: () => [] },
    coordinator: new BentoMutationCoordinator(),
    operations,
    journal,
    recovery,
    privacyMutations,
    broadcast,
  } as unknown as SettingsDomainContext;
  const service = new SettingsDomainService(ctx);
  await service.ready();
  return {
    service,
    ctx,
    storage,
    broadcast,
    backup,
    privacyMutations,
    recovery,
    operations,
    journal,
    settings,
  };
}

async function overlay(
  h: Harness,
  options: { documentId?: string; windowId?: number; isPrivate?: boolean; sessionId?: string } = {},
): Promise<SettingsCaller> {
  return h.service.overlayCaller({
    documentId: options.documentId ?? 'doc-1',
    windowId: options.windowId ?? 1,
    isPrivate: options.isPrivate ?? false,
    // The browser session chrome mints; the orphans below are owned by window 1 of this one.
    sessionId: options.sessionId ?? 'session-1',
  });
}

async function run(
  h: Harness,
  operation: SettingsOperation,
  payload: unknown,
  caller: SettingsCaller,
  operationId?: string,
) {
  return h.service.execute({ operation, payload, ...(operationId ? { operationId } : {}) }, caller);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof SettingsError ? error.code : `unexpected: ${String(error)}`;
  }
  return 'resolved';
}

function validationTokenOf(result: unknown): string {
  return (result as { validationToken: string }).validationToken;
}

async function preview(h: Harness, caller: SettingsCaller, file = exportFile()) {
  return validationTokenOf(
    await run(h, 'backup/validateImport', { json: JSON.stringify(file) }, caller),
  );
}

const ADDITIVE = { importSettings: false, importSavedPanels: false, replaceExisting: false };

describe('SettingsDomainService', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('samples settings mode and its full owner stamp in one snapshot', async () => {
    const h = await createHarness();
    const caller = await overlay(h);
    await run(h, 'settings/update', { changes: { uiColorMode: 'dark' } }, caller);
    await expect(run(h, 'snapshot/get', { domains: ['settings'] }, caller)).resolves.toMatchObject({
      settings: { uiColorMode: 'dark' }, colorStamp: h.settings.colorStamp(),
    });
  });

  describe('payload validation', () => {
    const invalid: Array<[SettingsOperation, unknown]> = [
      ['snapshot/get', {}],
      ['snapshot/get', { domains: ['nope'] }],
      ['snapshot/get', { domains: ['settings'], extra: true }],
      ['settings/update', { changes: {} }],
      ['settings/update', { changes: { tabSleepAfterMinutes: 0 } }],
      ['settings/update', { changes: { tabSleepEnabled: true }, extra: 1 }],
      ['settings/reset', { confirm: false }],
      ['privacy/setProtectionLevel', { level: 'custom' }],
      ['privacy/setAdvanced', { key: 'searchSuggestionsEnabled', value: true }],
      ['privacy/setAdvanced', { key: 'httpsOnlyMode', value: 'maybe' }],
      ['privacy/setDefaultSearchEngine', { id: '' }],
      ['privacy/setDefaultSearchEngine', { id: 'x'.repeat(SETTINGS_LIMITS.idCodeUnits + 1) }],
      ['backup/getContext', { unexpected: 1 }],
      ['backup/export', { workspaceIds: 'ws-1' }],
      ['backup/export', { workspaceIds: [1] }],
      [
        'backup/export',
        { workspaceIds: Array.from({ length: SETTINGS_LIMITS.workspaceCount + 1 }, () => 'ws') },
      ],
      ['backup/validateImport', { json: 1 }],
      ['backup/importValidated', { validationToken: 'abc', options: { importSettings: true } }],
      [
        'backup/importValidated',
        { validationToken: 'abc', options: { ...ADDITIVE, importSettings: 'yes' } },
      ],
      ['backup/restore', { backupId: '' }],
      ['backup/delete', { backupId: 'b1' }],
      ['operation/status', { operationId: 1 }],
      ['recovery/acknowledgeNotice', {}],
    ];

    it.each(invalid)('rejects %s %j', async (operation, payload) => {
      const h = await createHarness();
      const caller = await overlay(h);
      const operationId = [
        'settings/reset',
        'backup/importValidated',
        'backup/restore',
        'backup/delete',
      ].includes(operation)
        ? uuid()
        : undefined;
      await expect(codeOf(run(h, operation, payload, caller, operationId))).resolves.toBe(
        'invalid_payload',
      );
      expect(h.backup.collectSnapshot).not.toHaveBeenCalled();
      expect(h.privacyMutations.setProtectionLevel).not.toHaveBeenCalled();
    });

    it('requires an operation id for durable operations', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      await expect(codeOf(run(h, 'settings/reset', { confirm: true }, caller))).resolves.toBe(
        'invalid_payload',
      );
    });
  });

  describe('two validated entry points for settings', () => {
    it('saves tab appearance from either window type and exposes both in snapshots and notices', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      const listener = vi.fn();
      h.service.onSettingsChange(listener);
      await run(h, 'settings/update', { changes: { tabStateTintsEnabled: false } }, caller);
      await run(
        h,
        'settings/update',
        { changes: { customTabStateIconsEnabled: false } },
        { ...caller, isPrivate: true },
      );
      const appearance = { tabStateTintsEnabled: false, customTabStateIconsEnabled: false };
      expect(h.settings.snapshot()).toMatchObject(appearance);
      expect(listener).toHaveBeenLastCalledWith(expect.objectContaining(appearance), 2);
      await expect(
        run(h, 'snapshot/get', { domains: ['settings'] }, caller),
      ).resolves.toMatchObject({ settings: appearance });
    });

    it('limits the overlay operation to the editable inventory', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      for (const changes of [
        { welcomeSeen: true },
        { sidebarHidden: true },
        { sidebarCollapsed: true },
        { privacyProtectionLevel: 'hardened' },
      ]) {
        await expect(codeOf(run(h, 'settings/update', { changes }, caller))).resolves.toBe(
          'invalid_payload',
        );
      }
      expect(h.settings.snapshot().welcomeSeen).toBe(false);
      await expect(
        run(h, 'settings/update', { changes: { tabSleepAfterMinutes: 45 } }, caller),
      ).resolves.toMatchObject({ settings: { tabSleepAfterMinutes: 45 } });
    });

    it('keeps accepting the full shell set for ordinary handlers, through the same mutation', async () => {
      const h = await createHarness();
      const listener = vi.fn();
      h.service.onSettingsChange(listener);
      await h.service.updateSettings({ welcomeSeen: true, sidebarHidden: true });
      expect(h.settings.snapshot()).toMatchObject({ welcomeSeen: true, sidebarHidden: true });
      expect(h.service.revision).toBe(1);
      // Listeners get the editable subset only.
      expect(listener).toHaveBeenCalledWith(
        expect.not.objectContaining({ welcomeSeen: expect.anything() }),
        1,
      );
    });

    it('serializes ordinary updates with the other mutations', async () => {
      const h = await createHarness();
      const order: string[] = [];
      const gate = h.ctx.coordinator.runExclusive('graph-additive', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('graph');
      });
      const update = h.service.updateSettings({ sidebarCollapsed: true }).then(() => {
        order.push('settings');
      });
      await Promise.all([gate, update]);
      expect(order).toEqual(['graph', 'settings']);
    });
  });

  describe('private window policy', () => {
    const forbidden: Array<[SettingsOperation, unknown]> = [
      ['backup/getContext', {}],
      ['backup/export', {}],
      ['backup/validateImport', { json: '{}' }],
      ['backup/importValidated', { validationToken: 'abc', options: ADDITIVE }],
      ['backup/restore', { backupId: 'b1' }],
      ['backup/delete', { backupId: 'b1', confirm: true }],
      ['recovery/acknowledgeNotice', { operationId: uuid() }],
      ['settings/reset', { confirm: true }],
    ];

    it.each(forbidden)(
      'refuses %s for a private caller before touching anything',
      async (operation, payload) => {
        const h = await createHarness();
        const caller = await overlay(h, { windowId: 2, isPrivate: true });
        await expect(
          codeOf(
            run(
              h,
              operation,
              payload,
              caller,
              operation.startsWith('backup/') || operation === 'settings/reset'
                ? uuid()
                : undefined,
            ),
          ),
        ).resolves.toBe('private_window_forbidden');
        expect(h.backup.collectSnapshot).not.toHaveBeenCalled();
        expect(h.backup.getBackupData).not.toHaveBeenCalled();
        expect(h.backup.deleteBackup).not.toHaveBeenCalled();
        expect(h.operations.listOwned(caller.ownerId, Infinity)).toEqual([]);
      },
    );

    it('omits the backup domain and notices from snapshots, and allows the rest', async () => {
      const h = await createHarness();
      const caller = await overlay(h, { windowId: 2, isPrivate: true });
      const snapshot = (await run(
        h,
        'snapshot/get',
        { domains: ['settings', 'privacy', 'search', 'backup'] },
        caller,
      )) as Record<string, unknown>;
      expect(Object.keys(snapshot).sort()).toEqual([
        'colorStamp',
        'pendingOperations',
        'privacy',
        'revision',
        'search',
        'settings',
      ]);
      expect(h.backup.collectSnapshot).not.toHaveBeenCalled();
      await expect(
        run(h, 'settings/update', { changes: { panelShadowsEnabled: false } }, caller),
      ).resolves.toBeTruthy();
      await expect(
        run(h, 'privacy/setProtectionLevel', { level: 'hardened' }, caller),
      ).resolves.toMatchObject({ state: 'succeeded' });
    });

    it("saves a private caller's other settings but keeps its colour mode out of the profile", async () => {
      const h = await createHarness();
      const caller = await overlay(h, { windowId: 2, isPrivate: true });
      const before = h.settings.snapshot();
      const result = (await run(
        h,
        'settings/update',
        { changes: { uiColorMode: 'dark', panelShadowsEnabled: false } },
        caller,
      )) as { settings: typeof before };
      expect(h.settings.snapshot().panelShadowsEnabled).toBe(false);
      expect(h.settings.snapshot().uiColorMode).toBe(before.uiColorMode);
      expect(result.settings.uiColorMode).toBe(before.uiColorMode);
      // A colour mode alone changes nothing and still answers.
      await expect(
        run(h, 'settings/update', { changes: { uiColorMode: 'light' } }, caller),
      ).resolves.toMatchObject({ settings: { uiColorMode: before.uiColorMode } });
      expect(h.settings.snapshot().uiColorMode).toBe(before.uiColorMode);
    });

    it('saves the colour mode of a regular caller', async () => {
      const h = await createHarness();
      const caller = await overlay(h, { windowId: 1, isPrivate: false });
      await run(h, 'settings/update', { changes: { uiColorMode: 'dark' } }, caller);
      expect(h.settings.snapshot().uiColorMode).toBe('dark');
    });

    it('hides backup operation status from a private owner', async () => {
      const h = await createHarness();
      const caller = await overlay(h, { windowId: 2, isPrivate: true });
      const operationId = uuid();
      await h.operations.reserve({
        operationId,
        kind: 'backup/delete',
        ownerClientInstanceId: caller.ownerId,
        targetWindowId: 2,
        isPrivate: true,
        payloadHash: 'a'.repeat(64),
      });
      await expect(codeOf(run(h, 'operation/status', { operationId }, caller))).resolves.toBe(
        'private_window_forbidden',
      );
      expect(
        (
          (await run(h, 'snapshot/get', { domains: [] }, caller)) as {
            pendingOperations: unknown[];
          }
        ).pendingOperations,
      ).toEqual([]);
    });
  });

  describe('error codes', () => {
    it('maps oversize files and exports to payload_too_large', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      const oversize = 'a'.repeat(SETTINGS_LIMITS.backupFileBytes + 1);
      await expect(
        codeOf(run(h, 'backup/validateImport', { json: oversize }, caller)),
      ).resolves.toBe('payload_too_large');
      // Multi-byte text is measured in UTF-8 bytes, not code units.
      const wide = '€'.repeat(Math.ceil(SETTINGS_LIMITS.backupFileBytes / 3) + 1);
      expect(wide.length).toBeLessThan(SETTINGS_LIMITS.backupFileBytes);
      await expect(codeOf(run(h, 'backup/validateImport', { json: wide }, caller))).resolves.toBe(
        'payload_too_large',
      );
      h.backup.collectSnapshot.mockResolvedValue(
        exportFile({ bentoVersion: 'x'.repeat(SETTINGS_LIMITS.backupFileBytes) }),
      );
      await expect(codeOf(run(h, 'backup/export', {}, caller))).resolves.toBe('payload_too_large');
    });

    it('maps unreadable and invalid files to schema_invalid', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      for (const json of ['{not json', '{}', JSON.stringify({ schemaVersion: 3 })]) {
        await expect(codeOf(run(h, 'backup/validateImport', { json }, caller))).resolves.toBe(
          'schema_invalid',
        );
      }
    });

    it('maps unknown, foreign, expired and spent tokens to token_invalid', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const h = await createHarness();
      const caller = await overlay(h);
      const importWith = (token: string, who = caller) =>
        codeOf(
          run(
            h,
            'backup/importValidated',
            { validationToken: token, options: ADDITIVE },
            who,
            uuid(),
          ),
        );

      await expect(importWith('unknown')).resolves.toBe('token_invalid');

      const foreign = await preview(h, caller);
      await expect(importWith(foreign, await overlay(h, { documentId: 'doc-2' }))).resolves.toBe(
        'token_invalid',
      );
      await expect(importWith(foreign, await overlay(h, { windowId: 3 }))).resolves.toBe(
        'token_invalid',
      );

      const expired = await preview(h, caller);
      vi.setSystemTime(Date.now() + SETTINGS_LIMITS.validationTokenMs + 1);
      await expect(importWith(expired)).resolves.toBe('token_invalid');

      const spent = await preview(h, caller);
      await expect(
        run(
          h,
          'backup/importValidated',
          { validationToken: spent, options: ADDITIVE },
          caller,
          uuid(),
        ),
      ).resolves.toMatchObject({ state: 'succeeded' });
      await expect(importWith(spent)).resolves.toBe('token_invalid');
    });

    it('prunes expired tokens and keeps one preview per document', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      const first = await preview(h, caller);
      const second = await preview(h, caller);
      await expect(
        codeOf(
          run(
            h,
            'backup/importValidated',
            { validationToken: first, options: ADDITIVE },
            caller,
            uuid(),
          ),
        ),
      ).resolves.toBe('token_invalid');
      await expect(
        run(
          h,
          'backup/importValidated',
          { validationToken: second, options: ADDITIVE },
          caller,
          uuid(),
        ),
      ).resolves.toMatchObject({ state: 'succeeded' });
    });

    it('maps lower-layer failures', async () => {
      const h = await createHarness();
      const caller = await overlay(h);

      h.backup.getBackupData.mockResolvedValue(null);
      await expect(
        codeOf(run(h, 'backup/restore', { backupId: 'gone' }, caller, uuid())),
      ).resolves.toBe('not_found');

      // The coordinator reports a graph that kept changing under the export.
      h.backup.collectSnapshot.mockImplementation(async () => {
        h.ctx.coordinator.noteExternalGraphChange();
        return exportFile();
      });
      await expect(codeOf(run(h, 'backup/export', {}, caller))).resolves.toBe('snapshot_changed');
      h.backup.collectSnapshot.mockResolvedValue(exportFile());

      vi.mocked(executeImport).mockRejectedValueOnce(new Error('target_window_unavailable'));
      h.backup.getBackupData.mockResolvedValue(exportFile());
      await expect(
        codeOf(run(h, 'backup/restore', { backupId: 'b1' }, caller, uuid())),
      ).resolves.toBe('caller_unbound');

      vi.mocked(executeImport).mockRejectedValueOnce(new Error('something unexpected'));
      await expect(
        codeOf(run(h, 'backup/restore', { backupId: 'b1' }, caller, uuid())),
      ).resolves.toBe('internal_error');
      // Each failed graph import asks recovery to settle its journal.
      expect(h.recovery.bootstrap).toHaveBeenCalledTimes(2);
    });

    it('refuses an import while another graph operation holds the journal', async () => {
      const other = uuid();
      const h = await createHarness(async ({ journal }) => {
        await journal.begin({
          operationId: other,
          kind: 'backup/restore',
          mode: 'additive',
          applySettings: false,
          applySavedPanels: false,
          ownerClientInstanceId: 'someone',
          targetWindowId: 1,
          sourceHash: 'h',
          sourceJson: '{}',
          oldWorkspaceIds: [],
        });
      });
      const caller = await overlay(h);
      await expect(
        codeOf(run(h, 'backup/restore', { backupId: 'b1' }, caller, uuid())),
      ).resolves.toBe('graph_reserved');
    });

    it('keeps conflict, ownership and unknown-operation codes', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      const operationId = uuid();
      await run(h, 'backup/delete', { backupId: 'b1', confirm: true }, caller, operationId);
      await expect(
        codeOf(run(h, 'backup/delete', { backupId: 'b2', confirm: true }, caller, operationId)),
      ).resolves.toBe('conflict');
      const elsewhere = await overlay(h, { windowId: 5 });
      await expect(codeOf(run(h, 'operation/status', { operationId }, elsewhere))).resolves.toBe(
        'operation_not_owned',
      );
      await expect(
        codeOf(run(h, 'operation/status', { operationId: uuid() }, caller)),
      ).resolves.toBe('operation_unknown');
    });
  });

  describe('durable operations', () => {
    it('replays a finished import without needing its spent token (token consumed in the reservation)', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      const token = await preview(h, caller);
      const operationId = uuid();
      const payload = { validationToken: token, options: ADDITIVE };

      const first = await run(h, 'backup/importValidated', payload, caller, operationId);
      const retry = await run(h, 'backup/importValidated', payload, caller, operationId);

      expect(retry).toEqual(first);
      expect(vi.mocked(executeImport)).toHaveBeenCalledTimes(1);
      // The token really is spent for any other operation.
      await expect(codeOf(run(h, 'backup/importValidated', payload, caller, uuid()))).resolves.toBe(
        'token_invalid',
      );
    });

    it('does the ownership, hash and replay lookup before resolving any source', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      const operationId = uuid();
      await run(h, 'backup/restore', { backupId: 'b1' }, caller, operationId);
      expect(h.backup.getBackupData).toHaveBeenCalledTimes(1);

      // The backup is deleted afterwards; the retry still replays the result.
      h.backup.getBackupData.mockResolvedValue(null);
      const retry = await run(h, 'backup/restore', { backupId: 'b1' }, caller, operationId);
      expect(retry).toMatchObject({ state: 'succeeded', operationId });
      expect(h.backup.getBackupData).toHaveBeenCalledTimes(1);

      // A changed payload or another owner is refused without reading the backup.
      await expect(
        codeOf(run(h, 'backup/restore', { backupId: 'b2' }, caller, operationId)),
      ).resolves.toBe('conflict');
      await expect(
        codeOf(
          run(
            h,
            'backup/restore',
            { backupId: 'b1' },
            await overlay(h, { windowId: 4 }),
            operationId,
          ),
        ),
      ).resolves.toBe('operation_not_owned');
      expect(h.backup.getBackupData).toHaveBeenCalledTimes(1);

      // Same for a token-based import: a retry never looks at the (gone) token.
      const token = await preview(h, caller);
      const importId = uuid();
      const payload = { validationToken: token, options: ADDITIVE };
      await run(h, 'backup/importValidated', payload, caller, importId);
      await expect(
        codeOf(
          run(
            h,
            'backup/importValidated',
            { ...payload, options: { ...ADDITIVE, importSettings: true } },
            caller,
            importId,
          ),
        ),
      ).resolves.toBe('conflict');
    });

    it('keeps components current for every durable kind', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      const states = async (operationId: string) =>
        Object.fromEntries(
          (
            (await run(h, 'operation/status', { operationId }, caller)) as {
              components: Array<{ component: string; state: string }>;
            }
          ).components.map((c) => [c.component, c.state]),
        );

      const deleteId = uuid();
      await run(h, 'backup/delete', { backupId: 'b1', confirm: true }, caller, deleteId);
      expect(await states(deleteId)).toEqual({ backupRecord: 'succeeded' });

      const resetId = uuid();
      await run(h, 'settings/reset', { confirm: true }, caller, resetId);
      expect(await states(resetId)).toEqual({
        settings: 'succeeded',
        privacy: 'succeeded',
        search: 'succeeded',
      });

      const additive = uuid();
      await run(h, 'backup/restore', { backupId: 'b1' }, caller, additive);
      expect(await states(additive)).toMatchObject({
        graphStage: 'succeeded',
        panelSync: 'succeeded',
        oldGraphCleanup: 'skipped',
        savedPanels: 'skipped',
        settings: 'skipped',
        privacy: 'skipped',
        search: 'skipped',
      });

      const replace = uuid();
      const token = await preview(
        h,
        caller,
        exportFile({ settings: { privacyProtectionLevel: 'hardened' } }),
      );
      await run(
        h,
        'backup/importValidated',
        {
          validationToken: token,
          options: { importSettings: true, importSavedPanels: true, replaceExisting: true },
        },
        caller,
        replace,
      );
      expect(await states(replace)).toMatchObject({
        oldGraphCleanup: 'succeeded',
        savedPanels: 'succeeded',
        settings: 'succeeded',
        privacy: 'succeeded',
        // The file carries no search engine.
        search: 'skipped',
      });
    });

    it('marks every component failed when the operation fails', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      const operationId = uuid();
      vi.mocked(executeImport).mockRejectedValueOnce(new Error('boom'));
      await expect(
        codeOf(run(h, 'backup/restore', { backupId: 'b1' }, caller, operationId)),
      ).resolves.toBe('internal_error');
      const status = (await run(h, 'operation/status', { operationId }, caller)) as {
        state: string;
        errorCode: string;
        components: Array<{ state: string; errorCode?: string }>;
      };
      expect(status).toMatchObject({ state: 'failed', errorCode: 'internal_error' });
      expect(
        status.components.every((c) => c.state === 'failed' && c.errorCode === 'internal_error'),
      ).toBe(true);
    });

    it('reports a partial reset with the failed component', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      h.privacyMutations.setProtectionLevel.mockResolvedValue(liveOutcome('privacy', false));
      const operationId = uuid();
      const result = (await run(
        h,
        'settings/reset',
        { confirm: true },
        caller,
        operationId,
      )) as Record<string, unknown>;
      expect(result).toMatchObject({
        kind: 'settings/reset',
        state: 'partial',
        reconcileComponents: ['privacy'],
      });
      expect(
        (await run(h, 'operation/status', { operationId }, caller)) as { state: string },
      ).toMatchObject({ state: 'partial' });
    });

    it('propagates failed live effects of an import into the state and the retained result', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      vi.mocked(executeImport).mockImplementationOnce(
        async (data, _options, ctx: ImportContext) => {
          await ctx.operation?.onPhase('graph-published');
          ctx.operation?.onLiveEffectFailures?.([{ ...FAILED_PRIVACY }]);
          return { workspacesCreated: 1, tabsOpened: 0, panelsRestored: 0, settingsApplied: false };
        },
      );
      const token = await preview(
        h,
        caller,
        exportFile({
          settings: { privacyProtectionLevel: 'hardened', defaultSearchEngine: 'ddg' },
        }),
      );
      const operationId = uuid();
      const result = await run(
        h,
        'backup/importValidated',
        {
          validationToken: token,
          options: { ...ADDITIVE, importSettings: true },
        },
        caller,
        operationId,
      );
      expect(result).toMatchObject({
        state: 'partial',
        reconcileComponents: ['privacy'],
        summary: { settingsApplied: false },
      });
      const status = (await run(h, 'operation/status', { operationId }, caller)) as {
        state: string;
        result: { state: string; components: Array<{ component: string; state: string }> };
      };
      expect(status.state).toBe('partial');
      expect(status.result.state).toBe('partial');
      expect(status.result.components.find((c) => c.component === 'privacy')?.state).toBe('failed');
      expect(status.result.components.find((c) => c.component === 'search')?.state).toBe(
        'succeeded',
      );
      // A replay returns the same partial outcome.
      await expect(
        run(
          h,
          'backup/importValidated',
          { validationToken: token, options: { ...ADDITIVE, importSettings: true } },
          caller,
          operationId,
        ),
      ).resolves.toMatchObject({ state: 'partial' });
    });

    it('uses the caller window as the import target and the owner id for the journal', async () => {
      const h = await createHarness();
      const caller = await overlay(h, { windowId: 7 });
      let seen: { target: number; owner?: string } | undefined;
      vi.mocked(executeImport).mockImplementationOnce(
        async (_data, _options, ctx: ImportContext) => {
          seen = { target: ctx.targetWindowId, owner: h.journal.current()?.ownerClientInstanceId };
          return { workspacesCreated: 0, tabsOpened: 0, panelsRestored: 0, settingsApplied: false };
        },
      );
      await run(h, 'backup/restore', { backupId: 'b1' }, caller, uuid());
      expect(seen).toEqual({ target: 7, owner: caller.ownerId });
      expect(h.journal.current()).toBeNull();
    });

    it('gives an ordinary reset a registry record too', async () => {
      const h = await createHarness();
      const operationId = uuid();
      const result = await h.service.reset(operationId, shellPortCaller(3));
      expect(result).toMatchObject({ kind: 'settings/reset', state: 'succeeded' });
      expect(h.operations.getOwned(operationId, 'shell-port')).toMatchObject({
        state: 'succeeded',
        targetWindowId: 3,
      });
    });
  });

  describe('startup settlement', () => {
    async function orphan(
      operations: OperationRegistry,
      kind: 'settings/reset' | 'backup/delete' | 'backup/importValidated',
      state?: 'running',
    ) {
      const operationId = uuid();
      await operations.reserve({
        operationId,
        kind,
        ownerClientInstanceId: 'window:session-1:1',
        targetWindowId: 1,
        isPrivate: false,
        payloadHash: 'b'.repeat(64),
        components: ['settings'],
      });
      if (state) await operations.update(operationId, { state, phase: 'running' });
      return operationId;
    }

    it('fails orphaned records of every kind, including graph records with no journal', async () => {
      const ids: string[] = [];
      const h = await createHarness(async ({ operations }) => {
        ids.push(await orphan(operations, 'settings/reset', 'running'));
        ids.push(await orphan(operations, 'backup/delete', 'running'));
        ids.push(await orphan(operations, 'backup/importValidated'));
      });
      for (const id of ids) {
        expect(h.operations.getOwned(id, 'window:session-1:1')).toMatchObject({
          state: 'failed',
          errorCode: 'backend_restarted',
        });
      }
    });

    it('leaves the record a recoverable journal still covers to graph recovery', async () => {
      let covered = '';
      let stray = '';
      const h = await createHarness(async ({ operations, journal }) => {
        covered = await orphan(operations, 'backup/importValidated', 'running');
        stray = await orphan(operations, 'settings/reset', 'running');
        await journal.begin({
          operationId: covered,
          kind: 'backup/importValidated',
          mode: 'additive',
          applySettings: false,
          applySavedPanels: false,
          ownerClientInstanceId: 'window:session-1:1',
          targetWindowId: 1,
          sourceHash: 'h',
          sourceJson: '{}',
          oldWorkspaceIds: [],
        });
      });
      expect(h.operations.getOwned(covered, 'window:session-1:1')?.state).toBe('running');
      expect(h.operations.getOwned(stray, 'window:session-1:1')?.state).toBe('failed');
    });

    it('does not let startup settlement fail an ordinary mutation that arrived early', async () => {
      const h = await createHarness();
      let release!: () => void;
      const early = new SettingsDomainService({
        ...h.ctx,
        ready: new Promise<void>((resolve) => {
          release = resolve;
        }),
      });
      const operationId = uuid();
      const reset = early.reset(operationId, shellPortCaller(1));
      const update = early.updateSettings({ sidebarHidden: true });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(h.operations.peek(operationId)).toBeNull();
      expect(h.settings.snapshot().sidebarHidden).toBe(false);
      release();
      await Promise.all([reset, update]);
      expect(h.operations.peek(operationId)).toMatchObject({ state: 'succeeded' });
    });

    it('holds requests until startup recovery has run', async () => {
      const h = await createHarness();
      let release!: () => void;
      const gated = new SettingsDomainService({
        ...h.ctx,
        ready: new Promise<void>((resolve) => {
          release = resolve;
        }),
      });
      const caller = await overlay(h);
      let answered = false;
      const pending = gated
        .execute({ operation: 'snapshot/get', payload: { domains: [] } }, caller)
        .then(() => {
          answered = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(answered).toBe(false);
      release();
      await pending;
      expect(answered).toBe(true);
    });
  });

  describe('operation ownership and rediscovery', () => {
    it('scopes the owner to the browser session and the window', async () => {
      const h = await createHarness();
      const one = await overlay(h);
      expect((await overlay(h, { documentId: 'doc-9' })).ownerId).toBe(one.ownerId);
      expect((await overlay(h, { windowId: 2 })).ownerId).not.toBe(one.ownerId);
      expect((await overlay(h, { sessionId: 'session-2' })).ownerId).not.toBe(one.ownerId);
    });

    it('keeps the owner across a reload of tools, which only the browser session may change', async () => {
      // The operation was started by an earlier run of tools in the same browser session.
      const operationId = uuid();
      const h = await createHarness(async ({ operations }) => {
        await operations.reserve({
          operationId,
          kind: 'backup/importValidated',
          ownerClientInstanceId: 'window:browser-run-a:3',
          targetWindowId: 3,
          isPrivate: false,
          payloadHash: 'd'.repeat(64),
        });
        await operations.update(operationId, { state: 'running', phase: 'running' });
      });
      const sameWindow = await overlay(h, { sessionId: 'browser-run-a', windowId: 3 });
      expect(sameWindow.ownerId).toBe('window:browser-run-a:3');
      await expect(run(h, 'operation/status', { operationId }, sameWindow)).resolves.toMatchObject({
        operationId,
        state: 'failed',
        errorCode: 'backend_restarted',
      });
      const snapshot = (await run(h, 'snapshot/get', { domains: [] }, sameWindow)) as {
        pendingOperations: Array<{ operationId: string }>;
        recoveredOperationNotices: Array<{ operationId: string }>;
      };
      expect(snapshot.pendingOperations.map((entry) => entry.operationId)).toEqual([operationId]);
      expect(snapshot.recoveredOperationNotices.map((entry) => entry.operationId)).toEqual([
        operationId,
      ]);

      // A restarted browser has a new session, and window ids start over.
      const restarted = await overlay(h, { sessionId: 'browser-run-b', windowId: 3 });
      await expect(codeOf(run(h, 'operation/status', { operationId }, restarted))).resolves.toBe(
        'operation_not_owned',
      );
    });

    it("lets a reloaded document read its window's operation, and nobody else", async () => {
      const h = await createHarness();
      const before = await overlay(h, { documentId: 'doc-before' });
      const operationId = uuid();
      await run(h, 'settings/reset', { confirm: true }, before, operationId);

      const reloaded = await overlay(h, { documentId: 'doc-after' });
      await expect(run(h, 'operation/status', { operationId }, reloaded)).resolves.toMatchObject({
        operationId,
        state: 'succeeded',
      });
      await expect(
        codeOf(run(h, 'operation/status', { operationId }, await overlay(h, { windowId: 2 }))),
      ).resolves.toBe('operation_not_owned');

      // Window ids repeat across browser sessions: a new session cannot reach the old record.
      await expect(
        codeOf(
          run(h, 'operation/status', { operationId }, await overlay(h, { sessionId: 'session-2' })),
        ),
      ).resolves.toBe('operation_not_owned');
    });

    it('keeps records of a caller outside the overlay windows out of their reach', async () => {
      const h = await createHarness();
      const outsider: SettingsCaller = {
        clientId: uuid(),
        ownerId: uuid(),
        windowId: 1,
        isPrivate: false,
      };
      const operationId = uuid();
      await run(h, 'settings/reset', { confirm: true }, outsider, operationId);
      await expect(run(h, 'operation/status', { operationId }, outsider)).resolves.toMatchObject({
        state: 'succeeded',
      });
      await expect(
        codeOf(run(h, 'operation/status', { operationId }, await overlay(h))),
      ).resolves.toBe('operation_not_owned');
      const overlayOwned = uuid();
      await run(h, 'settings/reset', { confirm: true }, await overlay(h), overlayOwned);
      await expect(
        codeOf(run(h, 'operation/status', { operationId: overlayOwned }, outsider)),
      ).resolves.toBe('operation_not_owned');
    });

    it("lists the window's running and recently finished operations in snapshot/get", async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const h = await createHarness();
      const caller = await overlay(h);
      const other = await overlay(h, { windowId: 2 });
      const pending = async (who = caller) =>
        (
          (await run(h, 'snapshot/get', { domains: [] }, who)) as {
            pendingOperations: Array<{ operationId: string; state: string }>;
          }
        ).pendingOperations;

      const finished = uuid();
      await run(h, 'settings/reset', { confirm: true }, caller, finished);
      await run(h, 'settings/reset', { confirm: true }, other, uuid());

      // A delete that has not finished: its effect waits on the coordinator.
      let release!: () => void;
      const gate = h.ctx.coordinator.runExclusive(
        'graph-additive',
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const running = uuid();
      const inFlight = run(h, 'backup/delete', { backupId: 'b1', confirm: true }, caller, running);
      await vi.waitFor(async () =>
        expect((await pending()).find((entry) => entry.operationId === running)?.state).toBe(
          'running',
        ),
      );
      expect((await pending()).map((entry) => entry.operationId).sort()).toEqual(
        [finished, running].sort(),
      );
      expect((await pending(other)).map((entry) => entry.state)).toEqual(['succeeded']);

      release();
      await Promise.all([gate, inFlight]);
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      expect(await pending()).toEqual([]);
    });

    it('returns recovery notices for the window and lets it acknowledge them', async () => {
      const operationId = uuid();
      const h = await createHarness(async ({ operations }) => {
        await operations.reserve({
          operationId,
          kind: 'settings/reset',
          ownerClientInstanceId: 'window:session-1:1',
          targetWindowId: 1,
          isPrivate: false,
          payloadHash: 'c'.repeat(64),
        });
      });
      const caller = await overlay(h);
      const notices = async () =>
        (
          (await run(h, 'snapshot/get', { domains: [] }, caller)) as {
            recoveredOperationNotices: Array<{ operationId: string }>;
          }
        ).recoveredOperationNotices.map((notice) => notice.operationId);
      expect(await notices()).toEqual([operationId]);
      await run(h, 'recovery/acknowledgeNotice', { operationId }, caller);
      expect(await notices()).toEqual([]);
    });
  });

  describe('change notices', () => {
    const noticeTypes = (h: Harness) => h.broadcast.mock.calls.map(([event]) => event.type);

    it('broadcasts privacy and search changes after every kind of mutation', async () => {
      const h = await createHarness();
      const caller = await overlay(h);

      await run(h, 'privacy/setProtectionLevel', { level: 'enhanced' }, caller);
      expect(noticeTypes(h)).toEqual(['privacy/changed', 'searchEngines/changed']);
      expect(h.broadcast.mock.calls[0]![0]).toMatchObject({
        type: 'privacy/changed',
        privacy: { protectionLevel: 'standard', searchSuggestionsEnabled: false },
      });
      expect(h.broadcast.mock.calls[1]![0]).toEqual({
        type: 'searchEngines/changed',
        snapshot: {
          defaultSearchEngine: 'ddg',
          availableSearchEngines: [{ id: 'ddg', name: 'DuckDuckGo', isDefault: true }],
        },
      });

      h.broadcast.mockClear();
      await run(h, 'privacy/setAdvanced', { key: 'drmEnabled', value: false }, caller);
      expect(noticeTypes(h)).toEqual(['privacy/changed', 'searchEngines/changed']);

      h.broadcast.mockClear();
      await run(h, 'privacy/setDefaultSearchEngine', { id: 'ddg' }, caller);
      expect(noticeTypes(h)).toEqual(['privacy/changed', 'searchEngines/changed']);

      h.broadcast.mockClear();
      await run(h, 'settings/reset', { confirm: true }, caller, uuid());
      expect(noticeTypes(h)).toEqual(['privacy/changed', 'searchEngines/changed']);

      h.broadcast.mockClear();
      await h.service.setProtectionLevel('standard');
      await h.service.setAdvanced('searchSuggestionsEnabled', true);
      expect(noticeTypes(h)).toHaveLength(4);
    });

    it('broadcasts after an import that applies settings, and not otherwise', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      await run(h, 'backup/restore', { backupId: 'b1' }, caller, uuid());
      expect(h.broadcast).not.toHaveBeenCalled();
      const token = await preview(
        h,
        caller,
        exportFile({ settings: { defaultSearchEngine: 'ddg' } }),
      );
      await run(
        h,
        'backup/importValidated',
        { validationToken: token, options: { ...ADDITIVE, importSettings: true } },
        caller,
        uuid(),
      );
      expect(noticeTypes(h)).toEqual(['privacy/changed', 'searchEngines/changed']);
    });

    it('still answers when a change notice cannot be read', async () => {
      const h = await createHarness();
      vi.mocked(readPrivacySnapshot).mockRejectedValueOnce(new Error('unavailable'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(h.service.setSearchEngine('ddg')).resolves.toMatchObject({ state: 'succeeded' });
      expect(h.broadcast).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('does not announce settings changes itself (the store already broadcasts them)', async () => {
      const h = await createHarness();
      await h.service.updateSettings({ panelShadowsEnabled: false });
      expect(h.broadcast).not.toHaveBeenCalled();
    });
  });

  describe('snapshots', () => {
    it('returns only the requested domains with the editable settings and the revision', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      const snapshot = (await run(
        h,
        'snapshot/get',
        { domains: ['settings', 'search'] },
        caller,
      )) as {
        revision: number;
        settings: Record<string, unknown>;
        search: unknown;
        privacy?: unknown;
        backup?: unknown;
      };
      expect(snapshot.revision).toBe(0);
      expect(snapshot.settings).not.toHaveProperty('welcomeSeen');
      expect(snapshot.settings).toHaveProperty('customPanelSizes');
      expect(snapshot.search).toMatchObject({ defaultSearchEngine: 'ddg' });
      expect(snapshot.privacy).toBeUndefined();
      expect(snapshot.backup).toBeUndefined();
    });

    it('describes the backup context for a regular caller', async () => {
      const h = await createHarness();
      const caller = await overlay(h);
      await expect(run(h, 'backup/getContext', {}, caller)).resolves.toMatchObject({
        workspaces: [{ id: 'ws-1', name: 'One', normalTabCount: 0 }],
        backups: [],
        savedPanelCount: 0,
      });
    });
  });
});
