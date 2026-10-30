import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SETTINGS_LIMITS } from '@shared/settings-rules';
import type {
  PendingOperation,
  RecoveredOperationNotice,
  SettingsSnapshot,
} from '@shared/settings-client-protocol';
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
import type { BusUp } from '../bridge/shellBus';
import { RELAY_UP_MAX_CHARS } from './relayLimit';
import { controlRows } from '../components/SettingsPalette/rows';
import { createSettingsPaletteStore, type SettingsPaletteHost } from './settingsStore';

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
  const request = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);
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

const radius = (value: number) => ({ ...FIXTURE_SETTINGS, panelCornerRadiusPx: value });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

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
      pendingTargets: new Map(),
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

  it('tracks what a switch write asked for until it ends, so a broadcast cannot flip it back', async () => {
    const { palette, request, emit, load, model } = setup();
    await load();
    const shadows = () =>
      controlRows(model()).find((row) => row.id === 'setting:panelShadowsEnabled')!.switchOn;
    let finish!: (value: unknown) => void;
    request.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const write = palette.actions.update({ panelShadowsEnabled: false });
    expect(model().pendingTargets.get('panelShadowsEnabled')).toBe(false);
    expect(shadows()).toBe(false);
    // The change notice stores the new value before the reply: the switch stays where it is.
    emit({
      type: 'settings/changed',
      settings: { ...FIXTURE_SETTINGS, panelShadowsEnabled: false } as never,
    });
    expect(model().settings.panelShadowsEnabled).toBe(false);
    expect(shadows()).toBe(false);
    finish({ settings: { ...FIXTURE_SETTINGS, panelShadowsEnabled: false }, durableRevision: 2 });
    await write;
    expect(model().pendingTargets.size).toBe(0);
    expect(shadows()).toBe(false);
  });

  it('drops the target of a switch write that fails, so the switch shows the stored value', async () => {
    const { palette, request, load, model } = setup();
    await load();
    const shadows = () =>
      controlRows(model()).find((row) => row.id === 'setting:panelShadowsEnabled')!.switchOn;
    let fail!: (error: unknown) => void;
    request.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    const write = palette.actions.update({ panelShadowsEnabled: false });
    expect(shadows()).toBe(false);
    fail(new SettingsClientError('busy', true));
    await expect(write).resolves.toBe(false);
    expect(model().pendingTargets.size).toBe(0);
    expect(shadows()).toBe(true);
  });

  it('tracks an advanced privacy switch by its key, and no target for a choice or a number', async () => {
    const { palette, request, load, model } = setup();
    await load();
    let finish!: (value: unknown) => void;
    request.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const write = palette.actions.setAdvanced('remoteSafeBrowsingEnabled', true);
    expect(model().pendingTargets.get('advanced:remoteSafeBrowsingEnabled')).toBe(true);
    finish({ privacy: FIXTURE_PRIVACY, state: 'succeeded' });
    await write;
    expect(model().pendingTargets.size).toBe(0);

    request.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const number = palette.actions.update({ panelCornerRadiusPx: 20 });
    expect(model().pending.has('panelCornerRadiusPx')).toBe(true);
    expect(model().pendingTargets.size).toBe(0);
    finish({ settings: { ...FIXTURE_SETTINGS, panelCornerRadiusPx: 20 }, durableRevision: 3 });
    await number;
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

  describe('a backup file against the relay limit', () => {
    const preview = { validationToken: 'tok', expiresAt: 1, preview: FIXTURE_IMPORT_PREVIEW };

    // The message the document posts for a validate request, as bridge/shellBus.ts serializes it.
    const upMessageLength = (json: string) => {
      const message: BusUp = {
        kind: 'settings-request',
        request: {
          requestId: 'a4f3c1b2-6f0e-4b52-9a39-0d1f6a3a9c11',
          operation: 'backup/validateImport',
          payload: { json },
        },
      };
      return JSON.stringify(message).length;
    };

    it('keeps the actor limit equal to the relay limit the palette checks against', () => {
      const actor = readFileSync(
        new URL('../../../../src/browser/actors/BentoShellBusChild.sys.mjs', import.meta.url),
        'utf8',
      );
      const match = /const MAX_MESSAGE_CHARS = (\d+) \* 1024 \* 1024;/.exec(actor);
      expect(match, 'BentoShellBusChild.sys.mjs states its limit in MiB').not.toBeNull();
      expect(Number(match![1]) * 1024 * 1024).toBe(RELAY_UP_MAX_CHARS);
    });

    it('lets the relay carry the largest backup tools accepts, quotes and newlines escaped', async () => {
      // A pretty-printed backup is mostly quotes and newlines, which JSON escaping doubles.
      const json = '"\n'
        .repeat(SETTINGS_LIMITS.backupFileBytes / 3)
        .padEnd(SETTINGS_LIMITS.backupFileBytes, '"');
      expect(new TextEncoder().encode(json).length).toBe(SETTINGS_LIMITS.backupFileBytes);
      expect(upMessageLength(json)).toBeLessThanOrEqual(RELAY_UP_MAX_CHARS);

      const { palette, request, load } = setup();
      await load();
      request.mockResolvedValueOnce(preview);
      await expect(palette.actions.pickImportFile(new File([json], 'big.json'))).resolves.toBe(
        true,
      );
      expect(request).toHaveBeenLastCalledWith('backup/validateImport', { json });
    });

    it('accepts a file whose message is past the old 8 Mi limit but under the new one', async () => {
      // A 7.1 million character file escaped to a message of over 14 million, which the old
      // 8 Mi limit on the actor dropped without an answer.
      const json = '{"k":"v"}\n'.repeat(646_000);
      expect(json.length).toBeLessThan(8 * 1024 * 1024);
      const { palette, request, load } = setup();
      await load();
      request.mockResolvedValueOnce(preview);
      await expect(palette.actions.pickImportFile(new File([json], 'b.json'))).resolves.toBe(true);
      expect(upMessageLength(json)).toBeGreaterThan(8 * 1024 * 1024);
    });

    it('refuses a file past the backup size without reading it or asking tools', async () => {
      const { palette, request, load, model } = setup();
      await load();
      const calls = request.mock.calls.length;
      const big = new File(['x'.repeat(SETTINGS_LIMITS.backupFileBytes + 1)], 'big.json');
      const read = vi.spyOn(big, 'text');
      await expect(palette.actions.pickImportFile(big)).resolves.toBe(false);
      expect(read).not.toHaveBeenCalled();
      expect(request.mock.calls).toHaveLength(calls);
      expect(model().notice).toContain('too large');
    });

    it('refuses a file under the backup size whose escaped message the relay would drop', async () => {
      // Control characters escape to six characters each.
      const json = '\u0001'.repeat(SETTINGS_LIMITS.backupFileBytes);
      expect(upMessageLength(json)).toBeGreaterThan(RELAY_UP_MAX_CHARS);
      const { palette, request, load, model } = setup();
      await load();
      const calls = request.mock.calls.length;
      await expect(palette.actions.pickImportFile(new File([json], 'odd.json'))).resolves.toBe(
        false,
      );
      expect(request.mock.calls).toHaveLength(calls);
      expect(model().notice).toContain('too large');
    });
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

describe('older answers never replace newer values', () => {
  it('keeps a value a change notice delivered while the snapshot was being collected', async () => {
    const { palette, request, emit, load, model } = setup();
    await load();
    const late = deferred<SettingsSnapshot>();
    request.mockReturnValueOnce(late.promise);
    palette.actions.refresh();
    emit({ type: 'settings/changed', settings: radius(24) as never });
    // The snapshot was read before that change: its settings are the older picture, but its
    // privacy and search were not touched by anything since.
    late.resolve(
      snapshot({
        settings: radius(6),
        privacy: { ...FIXTURE_PRIVACY, protectionLevel: 'hardened' } as never,
      }),
    );
    await vi.waitFor(() => expect(model().privacy?.protectionLevel).toBe('hardened'));
    expect(model().settings.panelCornerRadiusPx).toBe(24);
  });

  it('keeps the answer of a write that came back while the snapshot was being collected', async () => {
    const { palette, request, load, model } = setup();
    await load();
    const late = deferred<SettingsSnapshot>();
    request.mockReturnValueOnce(late.promise);
    palette.actions.refresh();
    request.mockResolvedValueOnce({ settings: radius(30), durableRevision: 2 });
    await palette.actions.update({ panelCornerRadiusPx: 30 });
    late.resolve(snapshot({ settings: radius(6) }));
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    expect(model().settings.panelCornerRadiusPx).toBe(30);
  });

  it('keeps a notice that landed before the answer of an earlier write', async () => {
    const { palette, request, emit, load, model } = setup();
    await load();
    const answer = deferred<unknown>();
    request.mockReturnValueOnce(answer.promise);
    const write = palette.actions.update({ panelCornerRadiusPx: 12 });
    emit({ type: 'settings/changed', settings: radius(40) as never });
    answer.resolve({ settings: radius(12), durableRevision: 2 });
    await write;
    expect(model().settings.panelCornerRadiusPx).toBe(40);
  });

  it('takes the answer of the write sent last when the answers arrive out of order', async () => {
    const { palette, request, load, model } = setup();
    await load();
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    request.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const one = palette.actions.update({ panelCornerRadiusPx: 10 });
    const two = palette.actions.update({ panelCornerRadiusPx: 20 });
    second.resolve({ settings: radius(20), durableRevision: 3 });
    await two;
    first.resolve({ settings: radius(10), durableRevision: 2 });
    await one;
    expect(model().settings.panelCornerRadiusPx).toBe(20);
  });

  it('applies a snapshot collected after a write answered', async () => {
    const { palette, request, load, model } = setup();
    await load();
    request.mockResolvedValueOnce({ settings: radius(30), durableRevision: 2 });
    await palette.actions.update({ panelCornerRadiusPx: 30 });
    request.mockResolvedValueOnce(snapshot({ settings: radius(31) }));
    palette.actions.refresh();
    await vi.waitFor(() => expect(model().settings.panelCornerRadiusPx).toBe(31));
  });
  it('keeps a change notice that lands while the first snapshot is still being collected', async () => {
    const { palette, request, emit, model } = setup();
    const first = deferred<SettingsSnapshot>();
    request.mockReturnValueOnce(first.promise);
    palette.actions.refresh();
    // Another window changed the radius after the snapshot was asked for and before it came back:
    // the snapshot's 12 is the older picture.
    emit({ type: 'settings/changed', settings: radius(40) as never });
    expect(palette.store.getState().view.kind).toBe('loading');
    first.resolve(snapshot({ settings: radius(12) }));
    await vi.waitFor(() => expect(palette.store.getState().view.kind).toBe('ready'));
    expect(model().settings.panelCornerRadiusPx).toBe(40);
  });

  it('keeps early notices per field, and the snapshot for the fields none touched', async () => {
    const { palette, request, emit, model } = setup();
    const first = deferred<SettingsSnapshot>();
    request.mockReturnValueOnce(first.promise);
    palette.actions.refresh();
    emit({
      type: 'privacy/changed',
      privacy: { ...FIXTURE_PRIVACY, protectionLevel: 'hardened' } as never,
    });
    first.resolve(snapshot({ settings: radius(20) }));
    await vi.waitFor(() => expect(palette.store.getState().view.kind).toBe('ready'));
    expect(model().privacy?.protectionLevel).toBe('hardened');
    expect(model().settings.panelCornerRadiusPx).toBe(20);
  });

  it('takes a snapshot that was asked for after the notice came in', async () => {
    const { palette, request, emit, model } = setup();
    emit({ type: 'settings/changed', settings: radius(40) as never });
    request.mockResolvedValueOnce(snapshot({ settings: radius(12) }));
    palette.actions.refresh();
    await vi.waitFor(() => expect(palette.store.getState().view.kind).toBe('ready'));
    expect(model().settings.panelCornerRadiusPx).toBe(12);
  });

  it('keeps a change that landed while a reset ran, whatever the reset returns', async () => {
    const { palette, run, emit, load, model } = setup();
    await load();
    const reset = deferred<DurableOutcome>();
    run.mockReturnValueOnce(reset.promise);
    const done = palette.actions.reset();
    emit({ type: 'settings/changed', settings: radius(40) as never });
    reset.resolve(
      outcome({
        result: {
          result: { settings: radius(12), privacy: FIXTURE_PRIVACY, search: FIXTURE_SEARCH },
        },
      }),
    );
    await done;
    expect(model().settings.panelCornerRadiusPx).toBe(40);
  });

  it('applies what a reset returns when nothing newer came in', async () => {
    const { palette, run, load, model } = setup();
    await load();
    run.mockResolvedValueOnce(
      outcome({
        result: {
          result: { settings: radius(7), privacy: FIXTURE_PRIVACY, search: FIXTURE_SEARCH },
        },
      }),
    );
    await palette.actions.reset();
    expect(model().settings.panelCornerRadiusPx).toBe(7);
  });
});

describe('operations that ended out of sight', () => {
  const recovered = (over: Partial<RecoveredOperationNotice> = {}): RecoveredOperationNotice => ({
    operationId: 'op-1',
    kind: 'backup/importValidated',
    state: 'failed',
    components: [],
    updatedAt: 1,
    ...over,
  });
  const status = (over: Record<string, unknown> = {}) => ({
    operationId: 'op-1',
    kind: 'backup/importValidated',
    state: 'failed',
    phase: 'terminal',
    errorCode: 'backend_restarted',
    components: [],
    reconcileComponents: [],
    cancelRequested: false,
    createdAt: 1,
    updatedAt: 2,
    ...over,
  });
  const calls = (request: ReturnType<typeof setup>['request'], operation: string) =>
    request.mock.calls.filter(([name]) => name === operation);

  /** A tools stub: the snapshot the test names, and a status for every operation id. */
  const tools = (
    request: ReturnType<typeof setup>['request'],
    snap: () => SettingsSnapshot,
    statuses: Record<string, unknown>,
  ) =>
    request.mockImplementation(async (operation: unknown, payload: unknown) => {
      if (operation === 'snapshot/get') return snap();
      if (operation === 'operation/status') {
        return statuses[(payload as { operationId: string }).operationId];
      }
      return { acknowledged: true };
    });

  it('shows what restarting tools did to an import, and acknowledges the notice', async () => {
    const { palette, request, model } = setup();
    tools(request, () => snapshot({ recoveredOperationNotices: [recovered()] }), {
      'op-1': status(),
    });
    palette.actions.refresh();
    await vi.waitFor(() => expect(model().notice).toContain('The import did not finish'));
    expect(model().notice).toContain('restarted');
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('recovery/acknowledgeNotice', { operationId: 'op-1' }),
    );
  });

  it('reports an operation that finished while the document was reloading', async () => {
    const { palette, request, resume, model } = setup();
    const pending: PendingOperation[] = [
      { operationId: 'op-2', kind: 'backup/restore', state: 'succeeded', updatedAt: 5 },
    ];
    tools(request, () => snapshot({ pendingOperations: pending }), {
      'op-2': status({ operationId: 'op-2', kind: 'backup/restore', state: 'succeeded' }),
    });
    palette.actions.refresh();
    await vi.waitFor(() => expect(model().notice).toBe('The restore finished.'));
    expect(resume).toHaveBeenCalledWith(pending);
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith('recovery/acknowledgeNotice', { operationId: 'op-2' }),
    );
  });

  it('reports each operation once, however many snapshots list it', async () => {
    const { palette, request, model } = setup();
    tools(request, () => snapshot({ recoveredOperationNotices: [recovered()] }), {
      'op-1': status(),
    });
    palette.actions.refresh();
    await vi.waitFor(() => expect(model().notice).not.toBeNull());
    palette.actions.clearNotice();
    palette.actions.refresh();
    await vi.waitFor(() => expect(calls(request, 'snapshot/get')).toHaveLength(2));
    await Promise.resolve();
    expect(model().notice).toBeNull();
    expect(calls(request, 'recovery/acknowledgeNotice')).toHaveLength(1);
  });

  it('leaves alone an operation tools lists as already acknowledged', async () => {
    const { palette, request, model } = setup();
    tools(
      request,
      () =>
        snapshot({
          pendingOperations: [
            {
              operationId: 'op-3',
              kind: 'backup/delete',
              state: 'failed',
              updatedAt: 1,
              noticeAcknowledged: true,
            },
          ],
        }),
      {},
    );
    palette.actions.refresh();
    await vi.waitFor(() => expect(model()).toBeDefined());
    await Promise.resolve();
    expect(calls(request, 'operation/status')).toHaveLength(0);
    expect(model().notice).toBeNull();
  });

  it('does not report the operation this document ran itself a second time', async () => {
    const { palette, request, run, load, model } = setup();
    await load();
    tools(
      request,
      () =>
        snapshot({
          pendingOperations: [
            { operationId: 'op-run', kind: 'backup/restore', state: 'failed', updatedAt: 3 },
          ],
        }),
      { 'op-run': status({ operationId: 'op-run', kind: 'backup/restore', errorCode: 'busy' }) },
    );
    run.mockResolvedValueOnce(
      outcome({
        operationId: 'op-run',
        kind: 'backup/restore',
        state: 'failed',
        errorCode: 'busy',
      }),
    );
    await palette.actions.restoreBackup('b1');
    await vi.waitFor(() => expect(calls(request, 'snapshot/get').length).toBeGreaterThan(0));
    await Promise.resolve();
    expect(calls(request, 'operation/status')).toHaveLength(0);
    expect(calls(request, 'recovery/acknowledgeNotice')).toHaveLength(1);
    expect(model().notice).toContain('The restore did not finish');
  });

  it('looks again later at an operation tools cannot report on yet', async () => {
    const { palette, request, model } = setup();
    let answer: unknown = new SettingsClientError('timeout', true);
    tools(request, () => snapshot({ recoveredOperationNotices: [recovered()] }), {});
    request.mockImplementation(async (operation: unknown) => {
      if (operation === 'snapshot/get')
        return snapshot({ recoveredOperationNotices: [recovered()] });
      if (operation === 'operation/status') {
        if (answer instanceof Error) throw answer;
        return answer;
      }
      return { acknowledged: true };
    });
    palette.actions.refresh();
    await vi.waitFor(() => expect(calls(request, 'operation/status')).toHaveLength(1));
    expect(model().notice).toBeNull();
    answer = status();
    palette.actions.refresh();
    await vi.waitFor(() => expect(model().notice).toContain('The import did not finish'));
  });
  describe('while the palette is hidden', () => {
    const ackOf = (request: ReturnType<typeof setup>['request']) =>
      calls(request, 'recovery/acknowledgeNotice').map(([, payload]) => payload);

    it('keeps a failure that ends after the palette was closed, and shows it on the next show', async () => {
      const { palette, request, run, load, model } = setup();
      await load();
      tools(request, () => snapshot(), {});
      palette.actions.setVisible(false);
      run.mockResolvedValueOnce(
        outcome({
          operationId: 'op-h',
          kind: 'backup/restore',
          state: 'failed',
          errorCode: 'busy',
        }),
      );
      await palette.actions.restoreBackup('b1');
      // Nobody could read it, so it is neither shown nor acknowledged in tools.
      expect(model().notice).toBeNull();
      expect(ackOf(request)).toEqual([]);

      palette.actions.setVisible(true);
      expect(model().notice).toContain('The restore did not finish');
      await vi.waitFor(() => expect(ackOf(request)).toEqual([{ operationId: 'op-h' }]));
    });

    it('reports a success that ends while hidden as finished, on the next show', async () => {
      const { palette, request, run, load, model } = setup();
      await load();
      tools(request, () => snapshot(), {});
      palette.actions.setVisible(false);
      run.mockResolvedValueOnce(outcome({ operationId: 'op-s', kind: 'backup/importValidated' }));
      await palette.actions.restoreBackup('b1');
      expect(model().notice).toBeNull();
      palette.actions.setVisible(true);
      expect(model().notice).toBe('The import finished.');
      expect(ackOf(request)).toEqual([{ operationId: 'op-s' }]);
    });

    it('does not let a show clear the outcome it has just reported', async () => {
      const { palette, request, run, load, model } = setup();
      await load();
      tools(request, () => snapshot(), {});
      palette.actions.setVisible(false);
      run.mockResolvedValueOnce(
        outcome({ operationId: 'op-d', kind: 'backup/delete', state: 'failed', errorCode: 'busy' }),
      );
      await palette.actions.deleteBackup('b1');
      palette.actions.setVisible(true);
      const shown = model().notice;
      expect(shown).toContain('The delete did not finish');
      // A second show, with nothing new, starts clean: the outcome was seen once.
      palette.actions.setVisible(true);
      expect(model().notice).toBeNull();
      expect(ackOf(request)).toHaveLength(1);
    });

    it('acknowledges at once an outcome that ends while the palette is open', async () => {
      const { palette, request, run, load, model } = setup();
      await load();
      tools(request, () => snapshot(), {});
      run.mockResolvedValueOnce(
        outcome({ operationId: 'op-v', kind: 'backup/delete', state: 'failed', errorCode: 'busy' }),
      );
      await palette.actions.deleteBackup('b1');
      expect(model().notice).toContain('The delete did not finish');
      expect(ackOf(request)).toEqual([{ operationId: 'op-v' }]);
    });

    it('leaves an unseen outcome for a reloaded document to find, and does not repeat a seen one', async () => {
      // The first document: closed, the restore fails, the document is reloaded before a show.
      const first = setup();
      await first.load();
      tools(first.request, () => snapshot(), {});
      first.palette.actions.setVisible(false);
      first.run.mockResolvedValueOnce(
        outcome({
          operationId: 'op-r',
          kind: 'backup/restore',
          state: 'failed',
          errorCode: 'busy',
        }),
      );
      await first.palette.actions.restoreBackup('b1');
      expect(ackOf(first.request)).toEqual([]);

      // The reloaded document asks again: tools still lists the operation, not acknowledged.
      const second = setup();
      second.palette.actions.setVisible(false);
      tools(
        second.request,
        () =>
          snapshot({
            pendingOperations: [
              { operationId: 'op-r', kind: 'backup/restore', state: 'failed', updatedAt: 3 },
            ],
          }),
        { 'op-r': status({ operationId: 'op-r', kind: 'backup/restore', errorCode: 'busy' }) },
      );
      second.palette.actions.refresh();
      await vi.waitFor(() => expect(second.palette.store.getState().view.kind).toBe('ready'));
      await vi.waitFor(() => expect(calls(second.request, 'operation/status')).toHaveLength(1));
      expect(ackOf(second.request)).toEqual([]);
      second.palette.actions.setVisible(true);
      expect(second.model().notice).toContain('The restore did not finish');
      await vi.waitFor(() => expect(ackOf(second.request)).toEqual([{ operationId: 'op-r' }]));
    });

    it('holds an outcome until the first snapshot gives it a model to show in', async () => {
      const { palette, request, emitResumed, model } = setup();
      tools(request, () => snapshot(), {});
      palette.actions.setVisible(false);
      emitResumed(
        outcome({
          operationId: 'op-e',
          kind: 'backup/restore',
          state: 'failed',
          errorCode: 'busy',
        }),
      );
      // Shown before there is a model: nothing to put the notice in yet.
      palette.actions.setVisible(true);
      expect(palette.store.getState().view.kind).toBe('loading');
      palette.actions.refresh();
      await vi.waitFor(() => expect(palette.store.getState().view.kind).toBe('ready'));
      expect(model().notice).toContain('The restore did not finish');
    });
  });
});
