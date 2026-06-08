import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PinnedPanelsStore } from './PinnedPanelsStore';

const STORAGE_KEY = 'bento.pinnedPanels';

describe('PinnedPanelsStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({
            [STORAGE_KEY]: {
              version: 4,
              entries: [
                {
                  workspaceId: 'ws-a',
                  panelKey: 'panel-a',
                  url: 'https://a.example.test/',
                  order: 0,
                  title: 'A',
                },
                {
                  workspaceId: 'ws-b',
                  panelKey: 'panel-b',
                  url: 'https://b.example.test/',
                  order: 1,
                  title: 'B',
                },
              ],
            },
          })),
          set: vi.fn(async () => undefined),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: `https://${tabId}.example.test/` })),
      },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('exposes all persisted pins immediately and rebinds lazily restored workspaces', async () => {
    const store = new PinnedPanelsStore();

    await store.init();

    expect(store.entries()).toEqual([
      expect.objectContaining({
        workspaceId: 'ws-a',
        tabId: expect.any(Number),
        order: 0,
        url: 'https://a.example.test/',
        title: 'A',
      }),
      expect.objectContaining({
        workspaceId: 'ws-b',
        tabId: expect.any(Number),
        order: 1,
        url: 'https://b.example.test/',
        title: 'B',
      }),
    ]);
    expect(store.entries().every((entry) => entry.tabId < 0)).toBe(true);

    store.recoverTabIdsAfterPanelRestore('ws-b', {
      panelKeyToTabId: new Map([['panel-b', 42]]),
      urlToTabId: new Map([['https://b.example.test/', 42]]),
    });

    expect(store.entries()).toEqual([
      expect.objectContaining({
        workspaceId: 'ws-a',
        tabId: expect.any(Number),
        order: 0,
        url: 'https://a.example.test/',
      }),
      expect.objectContaining({
        workspaceId: 'ws-b',
        tabId: 42,
        order: 1,
        url: 'https://b.example.test/',
      }),
    ]);
    expect(store.entries()[0]?.tabId).toBeLessThan(0);
  });
});
