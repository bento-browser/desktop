import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addPanel, emptyLayout } from './PanelLayout';
import { load, Persistence } from './Persistence';
import type { PersistedWorkspacePanels } from './PanelStore';

const STORAGE_KEY = 'bento.panels';

describe('panel Persistence headerHidden', () => {
  let storage: Record<string, unknown>;

  beforeEach(() => {
    storage = {};
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (keys: string[]) =>
            Object.fromEntries(keys.map((key) => [key, storage[key]])),
          ),
          set: vi.fn(async (payload: Record<string, unknown>) => {
            Object.assign(storage, payload);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
          }),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          url: `https://${tabId}.example.test/`,
        })),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips headerHidden on live and parked workspace entries', async () => {
    const liveLayout = emptyLayout();
    addPanel(liveLayout, 101);

    const parked: PersistedWorkspacePanels = {
      entries: [
        {
          panelKey: 'parked-panel',
          url: 'https://parked.example.test/',
          headerHidden: true,
        },
      ],
      layout: { root: [{ kind: 'panel', panelKey: 'parked-panel' }] },
    };

    const persistence = new Persistence();
    persistence.flushNow(
      new Map([['live-ws', liveLayout]]),
      new Map([['parked-ws', parked]]),
      new Map(),
      new Map([[101, true]]),
      new Map(),
      new Map(),
    );

    await vi.waitFor(() => expect(storage[STORAGE_KEY]).toBeTruthy());

    const loaded = await load();

    expect(loaded?.byWorkspace.get('live-ws')?.entries).toEqual([
      {
        panelKey: 'panel-0',
        url: 'https://101.example.test/',
        headerHidden: true,
      },
    ]);
    expect(loaded?.byWorkspace.get('parked-ws')?.entries).toEqual([
      {
        panelKey: 'parked-panel',
        url: 'https://parked.example.test/',
        headerHidden: true,
      },
    ]);
  });

  it('loads headerHidden only when the stored value is true', async () => {
    storage[STORAGE_KEY] = {
      version: 5,
      mainWidthByWorkspace: {},
      byWorkspace: {
        ws: {
          entries: [
            { panelKey: 'a', url: 'https://a.example.test/' },
            { panelKey: 'b', url: 'https://b.example.test/', headerHidden: false },
            { panelKey: 'c', url: 'https://c.example.test/', headerHidden: 'yes' },
            { panelKey: 'd', url: 'https://d.example.test/', headerHidden: true },
          ],
          panelLayout: {
            root: [
              { kind: 'panel', panelKey: 'a' },
              { kind: 'panel', panelKey: 'b' },
              { kind: 'panel', panelKey: 'c' },
              { kind: 'panel', panelKey: 'd' },
            ],
          },
        },
      },
    };

    const loaded = await load();

    expect(loaded?.byWorkspace.get('ws')?.entries).toEqual([
      { panelKey: 'a', url: 'https://a.example.test/' },
      { panelKey: 'b', url: 'https://b.example.test/' },
      { panelKey: 'c', url: 'https://c.example.test/' },
      { panelKey: 'd', url: 'https://d.example.test/', headerHidden: true },
    ]);
  });
});
