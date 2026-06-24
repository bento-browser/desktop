import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TabRegistry } from './TabRegistry';

describe('TabRegistry closing markers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      sessions: {
        getTabValue: vi.fn().mockResolvedValue('1'),
        setTabValue: vi.fn().mockResolvedValue(undefined),
        removeTabValue: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('can clear the closing marker when a closed tab is restored', async () => {
    const tabs = new TabRegistry();

    await tabs.markClosing(123);
    expect(tabs.isClosing(123)).toBe(true);

    await tabs.unmarkClosing(123);

    expect(tabs.isClosing(123)).toBe(false);
    await expect(tabs.isClosingOrMarked(123)).resolves.toBe(false);
    expect(browser.sessions.removeTabValue).toHaveBeenCalledWith(123, 'bento.closingTab');
  });

  it('reports whether eager workspace assignment persisted to the session store', async () => {
    const tabs = new TabRegistry();

    await expect(tabs.assignWorkspaceEagerly(456, 'ws-imported')).resolves.toBe(true);

    expect(browser.sessions.setTabValue).toHaveBeenCalledWith(
      456,
      'bento.workspaceId',
      'ws-imported',
    );
  });

  it('returns false when eager workspace assignment cannot persist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(browser.sessions.setTabValue).mockRejectedValueOnce(new Error('write failed'));
    const tabs = new TabRegistry();

    try {
      await expect(tabs.assignWorkspaceEagerly(456, 'ws-imported')).resolves.toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('reports whether eager folder assignment persisted to the session store', async () => {
    const tabs = new TabRegistry();

    await expect(tabs.assignFolderEagerly(456, 'folder-imported')).resolves.toBe(true);

    expect(browser.sessions.setTabValue).toHaveBeenCalledWith(
      456,
      'bento.folderId',
      'folder-imported',
    );
  });

  it('returns false when eager folder assignment cannot persist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(browser.sessions.setTabValue).mockRejectedValueOnce(new Error('write failed'));
    const tabs = new TabRegistry();

    try {
      await expect(tabs.assignFolderEagerly(456, 'folder-imported')).resolves.toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('retries boot hydration so delayed session workspace values are recovered', async () => {
    const listeners: Array<(tab: browser.tabs.Tab) => void> = [];
    vi.stubGlobal('browser', {
      sessions: {
        getTabValue: vi.fn(async (tabId: number, key: string) => {
          if (tabId !== 123) return undefined;
          const workspaceReads = vi
            .mocked(browser.sessions.getTabValue)
            .mock.calls.filter((call) => call[0] === 123 && call[1] === 'bento.workspaceId').length;
          if (key === 'bento.workspaceId') return workspaceReads >= 2 ? 'ws-imported' : undefined;
          return undefined;
        }),
        setTabValue: vi.fn().mockResolvedValue(undefined),
        removeTabValue: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        query: vi.fn(async () => [
          {
            id: 123,
            windowId: 1,
            index: 0,
            title: 'Imported',
            active: true,
            pinned: false,
          },
        ]),
        onCreated: { addListener: vi.fn((listener) => listeners.push(listener)) },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        onActivated: { addListener: vi.fn() },
        onMoved: { addListener: vi.fn() },
        onAttached: { addListener: vi.fn() },
      },
    });

    const tabs = new TabRegistry();
    await tabs.init();
    expect(tabs.snapshot()[0]?.workspaceId).toBeUndefined();

    await tabs.hydrateWorkspaceIds({ attempts: 3, delayMs: 0 });

    expect(tabs.snapshot()[0]?.workspaceId).toBe('ws-imported');
  });
});
