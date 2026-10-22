import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONTRACT,
  CONTRACT_SHA256,
  PROTOCOL_VERSION,
} from '@shared/generated/native-preferences-protocol';
import { BentoMutationCoordinator } from '../mutations/BentoMutationCoordinator';
import { SettingsDomainService } from '../settings-domain/SettingsDomainService';
import { SettingsStore } from '../settings/SettingsStore';
import { NativePreferencesService } from './NativePreferencesService';
import { OperationRegistry } from './OperationRegistry';

vi.mock('../backup/ImportExecutor', () => ({ executeImport: vi.fn() }));
vi.mock('../privacy/ProtectionLevels', () => ({
  readPrivacySnapshot: vi.fn(async () => ({
    protectionLevel: 'standard',
    defaultSearchEngine: 'ddg',
    availableSearchEngines: [],
  })),
  readSearchEnginesSnapshot: vi.fn(async () => ({
    defaultSearchEngine: 'ddg',
    availableSearchEngines: [],
  })),
}));

interface Response {
  requestId: string;
  ok: boolean;
  result: {
    resumeToken: string;
    capabilities: { backup: boolean };
    settings: Record<string, unknown>;
  };
  error: { code: string; retryable: boolean; messageL10nId: string };
  [key: string]: unknown;
}

/** One native client: a session over the observer bridge, driven the way the pane does. */
class NativeClient {
  clientInstanceId = crypto.randomUUID();
  resumeToken = '';
  sequence = 0;

  constructor(
    private bridge: Bridge,
    private options: { windowId?: number; isPrivate?: boolean } = {},
  ) {}

  async hello(): Promise<Response> {
    const response = await this.send('session/hello', {}, { authenticated: false });
    this.resumeToken = response.result.resumeToken;
    return response;
  }

  async request(
    operation: string,
    payload: unknown = {},
    extra: Record<string, unknown> = {},
  ): Promise<Response> {
    return this.send(operation, payload, { extra });
  }

  private async send(
    operation: string,
    payload: unknown,
    options: { authenticated?: boolean; extra?: Record<string, unknown> } = {},
  ): Promise<Response> {
    const requestId = crypto.randomUUID();
    const authenticated = options.authenticated !== false;
    this.bridge.listener!({
      request: {
        protocolVersion: PROTOCOL_VERSION,
        contractHash: CONTRACT_SHA256,
        requestId,
        clientInstanceId: this.clientInstanceId,
        ...(authenticated ? { resumeToken: this.resumeToken, sequence: this.sequence++ } : {}),
        deadlineMs: 10_000,
        operation,
        payload,
        ...options.extra,
      },
      targetWindowId: this.options.windowId ?? 1,
      isPrivate: this.options.isPrivate ?? false,
    });
    await vi.waitFor(() => expect(this.bridge.find(requestId)).toBeDefined());
    return this.bridge.find(requestId)!;
  }
}

class Bridge {
  listener?: (message: unknown) => void;
  responses: Response[] = [];
  publications: Response[] = [];
  find = (requestId: string) => this.responses.find((entry) => entry.requestId === requestId);
}

