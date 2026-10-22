import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BentoExportSchema } from '@shared/protocol';
import { executeImport, type ImportContext } from './ImportExecutor';

const live = vi.hoisted(() => ({
  setProtectionLevel: vi.fn(),
  setSearchEngine: vi.fn(),
}));

vi.mock('../privacy/PrivacyMutationService', () => ({
  PrivacyMutationService: class {
    setProtectionLevel = live.setProtectionLevel;
    setSearchEngine = live.setSearchEngine;
  },
}));

const outcome = (component: 'privacy' | 'search', ok: boolean) => ({
  state: ok ? 'succeeded' : 'partial',
  value: {},
  component: ok
    ? { component, state: 'succeeded', retryable: false }
    : { component, state: 'failed', retryable: true, errorCode: 'live_effect_failed' },
});

describe('executeImport live effects', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function run(onLiveEffectFailures: (failed: unknown[]) => void) {
    vi.stubGlobal('browser', {
      windows: {
        get: vi.fn(async () => ({ id: 1, type: 'normal', incognito: false })),
        getAll: vi.fn(async () => [{ id: 1, type: 'normal', incognito: false }]),
      },
      tabs: {
        create: vi.fn(async (options: { url: string }) => ({
          id: 100,
          url: options.url,
          active: false,
          pinned: false,
        })),
      },
    });
    const data: BentoExportSchema = {
      schemaVersion: 2,
      bentoVersion: '0.0.0',
      exportedAt: 1,
      workspaces: [
        { id: 'source', name: 'Imported', createdAt: 1, tabs: [], panels: [], pinnedPanels: [] },
      ],
      savedPanels: [],
      settings: { privacyProtectionLevel: 'hardened', defaultSearchEngine: 'ddg' },
    };
    return executeImport(
      data,
      { importSettings: true, importSavedPanels: false, replaceExisting: false },
      {
        workspaces: {
          snapshot: () => ({ workspaces: [] }),
          create: vi.fn(() => ({ id: 'imported', name: 'Imported', createdAt: 1 })),
          activate: vi.fn(() => 'activated'),
          persistCurrentState: vi.fn(),
        },
        tabs: { assignWorkspace: vi.fn(async () => undefined), snapshot: () => [] },
        panels: {
          persistCurrentState: vi.fn(),
          restorePersistedLayout: vi.fn(),
          setMainWidth: vi.fn(),
          setStripScroll: vi.fn(),
          setWidth: vi.fn(),
        },
        pinnedPanels: { persistCurrentState: vi.fn() },
        settings: { update: vi.fn() },
        savedPanels: { save: vi.fn() },
        targetWindowId: 1,
        operation: {
          plannedWorkspaceIds: [],
          onPhase: vi.fn(async () => undefined),
          onWorkspaceCreated: vi.fn(async () => undefined),
          onTabCreated: vi.fn(async () => undefined),
          onLiveEffectFailures,
        },
      } as unknown as ImportContext,
    );
  }

  it('reports the components whose privacy or search effect did not stick', async () => {
    live.setProtectionLevel.mockResolvedValue(outcome('privacy', false));
    live.setSearchEngine.mockResolvedValue(outcome('search', true));
    const onFailures = vi.fn();
    const summary = await run(onFailures);
    expect(summary.settingsApplied).toBe(false);
    expect(onFailures).toHaveBeenCalledWith([
      { component: 'privacy', state: 'failed', retryable: true, errorCode: 'live_effect_failed' },
    ]);
  });

  it('stays quiet when every live effect applied', async () => {
    live.setProtectionLevel.mockResolvedValue(outcome('privacy', true));
    live.setSearchEngine.mockResolvedValue(outcome('search', true));
    const onFailures = vi.fn();
    expect((await run(onFailures)).settingsApplied).toBe(true);
    expect(onFailures).not.toHaveBeenCalled();
  });
});
