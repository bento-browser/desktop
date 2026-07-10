import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BentoSettings, TabSnapshot } from '@shared/protocol';
import type { SettingsStore } from '../settings/SettingsStore';
import type { TabRegistry } from './TabRegistry';
import { SleepPolicy } from './SleepPolicy';

interface TabListeners {
  activated?: (info: browser.tabs._OnActivatedActiveInfo) => void;
  created?: (tab: browser.tabs.Tab) => void;
  removed?: (id: number) => void;
}

function makeTab(overrides: Partial<TabSnapshot> & { id: number }): TabSnapshot {
  return {
    id: overrides.id,
    windowId: overrides.windowId ?? 1,
    index: overrides.index ?? overrides.id,
    title: overrides.title ?? `Tab ${overrides.id}`,
    active: overrides.active ?? false,
    pinned: overrides.pinned ?? false,
    audible: overrides.audible ?? false,
    muted: overrides.muted ?? false,
    loading: overrides.loading ?? false,
    discarded: overrides.discarded ?? false,
    workspaceId: overrides.workspaceId,
    url: overrides.url,
    favIconUrl: overrides.favIconUrl,
    customTitle: overrides.customTitle,
    folderId: overrides.folderId,
  };
}

function makeSettings(overrides: Partial<BentoSettings> = {}): SettingsStore {
  const settings: BentoSettings = {
    tabSleepEnabled: true,
    tabSleepAfterMinutes: 1,
    tabSleepKeepAlivePerWorkspace: 1,
    defaultWorkspaceName: 'Personal',
    commandPaletteEnabled: true,
    welcomeSeen: true,
    uiColorMode: 'light',
    contentColorMode: 'light',
    sidebarCollapsed: false,
    sidebarHidden: false,
    sidebarShortcutBehavior: 'collapse',
    defaultPanelWidthPx: 640,
    customPanelSizes: [320, 480, 768, 1280],
    panelCycleWraparound: false,
    panelShadowsEnabled: true,
    panelCornerRadiusPx: 8,
    autoBackupEnabled: true,
    autoBackupIntervalMinutes: 30,
    autoBackupMaxCount: 5,
    privacyProtectionLevel: 'standard',
    defaultSearchEngine: 'ddg',
    ...overrides,
  };
  return {
    snapshot: vi.fn(() => ({ ...settings })),
  } as unknown as SettingsStore;
}

function makeTabRegistry(tabs: TabSnapshot[]): TabRegistry {
  return {
    snapshot: vi.fn(() => tabs),
  } as unknown as TabRegistry;
}

function stubBrowser(): TabListeners {
  const listeners: TabListeners = {};
  vi.stubGlobal('browser', {
    tabs: {
      discard: vi.fn().mockResolvedValue(undefined),
      onActivated: { addListener: vi.fn((listener) => (listeners.activated = listener)) },
      onCreated: { addListener: vi.fn((listener) => (listeners.created = listener)) },
      onRemoved: { addListener: vi.fn((listener) => (listeners.removed = listener)) },
    },
  });
  return listeners;
}

describe('SleepPolicy', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps protected active-workspace panel tabs awake', async () => {
    stubBrowser();
    const policy = new SleepPolicy(
      makeTabRegistry([
        makeTab({ id: 1, workspaceId: 'ws-1', active: true }),
        makeTab({ id: 10, workspaceId: 'ws-1' }),
      ]),
      makeSettings(),
      { getProtectedTabIds: () => [10] },
    );
    policy.init();

    vi.setSystemTime(61_000);
    await policy.sweep();

    expect(browser.tabs.discard).not.toHaveBeenCalled();
    policy.dispose();
  });

  it('skips tabs that Firefox already reports as discarded', async () => {
    stubBrowser();
    const policy = new SleepPolicy(
      makeTabRegistry([
        makeTab({ id: 1, workspaceId: 'ws-1', active: true }),
        makeTab({ id: 10, workspaceId: 'ws-1', discarded: true }),
      ]),
      makeSettings(),
    );
    policy.init();

    vi.setSystemTime(61_000);
    await policy.sweep();

    expect(browser.tabs.discard).not.toHaveBeenCalled();
    policy.dispose();
  });

  it('still discards idle unprotected tabs after the sleep threshold', async () => {
    const listeners = stubBrowser();
    const policy = new SleepPolicy(
      makeTabRegistry([
        makeTab({ id: 1, workspaceId: 'ws-1', active: true }),
        makeTab({ id: 10, workspaceId: 'ws-1' }),
      ]),
      makeSettings(),
    );
    policy.init();
    vi.setSystemTime(10);
    listeners.activated?.({ tabId: 1, windowId: 1 });

    vi.setSystemTime(61_000);
    await policy.sweep();

    expect(browser.tabs.discard).toHaveBeenCalledWith(10);
    policy.dispose();
  });
});