describe('NativePreferencesService on the domain service', () => {
  let bridge: Bridge;
  let domain: SettingsDomainService;
  let settings: SettingsStore;
  let service: NativePreferencesService;
  let backup: {
    getBackupData: ReturnType<typeof vi.fn>;
    collectSnapshot: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    bridge = new Bridge();
    const storage: Record<string, unknown> = {};
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (keys: string | string[]) => {
            const selected = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(selected.map((key) => [key, storage[key]]));
          }),
          set: vi.fn(async (patch: Record<string, unknown>) => Object.assign(storage, patch)),
        },
      },
      bentoNativePreferences: {
        onRequest: {
          addListener: (listener: (message: unknown) => void) => (bridge.listener = listener),
        },
        respond: vi.fn(async (response: Response) => {
          bridge.responses.push(response);
          return true;
        }),
        publish: vi.fn(async (publication: Response) => {
          bridge.publications.push(publication);
        }),
        getCurrentBootAttestation: vi.fn(async () => ({
          currentParentSessionId: 'parent',
          currentBootId: 'boot',
          singletonInitializedAt: 0,
          registryEpoch: 0,
        })),
      },
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    settings = new SettingsStore();
    await settings.init();
    const operations = new OperationRegistry();
    await operations.init();
    backup = { getBackupData: vi.fn(async () => null), collectSnapshot: vi.fn() };
    domain = new SettingsDomainService({
      ready: Promise.resolve(),
      settings,
      backup,
      workspaces: { snapshot: () => ({ workspaces: [] }) },
      savedPanels: { list: () => [] },
      coordinator: new BentoMutationCoordinator(),
      operations,
      journal: { current: () => null },
      privacyMutations: {
        setProtectionLevel: vi.fn(async () => ({
          state: 'succeeded',
          value: {
            protectionLevel: 'hardened',
            defaultSearchEngine: 'ddg',
            availableSearchEngines: [],
          },
          component: { component: 'privacy', state: 'succeeded', retryable: false },
        })),
        setSearchEngine: vi.fn(async () => ({
          state: 'succeeded',
          value: { defaultSearchEngine: 'ddg', availableSearchEngines: [] },
          component: { component: 'search', state: 'succeeded', retryable: false },
        })),
      },
      broadcast: vi.fn(),
      bootAttestation: async () => ({ currentParentSessionId: 'parent', currentBootId: 'boot' }),
    } as never);
    service = new NativePreferencesService({ domain, operations, backendInstanceId: 'backend-1' });
    service.start();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens a session and reports backup capability by privacy', async () => {
    const regular = await new NativeClient(bridge).hello();
    expect(regular).toMatchObject({ ok: true, result: { capabilities: { backup: true } } });
    const priv = await new NativeClient(bridge, { isPrivate: true }).hello();
    expect(priv.result.capabilities.backup).toBe(false);
  });

  it('serves snapshots and settings changes, and publishes them to the session', async () => {
    const client = new NativeClient(bridge);
    await client.hello();
    const snapshot = await client.request('snapshot/get', { domains: ['settings', 'search'] });
    expect(snapshot).toMatchObject({
      ok: true,
      result: { settings: { tabSleepAfterMinutes: 30 }, search: { defaultSearchEngine: 'ddg' } },
    });
    expect(snapshot.result.settings).not.toHaveProperty('welcomeSeen');

    const update = await client.request('settings/update', {
      changes: { tabSleepAfterMinutes: 45 },
    });
    expect(update).toMatchObject({
      ok: true,
      revision: 1,
      result: { settings: { tabSleepAfterMinutes: 45 }, durableRevision: 1 },
    });
    await vi.waitFor(() => expect(bridge.publications).toHaveLength(1));
    expect(bridge.publications[0]).toMatchObject({
      clientInstanceId: client.clientInstanceId,
      domain: 'settings',
      revision: 1,
      payload: { tabSleepAfterMinutes: 45 },
    });
  });

  it('refuses backup operations and notice acknowledgement to a private session', async () => {
    const client = new NativeClient(bridge, { windowId: 2, isPrivate: true });
    await client.hello();
    for (const [operation, payload] of [
      ['backup/getContext', {}],
      ['backup/export', {}],
      ['recovery/acknowledgeNotice', { operationId: crypto.randomUUID() }],
    ] as const) {
      expect(await client.request(operation, payload)).toMatchObject({
        ok: false,
        error: {
          code: 'private_window_forbidden',
          retryable: false,
          messageL10nId: 'bento-error-private-window-forbidden',
        },
      });
    }
    expect(backup.collectSnapshot).not.toHaveBeenCalled();
  });

  it('answers file and token failures with their own codes instead of internal_error', async () => {
    const client = new NativeClient(bridge);
    await client.hello();
    const code = async (operation: string, payload: unknown, extra?: Record<string, unknown>) =>
      (await client.request(operation, payload, extra)).error?.code;

    expect(
      await code('backup/validateImport', {
        json: 'x'.repeat(CONTRACT.bounds.backupFileBytes + 1),
      }),
    ).toBe('payload_too_large');
    expect(await code('backup/validateImport', { json: '{}' })).toBe('invalid_payload');
    expect(
      await code(
        'backup/importValidated',
        {
          validationToken: 'unknown',
          options: { importSettings: false, importSavedPanels: false, replaceExisting: false },
        },
        { operationId: crypto.randomUUID() },
      ),
    ).toBe('validation_token_invalid');
    expect(
      await code('backup/restore', { backupId: 'gone' }, { operationId: crypto.randomUUID() }),
    ).toBe('not_found');
  });

  it('retains a reset by operation id, replays it, and keeps ownership per client', async () => {
    const client = new NativeClient(bridge);
    await client.hello();
    const operationId = crypto.randomUUID();
    const first = await client.request('settings/reset', { confirm: true }, { operationId });
    expect(first).toMatchObject({ ok: true, operationId, result: { state: 'succeeded' } });
    const replay = await client.request('settings/reset', { confirm: true }, { operationId });
    expect(replay.result).toEqual(first.result);

    expect(await client.request('operation/status', { operationId })).toMatchObject({
      ok: true,
      result: { operationId, kind: 'settings/reset', state: 'succeeded' },
    });
    // Only the native transport offers reconcile and cancel.
    expect((await client.request('operation/reconcile', { operationId })).error.code).toBe(
      'operation_not_reconcilable',
    );
    expect(
      (await client.request('request/cancel', { operationId: crypto.randomUUID() })).error.code,
    ).toBe('operation_unknown');

    const other = new NativeClient(bridge);
    await other.hello();
    expect((await other.request('operation/status', { operationId })).error.code).toBe(
      'operation_not_owned',
    );
  });

  it('rejects a malformed envelope without reaching the domain', async () => {
    const client = new NativeClient(bridge);
    await client.hello();
    const response = await client.request('settings/update', { changes: {} }, { injected: true });
    expect(response).toMatchObject({ ok: false, error: { code: 'invalid_envelope' } });
    expect(settings.snapshot().tabSleepAfterMinutes).toBe(30);
  });
});
