import { describe, expect, it, vi } from 'vitest';
import type { PendingOperation, SettingsSnapshot } from '@shared/settings-client-protocol';
import {
  FIXTURE_BACKUP,
  FIXTURE_IMPORT_PREVIEW,
  FIXTURE_PRIVACY,
  FIXTURE_SEARCH,
  FIXTURE_SETTINGS,
} from '../state/__fixtures__/settingsPalette';
import type { SettingsPaletteModel } from '../components/SettingsPalette/types';
import {
  SettingsClientError,
  type DurableOutcome,
  type SettingsChangeEvent,
  type SettingsClient,
} from './settingsClient';
import {
  MAX_IMPORT_FILE_CHARS,
  createSettingsPaletteStore,
  type SettingsPaletteHost,
} from './settingsStore';

const snapshot = (overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot => ({
  revision: 1,
  settings: FIXTURE_SETTINGS,
  privacy: FIXTURE_PRIVACY,
  search: FIXTURE_SEARCH,
  backup: FIXTURE_BACKUP,
  pendingOperations: [],
  ...overrides,
});

function setup() {
  const request = vi.fn();
  const run = vi.fn();
  const resume = vi.fn<(pending: readonly PendingOperation[]) => void>();
  let change: ((event: SettingsChangeEvent) => void) | undefined;
  let resumed: ((outcome: DurableOutcome) => void) | undefined;
  const client: SettingsClient = {
    request: request as SettingsClient['request'],
    run: run as SettingsClient['run'],
    resume,
    onChange: (listener) => {
      change = listener;
      return () => undefined;
    },
    onResumed: (listener) => {
      resumed = listener;
      return () => undefined;
    },
    dispose: () => undefined,
  };
  const host: SettingsPaletteHost = {
    openFirefoxSearchSettings: vi.fn(),
    openMergePalette: vi.fn(),
    saveFile: vi.fn(),
  };
  const palette = createSettingsPaletteStore(client, host);
  const model = (): SettingsPaletteModel => {
    const { view } = palette.store.getState();
    if (view.kind !== 'ready') throw new Error(`view is ${view.kind}`);
    return view.model;
  };
  const load = async (value: SettingsSnapshot = snapshot()) => {
    request.mockResolvedValueOnce(value);
    palette.actions.refresh();
    await vi.waitFor(() => expect(palette.store.getState().view.kind).toBe('ready'));
  };
  return {
    palette,
    request,
    run,
    resume,
    host,
    model,
    load,
    emit: (event: SettingsChangeEvent) => change?.(event),
    emitResumed: (outcome: DurableOutcome) => resumed?.(outcome),
  };
}

const outcome = (over: Partial<DurableOutcome> = {}): DurableOutcome => ({
  operationId: 'op',
  kind: 'settings/reset',
  state: 'succeeded',
  components: [],
  reconcileComponents: [],
  ...over,
});

describe('loading', () => {
  it('starts loading, then holds the snapshot and asks for every domain', async () => {
    const { palette, request, load, model } = setup();
    expect(palette.store.getState().view).toEqual({ kind: 'loading' });
    await load();
    expect(request).toHaveBeenCalledWith('snapshot/get', {
      domains: ['settings', 'privacy', 'search', 'backup'],
    });
    expect(model()).toMatchObject({
      isPrivate: false,
      settings: FIXTURE_SETTINGS,
      backup: FIXTURE_BACKUP,
      pending: new Set(),
      notice: null,
    });
  });

  it('treats a snapshot without the backup domain as a private window', async () => {
    const { load, model } = setup();
    await load(snapshot({ backup: undefined }));
    expect(model()).toMatchObject({ isPrivate: true, backup: null });
  });

  it('reports a failed first load and recovers on retry', async () => {
    const { palette, request, load } = setup();
    request.mockRejectedValueOnce(new SettingsClientError('timeout', true));
    palette.actions.refresh();
    await vi.waitFor(() => expect(palette.store.getState().view.kind).toBe('error'));
    expect(palette.store.getState().view).toMatchObject({
      message: expect.stringContaining('did not answer'),
    });
    await load();
    expect(palette.store.getState().view.kind).toBe('ready');
  });

  it('keeps what it has and shows a notice when a later refresh fails', async () => {
    const { palette, request, load, model } = setup();
    await load();
    request.mockRejectedValueOnce(new SettingsClientError('transport_unavailable', true));
    palette.actions.refresh();
    await vi.waitFor(() => expect(model().notice).toContain('not reachable'));
    expect(model().settings).toEqual(FIXTURE_SETTINGS);
  });

  it('applies only the newest of two overlapping refreshes', async () => {
    const { palette, request, model } = setup();
    let releaseFirst!: (value: SettingsSnapshot) => void;
    request.mockReturnValueOnce(
      new Promise<SettingsSnapshot>((resolve) => (releaseFirst = resolve)),
    );
    request.mockResolvedValueOnce(
      snapshot({ settings: { ...FIXTURE_SETTINGS, panelCornerRadiusPx: 30 } }),
    );
    palette.actions.refresh();
    palette.actions.refresh();
    await vi.waitFor(() => expect(palette.store.getState().view.kind).toBe('ready'));
    releaseFirst(snapshot({ settings: { ...FIXTURE_SETTINGS, panelCornerRadiusPx: 1 } }));
    await Promise.resolve();
    await Promise.resolve();
    expect(model().settings.panelCornerRadiusPx).toBe(30);
  });

  it('hands the pending durable operations to the client for rediscovery', async () => {
    const { resume, load } = setup();
    const pending: PendingOperation[] = [
      { operationId: 'op', kind: 'backup/restore', state: 'running', updatedAt: 1 },
    ];
    await load(snapshot({ pendingOperations: pending }));
    expect(resume).toHaveBeenCalledWith(pending);
  });
});

describe('live updates', () => {
  it('applies the three change notices', async () => {
    const { emit, load, model } = setup();
    await load();
    emit({
      type: 'settings/changed',
      settings: { ...FIXTURE_SETTINGS, panelShadowsEnabled: false } as never,
    });
    expect(model().settings.panelShadowsEnabled).toBe(false);
    emit({
      type: 'privacy/changed',
      privacy: { ...FIXTURE_PRIVACY, protectionLevel: 'hardened' } as never,
    });
    expect(model().privacy?.protectionLevel).toBe('hardened');
    emit({
      type: 'searchEngines/changed',
      snapshot: {
        defaultSearchEngine: 'google',
        availableSearchEngines: [{ id: 'google', name: 'Google', isDefault: true, iconUrl: 'x' }],
      },
    });
    expect(model().search).toEqual({
      defaultSearchEngine: 'google',
      availableSearchEngines: [{ id: 'google', name: 'Google', isDefault: true }],
    });
  });

  it('ignores a notice that arrives before the first snapshot', () => {
    const { emit, palette } = setup();
    emit({ type: 'settings/changed', settings: FIXTURE_SETTINGS as never });
    expect(palette.store.getState().view.kind).toBe('loading');
  });
});

describe('writes', () => {
  it('shows a write as pending while it runs and stores its result', async () => {
    const { palette, request, load, model } = setup();
    await load();
    let finish!: (value: unknown) => void;
    request.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const write = palette.actions.update({ panelShadowsEnabled: false });
    expect(model().pending.has('panelShadowsEnabled')).toBe(true);
    expect(request).toHaveBeenLastCalledWith('settings/update', {
      changes: { panelShadowsEnabled: false },
    });
    finish({ settings: { ...FIXTURE_SETTINGS, panelShadowsEnabled: false }, durableRevision: 2 });
    await expect(write).resolves.toBe(true);
    expect(model().pending.size).toBe(0);
    expect(model().settings.panelShadowsEnabled).toBe(false);
  });

  it('keeps a key pending until the last of its overlapping writes ends', async () => {
    const { palette, request, load, model } = setup();
    await load();
    const finishers: Array<(value: unknown) => void> = [];
    request.mockImplementation(() => new Promise((resolve) => finishers.push(resolve)));
    const first = palette.actions.update({ panelCornerRadiusPx: 2 });
    const second = palette.actions.update({ panelCornerRadiusPx: 24 });
    finishers[0]!({
      settings: { ...FIXTURE_SETTINGS, panelCornerRadiusPx: 2 },
      durableRevision: 2,
    });
    await first;
    expect(model().pending.has('panelCornerRadiusPx')).toBe(true);
    finishers[1]!({
      settings: { ...FIXTURE_SETTINGS, panelCornerRadiusPx: 24 },
      durableRevision: 3,
    });
    await second;
    expect(model().pending.size).toBe(0);
    expect(model().settings.panelCornerRadiusPx).toBe(24);
  });

  it('resolves false with a notice when tools refuses, and clears it on the next write', async () => {
    const { palette, request, load, model } = setup();
    await load();
    request.mockRejectedValueOnce(new SettingsClientError('busy', true));
    await expect(palette.actions.update({ panelShadowsEnabled: false })).resolves.toBe(false);
    expect(model().notice).toContain('busy');
    expect(model().settings.panelShadowsEnabled).toBe(true);
    request.mockResolvedValueOnce({ settings: FIXTURE_SETTINGS, durableRevision: 3 });
    await palette.actions.update({ panelShadowsEnabled: true });
    expect(model().notice).toBeNull();
  });

  it('applies privacy and search results, and tells when Firefox only took part of it', async () => {
    const { palette, request, load, model } = setup();
    await load();
    request.mockResolvedValueOnce({
      privacy: { ...FIXTURE_PRIVACY, protectionLevel: 'enhanced' },
      durableRevision: 2,
      state: 'partial',
      component: { component: 'privacy', state: 'failed', retryable: true },
    });
    await palette.actions.setProtectionLevel('enhanced');
    expect(request).toHaveBeenLastCalledWith('privacy/setProtectionLevel', { level: 'enhanced' });
    expect(model().privacy?.protectionLevel).toBe('enhanced');
    expect(model().notice).toContain('did not apply');
    request.mockResolvedValueOnce({
      search: { ...FIXTURE_SEARCH, defaultSearchEngine: 'google' },
      durableRevision: 3,
      state: 'succeeded',
      component: { component: 'search', state: 'succeeded', retryable: false },
    });
    await palette.actions.setSearchEngine('google');
    expect(model().search?.defaultSearchEngine).toBe('google');
    expect(model().notice).toBeNull();
  });

  it('sends advanced privacy changes by key', async () => {
    const { palette, request, load } = setup();
    await load();
    request.mockResolvedValueOnce({
      privacy: FIXTURE_PRIVACY,
      durableRevision: 2,
      state: 'succeeded',
      component: { component: 'privacy', state: 'succeeded', retryable: false },
    });
    await palette.actions.setAdvanced('resistFingerprinting', true);
    expect(request).toHaveBeenLastCalledWith('privacy/setAdvanced', {
      key: 'resistFingerprinting',
      value: true,
    });
  });
});

describe('reset and backups', () => {
  it('runs the reset as a durable operation and takes the reset state from it', async () => {
    const { palette, run, load, model } = setup();
    await load();
    run.mockResolvedValueOnce(
      outcome({
        result: {
          result: {
            settings: { ...FIXTURE_SETTINGS, panelCornerRadiusPx: 12 },
            privacy: FIXTURE_PRIVACY,
            search: FIXTURE_SEARCH,
          },
        },
      }),
    );
    await expect(palette.actions.reset()).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith('settings/reset', { confirm: true });
    expect(model().pending.size).toBe(0);
  });

  it('does not start a second durable operation while one with the same key runs', async () => {
    const { palette, run, load } = setup();
    await load();
    let finish!: (value: DurableOutcome) => void;
    run.mockReturnValueOnce(new Promise<DurableOutcome>((resolve) => (finish = resolve)));
    const first = palette.actions.reset();
    await expect(palette.actions.reset()).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    finish(outcome());
    await expect(first).resolves.toBe(true);
  });

  it('does not close on a partial reset and says what happened', async () => {
    const { palette, request, run, load, model } = setup();
    await load();
    request.mockResolvedValue(snapshot());
    run.mockResolvedValueOnce(outcome({ state: 'partial', reconcileComponents: ['search'] }));
    await expect(palette.actions.reset()).resolves.toBe(false);
    expect(model().notice).toContain('some parts did not apply');
  });

  it('exports through the host as a file', async () => {
    const { palette, request, host, load } = setup();
    await load();
    request.mockResolvedValueOnce({
      json: '{}',
      filename: 'bento-backup.json',
      schemaVersion: 2,
      snapshotRevision: 1,
    });
    await palette.actions.exportBackup();
    expect(host.saveFile).toHaveBeenCalledWith('bento-backup.json', '{}');
  });

  it('validates a chosen file, then imports it with the preview choices and drops the preview', async () => {
    const { palette, request, run, load, model } = setup();
    await load();
    request.mockResolvedValueOnce({
      validationToken: 'tok',
      expiresAt: 1,
      preview: FIXTURE_IMPORT_PREVIEW,
    });
    await palette.actions.pickImportFile(new File(['{"a":1}'], 'b.json'));
    expect(request).toHaveBeenLastCalledWith('backup/validateImport', { json: '{"a":1}' });
    expect(model().importPreview).toMatchObject({ fileName: 'b.json', validationToken: 'tok' });

    request.mockResolvedValue(snapshot());
    run.mockResolvedValueOnce(outcome({ kind: 'backup/importValidated' }));
    await expect(palette.actions.confirmImport()).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith('backup/importValidated', {
      validationToken: 'tok',
      options: { importSettings: true, importSavedPanels: true, replaceExisting: false },
    });
    expect(model().importPreview).toBeNull();
  });

  it('drops the preview even when the import fails', async () => {
    const { palette, request, run, load, model } = setup();
    await load();
    request.mockResolvedValueOnce({
      validationToken: 'tok',
      expiresAt: 1,
      preview: FIXTURE_IMPORT_PREVIEW,
    });
    await palette.actions.pickImportFile(new File(['{}'], 'b.json'));
    run.mockRejectedValueOnce(new SettingsClientError('token_invalid', false));
    await expect(palette.actions.confirmImport()).resolves.toBe(false);
    expect(model().importPreview).toBeNull();
    expect(model().notice).toContain('Choose the file again');
  });

  it('refuses a file the relay could not carry, without asking tools', async () => {
    const { palette, request, load, model } = setup();
    await load();
    const calls = request.mock.calls.length;
    const big = new File(['x'.repeat(MAX_IMPORT_FILE_CHARS + 1)], 'big.json');
    await expect(palette.actions.pickImportFile(big)).resolves.toBe(false);
    expect(request.mock.calls).toHaveLength(calls);
    expect(model().notice).toContain('too large');
  });

  it('restores and deletes with durable operations and reloads the snapshot', async () => {
    const { palette, request, run, load } = setup();
    await load();
    request.mockResolvedValue(snapshot());
    run.mockResolvedValue(outcome({ kind: 'backup/restore' }));
    await palette.actions.restoreBackup('b1');
    expect(run).toHaveBeenLastCalledWith('backup/restore', { backupId: 'b1' });
    await palette.actions.deleteBackup('b1');
    expect(run).toHaveBeenLastCalledWith('backup/delete', { backupId: 'b1', confirm: true });
    await vi.waitFor(() =>
      expect(
        request.mock.calls.filter(([operation]) => operation === 'snapshot/get').length,
      ).toBeGreaterThan(2),
    );
  });

  it('reports an operation a reloaded document finds finished, and reloads', async () => {
    const { emitResumed, request, load, model } = setup();
    await load();
    request.mockResolvedValue(snapshot());
    emitResumed(outcome({ kind: 'backup/restore', state: 'failed', errorCode: 'busy' }));
    expect(model().notice).toContain('The restore did not finish');
    await vi.waitFor(() => expect(request.mock.calls.length).toBeGreaterThan(1));
  });

  it('forwards the two links that leave the palette to the host', async () => {
    const { palette, host } = setup();
    palette.actions.openFirefoxSearchSettings();
    palette.actions.openMergePalette();
    expect(host.openFirefoxSearchSettings).toHaveBeenCalledOnce();
    expect(host.openMergePalette).toHaveBeenCalledOnce();
  });
});
